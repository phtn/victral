import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { Session, type SessionOptions } from '../src/session.js';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { Evaluations } from '../src/evaluations.js';
import { Metrics } from '../src/metrics.js';
import { Integrations } from '../src/integrations.js';
import { Subagents } from '../src/subagents.js';
import { CommandTools } from '../src/command-tools.js';
import { Runner } from '../src/runner.js';
import { Meta } from '../src/meta.js';
import { SessionSettings, SessionStorage } from '../src/core/session-services.js';
import { EffectAdapterError } from '../src/core/async.js';
import { IOError } from '../src/core/errors.js';
import { AudioNotifications } from '../src/sfx/notifications.js';
import { NativeSoundPlayer } from '../src/sfx/player.js';

const directories: string[] = [], sessions: Session[] = [];
const previousKey = process.env.META_API_KEY;
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  mock.restore();
  if (previousKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = previousKey;
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function options(): Promise<SessionOptions> {
  process.env.META_API_KEY = 'offline-runtime-fixture';
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'victral-runtime-'))); directories.push(directory);
  return { project: directory, chatDir: path.join(directory, 'chat'), model: 'muse-spark-1.3', compactorModel: 'muse-spark-1.3', allowShell: false, jev: false, metrics: true };
}
type Resource = 'commands' | 'integrations' | 'workers' | 'runner' | 'memory' | 'evaluations' | 'metrics' | 'storage';
function cleanup(failures: Partial<Record<Resource, Error>> = {}) {
  const events: Resource[] = [], memories: Memory[] = [], evaluations: Evaluations[] = [];
  const commandClose = CommandTools.prototype.close, integrationClose = Integrations.prototype.close, workerClose = Subagents.prototype.close;
  const runnerClose = Runner.prototype.close, memoryStop = Memory.prototype.stop, evaluationClose = Evaluations.prototype.close;
  const metricsClose = Metrics.prototype.close, storageClose = Storage.prototype.close;
  const done = (name: Resource) => { events.push(name); if (failures[name]) throw failures[name]; };
  const spies = {
    commands: spyOn(CommandTools.prototype, 'close').mockImplementation(async function(this: CommandTools) { await commandClose.call(this); done('commands'); }),
    integrations: spyOn(Integrations.prototype, 'close').mockImplementation(async function(this: Integrations) { await integrationClose.call(this); done('integrations'); }),
    workers: spyOn(Subagents.prototype, 'close').mockImplementation(async function(this: Subagents) { await workerClose.call(this); done('workers'); }),
    runner: spyOn(Runner.prototype, 'close').mockImplementation(async function(this: Runner) { try { await runnerClose.call(this); } finally { done('runner'); } }),
    memory: spyOn(Memory.prototype, 'stop').mockImplementation(async function(this: Memory) { memories.push(this); await memoryStop.call(this); done('memory'); }),
    evaluations: spyOn(Evaluations.prototype, 'close').mockImplementation(async function(this: Evaluations) { evaluations.push(this); await evaluationClose.call(this); done('evaluations'); }),
    metrics: spyOn(Metrics.prototype, 'close').mockImplementation(function(this: Metrics) { metricsClose.call(this); done('metrics'); }),
    storage: spyOn(Storage.prototype, 'close').mockImplementation(async function(this: Storage) { await storageClose.call(this); done('storage'); }),
  };
  return { events, spies, memories, evaluations };
}
async function reopen(directory: string) { const storage = await Storage.open(directory); await storage.close(); }

test('one session runtime shares settings/storage across completed turns and synchronous model switches', async () => {
  const configured = await options(), runtimeSpy = spyOn(ManagedRuntime, 'make'), openSpy = spyOn(Storage, 'open');
  const playSpy = spyOn(NativeSoundPlayer.prototype, 'play'), audioCloseSpy = spyOn(NativeSoundPlayer.prototype, 'close');
  const releases = cleanup();
  spyOn(Meta.prototype, 'stream').mockImplementation(async () => ({
    message: { role: 'assistant', content: 'Answer 🦓', _metaContent: [] }, finish_reason: 'COMPLETE', usage: {},
  }));
  const session = await Session.open(configured); sessions.push(session);
  expect(runtimeSpy).toHaveBeenCalledTimes(1); expect(openSpy).toHaveBeenCalledTimes(1);
  const runtime = runtimeSpy.mock.results[0]!.value;
  expect(ManagedRuntime.isManagedRuntime(runtime)).toBe(true);
  if (!ManagedRuntime.isManagedRuntime(runtime)) throw new Error('Expected the session runtime.');
  expect(await runtime.runPromise(SessionSettings)).toBe(configured);
  expect(await runtime.runPromise(SessionStorage)).toBe(session.storage);
  const audio = await runtime.runPromise(AudioNotifications);
  expect(await runtime.runPromise(audio.play('success'))).toEqual({ status: 'skipped', reason: 'silent' });
  await session.submit('First turn'); await session.submit('/model ms1.3c'); await session.submit('Second turn');
  expect(session.snapshot().model).toBe('muse-spark-1.3-contributor'); expect(session.options.compactorModel).toBe('muse-spark-1.3');
  expect(runtimeSpy).toHaveBeenCalledTimes(1); expect(openSpy).toHaveBeenCalledTimes(1); expect(releases.events).toEqual([]);
  let closed = 0; session.on('closed', () => { closed++; });
  const closing = session.close(); expect(session.close()).toBe(closing); await closing; await session.close();
  expect(closed).toBe(1); expect(releases.events.slice(-5)).toEqual(['runner', 'memory', 'evaluations', 'metrics', 'storage']);
  for (const spy of Object.values(releases.spies)) expect(spy).toHaveBeenCalledTimes(1);
  expect(session.memory.listenerCount('node')).toBe(0); expect(session.evaluations.listenerCount('update')).toBe(0);
  const disposed = await runtime.runPromiseExit(Effect.void); expect(Exit.isFailure(disposed)).toBe(true);
  expect(playSpy).not.toHaveBeenCalled(); expect(audioCloseSpy).not.toHaveBeenCalled();
  await reopen(configured.chatDir);
});

const startupCases = [
  { name: 'instructions', acquired: [] },
  { name: 'compactor', acquired: ['integrations'] },
  { name: 'memory', acquired: ['integrations', 'storage'] },
  { name: 'evaluations', acquired: ['integrations', 'memory', 'storage'] },
  { name: 'metrics', acquired: ['integrations', 'memory', 'evaluations', 'storage'] },
  { name: 'plans', acquired: ['integrations', 'workers', 'memory', 'evaluations', 'metrics', 'storage'] },
  { name: 'runner', acquired: ['commands', 'integrations', 'workers', 'memory', 'evaluations', 'metrics', 'storage'] },
  { name: 'pump', acquired: ['commands', 'integrations', 'workers', 'runner', 'memory', 'evaluations', 'metrics', 'storage'] },
] as const;
for (const scenario of startupCases) test(`startup failure at ${scenario.name} closes each acquired owner exactly once and releases the lock`, async () => {
  const configured = await options(), releases = cleanup(), failure = new Error(`Fixture ${scenario.name} failure.`);
  const load = Storage.prototype.load;
  if (scenario.name === 'instructions') configured.instructions = path.join(configured.project, 'missing');
  else if (scenario.name === 'compactor') configured.compactorModel = 'unsupported-fixture';
  else if (scenario.name === 'memory') spyOn(Storage.prototype, 'loadView').mockImplementation(() => { throw failure; });
  else if (['evaluations', 'metrics', 'plans'].includes(scenario.name)) spyOn(Storage.prototype, 'load').mockImplementation(function(this: Storage, stream) {
    if (stream === scenario.name) throw failure; return load.call(this, stream);
  });
  else if (scenario.name === 'runner') spyOn(Memory.prototype, 'configure').mockImplementation(() => { throw failure; });
  else spyOn(Memory.prototype, 'pump').mockImplementation(() => { throw failure; });
  const error: unknown = await Session.open(configured).catch(error => error);
  if (scenario.name === 'instructions') expect(error instanceof Error && error.message).toBe('The instructions file does not exist.');
  else if (scenario.name === 'compactor') expect(error instanceof Error && error.message).toContain('Unsupported model: unsupported-fixture.');
  else expect(error).toBe(failure);
  for (const [name, spy] of Object.entries(releases.spies)) {
    expect(spy.mock.calls.length).toBe(scenario.acquired.some(resource => resource === name) ? 1 : 0);
  }
  for (const memory of releases.memories) expect(memory.listenerCount('node')).toBe(0);
  for (const evaluations of releases.evaluations) expect(evaluations.listenerCount('update')).toBe(0);
  mock.restore(); await reopen(configured.chatDir);
});

test('failed startup retains its original cause and every cleanup failure while still releasing storage', async () => {
  const configured = await options(), original = new Error('private-startup-detail');
  const memoryFailure = new Error('private-memory-cleanup'), metricsFailure = new Error('private-metrics-cleanup');
  const releases = cleanup({ memory: memoryFailure, metrics: metricsFailure });
  spyOn(Memory.prototype, 'pump').mockImplementation(() => { throw original; });
  const error: unknown = await Session.open(configured).catch(error => error);
  expect(error).toBeInstanceOf(EffectAdapterError);
  if (!(error instanceof EffectAdapterError)) throw new Error('Expected combined runtime cause.');
  expect(error.message).toBe('Session startup failed.'); expect(error.message).not.toContain('private-');
  const cause = error.cause;
  expect(Cause.isCause(cause)).toBe(true);
  if (!Cause.isCause(cause)) throw new Error('Expected Effect cause.');
  expect(cause.reasons.find(Cause.isFailReason)?.error).toBe(original);
  const defects = cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect);
  expect(defects).toHaveLength(2);
  expect(defects.every(defect => defect instanceof IOError)).toBe(true);
  expect(defects.filter(defect => defect instanceof IOError).map(defect => defect.cause)).toEqual([memoryFailure, metricsFailure]);
  expect(releases.events.slice(-4)).toEqual(['memory', 'evaluations', 'metrics', 'storage']);
  expect(releases.spies.storage).toHaveBeenCalledTimes(1);
  mock.restore(); await reopen(configured.chatDir);
});

test('shutdown waits for all tool cleanup, retains simultaneous failures, and closes the remaining scopes', async () => {
  const configured = await options(), integrationFailure = new Error('private-integration-cleanup'), workerFailure = new Error('private-worker-cleanup');
  const workerClose = Subagents.prototype.close;
  const releases = cleanup({ integrations: integrationFailure, workers: workerFailure });
  let releaseWorker!: () => void, workerStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseWorker = resolve; });
  const started = new Promise<void>(resolve => { workerStarted = resolve; });
  spyOn(Subagents.prototype, 'close').mockImplementation(async function(this: Subagents) {
    workerStarted(); await gate; await workerClose.call(this); releases.events.push('workers'); throw workerFailure;
  });
  const session = await Session.open(configured); sessions.push(session);
  let closed = 0; session.on('closed', () => { closed++; });
  const closing = session.close(); expect(session.close()).toBe(closing);
  const result = closing.catch(error => error);
  try {
    await started; await new Promise(resolve => setTimeout(resolve, 0));
    expect(releases.spies.integrations).toHaveBeenCalledTimes(1);
    expect(releases.spies.memory).toHaveBeenCalledTimes(0); expect(releases.spies.storage).toHaveBeenCalledTimes(0);
  } finally { releaseWorker(); }
  const error: unknown = await result;
  expect(error).toBeInstanceOf(EffectAdapterError);
  if (!(error instanceof EffectAdapterError) || !Cause.isCause(error.cause)) throw new Error('Expected cleanup cause.');
  expect(error.message).toBe('Session cleanup failed.'); expect(error.message).not.toContain('private-');
  const defect = error.cause.reasons.find(Cause.isDieReason)?.defect;
  expect(defect).toBeInstanceOf(IOError);
  if (!(defect instanceof IOError) || !(defect.cause instanceof AggregateError)) throw new Error('Expected all tool cleanup failures.');
  expect(defect.cause.errors).toEqual([integrationFailure, workerFailure]);
  expect(releases.events.indexOf('memory')).toBeGreaterThan(releases.events.indexOf('integrations'));
  expect(releases.events.indexOf('memory')).toBeGreaterThan(releases.events.indexOf('workers'));
  expect(releases.events.slice(-4)).toEqual(['memory', 'evaluations', 'metrics', 'storage']);
  expect(closed).toBe(1); expect(session.close()).toBe(closing);
  for (const spy of Object.values(releases.spies)) expect(spy).toHaveBeenCalledTimes(1);
  mock.restore(); await reopen(configured.chatDir);
});

test('runner cleanup preserves a failed drain together with tool cleanup failure', async () => {
  const original = new Error('Fixture drain failed.'), cleanup = new Error('Fixture tools failed.');
  let closed = 0;
  const runner = new Runner({ append() {}, settle: async () => true, render: () => '', zoom: () => '', date: () => '' },
    { model: 'fixture', stream: async () => { throw new Error('Must not request a model.'); } },
    { definitions: [], execute: async () => '', close: async () => { closed++; throw cleanup; } });
  runner.running = Promise.reject(original);
  const error: unknown = await runner.close().catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected combined cleanup error.');
  expect(error.errors).toEqual([original, cleanup]); expect(closed).toBe(1);
});

test('completed turns retain background commands until session scope closes', async () => {
  const configured = { ...await options(), allowShell: true }, releases = cleanup();
  let calls = 0;
  spyOn(Meta.prototype, 'stream').mockImplementation(async () => ++calls === 1 ? {
    message: { role: 'assistant', content: [], _metaContent: [], tool_calls: [{ id: 'start', function: { name: 'start_command', arguments: JSON.stringify({ program: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }) } }] }, finish_reason: 'TOOL_CALL', usage: {},
  } : { message: { role: 'assistant', content: 'Started.', _metaContent: [] }, finish_reason: 'COMPLETE', usage: {} });
  const session = await Session.open(configured); sessions.push(session);
  await session.submit('Start the background job.'); await session.submit('Another completed turn.'); await session.submit('/jobs');
  expect(session.snapshot().entries.at(-1)?.text).toContain('running'); expect(releases.events).toEqual([]);
  await session.close(); expect(releases.spies.commands).toHaveBeenCalledTimes(1); expect(releases.spies.storage).toHaveBeenCalledTimes(1);
  await reopen(configured.chatDir);
});
