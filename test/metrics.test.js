import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Metrics, usageTotals } from '../src/metrics.js';
import { bytes } from '../src/constants.js';

function fixture() {
  const requests = [
    { purpose: 'agent', usage: { tokens: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 10 }, cached_tokens: 30 }, latency_ms: 200, ttft_ms: 100 },
    { purpose: 'compactor', usage: { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 } },
    { purpose: 'agent', status: 'error' },
  ];
  const events = [{ type: 'node', generated: true }, { type: 'node', generated: false }, { type: 'turn', tool_calls: 2, retrievals: 1, duration_ms: 1000, settle_ms: 10 }];
  const root = [{ kind: 'user', text: 'remember 🦓' }];
  const storage = { root, nodes: new Map(), load: stream => stream === 'usage' ? [...requests] : [...events], usage() {}, telemetry() {} };
  const memory = Object.assign(new EventEmitter(), { storage, view: [{ l: 0, i: 0 }], viewBudget: 128_000, busy: new Map(), text: () => 'user: remember 🦓', node: () => ({}) });
  const evaluations = Object.assign(new EventEmitter(), { latest: new Map(), reason: 'enabled' });
  return { metrics: new Metrics(storage, memory, evaluations), storage, memory, evaluations };
}

test('incremental metrics match full totals across saved history and appended records', () => {
  const { metrics, storage, memory } = fixture();
  try {
    const initial = metrics.snapshot();
    expect(initial.usage).toEqual(usageTotals(metrics.requests));
    expect(initial.session).toEqual(usageTotals([]));
    expect(initial.generated).toBe(1); expect(initial.free).toBe(1);
    expect(initial.turns).toBe(1); expect(initial.tool_calls).toBe(2); expect(initial.retrievals).toBe(1);
    const appended = [
      { purpose: 'agent', usage: { input_tokens: 50, output_tokens: 4, cache_read_input_tokens: 20 }, latency_ms: 100 },
      { purpose: 'compactor', status: 'canceled' },
      { purpose: 'compactor', usage: { tokens: { input_tokens: 12, output_tokens: 3 } } },
    ];
    for (const record of appended) { metrics.usage(record); metrics.snapshot(); }
    storage.root.push({ kind: 'talk', text: 'decisions preserved 🦓' });
    memory.emit('node', { generated: true });
    metrics.record({ type: 'turn', tool_calls: 3, retrievals: 2, duration_ms: 2000, settle_ms: 20 });
    const updated = metrics.snapshot();
    expect(updated.usage).toEqual(usageTotals(metrics.requests));
    expect(updated.session).toEqual(usageTotals(appended));
    for (const purpose of ['agent', 'compactor']) expect(updated.by_purpose[purpose]).toEqual(usageTotals(metrics.requests.filter(r => r.purpose === purpose)));
    expect(updated.raw_bytes).toBe(storage.root.reduce((sum, r) => sum + bytes(`${r.kind}: ${r.text}`), 0));
    expect(updated.generated).toBe(2); expect(updated.free).toBe(1);
    expect(updated.turns).toBe(2); expect(updated.tool_calls).toBe(5); expect(updated.retrievals).toBe(3);
    expect(metrics.snapshot()).toEqual(updated);
    expect(initial.usage).not.toEqual(updated.usage);
    updated.usage.calls = -1; updated.by_purpose.agent.calls = -1;
    expect(metrics.snapshot().usage.calls).toBe(6);
    expect(metrics.snapshot().by_purpose.agent.calls).toBe(3);
    expect(metrics.compact()).toContain('turn 2.00s');
  } finally { metrics.close(); }
});

test('audit totals refresh for status changes and preserve chronological latest results', () => {
  const { metrics, evaluations } = fixture();
  const save = record => { evaluations.latest.set(record.key, record); evaluations.emit('update', record); };
  const completed = (key, date, risk) => ({ key, status: 'completed', date, answers: Object.fromEntries(['unsupported_claim', 'user_decision_omitted', 'progress_inflated'].map(name => [name, { noul: risk }])), usage: { input_tokens: 100 }, latency_ms: 200 });
  try {
    expect(metrics.snapshot().jev.completed).toBe(0);
    save({ key: '0:0', status: 'queued' });
    expect(metrics.snapshot().jev.pending).toBe(1);
    save(completed('0:0', '2026-10-08T02:00:00Z', 0.2));
    const first = metrics.snapshot();
    save(completed('0:1', '2026-10-08T01:00:00Z', 0.4));
    const latest = metrics.snapshot().jev;
    expect(latest.completed).toBe(2); expect(latest.pending).toBe(0);
    expect(latest.latest.key).toBe('0:0');
    expect(latest.averages.unsupported_claim).toBeCloseTo(0.3);
    expect(latest.input_tokens).toBe(200); expect(latest.latency_ms).toBe(400);
    expect(first.jev.completed).toBe(1);
    latest.averages.unsupported_claim = -1;
    expect(metrics.snapshot().jev.averages.unsupported_claim).toBeCloseTo(0.3);
    save({ key: '0:1', status: 'error' });
    expect(metrics.snapshot().jev.errors).toBe(1);
    expect(metrics.snapshot().jev.completed).toBe(1);
    save({ key: '0:1', status: 'skipped' });
    expect(metrics.snapshot().jev.skipped).toBe(1);
  } finally { metrics.close(); }
  expect(evaluations.listenerCount('update')).toBe(0);
});
