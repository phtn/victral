import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Schema from 'effect/Schema';
import { CommandTools, readCommandOutput } from '../src/command-tools.js';
import { LegacyPorts } from '../src/core/legacy-ports.js';
import { ToolExecutionError, ValidationError } from '../src/core/errors.js';
import { parallelTools } from '../src/parallel-tools.js';
import { toolPromise } from '../src/tool-effects.js';
import { schemaTool, ToolRegistry } from '../src/tool-registry.js';
import { projectTools, readOnlyProjectTools } from '../src/tools.js';
import type { AgentTools } from '../src/types.js';

const directories: string[] = [], owners: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  await Promise.all(directories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-tool-effects-')); directories.push(root); return root;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Native cleanup did not finish.'); await Bun.sleep(5); }
}
const memory = { zoom: () => '', date: () => '' };

test('native batch interruption aborts every operation and awaits asynchronous cleanup', async () => {
  const controller = new AbortController(), cleanup = deferred(), started = deferred();
  let calls = 0, aborted = 0, drained = 0, finished = false;
  const entry = schemaTool({ name: 'get_plan', schema: Schema.Struct({}), capabilities: ['read'],
    execute: () => 'unused',
    executeEffect: () => toolPromise(signal => new Promise<string>((_resolve, reject) => {
      if (++calls === 2) started.resolve();
      signal.addEventListener('abort', () => {
        aborted++;
        void cleanup.promise.then(() => { drained++; reject(signal.reason); });
      }, { once: true });
    })),
  });
  const registry: ToolRegistry = new ToolRegistry([entry, parallelTools((name, args) => registry.prepare(name, args))], ['read']);
  const pending = Effect.runPromiseExit(registry.executeEffect('parallel_tools', { calls: [0, 1].map(() => ({ tool: 'get_plan', arguments: {} })) }), { signal: controller.signal })
    .then(exit => { finished = true; return exit; });
  await started.promise; controller.abort(); await until(() => aborted === 2);
  expect(finished).toBe(false); cleanup.resolve();
  const exit = await pending;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(drained).toBe(2);
});

test('tool cleanup failure during interruption is retained alongside cancellation', async () => {
  const controller = new AbortController(), started = deferred(), cleanupFailure = new Error('rollback failed');
  const pending = Effect.runPromiseExit(toolPromise(signal => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(cleanupFailure), { once: true }); started.resolve();
  })), { signal: controller.signal });
  await started.promise; controller.abort(); const exit = await pending;
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true); expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(exit.cause.reasons.some(reason => Cause.isDieReason(reason) && reason.defect === cleanupFailure)).toBe(true);
  }
});

test('native registry validates the whole batch before I/O and preserves independent domain errors', async () => {
  let calls = 0;
  const entry = schemaTool({ name: 'get_plan', schema: Schema.Struct({ value: Schema.String }), capabilities: ['read'],
    execute: args => { calls++; if (args.value === 'fail') throw new Error('Missing plan.'); return args.value; } });
  const registry: ToolRegistry = new ToolRegistry([entry, parallelTools((name, args) => registry.prepare(name, args))], ['read']);
  const invalid = await Effect.runPromiseExit(registry.executeEffect('parallel_tools', { calls: [
    { tool: 'get_plan', arguments: { value: 'first' } }, { tool: 'get_plan', arguments: { value: null } },
  ] }));
  expect(calls).toBe(0); expect(Exit.isFailure(invalid) && Cause.squash(invalid.cause) instanceof ValidationError).toBe(true);
  expect(await Effect.runPromise(registry.executeEffect('parallel_tools', { calls: [
    { tool: 'get_plan', arguments: { value: 'first' } }, { tool: 'get_plan', arguments: { value: 'fail' } },
  ] }))).toBe('[1/2 get_plan; status: completed]\nfirst\n\n[2/2 get_plan; status: error]\nMissing plan.');
});

test('an output read failure interrupts and releases the other output pipe', async () => {
  let failed!: ReadableStreamDefaultController<Uint8Array>, canceled = false, killed = 0;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { failed = controller; } });
  const stderr = new ReadableStream<Uint8Array>({ async cancel() { await Bun.sleep(5); canceled = true; } });
  const pending = Effect.runPromiseExit(Effect.all([
    readCommandOutput(stdout, () => {}, () => killed++), readCommandOutput(stderr, () => {}, () => killed++),
  ], { concurrency: 2 }));
  await until(() => stdout.locked && stderr.locked); failed.error(new Error('read failed'));
  expect(Exit.isFailure(await pending)).toBe(true);
  expect(killed).toBeGreaterThan(0); expect(canceled).toBe(true);
  expect(stdout.locked).toBe(false); expect(stderr.locked).toBe(false);
});

test('output-reader cancellation defects survive native interruption and the lock is released', async () => {
  const cleanupFailure = new Error('pipe cleanup failed'), controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { throw cleanupFailure; } });
  const pending = Effect.runPromiseExit(readCommandOutput(stream, () => {}, () => {}), { signal: controller.signal });
  await until(() => stream.locked); controller.abort(); const exit = await pending;
  expect(stream.locked).toBe(false);
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && Cause.hasDies(exit.cause)).toBe(true);
});

async function nativeTree(commands: CommandTools, root: string, interrupt: boolean) {
  const marker = path.join(root, 'pids.json'), controller = new AbortController();
  const script = `const child = Bun.spawn(['sleep', '30'], { stdout: 'inherit', stderr: 'inherit' });
    await Bun.write(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`;
  const pending = Effect.runPromiseExit(commands.runEffect([process.execPath, '-e', script], 30_000), { signal: controller.signal });
  await until(() => fs.stat(marker).then(() => true, () => false));
  const pids: number[] = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (interrupt) controller.abort(); else { const close = commands.close(); expect(commands.close()).toBe(close); await close; }
  const exit = await pending;
  if (interrupt) expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  else expect(Exit.isSuccess(exit) && exit.value.includes('SIGKILL')).toBe(true);
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
}

test('native foreground interruption kills descendants that inherit output pipes', async () => {
  const root = await directory(), commands = new CommandTools(root); owners.push(commands);
  await nativeTree(commands, root, true);
});

test('closing a command session drains foreground processes and descendants', async () => {
  const root = await directory(), commands = new CommandTools(root); owners.push(commands);
  await nativeTree(commands, root, false);
  await expect(commands.run(['echo', 'late'], 1000)).rejects.toThrow('closed');
});

test('native background commands survive invocation completion and retain originating-turn cancellation', async () => {
  const tools = projectTools(memory, await directory(), { allowShell: true }); owners.push({ close: () => tools.close!() });
  const origin = new AbortController();
  const output = await Effect.runPromise(tools.executeEffect!('start_command', { program: 'sleep', args: ['30'] }, undefined, origin.signal));
  const id = /command_id: (command-\d+)/.exec(output)![1]!;
  expect(await Effect.runPromise(tools.executeEffect!('command_status', { command_id: id }))).toContain('status: running');
  origin.abort();
  expect(await Effect.runPromise(tools.executeEffect!('command_status', { command_id: id, wait_ms: 1000 }))).toContain('status: completed');
});

test('native worker execution enforces write restrictions before I/O', async () => {
  const root = await directory(), tools = readOnlyProjectTools(memory, root); owners.push({ close: () => tools.close!() });
  const exit = await Effect.runPromiseExit(tools.executeEffect!('write_file', { path: 'forbidden', content: 'data' }));
  expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause)).includes('cannot use')).toBe(true);
  expect(await fs.readdir(root)).toEqual([]);
});

test('the borrowed tool service prefers native execution and retains typed failures', async () => {
  let native = 0, legacy = 0;
  const tools: AgentTools = { definitions: [], async execute() { legacy++; return 'legacy'; },
    executeEffect() { native++; return Effect.fail(new Error('private execution detail')); } };
  const model = { model: 'fake', async stream() { return { message: { role: 'assistant', content: '' } }; } };
  const exit = await Effect.runPromiseExit(Effect.gen(function*() {
    const ports = yield* LegacyPorts; return yield* ports.tools.execute('read_file', {});
  }).pipe(Effect.provide(LegacyPorts.layer(model, tools))));
  expect(native).toBe(1); expect(legacy).toBe(0);
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ToolExecutionError).toBe(true);
});


test('native blocked-write interruption returns only after process and stdin cleanup', async () => {
  const tools = projectTools(memory, await directory(), { allowShell: true }); owners.push({ close: () => tools.close!() });
  const output = await Effect.runPromise(tools.executeEffect!('start_command', { program: 'sleep', args: ['30'], interactive: true }));
  const id = /command_id: (command-\d+)/.exec(output)![1]!, controller = new AbortController();
  const pending = Effect.runPromiseExit(Effect.gen(function*() {
    for (let i = 0; i < 32; i++) yield* tools.executeEffect!('write_command_input', { command_id: id, input: 'x'.repeat(65536) });
  }), { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 40);
  let exit;
  try { exit = await pending; } finally { clearTimeout(timer); }
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  const status = await Effect.runPromise(tools.executeEffect!('command_status', { command_id: id }));
  expect(status).toContain('status: completed'); expect(status).toContain('stopped: true');
});

test('compound batch failures retain execution and cleanup reasons', async () => {
  const failure = new Error('execution failed'), defect = new Error('cleanup failed');
  const entry = schemaTool({ name: 'get_plan', schema: Schema.Struct({}), capabilities: ['read'], execute: () => '',
    executeEffect: () => Effect.failCause(Cause.combine(Cause.fail(failure), Cause.die(defect))) });
  const registry: ToolRegistry = new ToolRegistry([entry, parallelTools((name, args) => registry.prepare(name, args))], ['read']);
  const exit = await Effect.runPromiseExit(registry.executeEffect('parallel_tools', { calls: [{ tool: 'get_plan', arguments: {} }] }));
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause) && Cause.hasDies(exit.cause)).toBe(true);
  if (Exit.isFailure(exit)) expect(exit.cause.reasons).toHaveLength(2);
});
