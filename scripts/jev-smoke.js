import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { createModel } from '../src/models.js';
import { Runner } from '../src/runner.js';
import { projectTools } from '../src/tools.js';
import { Evaluations } from '../src/evaluations.js';
import { Metrics } from '../src/metrics.js';
import { MODEL } from '../src/constants.js';

if (!Bun.env.TYPESAFE_API_KEY) throw new Error('Set TYPESAFE_API_KEY locally before running the live Jev smoke test.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-jev-smoke-'));
const storage = await Storage.open(path.join(directory, 'chat'));
let memory, evaluations, metrics, runner;
try {
  const report = record => metrics.usage(record);
  const model = createModel(MODEL, { usage: report });
  memory = new Memory(storage, createModel(MODEL, { purpose: 'compactor', usage: report }));
  evaluations = new Evaluations(memory);
  metrics = new Metrics(storage, memory, evaluations);
  const errors = [];
  runner = new Runner(memory, model, projectTools(memory, directory), '', { onError: text => errors.push(text), onTurn: turn => metrics.record({ type: 'turn', ...turn }) });
  await runner.submit('Remember this synthetic project decision: the release code is ZEBRA-7319. The release is planned, not completed. ' +
    'The fictional project has a green interface, a gray footer, and a release planned for next month. '.repeat(8) + 'Reply only ACK.');
  assert.deepEqual(errors, []);
  assert.equal(await memory.drain(AbortSignal.timeout(90_000)), true);
  assert.equal(await evaluations.drain(AbortSignal.timeout(90_000)), true);
  const result = metrics.snapshot();
  assert.ok(result.jev.completed > 0, 'At least one real summary must be evaluated by Jev.');
  assert.equal(result.jev.errors, 0);
  assert.ok(result.usage.timed > 0);
  assert.ok(result.messages >= 2);
  console.log(metrics.detailed());
  console.log(`\nSynthetic fresh-chat artifacts: ${directory}`);
  // Only print evaluation metadata/probabilities, not credentials or raw source.
  console.log(JSON.stringify([...evaluations.latest.values()].filter(r => r.status === 'completed').map(({ key, model, answers, usage, latency_ms }) => ({ key, model, answers, usage, latency_ms })), null, 2));
} finally {
  await runner?.close(); await memory?.stop(); await evaluations?.close(); metrics?.close(); await storage.close();
}
