import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectTools } from '../src/tools.js';
import { Runner } from '../src/runner.js';
import type { AgentTools, MemoryPort, ModelPort } from '../src/types.js';

const fixtures: { directory: string; tools: AgentTools }[] = [];
afterEach(async () => {
  for (const { directory, tools } of fixtures.splice(0)) {
    await tools.close?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture(allowShell = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-advanced-'));
  const tools = projectTools({ zoom: () => '', date: () => '' }, directory, { allowShell });
  const value = { directory, tools }; fixtures.push(value); return value;
}
const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const commandId = (output: string) => {
  const id = /command_id: (command-\d+)/.exec(output)?.[1];
  if (!id) throw new Error(`No command ID in ${output}`);
  return id;
};

test('glob discovery scopes project-relative patterns and skips excluded files and symlinks', async () => {
  const { directory, tools } = await fixture();
  for (const name of ['a.ts', 'src/a.ts', 'src/b.js', 'src/c.txt', 'node_modules/a.ts', 'dist/a.ts', '.env.local']) {
    await tools.execute('write_file', { path: name, content: 'needle' });
  }
  await fs.symlink(path.join(directory, 'src'), path.join(directory, 'link'));
  expect(await tools.execute('glob_files', { pattern: '**/*.{ts,js}', path: 'src' })).toBe('src/a.ts\nsrc/b.js\n[3 files scanned]');
  const limited = await tools.execute('glob_files', { pattern: '**/*.ts', max_results: 1 });
  expect(limited).toContain('a.ts\n'); expect(limited).toContain('limit reached');
  await expect(tools.execute('glob_files', { pattern: '../*' })).rejects.toThrow('project-relative');
  await expect(tools.execute('glob_files', { pattern: '**/*', path: 'node_modules' })).rejects.toThrow('excludes');
  await expect(tools.execute('glob_files', { pattern: '**/*', path: '../' })).rejects.toThrow('outside');
});

test('search supports regex, case folding, file filters and result limits while retaining literal defaults', async () => {
  const { tools } = await fixture();
  await tools.execute('write_file', { path: 'src/a.ts', content: 'const First = 1;\nconst second = 2;\nliteral a.b\nliteral axb\n' });
  await tools.execute('write_file', { path: 'src/b.txt', content: 'const third = 3;' });
  expect(await tools.execute('search_files', { query: '^const (first|second)', regex: true, case_sensitive: false, glob: '**/*.ts' })).toContain('src/a.ts:1: const First');
  const literal = await tools.execute('search_files', { query: 'a.b' });
  expect(literal).toContain('src/a.ts:3: literal a.b'); expect(literal).not.toContain('axb');
  const limited = await tools.execute('search_files', { query: '^const', regex: true, max_results: 1 });
  expect(limited).toContain('limit reached'); expect(limited).not.toContain('second');
  await expect(tools.execute('search_files', { query: '[', regex: true })).rejects.toThrow('Invalid regular expression');
  await expect(tools.execute('search_files', { query: 'const', regex: 'yes' })).rejects.toThrow('boolean');
  await expect(tools.execute('search_files', { query: 'const', max_results: 1001 })).rejects.toThrow('between');
  await expect(tools.execute('search_files', { query: 'const', path: 'node_modules/nested' })).rejects.toThrow('excludes');
});

test('regex search can be canceled while matching a backtracking expression', async () => {
  const { tools } = await fixture();
  await tools.execute('write_file', { path: 'long.txt', content: 'a'.repeat(10000) + '!' });
  const controller = new AbortController();
  const started = performance.now();
  const pending = tools.execute('search_files', { query: '^(a+)+$', regex: true }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 40);
  try { await expect(pending).rejects.toThrow(); }
  finally { clearTimeout(timer); }
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await tools.execute('search_files', { query: '!' })).toContain('long.txt:1:');
});

test('patches add, update, move and delete files together and preserve newline style and file mode', async () => {
  const { directory, tools } = await fixture();
  await tools.execute('write_file', { path: 'old.ts', content: 'first\r\nsecond\r\nthird\r\n' });
  await fs.chmod(path.join(directory, 'old.ts'), 0o755);
  await tools.execute('write_file', { path: 'obsolete.txt', content: 'obsolete' });
  const result = await tools.execute('apply_patch', { patch: patch(
    '*** Add File: src/new.ts', '+export const added = true;',
    '*** Update File: old.ts', '*** Move to: src/moved.ts', '@@', ' first', '-second', '+changed', ' third', '*** End of File',
    '*** Delete File: obsolete.txt',
  ) });
  expect(result).toContain('Added src/new.ts'); expect(result).toContain('old.ts -> src/moved.ts');
  expect(await fs.readFile(path.join(directory, 'src/new.ts'), 'utf8')).toBe('export const added = true;\n');
  expect(await fs.readFile(path.join(directory, 'src/moved.ts'), 'utf8')).toBe('first\r\nchanged\r\nthird\r\n');
  expect((await fs.stat(path.join(directory, 'src/moved.ts'))).mode & 0o777).toBe(0o755);
  expect(await fs.exists(path.join(directory, 'old.ts'))).toBe(false);
  expect(await fs.exists(path.join(directory, 'obsolete.txt'))).toBe(false);
});

test('patches reject stale or ambiguous context before writing any other file', async () => {
  const { tools } = await fixture();
  await tools.execute('write_file', { path: 'a.txt', content: 'one\none\nlast' });
  for (const [context, expected] of [['one', 'ambiguous'], ['missing', 'not found']]) {
    await expect(tools.execute('apply_patch', { patch: patch('*** Add File: new.txt', '+created', '*** Update File: a.txt', '@@', `-${context}`, '+replacement') })).rejects.toThrow(expected);
    await expect(tools.execute('read_file', { path: 'new.txt' })).rejects.toThrow();
    expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('one\none\nlast');
  }
  await tools.execute('apply_patch', { patch: patch('*** Update File: a.txt', '@@', ' one', '-one', '+two', ' last') });
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('one\ntwo\nlast');
});

test('patches reject escapes, symlinks, duplicate paths, malformed hunks and overwrites', async () => {
  const { directory, tools } = await fixture();
  await tools.execute('write_file', { path: 'a.txt', content: 'one\n' });
  await fs.symlink(path.join(directory, 'a.txt'), path.join(directory, 'link.txt'));
  await fs.symlink(os.tmpdir(), path.join(directory, 'outside'));
  const invalid: [string, string][] = [
    [patch('*** Add File: new.txt', '+new', '*** Add File: ../escape.txt', '+outside'), 'outside'],
    [patch('*** Add File: outside/escape.txt', '+outside'), 'Symlink'],
    [patch('*** Update File: link.txt', '@@', '-one', '+two'), 'symlink'],
    [patch('*** Update File: a.txt', '@@', '-one', '+two', '*** Delete File: ./a.txt'), 'same file'],
    [patch('*** Add File: a.txt', '+overwrite'), 'already exists'],
    [patch('*** Update File: a.txt', '*** Move to: link.txt', '@@', '-one', '+two'), 'same file'],
    [patch('*** Update File: a.txt', '@@', '+no context'), 'existing context'],
    [patch('*** Update File: a.txt', '@@', 'unprefixed'), 'must start'],
  ];
  for (const [value, message] of invalid) await expect(tools.execute('apply_patch', { patch: value })).rejects.toThrow(message);
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('one\n');
  expect(await fs.exists(path.join(directory, 'new.txt'))).toBe(false);
});

test('patches roll back earlier file writes when a later write fails', async () => {
  const { directory, tools } = await fixture();
  await tools.execute('write_file', { path: 'a.txt', content: 'one\n' });
  // Both missing paths pass preflight, but a file cannot also be a parent directory.
  await expect(tools.execute('apply_patch', { patch: patch(
    '*** Update File: a.txt', '@@', '-one', '+two',
    '*** Add File: blocker', '+file', '*** Add File: blocker/child.txt', '+child',
  ) })).rejects.toThrow();
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('one\n');
  expect(await fs.exists(path.join(directory, 'blocker'))).toBe(false);
});

test('patches honor ordered hunks, end anchors and preexisting cancellation', async () => {
  const { tools } = await fixture();
  await tools.execute('write_file', { path: 'a.txt', content: 'same\nmiddle\nsame\n' });
  await tools.execute('apply_patch', { patch: patch('*** Update File: a.txt', '@@', '-same', '+last', '*** End of File') });
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('same\nmiddle\nlast\n');
  await tools.execute('apply_patch', { patch: patch('*** Update File: a.txt', '@@', '-same', '+first', '@@', '-last', '+third') });
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('first\nmiddle\nthird\n');
  await expect(tools.execute('apply_patch', { patch: patch('*** Delete File: a.txt') }, AbortSignal.abort())).rejects.toThrow();
  expect(await tools.execute('read_file', { path: 'a.txt' })).toBe('first\nmiddle\nthird\n');
});

test('background tools require command authorization and validate arguments and IDs', async () => {
  const { tools } = await fixture();
  for (const name of ['start_command', 'command_status', 'stop_command']) {
    expect(tools.definitions.some(t => t.function.name === name)).toBe(false);
    await expect(tools.execute(name, {})).rejects.toThrow('disabled');
  }
  const enabled = (await fixture(true)).tools;
  await expect(enabled.execute('start_command', { program: 'echo', args: 'bad' })).rejects.toThrow('array');
  await expect(enabled.execute('start_command', { program: 'echo', args: [], timeout_ms: 600001 })).rejects.toThrow('between');
  await expect(enabled.execute('command_status', { command_id: 'missing' })).rejects.toThrow('Unknown command_id');
  await expect(enabled.execute('command_status', { command_id: 'missing', wait_ms: -1 })).rejects.toThrow('between');
});

test('background commands return immediately, permit other tools, and can be stopped', async () => {
  const { tools } = await fixture(true);
  const started = performance.now();
  const id = commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'] }));
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await tools.execute('command_status', { command_id: id })).toContain('status: running');
  expect(await tools.execute('write_file', { path: 'while-running.txt', content: 'working' })).toContain('Wrote');
  const stopped = await tools.execute('stop_command', { command_id: id });
  expect(stopped).toContain('status: completed'); expect(stopped).toContain('stopped: true');
  expect(await tools.execute('command_status', { command_id: id })).toBe(stopped);
});

test('background concurrency is bounded and stopping a job releases capacity', async () => {
  const { tools } = await fixture(true);
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'] })));
  await expect(tools.execute('start_command', { program: 'sleep', args: ['30'] })).rejects.toThrow('At most 8');
  await tools.execute('stop_command', { command_id: ids[0] });
  const replacement = commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'] }));
  expect(await tools.execute('command_status', { command_id: replacement })).toContain('status: running');
});

test('canceling a status wait leaves a command from another turn running', async () => {
  const { tools } = await fixture(true);
  const id = commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'] }));
  const controller = new AbortController();
  const pending = tools.execute('command_status', { command_id: id, wait_ms: 10000 }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(await tools.execute('command_status', { command_id: id })).toContain('status: running');
});

test('background output preserves literal arguments, caps large output, and strips credentials', async () => {
  const { tools } = await fixture(true);
  const previous = process.env.VICTRAL_TEST_TOKEN;
  process.env.VICTRAL_TEST_TOKEN = 'offline-sentinel';
  try {
    const id = commandId(await tools.execute('start_command', { program: process.execPath, args: ['-e', 'console.log(process.env.VICTRAL_TEST_TOKEN ?? "removed"); console.log(process.argv.at(-1)); console.log("x".repeat(40000)); console.log("last 🦓")', '$(exit 9);literal'] }));
    const output = await tools.execute('command_status', { command_id: id, wait_ms: 1000 });
    expect(output).toContain('status: completed'); expect(output).toContain('exit: 0');
    expect(output).toContain('removed'); expect(output).not.toContain('offline-sentinel');
    expect(output).toContain('$(exit 9);literal'); expect(output).toContain('last 🦓');
    expect(output).toContain('output capped'); expect(output.length).toBeLessThan(31000);
  } finally { if (previous === undefined) delete process.env.VICTRAL_TEST_TOKEN; else process.env.VICTRAL_TEST_TOKEN = previous; }
});

test('background timeouts and originating-turn cancellation kill process groups', async () => {
  const { tools } = await fixture(true);
  const timeoutId = commandId(await tools.execute('start_command', { program: '/bin/sh', args: ['-c', 'sleep 30 & wait'], timeout_ms: 60 }));
  const timed = await tools.execute('command_status', { command_id: timeoutId, wait_ms: 1000 });
  expect(timed).toContain('timeout: true'); expect(timed).toContain('status: completed');
  const controller = new AbortController();
  const canceledId = commandId(await tools.execute('start_command', { program: '/bin/sh', args: ['-c', 'sleep 30 & wait'] }, controller.signal));
  controller.abort();
  const canceled = await tools.execute('command_status', { command_id: canceledId, wait_ms: 1000 });
  expect(canceled).toContain('status: completed'); expect(canceled).toContain('timeout: false');
});

test('background commands survive a completed turn and are cleaned up when the runner closes', async () => {
  const { tools } = await fixture(true);
  let calls = 0, id = '';
  const memory: MemoryPort = { append() {}, async settle() { return true; }, render: () => '', zoom: () => '', date: () => '' };
  const model: ModelPort = { model: 'test', async stream(messages) {
    if (++calls === 1) return { message: { role: 'assistant', content: [], tool_calls: [{ id: 'start', function: { name: 'start_command', arguments: JSON.stringify({ program: 'sleep', args: ['30'] }) } }] }, finish_reason: 'TOOL_CALL' };
    const output = messages.at(-1)?.content;
    if (Array.isArray(output)) id = commandId(output[0]!.text!);
    return { message: { role: 'assistant', content: 'Started' }, finish_reason: 'COMPLETE' };
  } };
  const runner = new Runner(memory, model, tools);
  await runner.submit('Start a background command');
  expect(await tools.execute('command_status', { command_id: id })).toContain('status: running');
  const started = performance.now();
  await runner.close();
  expect(performance.now() - started).toBeLessThan(2000);
  await expect(tools.execute('start_command', { program: 'echo', args: [] })).rejects.toThrow('closed');
});
