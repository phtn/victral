import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectTools } from '../src/tools.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture(allowShell = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-tools-')); directories.push(directory);
  return { directory, tools: projectTools({ zoom: () => '', date: () => '' }, directory, { allowShell }) };
}
test('exact edits reject ambiguous or stale text without modifying files', async () => {
  const { tools } = await fixture();
  await tools.execute('write_file', { path: 'a.txt', content: 'one\none\nthree' });
  await expect(tools.execute('edit_file', { path: 'a.txt', old_text: 'one', new_text: 'two' })).rejects.toThrow('ambiguous');
  await expect(tools.execute('edit_file', { path: 'a.txt', old_text: 'missing', new_text: 'two' })).rejects.toThrow('not found');
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('one\none\nthree');
  await tools.execute('edit_file', { path: 'a.txt', old_text: 'one\none', new_text: 'two' });
  expect(await tools.execute('read_file', { path: 'a.txt', start_line: 2, end_line: 2 })).toBe('2: three');
});
test('search reports lines and skips secrets, dependencies, binary files, and symlinks', async () => {
  const { directory, tools } = await fixture();
  for (const filename of ['src/a.txt', '.env', '.env.local', 'node_modules/a.txt', '.git/a.txt']) await tools.execute('write_file', { path: filename, content: 'needle' });
  await fs.writeFile(path.join(directory, 'binary'), Buffer.from('needle\0'));
  await fs.symlink(path.join(directory, 'src'), path.join(directory, 'link'));
  const result = await tools.execute('search_files', { query: 'needle' });
  expect(result).toContain('src/a.txt:1: needle'); expect(result).not.toContain('.env'); expect(result).not.toContain('node_modules'); expect(result).not.toContain('binary:'); expect(result).not.toContain('link/a');
  await expect(tools.execute('search_files', { query: 'needle', path: '../' })).rejects.toThrow('outside');
});
test('CLI execution is explicitly enabled and uses literal arguments', async () => {
  const disabled = await fixture();
  expect(disabled.tools.definitions.some(t => t.function.name === 'run_command')).toBe(false);
  await expect(disabled.tools.execute('run_command', { program: 'echo', args: [] })).rejects.toThrow('disabled');
  const { tools } = await fixture(true);
  const output = await tools.execute('run_command', { program: 'printf', args: ['%s', '🦓; $(exit 9)'] });
  expect(output).toContain('🦓; $(exit 9)'); expect(output).toContain('exit: 0');
});
test('command timeout and cancellation terminate processes promptly', async () => {
  const { tools } = await fixture(true);
  const start = performance.now();
  const output = await tools.execute('shell', { command: 'sleep 30 & wait', timeout_ms: 80 });
  expect(output).toContain('timeout: true'); expect(performance.now() - start).toBeLessThan(2000);
  const controller = new AbortController();
  const pending = tools.execute('run_command', { program: 'sleep', args: ['30'] }, controller.signal);
  setTimeout(() => controller.abort(), 40);
  await expect(pending).rejects.toThrow();
});
test('Git tools expose real status/diffs without enabling arbitrary execution', async () => {
  const { directory, tools } = await fixture();
  const init = Bun.spawn(['git', 'init', '-q'], { cwd: directory }); expect(await init.exited).toBe(0);
  await tools.execute('write_file', { path: 'file.txt', content: 'first' });
  const add = Bun.spawn(['git', 'add', 'file.txt'], { cwd: directory }); expect(await add.exited).toBe(0);
  expect(await tools.execute('git_status', {})).toContain('A  file.txt');
  expect(await tools.execute('git_diff', { staged: true })).toContain('+first');
  await expect(tools.execute('git_diff', { path: '../outside' })).rejects.toThrow('outside');
});
test('fetch_url returns text, summarizes binary, and rejects non-http(s) URLs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-tools-')); directories.push(directory);
  const seen: string[] = [];
  const stub = async (url: string) => {
    seen.push(url);
    const binary = url.endsWith('/binary');
    const body = new TextEncoder().encode(binary ? 'PNGDATA' : 'hello page');
    return new Response(body, { status: binary ? 200 : 404, headers: { 'content-type': binary ? 'image/png' : 'text/html; charset=utf-8' } });
  };
  const tools = projectTools({ zoom: () => '', date: () => '' }, directory, { fetchImpl: stub as unknown as typeof fetch });
  expect(tools.definitions.some(t => t.function.name === 'fetch_url')).toBe(true);
  const page = await tools.execute('fetch_url', { url: 'https://example.com/page' });
  expect(page).toContain('[status: 404'); expect(page).toContain('hello page');
  const binary = await tools.execute('fetch_url', { url: 'https://example.com/binary' });
  expect(binary).toContain('Non-text response omitted'); expect(binary).not.toContain('PNGDATA');
  expect(seen).toEqual(['https://example.com/page', 'https://example.com/binary']);
  await expect(tools.execute('fetch_url', { url: 'ftp://example.com/file' })).rejects.toThrow('http(s)');
  await expect(tools.execute('fetch_url', { url: 'not a url' })).rejects.toThrow('http(s)');
});
test('CLI subprocesses do not inherit credential-like environment variables', async () => {
  const { tools } = await fixture(true);
  const previous = process.env.VICTRAL_TEST_TOKEN;
  process.env.VICTRAL_TEST_TOKEN = 'offline-sentinel';
  try {
    const output = await tools.execute('run_command', { program: process.execPath, args: ['-e', 'console.log(process.env.VICTRAL_TEST_TOKEN === undefined ? "removed" : "present")'] });
    expect(output).toContain('removed'); expect(output).not.toContain('present');
  } finally { if (previous === undefined) delete process.env.VICTRAL_TEST_TOKEN; else process.env.VICTRAL_TEST_TOKEN = previous; }
});
