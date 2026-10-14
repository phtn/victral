import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as TestClock from 'effect/testing/TestClock';
import { Memory } from '../src/memory.js';
import { Storage } from '../src/storage.js';
import { ProviderFailure, ProviderOutputLimit } from '../src/providers/core.js';
import { toolPromise } from '../src/tool-effects.js';
import type { Message } from '../src/types.js';

const memories: Memory[] = [], stores: Storage[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(memories.splice(0).map(memory => memory.stop()));
  await Promise.all(stores.splice(0).map(storage => storage.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const response = (text = 'user: summary', finish_reason = 'COMPLETE') => ({ finish_reason, message: { role: 'assistant', content: [{ type: 'text', text }] } });
async function fixture(model: unknown, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-memory-effects-')); directories.push(directory);
  const storage = await Storage.open(directory, () => {}); stores.push(storage);
  const memory = new Memory(storage, model, { report: () => {}, ...options }); memories.push(memory);
  return { memory, storage, directory };
}
const flush = () => Effect.promise(() => Bun.sleep(0));

test('native compactions preserve the full legacy request conversation, shortest selection and saved nodes', async () => {
  const lines = [530, 520, 519, 521, 518];
  const nativeRequests: Message[][] = [], legacyRequests: Message[][] = [];
  const native = await fixture({ chat() { throw new Error('Promise fallback must not run'); }, effects: {
    chat: (messages: Message[]) => Effect.sync(() => { nativeRequests.push(structuredClone(messages)); return response('x'.repeat(lines[nativeRequests.length - 1]!)); }),
  } });
  const legacy = await fixture({ chat: async (messages: Message[]) => { legacyRequests.push(structuredClone(messages)); return response('x'.repeat(lines[legacyRequests.length - 1]!)); } });
  for (const f of [native, legacy]) {
    f.memory.configure('fixed complete system prompt', []); f.memory.append('user', 'z'.repeat(900));
    expect(await Effect.runPromise(f.memory.drainEffect())).toBe(true);
  }
  expect(nativeRequests).toEqual(legacyRequests); expect(nativeRequests).toHaveLength(5);
  expect(native.storage.nodes.get('0:0')).toEqual(legacy.storage.nodes.get('0:0'));
  expect(native.storage.nodes.get('0:0')?.size).toBe(518);
  expect(native.memory.observerFailure).toBeUndefined();
});

test('eight native jobs occupy slots through shutdown cleanup, no late summary commits, restart recovers unfinished nodes', async () => {
  let calls = 0, aborted = 0; const cleanup = deferred();
  const f = await fixture({ chat() { throw new Error('Promise fallback must not run'); }, effects: {
    chat: () => toolPromise(signal => new Promise<ReturnType<typeof response>>((_resolve, reject) => {
      calls++; signal.addEventListener('abort', () => { aborted++; void cleanup.promise.then(() => reject(signal.reason)); }, { once: true });
    })),
  } });
  await Effect.runPromise(f.memory.pumpEffect());
  for (let i = 0; i < 9; i++) f.memory.append('user', `decision ${i} `.repeat(100));
  expect(calls).toBe(8); expect(f.memory.busy.size).toBe(8);
  let closed = false; const ownedClose = f.memory.stop(); const closing = ownedClose.then(() => { closed = true; }); await Bun.sleep(0);
  expect(aborted).toBe(8); expect(closed).toBe(false); expect(f.memory.busy.size).toBe(8); expect(f.storage.nodes.size).toBe(0);
  expect(f.memory.stop()).toBe(ownedClose);
  cleanup.resolve(); await closing; expect(f.memory.busy.size).toBe(0); expect(f.storage.nodes.size).toBe(0); expect(calls).toBe(8);
  await f.storage.close(); const reopened = await Storage.open(f.directory, () => {}); stores.push(reopened);
  const recovered = new Memory(reopened, { chat: async () => response() }, { report: () => {} }); memories.push(recovered);
  expect(await recovered.drain()).toBe(true); expect(reopened.root).toHaveLength(9); expect(reopened.nodes.has('0:0')).toBe(true);
});

test('interrupting a native settle waiter releases listeners without canceling background compaction', async () => {
  const finish = deferred(); let aborted = false;
  const { memory } = await fixture({ chat() { throw new Error('Promise fallback must not run'); }, effects: {
    chat: () => toolPromise(async signal => { signal.addEventListener('abort', () => { aborted = true; }, { once: true }); await finish.promise; return response(); }),
  } });
  memory.append('user', 'source '.repeat(100));
  const waiter = Effect.runFork(memory.settleEffect()); await Bun.sleep(0); expect(memory.listenerCount('change')).toBe(1);
  await Effect.runPromise(Fiber.interrupt(waiter)); expect(memory.listenerCount('change')).toBe(0);
  expect(aborted).toBe(false); expect(memory.busy.size).toBe(1);
  finish.resolve(); expect(await memory.drain()).toBe(true); expect(aborted).toBe(false);
});

test('failed native compactions wait for new input, with no background retry timer on the borrowed Clock', async () => {
  let calls = 0;
  const { memory } = await fixture({ chat() { throw new Error('Promise fallback must not run'); }, effects: {
    chat: () => Effect.suspend(() => ++calls === 1
      ? Effect.fail(new ProviderFailure({ provider: 'fake', reason: 'http', status: 503, message: 'fake transient error', cause: undefined }))
      : Effect.succeed(response())),
  } });
  await Effect.runPromise(Effect.gen(function*() {
    yield* memory.pumpEffect(); memory.append('user', 'source '.repeat(100));
    expect(yield* memory.drainEffect()).toBe(false); expect(calls).toBe(1);
    yield* TestClock.adjust(360_000); yield* flush(); expect(calls).toBe(1);
    memory.append('user', 'new input'); expect(yield* memory.drainEffect()).toBe(true); expect(calls).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())));
  expect(memory.failures.size).toBe(0);
});

test('observer failures cannot gate compaction or prevent other observers receiving an immutable node', async () => {
  const { memory, storage } = await fixture({ chat: async () => response() });
  let notifications = 0;
  memory.on('node', () => { throw new Error('audit failure'); });
  memory.once('node', async () => { throw new Error('metrics failure'); });
  memory.on('node', () => { notifications++; });
  memory.append('user', 'source '.repeat(100)); expect(await memory.drain()).toBe(true); await Bun.sleep(0);
  expect(notifications).toBe(1); expect(memory.observerFailure).toBeDefined(); expect(memory.failures.size).toBe(0);
  expect(storage.nodes.get('0:0')?.text).toBe('user: summary'); expect(() => storage.saveNode(0, 0, 'rewrite')).toThrow('Cannot replace');
});

test('native output limits retain the legacy incomplete diagnostic without saving partial text', async () => {
  const reports: string[] = [];
  const { memory, storage } = await fixture({ effects: { chat: () => Effect.fail(new ProviderOutputLimit({ provider: 'fake', result: response('partial', 'MAX_TOKENS') })) } }, { report: (text: string) => reports.push(text) });
  memory.append('user', 'source '.repeat(100)); expect(await memory.drain()).toBe(false);
  expect(reports[0]).toContain('Incomplete compactor response: MAX_TOKENS'); expect(storage.nodes.size).toBe(0);
});

test('canceling native compaction preserves additional cleanup defects privately', async () => {
  const { memory, storage } = await fixture({ effects: { chat: () => toolPromise(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private cleanup defect')), { once: true });
  })) } });
  memory.append('user', 'source '.repeat(100)); await memory.stop();
  expect(storage.nodes.size).toBe(0); expect(memory.supervisor.lastFailure).toBeDefined();
  expect(Cause.hasDies(memory.supervisor.lastFailure!)).toBe(true); expect(memory.failures.size).toBe(0);
});

test('a failed durable node write remains unpublished and retries only after new input', async () => {
  const { memory, storage } = await fixture({ chat: async () => response() });
  const save = spyOn(storage, 'saveNode').mockImplementation(() => { throw new Error('durable write failed'); });
  try {
    memory.append('user', 'source '.repeat(100)); expect(await memory.drain()).toBe(false);
    expect(storage.nodes.size).toBe(0); expect(memory.remaining).toBe(1); expect(memory.failures.has('0:0')).toBe(true);
  } finally { save.mockRestore(); }
  memory.append('user', 'new input'); expect(await memory.drain()).toBe(true); expect(memory.remaining).toBe(0);
});
