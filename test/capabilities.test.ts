import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectTools } from '../src/tools.js';
import { Storage } from '../src/storage.js';
import { Runner } from '../src/runner.js';
import type { AgentTools, MemoryPort, ModelPort, TurnRecord } from '../src/types.js';
import type { TaskPlan } from '../src/task-plans.js';

const fixtures: { directory: string; tools: AgentTools }[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const { directory, tools } of fixtures.splice(0)) { await tools.close?.(); await fs.rm(directory, { recursive: true, force: true }); }
});
async function fixture(options: Parameters<typeof projectTools>[2] = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-capabilities-'));
  const tools = projectTools({ zoom: () => '', date: () => '' }, directory, options);
  const value = { directory, tools }; fixtures.push(value); return value;
}
const newPlan = { title: 'Ship the feature', expected_revision: 0, steps: [{ step: 'Inspect code', status: 'in_progress' }, { step: 'Implement and verify', status: 'pending' }] };
const commandId = (output: string) => /command_id: (command-\d+)/.exec(output)![1]!;

test('plans validate progress and reject stale revisions without losing saved state', async () => {
  const records: TaskPlan[] = [];
  const { tools } = await fixture({ planStore: { load: () => records, save: record => { records.push(record); } } });
  expect(await tools.execute('get_plan', {})).toContain('expected_revision: 0');
  const first = JSON.parse(await tools.execute('update_plan', newPlan));
  expect(first.revision).toBe(1); expect(records).toHaveLength(1);
  await expect(tools.execute('update_plan', newPlan)).rejects.toThrow('revision changed');
  await expect(tools.execute('update_plan', { ...newPlan, expected_revision: 1, steps: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] })).rejects.toThrow('Only one');
  await expect(tools.execute('update_plan', { ...newPlan, expected_revision: 1, steps: [{ step: 'a', status: 'unknown' }] })).rejects.toThrow('Plan status');
  expect(JSON.parse(await tools.execute('get_plan', {}))).toEqual(first);
  expect(records).toHaveLength(1);
  const done = JSON.parse(await tools.execute('update_plan', { ...newPlan, expected_revision: 1, steps: newPlan.steps.map(step => ({ ...step, status: 'completed' })) }));
  expect(done.revision).toBe(2);
});

test('plans publish only after persistence succeeds', async () => {
  const { tools } = await fixture({ planStore: { load: () => [], save() { throw new Error('disk full'); } } });
  await expect(tools.execute('update_plan', newPlan)).rejects.toThrow('disk full');
  expect(await tools.execute('get_plan', {})).toContain('No task plan');
  expect(tools.context?.()).toBe('');
});

test('plans survive real storage restart and are isolated by canonical project root', async () => {
  const { directory } = await fixture();
  const chat = path.join(directory, 'chat');
  const open = async () => {
    const storage = await Storage.open(chat);
    const tools = projectTools({ zoom: () => '', date: () => '' }, directory, { planStore: { load: () => storage.load('plans'), save: plan => storage.savePlan(plan) } });
    return { storage, tools };
  };
  const first = await open();
  await first.tools.execute('update_plan', newPlan);
  await first.tools.close?.(); await first.storage.close();
  const second = await open();
  cleanups.push(async () => { await second.tools.close?.(); await second.storage.close(); });
  expect(JSON.parse(await second.tools.execute('get_plan', {})).revision).toBe(1);
  expect(second.storage.root).toHaveLength(0);
  const elsewhere = await fixture({ planStore: { load: () => second.storage.load('plans'), save: plan => second.storage.savePlan(plan) } });
  expect(await elsewhere.tools.execute('get_plan', {})).toContain('No task plan');
  const alias = path.join(directory, 'alias'); await fs.symlink(directory, alias);
  const aliased = projectTools({ zoom: () => '', date: () => '' }, alias, { planStore: { load: () => second.storage.load('plans'), save: plan => second.storage.savePlan(plan) } });
  expect(JSON.parse(await aliased.execute('get_plan', {})).title).toBe('Ship the feature');
  await aliased.close?.();
});

test('every fresh runner turn receives the current plan outside the permanent conversation log', async () => {
  const { tools } = await fixture();
  await tools.execute('update_plan', newPlan);
  const logged: string[] = [], contexts: string[] = [];
  const memory: MemoryPort = { append(_kind, text) { logged.push(text); }, async settle() { return true; }, render: () => '', zoom: () => '', date: () => '' };
  const model: ModelPort = { model: 'test', async stream(messages) { contexts.push(JSON.stringify(messages[1]!.content)); return { message: { role: 'assistant', content: '' }, finish_reason: 'COMPLETE' }; } };
  const runner = new Runner(memory, model, tools);
  await runner.submit('First turn');
  await tools.execute('update_plan', { ...newPlan, title: 'Updated work', expected_revision: 1 });
  await runner.submit('Second turn'); await runner.close();
  expect(contexts[0]).toContain('Ship the feature'); expect(contexts[1]).toContain('Updated work');
  expect(logged).toEqual(['First turn', 'Second turn']);
});

test('parallel reads run concurrently while preserving request order and independent errors', async () => {
  let requests = 0, release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = (async (url: string) => {
    if (++requests === 2) release();
    await both;
    return new Response(url.endsWith('/first') ? 'first' : 'second', { headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const { tools } = await fixture({ fetchImpl });
  const result = await tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.com/first' } },
    { tool: 'read_file', arguments: { path: 'missing' } },
    { tool: 'fetch_url', arguments: { url: 'https://example.com/second' } },
  ] });
  expect(requests).toBe(2);
  expect(result).toContain('[1/3 fetch_url; status: completed]'); expect(result).toContain('[2/3 read_file; status: error]');
  expect(result.indexOf('first')).toBeLessThan(result.indexOf('second'));
});

test('parallel reads reject mutation and recursion before starting any tool and cap individual results', async () => {
  let requests = 0;
  const { tools } = await fixture({ fetchImpl: (async () => { requests++; return new Response('text'); }) as unknown as typeof fetch });
  for (const tool of ['write_file', 'shell', 'start_command', 'update_plan', 'parallel_tools', 'write_command_input']) {
    await expect(tools.execute('parallel_tools', { calls: [{ tool: 'fetch_url', arguments: { url: 'https://example.com' } }, { tool, arguments: {} }] })).rejects.toThrow('read-only');
  }
  expect(requests).toBe(0);
  await tools.execute('write_file', { path: 'large.txt', content: '🦓'.repeat(5000) });
  const result = await tools.execute('parallel_tools', { calls: [{ tool: 'read_file', arguments: { path: 'large.txt' } }, { tool: 'get_plan', arguments: {} }] });
  expect(result).toContain('batch result capped'); expect(result).not.toContain('�'); expect(result).toContain('[2/2 get_plan; status: completed]');
  await expect(tools.execute('parallel_tools', { calls: [] })).rejects.toThrow('between 1 and 8');
});

test('parallel reads propagate cancellation to pending network requests', async () => {
  const { tools } = await fixture({ fetchImpl: (async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  })) as typeof fetch });
  const controller = new AbortController();
  const pending = tools.execute('parallel_tools', { calls: [{ tool: 'fetch_url', arguments: { url: 'https://example.com' } }] }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test('runner metrics count nested parallel tool calls and memory retrievals', async () => {
  const { tools } = await fixture();
  const turns: TurnRecord[] = [];
  let requests = 0;
  const model: ModelPort = { model: 'test', async stream() {
    if (++requests === 1) return { message: { role: 'assistant', content: [], tool_calls: [{ id: 'batch', function: {
      name: 'parallel_tools', arguments: JSON.stringify({ calls: [{ tool: 'zoom', arguments: { id: 0, n: 1 } }, { tool: 'get_plan', arguments: {} }] }),
    } }] }, finish_reason: 'TOOL_CALL' };
    return { message: { role: 'assistant', content: '' }, finish_reason: 'COMPLETE' };
  } };
  const memory: MemoryPort = { append() {}, async settle() { return true; }, render: () => '', zoom: () => '', date: () => '' };
  const runner = new Runner(memory, model, tools, '', { onTurn: turn => turns.push(turn) });
  await runner.submit('Investigate'); await runner.close();
  expect(turns[0]!.tool_calls).toBe(3); expect(turns[0]!.retrievals).toBe(1);
});

test('Git history, commit patches and blame inspect real commits without shell access', async () => {
  const { directory, tools } = await fixture();
  const git = async (...args: string[]) => {
    const child = Bun.spawn(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(stderr); return stdout;
  };
  await git('init', '-q');
  await tools.execute('write_file', { path: 'file.txt', content: 'first\nsecond\n' });
  await tools.execute('write_file', { path: 'literal[1].txt', content: 'literal\n' });
  await git('add', '.');
  await git('-c', 'user.name=Offline Author', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial feature');
  const initial = (await git('rev-parse', 'HEAD')).trim();
  await tools.execute('edit_file', { path: 'file.txt', old_text: 'second', new_text: 'changed' });
  await git('add', '.'); await git('-c', 'user.name=Offline Author', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Update feature');
  const log = await tools.execute('git_log', { max_count: 1, path: 'file.txt' });
  expect(log).toContain('Update feature'); expect(log).not.toContain('Initial feature');
  const shown = await tools.execute('git_show', { path: 'file.txt' });
  expect(shown).toContain('+changed'); expect(shown).toContain('-second');
  expect(await tools.execute('git_show', { path: 'literal[1].txt', ref: initial })).toContain('+literal');
  const blame = await tools.execute('git_blame', { path: 'file.txt', start_line: 2, end_line: 2 });
  expect(blame).toContain('Offline Author'); expect(blame).toContain('changed'); expect(blame).not.toContain('first');
  expect(await tools.execute('git_diff', { base: initial, path: 'file.txt' })).toContain('+changed');
  await expect(tools.execute('git_log', { ref: '--output=escape' })).rejects.toThrow('cannot start');
  await expect(tools.execute('git_show', { path: '../escape' })).rejects.toThrow('outside');
  await expect(tools.execute('git_blame', { path: 'file.txt', start_line: 1 })).rejects.toThrow('end_line');
});

test('interactive commands accept literal Unicode input and EOF, and list_commands recovers their IDs', async () => {
  const { tools } = await fixture({ allowShell: true });
  const id = commandId(await tools.execute('start_command', { program: 'cat', args: [], interactive: true }));
  const listed = JSON.parse(await tools.execute('list_commands', {}));
  expect(listed[0].command_id).toBe(id); expect(listed[0].stdin_closed).toBe(false); expect(listed[0].status).toBe('running');
  const sent = await tools.execute('write_command_input', { command_id: id, input: '🦓 $(exit 9); hello\n', eof: true });
  expect(sent).toContain('stdin closed');
  const result = await tools.execute('command_status', { command_id: id, wait_ms: 1000 });
  expect(result).toContain('🦓 $(exit 9); hello'); expect(result).toContain('exit: 0');
  await expect(tools.execute('write_command_input', { command_id: id, input: 'more' })).rejects.toThrow('already exited');
  const second = commandId(await tools.execute('start_command', { program: 'cat', args: [], interactive: true }));
  await tools.execute('write_command_input', { command_id: second, eof: true });
  expect(await tools.execute('command_status', { command_id: second, wait_ms: 1000 })).toContain('exit: 0');
});

test('command input enforces shell access, pipe state, input size and argument types', async () => {
  const disabled = (await fixture()).tools;
  for (const name of ['list_commands', 'write_command_input']) {
    expect(disabled.definitions.some(tool => tool.function.name === name)).toBe(false);
    await expect(disabled.execute(name, {})).rejects.toThrow('disabled');
  }
  const { tools } = await fixture({ allowShell: true });
  const closed = commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'] }));
  await expect(tools.execute('write_command_input', { command_id: closed, input: 'text' })).rejects.toThrow('stdin is closed');
  await expect(tools.execute('start_command', { program: 'cat', args: [], interactive: 'yes' })).rejects.toThrow('boolean');
  const id = commandId(await tools.execute('start_command', { program: 'cat', args: [], interactive: true }));
  await expect(tools.execute('write_command_input', { command_id: id, input: '🦓'.repeat(20000) })).rejects.toThrow('65536');
  await expect(tools.execute('write_command_input', { command_id: id })).rejects.toThrow('Provide input');
  await expect(tools.execute('write_command_input', { command_id: id, eof: 'yes' })).rejects.toThrow('boolean');
  expect(JSON.parse(await tools.execute('list_commands', {}))).toHaveLength(2);
});

test('canceling blocked command input stops the process and releases its pipe', async () => {
  const { tools } = await fixture({ allowShell: true });
  const id = commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'], interactive: true }));
  const controller = new AbortController();
  const pending = (async () => {
    for (let i = 0; i < 32; i++) await tools.execute('write_command_input', { command_id: id, input: 'x'.repeat(65536) }, controller.signal);
  })();
  const timer = setTimeout(() => controller.abort(), 40);
  try { await expect(pending).rejects.toThrow(); }
  finally { clearTimeout(timer); }
  const result = await tools.execute('command_status', { command_id: id, wait_ms: 1000 });
  expect(result).toContain('status: completed'); expect(result).toContain('stopped: true');
});

test('blocked command input reaches its deadline and stops the process', async () => {
  const { tools } = await fixture({ allowShell: true });
  const id = commandId(await tools.execute('start_command', { program: 'sleep', args: ['30'], interactive: true }));
  const pending = (async () => {
    for (let i = 0; i < 32; i++) await tools.execute('write_command_input', { command_id: id, input: 'x'.repeat(65536) });
  })();
  await expect(pending).rejects.toThrow('input timed out');
  expect(await tools.execute('command_status', { command_id: id, wait_ms: 1000 })).toContain('stopped: true');
});
