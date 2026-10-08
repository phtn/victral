import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { Evaluations } from '../src/evaluations.js';
import { Metrics, usageTotals } from '../src/metrics.js';
import { createModel } from '../src/models.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const result = () => ({ model: 'jev-test', answers: Object.fromEntries(['unsupported_claim', 'user_decision_omitted', 'progress_inflated'].map(name => [name, { type: 'noul', noul: 0.25 }])), usage: { input_tokens: 100, output_tokens: 3 } });
const summaryModel = { chat: async () => ({ finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'user: keep code ZEBRA-7319; release planned' }] } }) };
async function setup(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-eval-test-'));
  const storage = await Storage.open(directory, () => {});
  const memory = new Memory(storage, summaryModel);
  const evaluations = new Evaluations(memory, { apiKey: 'test-key', audit: async () => result(), ...options });
  cleanups.push(async () => { await memory.stop(); await evaluations.close(); await storage.close(); });
  return { directory, storage, memory, evaluations };
}
test('new chat evaluates generated summaries automatically and records metrics outside the chat log', async () => {
  let sourceSeen;
  const { storage, memory, evaluations } = await setup({ audit: async (source, summary, options) => {
    sourceSeen = source;
    expect(options.context).toBe('<chat>\n\n</chat>');
    expect(summary).toContain('ZEBRA-7319');
    return result();
  } });
  const metrics = new Metrics(storage, memory, evaluations); cleanups.push(() => metrics.close());
  const input = 'Keep code ZEBRA-7319. '.repeat(40);
  memory.append('user', input);
  await memory.drain(AbortSignal.timeout(3000));
  await evaluations.drain(AbortSignal.timeout(3000));
  expect(sourceSeen).toBe('user: ' + input);
  expect(storage.root).toHaveLength(1);
  expect(storage.root[0].text).toBe(input);
  expect(evaluations.latest.get('0:0').status).toBe('completed');
  expect(metrics.snapshot().jev.completed).toBe(1);
  expect(metrics.snapshot().generated).toBe(1);
  expect(metrics.compact()).toContain('unsupported 25.0%');
});
test('exact-copy nodes need no Jev call; evaluation errors never block summarization', async () => {
  let calls = 0;
  const { memory, evaluations } = await setup({ audit: async () => { calls++; throw new Error('TypeSafe HTTP 401: invalid credentials'); } });
  memory.append('user', 'short instruction');
  await memory.drain(AbortSignal.timeout(3000));
  expect(calls).toBe(0);
  memory.append('user', 'large instruction '.repeat(50));
  await memory.drain(AbortSignal.timeout(3000));
  await evaluations.drain(AbortSignal.timeout(3000));
  expect(calls).toBe(1);
  expect(evaluations.latest.get('0:1').status).toBe('error');
  expect(memory.node(0, 1).text).toContain('ZEBRA-7319');
});
test('missing credentials leaves visible pending jobs that resume after restart without imports', async () => {
  const { directory, storage, memory, evaluations: disabled } = await setup({ apiKey: '' });
  memory.append('user', 'new conversation '.repeat(50));
  await memory.drain(AbortSignal.timeout(3000));
  expect(disabled.reason).toBe('missing TYPESAFE_API_KEY');
  expect(disabled.latest.get('0:0').status).toBe('queued');
  await memory.stop(); await disabled.close(); await storage.close();
  const reopened = await Storage.open(directory, () => {});
  const nextMemory = new Memory(reopened, summaryModel);
  const resumed = new Evaluations(nextMemory, { apiKey: 'test-key', audit: async () => result() });
  cleanups.push(async () => { await nextMemory.stop(); await resumed.close(); await reopened.close(); });
  resumed.pump();
  await resumed.drain(AbortSignal.timeout(3000));
  expect(resumed.latest.get('0:0').status).toBe('completed');
  expect(reopened.root).toHaveLength(1);
});
test('shutdown cancels an active evaluation and resumes its saved job on restart', async () => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const { directory, storage, memory, evaluations } = await setup({ audit: async (_source, _summary, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  memory.append('user', 'remember this decision '.repeat(50));
  await memory.drain(AbortSignal.timeout(3000));
  await pending;
  expect(evaluations.latest.get('0:0').status).toBe('running');
  await memory.stop(); await evaluations.close();
  expect(evaluations.latest.get('0:0').status).toBe('queued');
  await storage.close();
  const reopened = await Storage.open(directory, () => {});
  const nextMemory = new Memory(reopened, summaryModel);
  const resumed = new Evaluations(nextMemory, { apiKey: 'test-key', audit: async () => result() });
  cleanups.push(async () => { await nextMemory.stop(); await resumed.close(); await reopened.close(); });
  resumed.pump();
  await resumed.drain(AbortSignal.timeout(3000));
  expect(resumed.latest.get('0:0').status).toBe('completed');
});
test('oversized audit inputs are marked skipped instead of truncated or counted as a pass', async () => {
  let calls = 0;
  const { memory, evaluations } = await setup({ audit: async () => { calls++; return result(); } });
  memory.append('user', 'long '.repeat(6000));
  await memory.drain(AbortSignal.timeout(3000));
  await evaluations.drain(AbortSignal.timeout(3000));
  expect(calls).toBe(0);
  expect(evaluations.latest.get('0:0').status).toBe('skipped');
});
test.each([429, 503, 529])('TypeSafe HTTP %i retries recover and successful evaluation retains retry count', async status => {
  let calls = 0;
  const { memory, evaluations } = await setup({ retryMs: 1, audit: async () => { calls++; if (calls < 3) throw new Error(`TypeSafe HTTP ${status}: temporarily unavailable`); return result(); } });
  memory.append('user', 'instruction '.repeat(70));
  await memory.drain(AbortSignal.timeout(3000));
  await evaluations.drain(AbortSignal.timeout(3000));
  expect(calls).toBe(3);
  expect(evaluations.latest.get('0:0').retries).toBe(2);
});
test('persistent TypeSafe 503 failures stop after two retries without blocking summaries', async () => {
  let calls = 0;
  const { memory, evaluations } = await setup({ retryMs: 1, audit: async () => {
    calls++;
    throw new Error('TypeSafe HTTP 503: {"detail":{"error_type":"model_unavailable"}}');
  } });
  memory.append('user', 'instruction '.repeat(70));
  expect(await memory.drain(AbortSignal.timeout(3000))).toBe(true);
  expect(await evaluations.drain(AbortSignal.timeout(3000))).toBe(true);
  expect(calls).toBe(3);
  expect(evaluations.latest.get('0:0').status).toBe('error');
  expect(evaluations.latest.get('0:0').error).toContain('model_unavailable');
  expect(memory.node(0, 0).text).toContain('ZEBRA-7319');
});
test('cache totals preserve older inclusive counters and Meta separate cache reads without double counting', () => {
  const totals = usageTotals([
    { usage: { tokens: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 10 }, cached_tokens: 30 }, latency_ms: 200, ttft_ms: 100 },
    { usage: { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30, output_tokens_details: { thinking_tokens: 5 } }, latency_ms: 400 },
    { status: 'error', latency_ms: 50 },
  ]);
  expect(totals.input).toBe(200); expect(totals.output).toBe(40); expect(totals.cached).toBe(60);
  expect(totals.reasoning).toBe(15); expect(totals.errors).toBe(1); expect(totals.ttft).toBe(100);
});
test('provider instrumentation records measured latency, first text, tokens, and failed calls', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const records = [];
  const model = createModel('muse-spark-1.3-contributor', { apiKey: 'test-key', usage: r => records.push(r), fetchImpl: async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')) });
  await model.stream([]);
  expect(records).toHaveLength(1);
  expect(records[0].latency_ms).toBeGreaterThanOrEqual(0);
  expect(records[0].ttft_ms).toBeGreaterThanOrEqual(0);
  expect(records[0].usage.input_tokens).toBe(5);
  model.fetchImpl = async () => new Response('busy', { status: 503 });
  await expect(model.chat([])).rejects.toThrow('HTTP 503');
  expect(records).toHaveLength(2);
  expect(records[1].status).toBe('error');
});
