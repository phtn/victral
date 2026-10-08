import { EventEmitter } from 'node:events';
import { Metrics } from '../src/metrics.js';
import { Memory } from '../src/memory.js';

// CPU-only benchmark: no credentials, API calls, or filesystem writes.
const history = Number(process.argv[2] ?? 10_000);
if (!Number.isSafeInteger(history) || history < 1) throw new Error('History size must be a positive integer.');
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
metrics.close();

// A full binary summary cache with realistic 400-byte nodes exercises replay
// and scheduling at scale. Storage here is in memory; durability is tested by
// the normal suite, independently of CPU timing and filesystem speed.
const nodes = new Map(), summary = 'user: retain decisions and their original sources. '.repeat(8).slice(0, 400);
for (let l = 0; 2 ** l <= history; l++) {
  for (let i = 0; (i + 1) * 2 ** l <= history; i++) nodes.set(`${l}:${i}`, { l, i, text: summary, size: Buffer.byteLength(summary) });
}
const get = nodes.get.bind(nodes);
let nodeReads = 0;
nodes.get = key => { nodeReads++; return get(key); };
const replaySamples = [], pumpSamples = [], pendingReplaySamples = [];
let idleReads = 0, viewParts = 0;
for (let round = 0; round < 5; round++) {
  const start = performance.now();
  const replay = new Memory({ root, nodes }, { chat() { throw new Error('Unexpected model request in CPU benchmark.'); } });
  replaySamples.push(performance.now() - start);
  viewParts = replay.view.length;
  nodeReads = 0;
  const pumpStart = performance.now();
  for (let i = 0; i < iterations; i++) replay.pump();
  pumpSamples.push((performance.now() - pumpStart) / iterations);
  idleReads = nodeReads / iterations;
  await replay.stop();
  const pendingStart = performance.now();
  const pending = new Memory({ root, nodes: new Map() }, {});
  pendingReplaySamples.push(performance.now() - pendingStart);
  await pending.stop();
}
replaySamples.sort((a, b) => a - b); pumpSamples.sort((a, b) => a - b); pendingReplaySamples.sort((a, b) => a - b);
console.log(JSON.stringify({ history, iterations, median_ms_per_snapshot: samples[2],
  memory: { nodes: nodes.size, view_parts: viewParts, median_replay_ms: replaySamples[2], median_pending_replay_ms: pendingReplaySamples[2], median_idle_pump_ms: pumpSamples[2], node_reads_per_idle_pump: idleReads },
}, null, 2));
