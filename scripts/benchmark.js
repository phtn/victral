import { EventEmitter } from 'node:events';
import { Metrics } from '../src/metrics.js';

// CPU-only benchmark: no credentials, API calls, or filesystem writes.
const history = Number(process.argv[2] ?? 10_000);
const iterations = 200;
const root = Array.from({ length: history }, (_, i) => ({ i, kind: 'user', text: `decision ${i} 🦓 `.repeat(50) }));
const requests = root.map(() => ({ purpose: 'agent', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }, latency_ms: 200 }));
const events = root.map(() => ({ type: 'turn', tool_calls: 2, retrievals: 1, duration_ms: 1000, settle_ms: 10 }));
const storage = { root, nodes: new Map(), load: stream => stream === 'usage' ? requests : events };
const memory = Object.assign(new EventEmitter(), { storage, view: [{ l: 0, i: 0 }], viewBudget: 128_000, busy: new Map(), text: () => 'user: decisions', node: () => ({ text: 'user: decisions' }) });
const evaluations = Object.assign(new EventEmitter(), { latest: new Map(), reason: 'disabled' });
const metrics = new Metrics(storage, memory, evaluations);
for (let i = 0; i < 10; i++) metrics.compact();
const samples = [];
for (let round = 0; round < 5; round++) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) metrics.compact();
  samples.push((performance.now() - start) / iterations);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ history, iterations, median_ms_per_snapshot: samples[2] }, null, 2));
metrics.close();
