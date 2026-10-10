import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Schema from 'effect/Schema';
import type { CommandTools } from '../src/command-tools.js';
import { commandTools } from '../src/command-tool-registry.js';
import { runCommandSchema, shellSchema, StartCommandSchema, CommandStatusSchema, WriteCommandInputSchema } from '../src/command-tool-schema.js';
import { ToolAccessDenied, ValidationError } from '../src/core/errors.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { projectTools, readOnlyProjectTools, type ToolOptions } from '../src/tools.js';
import type { AgentTools } from '../src/types.js';
import legacy from './fixtures/effect-migration/legacy-command-tools.json';

const directories: string[] = [], toolsets: AgentTools[] = [];
afterEach(async () => {
  await Promise.all(toolsets.splice(0).map(tools => tools.close?.()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(options: ToolOptions = {}, readOnly = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'victral-commands-'))); directories.push(root);
  const memory = { zoom: () => '', date: () => '' };
  const tools = (readOnly ? readOnlyProjectTools : projectTools)(memory, root, options); toolsets.push(tools);
  return { root, tools };
}
const commandNames = ['run_command', 'shell', 'start_command', 'command_status', 'stop_command', 'list_commands', 'write_command_input'];
function fakeCommands() {
  const calls: Record<string, unknown>[] = [], signal = new AbortController().signal;
  const commands: Pick<CommandTools, 'run' | 'start' | 'status' | 'stop' | 'list' | 'write'> = {
    async run(argv, timeoutMs, received) { calls.push({ method: 'run', argv, timeoutMs, signal: received === signal }); return legacy.output; },
    start(argv, timeoutMs, received, interactive) { calls.push({ method: 'start', argv, timeoutMs, signal: received === signal, interactive }); return legacy.output; },
    async status(id, waitMs, received) { calls.push({ method: 'status', id, waitMs, signal: received === signal }); return legacy.output; },
    async stop(id) { calls.push({ method: 'stop', id }); return legacy.output; },
    list() { calls.push({ method: 'list' }); return legacy.output; },
    async write(id, input, eof, received) {
      calls.push({ method: 'write', id, input, eof, signal: received === signal });
      return `Sent ${Buffer.byteLength(input, 'utf8')} bytes to ${id}${eof ? '; stdin closed' : ''}.`;
    },
  };
  return { commands, calls, signal, registry: new ToolRegistry(commandTools(commands, legacy.timeoutMs), ['read', 'shell']) };
}

test('registered commands preserve legacy argv, defaults, input, signals and result bytes', async () => {
  const { calls, registry, signal } = fakeCommands(), previousShell = process.env.SHELL;
  process.env.SHELL = legacy.shell;
  try {
    for (const call of legacy.calls) {
      const before = calls.length;
      expect(await registry.execute(call.tool, call.arguments, signal)).toBe(call.output);
      expect(calls.slice(before)).toEqual([call.invocation]);
    }
  } finally { if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell; }
});

test('command codecs preserve literal text, nullish numeric defaults and undefined-only flag/input defaults', () => {
  const runSchema = runCommandSchema(legacy.timeoutMs), shell = shellSchema(legacy.timeoutMs);
  for (const timeout_ms of [undefined, null, 1, 120_000]) {
    const run = Schema.decodeUnknownSync(runSchema)({ program: ' program with spaces ', args: ['--option', '', '\n', '🦓; $(exit 9)'], timeout_ms, extra: true });
    expect(run).toEqual({ program: ' program with spaces ', args: ['--option', '', '\n', '🦓; $(exit 9)'], timeout_ms: timeout_ms ?? legacy.timeoutMs });
    expect(Schema.encodeSync(runSchema)(run)).toEqual(run);
    const decodedShell = Schema.decodeUnknownSync(shell)({ command: ' \0🦓\n', timeout_ms });
    expect(decodedShell.command).toBe(' \0🦓\n'); expect(Schema.encodeSync(shell)(decodedShell)).toEqual(decodedShell);
  }
  const decodeStart = Schema.decodeUnknownSync(StartCommandSchema);
  expect(decodeStart({ program: 'cat', args: [] })).toEqual({ program: 'cat', args: [], timeout_ms: 120_000, interactive: false });
  expect(decodeStart({ program: 'cat', args: [], timeout_ms: null, interactive: undefined }).interactive).toBe(false);
  const explicit = decodeStart({ program: 'cat', args: [], timeout_ms: 600_000, interactive: true });
  expect(Schema.encodeSync(StartCommandSchema)(explicit)).toEqual(explicit);
  for (const wait_ms of [undefined, null, 0, 10_000]) {
    const status = Schema.decodeUnknownSync(CommandStatusSchema)({ command_id: ' command-1 ', wait_ms });
    expect(status).toEqual({ command_id: ' command-1 ', wait_ms: wait_ms ?? 0 }); expect(Schema.encodeSync(CommandStatusSchema)(status)).toEqual(status);
  }
  for (const input of [undefined, '', ' \0🦓\n']) {
    const decoded = Schema.decodeUnknownSync(WriteCommandInputSchema)({ command_id: '', input, eof: true, extra: true });
    expect(decoded).toEqual({ command_id: '', input: input ?? '', eof: true }); expect(Schema.encodeSync(WriteCommandInputSchema)(decoded)).toEqual(decoded);
  }
});

test('malformed command arguments fail with safe Schema paths before any command service operation', async () => {
  const { registry, calls } = fakeCommands();
  const cases: [string, unknown, string][] = [
    ['run_command', { program: null, args: [] }, 'program'],
    ...['', '-private', 'secret-program\0'].map(program => ['run_command', { program, args: [] }, 'program'] as [string, unknown, string]),
    ...[undefined, null, 'secret-array', [null], ['secret-argument\0'], new Array(1)].map(args => ['run_command', { program: 'printf', args }, 'args'] as [string, unknown, string]),
    ['shell', { command: { secret: 'secret-command' } }, 'command'],
    ['start_command', { program: 'cat', args: [], interactive: null }, 'interactive'],
    ['start_command', { program: 'cat', args: [], interactive: 'secret-flag' }, 'interactive'],
    ['command_status', { command_id: 42 }, 'command_id'],
    ['stop_command', {}, 'command_id'],
    ['write_command_input', { command_id: 'command-1', input: null, eof: true }, 'input'],
    ['write_command_input', { command_id: 'command-1', input: { secret: 'secret-input' } }, 'input'],
    ['write_command_input', { command_id: 'command-1', input: '', eof: null }, 'eof'],
    ['write_command_input', { command_id: 'command-1' }, 'input'],
  ];
  for (const timeout_ms of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'secret-timeout', 120_001]) {
    cases.push(['run_command', { program: 'printf', args: [], timeout_ms }, 'timeout_ms'], ['shell', { command: '', timeout_ms }, 'timeout_ms']);
  }
  for (const timeout_ms of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'secret-timeout', 600_001]) {
    cases.push(['start_command', { program: 'cat', args: [], timeout_ms }, 'timeout_ms']);
  }
  for (const wait_ms of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'secret-wait', 10_001]) cases.push(['command_status', { command_id: 'command-1', wait_ms }, 'wait_ms']);
  for (const [name, value, field] of cases) {
    const error = await registry.execute(name, value).catch(error => error);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw new Error('Expected validation failure.');
    expect(error.message).toContain(field); expect(error.message).not.toContain('secret-'); expect(error.cause).toBeInstanceOf(Schema.SchemaError);
  }
  for (const name of commandNames) for (const value of [null, [], 'secret-record']) await expect(registry.execute(name, value)).rejects.toBeInstanceOf(ValidationError);
  // A bad configured fallback is subject to the same bound as explicit input.
  const invalidDefault = new ToolRegistry(commandTools(fakeCommands().commands, 120_001), ['read', 'shell']);
  await expect(invalidDefault.execute('run_command', { program: 'printf', args: [] })).rejects.toBeInstanceOf(ValidationError);
  await expect(invalidDefault.execute('shell', { command: '' })).rejects.toBeInstanceOf(ValidationError);
  expect(calls).toEqual([]);
});

test('command input applies the UTF-8 byte limit before writes, accepts exact endpoints and permits EOF-only input', async () => {
  const { registry, calls } = fakeCommands();
  for (const input of ['x'.repeat(65_536), 'é'.repeat(32_768), '🦓'.repeat(16_384), '\ud800'.repeat(21_845) + 'x']) {
    expect(Buffer.byteLength(input, 'utf8')).toBe(65_536);
    expect(await registry.execute('write_command_input', { command_id: 'command-1', input })).toBe('Sent 65536 bytes to command-1.');
    const before = calls.length;
    await expect(registry.execute('write_command_input', { command_id: 'command-1', input: input + 'x', eof: true })).rejects.toThrow('65536');
    expect(calls).toHaveLength(before);
  }
  expect(await registry.execute('write_command_input', { command_id: 'command-1', eof: true })).toBe('Sent 0 bytes to command-1; stdin closed.');
  expect(await registry.execute('write_command_input', { command_id: 'command-1', input: ' ', eof: undefined })).toBe('Sent 1 bytes to command-1.');
  const before = calls.length;
  for (const input of [undefined, '']) await expect(registry.execute('write_command_input', { command_id: 'command-1', input })).rejects.toThrow('Provide input');
  expect(calls).toHaveLength(before);
});

test('command entries require shell access before decoding while disabled and worker tool permissions stay unchanged', async () => {
  const { commands, calls } = fakeCommands();
  const denied = new ToolRegistry(commandTools(commands, legacy.timeoutMs), ['read', 'write']);
  for (const name of commandNames) await expect(denied.execute(name, null)).rejects.toBeInstanceOf(ToolAccessDenied);
  const shellOnly = new ToolRegistry(commandTools(commands, legacy.timeoutMs), ['shell']);
  for (const name of ['command_status', 'list_commands']) await expect(shellOnly.execute(name, null)).rejects.toBeInstanceOf(ToolAccessDenied);
  const disabled = (await fixture()).tools, worker = (await fixture({}, true)).tools;
  for (const name of commandNames) {
    expect(disabled.definitions.some(tool => tool.function.name === name)).toBe(false);
    expect(worker.definitions.some(tool => tool.function.name === name)).toBe(false);
    await expect(disabled.execute(name, {})).rejects.toThrow(`Unknown or disabled tool: ${name}`);
    await expect(worker.execute(name, {})).rejects.toThrow('cannot use');
  }
  expect(calls).toEqual([]);
});

test('registered command reads validate the entire parallel batch before I/O and keep unknown IDs as individual runtime failures', async () => {
  let requests = 0;
  const nested: string[] = [];
  const { tools } = await fixture({ allowShell: true, fetchImpl: (async () => { requests++; return new Response('page'); }) as unknown as typeof fetch });
  for (const args of [{ command_id: null }, { command_id: 'missing', wait_ms: -1 }, { command_id: 'missing', wait_ms: 10_001 }]) {
    await expect(tools.execute('parallel_tools', { calls: [
      { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool: 'command_status', arguments: args },
    ] }, undefined, name => nested.push(name))).rejects.toBeInstanceOf(ValidationError);
  }
  for (const tool of ['run_command', 'shell', 'start_command', 'stop_command', 'write_command_input']) {
    await expect(tools.execute('parallel_tools', { calls: [
      { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool, arguments: {} },
    ] }, undefined, name => nested.push(name))).rejects.toThrow('read-only');
  }
  expect(requests).toBe(0); expect(nested).toEqual([]);
  const result = await tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool: 'command_status', arguments: { command_id: 'missing' } },
    { tool: 'list_commands', arguments: { extra: true } },
  ] }, undefined, name => nested.push(name));
  expect(requests).toBe(1); expect(nested).toEqual(['fetch_url', 'command_status', 'list_commands']);
  expect(result).toContain('[1/3 fetch_url; status: completed]'); expect(result).toContain('[2/3 command_status; status: error]');
  expect(result).toContain('Unknown command_id: missing'); expect(result).toContain('[3/3 list_commands; status: completed]\n[]');
});

test('prepared commands perform no work until invocation and pre-aborted calls leave the service untouched', async () => {
  const { registry, calls, signal } = fakeCommands();
  const invoke = registry.prepare('run_command', { program: 'printf', args: ['%s', 'literal'] });
  expect(calls).toEqual([]);
  const controller = new AbortController(); controller.abort();
  for (const name of commandNames) await expect(registry.execute(name, null, controller.signal)).rejects.toThrow('aborted');
  await expect(invoke(controller.signal)).rejects.toThrow('aborted'); expect(calls).toEqual([]);
  expect(await invoke(signal)).toBe(legacy.output);
  expect(calls).toEqual([{ method: 'run', argv: ['printf', '%s', 'literal'], timeoutMs: legacy.timeoutMs, signal: true }]);
});

test('shell executable selection remains at invocation time with the existing fallback', async () => {
  const { registry, calls } = fakeCommands(), previousShell = process.env.SHELL;
  process.env.SHELL = '/fixture/first-shell';
  try {
    const invoke = registry.prepare('shell', { command: '' });
    process.env.SHELL = '/fixture/second-shell'; await invoke();
    delete process.env.SHELL; await registry.execute('shell', { command: '' });
    expect(calls).toEqual([
      { method: 'run', argv: ['/fixture/second-shell', '-c', ''], timeoutMs: legacy.timeoutMs, signal: false },
      { method: 'run', argv: ['/bin/sh', '-c', ''], timeoutMs: legacy.timeoutMs, signal: false },
    ]);
  } finally { if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell; }
});
