import { bytes } from './constants.js';

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const percent = value => typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';
const seconds = ms => `${(ms / 1000).toFixed(2)}s`;
export function usageTotals(records) {
  const result = { calls: 0, errors: 0, input: 0, output: 0, reasoning: 0, cached: 0, cacheKnown: 0, latency: 0, timed: 0, ttft: 0, textCalls: 0 };
  for (const record of records) {
    result.calls++;
    if (['error', 'canceled'].includes(record.status)) { result.errors++; continue; }
    const u = record.usage ?? {};
    // Meta input_tokens excludes cache reads; Cohere tokens.input_tokens includes them.
    const meta = typeof u.cache_read_input_tokens === 'number';
    const cached = meta ? u.cache_read_input_tokens : u.cached_tokens;
    result.cached += number(cached);
    if (typeof cached === 'number') result.cacheKnown++;
    result.input += meta ? number(u.input_tokens) + number(cached) : number(u.tokens?.input_tokens ?? u.input_tokens);
    result.output += number(u.tokens?.output_tokens ?? u.output_tokens);
    result.reasoning += number(u.tokens?.reasoning_tokens ?? u.output_tokens_details?.thinking_tokens);
    if (typeof record.latency_ms === 'number') { result.latency += record.latency_ms; result.timed++; }
    if (typeof record.ttft_ms === 'number') { result.ttft += record.ttft_ms; result.textCalls++; }
  }
  return result;
}
export class Metrics {
  constructor(storage, memory, evaluations) {
    Object.assign(this, { storage, memory, evaluations });
    this.requests = storage.load('usage');
    this.events = storage.load('metrics');
    this.sessionStart = this.requests.length;
    this.nodeListener = node => {
      const { context_parts, ...metrics } = node;
      this.record({ type: 'node', ...metrics });
    };
    memory.on('node', this.nodeListener);
  }
  usage(record) { this.storage.usage(record); this.requests.push(record); }
  record(record) { this.storage.telemetry('metrics', record); this.events.push(record); }
  snapshot() {
    const memory = this.memory;
    const rawBytes = memory.storage.root.reduce((sum, r) => sum + bytes(`${r.kind}: ${r.text}`), 0);
    const viewBytes = memory.view.reduce((sum, p) => sum + bytes(memory.text(p)), 0);
    const auditRecords = [...this.evaluations.latest.values()];
    const completed = auditRecords.filter(r => r.status === 'completed').sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    const averages = Object.fromEntries(['unsupported_claim', 'user_decision_omitted', 'progress_inflated'].map(name =>
      [name, completed.length ? completed.reduce((sum, r) => sum + r.answers[name].noul, 0) / completed.length : null]));
    const nodes = this.events.filter(e => e.type === 'node');
    const turns = this.events.filter(e => e.type === 'turn');
    return {
      messages: memory.storage.root.length, nodes: memory.storage.nodes.size, raw_bytes: rawBytes, view_bytes: viewBytes,
      view_budget: memory.viewBudget, compression: viewBytes ? rawBytes / viewBytes : 0,
      pending_summaries: memory.view.filter(p => !memory.node(p.l, p.i)).length,
      compactor_running: [...memory.busy.values()].filter(e => !e.timer).length,
      compactor_retries: [...memory.busy.values()].filter(e => e.timer).length,
      generated: nodes.filter(n => n.generated).length, free: nodes.filter(n => !n.generated).length,
      turns: turns.length, tool_calls: turns.reduce((sum, e) => sum + e.tool_calls, 0), retrievals: turns.reduce((sum, e) => sum + e.retrievals, 0),
      usage: usageTotals(this.requests), session: usageTotals(this.requests.slice(this.sessionStart)),
      by_purpose: Object.fromEntries(['agent', 'compactor'].map(p => [p, usageTotals(this.requests.filter(r => r.purpose === p))])),
      jev: { state: this.evaluations.reason, completed: completed.length, pending: auditRecords.filter(r => ['queued', 'running'].includes(r.status)).length, errors: auditRecords.filter(r => r.status === 'error').length, skipped: auditRecords.filter(r => r.status === 'skipped').length, averages, latest: completed.at(-1) ?? null, input_tokens: completed.reduce((sum, r) => sum + number(r.usage?.input_tokens), 0), latency_ms: completed.reduce((sum, r) => sum + number(r.latency_ms), 0) },
    };
  }
  compact() {
    const s = this.snapshot(), u = s.session;
    const lastTurn = this.events.findLast(e => e.type === 'turn');
    const last = s.jev.latest;
    return [
      `[metrics] ${lastTurn ? `turn ${seconds(lastTurn.duration_ms)} · wait ${seconds(lastTurn.settle_ms)} · ` : ''}session tokens ${u.input} in / ${u.output} out · cached ${u.cacheKnown ? u.cached : 'n/a'} · zoom ${s.retrievals}`,
      `[memory] ${s.messages} messages · ${s.nodes} nodes · view ${s.view_bytes}/${s.view_budget} B · raw/view ${s.compression.toFixed(2)}x · ${s.pending_summaries} pending summaries`,
      `[jev] ${s.jev.state} · ${s.jev.completed} evaluated / ${s.jev.pending} pending / ${s.jev.errors} errors / ${s.jev.skipped} skipped${last ? ` · latest risks: unsupported ${percent(last.answers.unsupported_claim.noul)}, omitted ${percent(last.answers.user_decision_omitted.noul)}, inflated ${percent(last.answers.progress_inflated.noul)}` : ''}`,
    ].join('\n');
  }
  detailed() {
    const s = this.snapshot();
    const lines = [this.compact(), 'Totals across saved sessions:'];
    for (const [purpose, u] of Object.entries(s.by_purpose)) lines.push(`  ${purpose}: ${u.calls} calls (${u.errors} failed/canceled) · ${u.input} input / ${u.output} output / ${u.reasoning} reasoning tokens · ${u.cacheKnown ? u.cached : 'n/a'} cached · avg latency ${u.timed ? seconds(u.latency / u.timed) : 'n/a'} · avg first text ${u.textCalls ? seconds(u.ttft / u.textCalls) : 'n/a'}`);
    lines.push(`  compaction: ${s.generated} generated, ${s.free} exact-copy nodes observed · ${s.compactor_running} active / ${s.compactor_retries} waiting to retry`);
    lines.push(`  Jev: ${s.jev.input_tokens} input tokens · avg latency ${s.jev.completed ? seconds(s.jev.latency_ms / s.jev.completed) : 'n/a'} · mean risk probabilities: unsupported ${percent(s.jev.averages.unsupported_claim)}, omitted ${percent(s.jev.averages.user_decision_omitted)}, inflated ${percent(s.jev.averages.progress_inflated)}`);
    lines.push('Jev probabilities are model judgments, not accuracy scores. Reasoning tokens are included in output tokens. Raw/view compares stored message text with summary text, not API tokens.');
    return lines.join('\n');
  }
  jevDetails() {
    const records = [...this.evaluations.latest.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')).slice(-5);
    return [this.compact().split('\n').at(-1), ...records.map(r => {
      const range = `${r.i * 2 ** r.l}+${2 ** r.l}`;
      return r.status === 'completed'
        ? `  ${range}: ${r.model} · ${seconds(r.latency_ms)} · unsupported ${percent(r.answers.unsupported_claim.noul)} / omitted ${percent(r.answers.user_decision_omitted.noul)} / inflated ${percent(r.answers.progress_inflated.noul)}`
        : `  ${range}: ${r.status}${r.error || r.reason ? ` · ${r.error || r.reason}` : ''}`;
    })].join('\n');
  }
  close() { this.memory.off('node', this.nodeListener); }
}
