import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as Effect from 'effect/Effect';
import * as TestClock from 'effect/testing/TestClock';
import { Evaluations, type EvaluationOptions, type EvaluationRecord } from '../src/evaluations.js';
import { auditSummary, validateAuditResult } from '../src/jev.js';
import type { WorkflowEvent } from '../src/workflow-events.js';

const owners: Evaluations[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
const result = () => ({ model: 'jev-test', answers: {
  unsupported_claim: { type: 'noul' as const, noul: 0 }, user_decision_omitted: { type: 'noul' as const, noul: 1 }, progress_inflated: { type: 'noul' as const, noul: 0.75 },
}, usage: { input_tokens: 7 }, extension: { retained: true } });
function fixture(count = 1, options: EvaluationOptions = {}) {
  const records: EvaluationRecord[] = Array.from({ length: count }, (_, i) => ({ key: `0:${i}`, l: 0, i, status: 'queued', context_parts: [] }));
  const writes: unknown[] = [], events: WorkflowEvent[] = [];
  const memory = Object.assign(new EventEmitter(), { node: () => ({ text: 'summary' }), storage: {
    root: records.map(() => ({ kind: 'user', text: 'source' })), load: () => records,
    telemetry: (_stream: string, record: unknown) => writes.push(record),
  } });
  const owner = new Evaluations(memory, { apiKey: 'secret', audit: async () => result(), onWorkflow: e => events.push(e), ...options });
  owners.push(owner); return { owner, memory, writes, events };
}
const flush = () => Effect.promise(() => Bun.sleep(0));

test.each([429, 503, 529])('HTTP %i retries exactly at 1000 and 3000 milliseconds with a borrowed TestClock', async status => {
  let calls = 0;
  const { owner, events } = fixture(1, { audit: async () => { calls++; if (calls <= 2) throw new Error(`TypeSafe HTTP ${status}: busy`); return result(); } });
  await Effect.runPromise(Effect.gen(function*() {
    yield* owner.pumpEffect(); yield* flush(); expect(calls).toBe(1);
    yield* TestClock.adjust(999); expect(calls).toBe(1);
    yield* TestClock.adjust(1); yield* flush(); expect(calls).toBe(2);
    yield* TestClock.adjust(1999); expect(calls).toBe(2);
    yield* TestClock.adjust(1); yield* flush(); expect(calls).toBe(3);
    expect(yield* Effect.promise(() => owner.drain())).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())));
  expect(owner.latest.get('0:0')?.retries).toBe(2);
  expect(events.map(e => e.status)).toEqual(['processing', 'retry', 'retry', 'completed']);
  expect(new Set(events.map(e => e.operationId)).size).toBe(1);
  expect(JSON.stringify(events)).not.toContain('secret');
});

test.each([401, 408, 500, 502, 504])('HTTP %i remains a single visible failure with redacted diagnostics', async status => {
  let calls = 0;
  const { owner, events } = fixture(1, { audit: async () => { calls++; throw new Error(`TypeSafe HTTP ${status}: secret`); } });
  await owner.drain(); expect(calls).toBe(1); expect(owner.latest.get('0:0')?.error).toContain('[redacted]');
  expect(events.map(e => e.status)).toEqual(['processing', 'failed']);
});

test('two supervised consumers hold slots until native cancellation cleanup finishes and leave all jobs recoverable', async () => {
  let calls = 0, finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  const { owner } = fixture(4, { audit: async (_source, _summary, { signal }) => {
    calls++; await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup; signal!.throwIfAborted(); return result();
  } });
  owner.pump(); await Bun.sleep(0); expect(calls).toBe(2); expect(owner.active.size).toBe(2); expect(owner.queue).toHaveLength(2);
  const waiter = new AbortController(); const drain = owner.drain(waiter.signal); waiter.abort(); expect(await drain).toBe(false);
  expect(calls).toBe(2); expect(owner.active.size).toBe(2);
  let closed = false; const closing = owner.close().then(() => { closed = true; }); await Bun.sleep(0);
  expect(closed).toBe(false); expect(owner.active.size).toBe(2); finish(); await closing;
  expect(closed).toBe(true); expect(calls).toBe(2); expect([...owner.latest.values()].every(r => r.status === 'queued')).toBe(true);
});

test('closing during a retry delay prevents further calls and persists the pending job', async () => {
  let calls = 0;
  const { owner } = fixture(1, { audit: async () => { calls++; throw new Error('TypeSafe HTTP 503: busy'); } });
  await Effect.runPromise(Effect.gen(function*() {
    yield* owner.pumpEffect(); yield* flush(); expect(calls).toBe(1);
    yield* Effect.promise(() => owner.close()); yield* TestClock.adjust(10_000); expect(calls).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())));
  expect(owner.latest.get('0:0')?.status).toBe('queued');
});

test('per-attempt deadline uses the Effect Clock and waits for cancellation', async () => {
  let calls = 0, aborted = false;
  const { owner } = fixture(1, { audit: async (_source, _summary, { signal }) => {
    calls++; return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true }));
  } });
  await Effect.runPromise(Effect.gen(function*() {
    yield* owner.pumpEffect(); yield* flush(); yield* TestClock.adjust(59_999); expect(aborted).toBe(false);
    yield* TestClock.adjust(1); yield* flush(); expect(aborted).toBe(true);
    yield* Effect.promise(() => owner.drain());
  }).pipe(Effect.provide(TestClock.layer())));
  expect(calls).toBe(1); expect(owner.latest.get('0:0')?.status).toBe('error');
  expect(owner.latest.get('0:0')?.error).toContain('timed out');
});

test.each([NaN, Infinity, -0.1, 1.1, '0.5', null])('probability %p is rejected independently of the other judgments', probability => {
  const response = result(); response.answers.progress_inflated.noul = probability as number;
  expect(() => validateAuditResult(response)).toThrow('Invalid Jev answer');
});
test('valid independent probabilities and native extensions retain their original values', () => {
  const response = result(); expect(validateAuditResult(response)).toBe(response);
});
test('Jev HTTP failures redact the key and release the reader before returning', async () => {
  let body: ReadableStream<Uint8Array> | undefined;
  await expect(auditSummary('source', 'summary', { apiKey: 'secret', fetchImpl: Object.assign(async () => {
    body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('secret')); controller.close(); } });
    return new Response(body, { status: 503 });
  }, { preconnect: fetch.preconnect }) })).rejects.toThrow('TypeSafe HTTP 503: [redacted]');
  expect(body?.locked).toBe(false);
});

test('shutdown retains cleanup diagnostics privately while the canceled job remains recoverable', async () => {
  const { owner } = fixture(1, { audit: async (_source, _summary, { signal }) => {
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('private native cleanup failure');
  } });
  owner.pump(); await Bun.sleep(0); await owner.close();
  expect(owner.latest.get('0:0')?.status).toBe('queued');
  expect(owner.latest.get('0:0')?.error).toBeUndefined(); expect(owner.lastFailure).toBeDefined();
});
