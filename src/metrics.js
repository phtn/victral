import { bytes } from './constants.js';

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const percent = value => typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';
const seconds = ms => `${(ms / 1000).toFixed(2)}s`;
const count = value => number(value).toLocaleString('en-US');
const table = (headers, rows) => {
  const cells = [headers, ...rows].map(row => row.map(value => String(value).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')));
  const widths = headers.map((_, index) => Math.max(...cells.map(row => row[index].length)));
  const row = values => `| ${values.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;
  return [row(cells[0]), row(widths.map(width => '-'.repeat(width))), ...cells.slice(1).map(row)].join('\n');
};
const usageRows = columns => [
  ['API calls', ...columns.map(u => count(u.calls))],
  ['Failed / canceled', ...columns.map(u => count(u.errors))],
  ['Input tokens', ...columns.map(u => count(u.input))],
  ['Output tokens', ...columns.map(u => count(u.output))],
  ['Reasoning tokens', ...columns.map(u => count(u.reasoning))],
  ['Cached input tokens', ...columns.map(u => u.cacheKnown ? count(u.cached) : 'n/a')],
  ['Avg API latency', ...columns.map(u => u.timed ? seconds(u.latency / u.timed) : 'n/a')],
  ['Avg first text', ...columns.map(u => u.textCalls ? seconds(u.ttft / u.textCalls) : 'n/a')],
];
export function usageTotals(records) {
  const result = { calls: 0, errors: 0, input: 0, output: 0, reasoning: 0, cached: 0, cacheKnown: 0, latency: 0, timed: 0, ttft: 0, textCalls: 0 };
  for (const record of records) {
    result.calls++;
    if (['error', 'canceled'].includes(record.status)) { result.errors++; continue; }
    const u = record.usage ?? {};
    // Separate cache-read counts are excluded from input_tokens. Older saved
    // usage formats include reads in their input counter; retain their totals.
    const meta = typeof u.cache_read_input_tokens === 'number';
    const cached = meta ? u.cache_read_input_tokens : u.input_tokens_details?.cached_tokens ?? u.cached_tokens;
    result.cached += number(cached);
    if (typeof cached === 'number') result.cacheKnown++;
    result.input += meta ? number(u.input_tokens) + number(cached) : number(u.tokens?.input_tokens ?? u.input_tokens);
    result.output += number(u.tokens?.output_tokens ?? u.output_tokens);
    result.reasoning += number(u.tokens?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.thinking_tokens);
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
    this.requestCount = 0; this.eventCount = 0; this.rootCount = 0;
    this.rawBytes = 0; this.generated = 0; this.free = 0;
    this.turns = 0; this.toolCalls = 0; this.retrievals = 0;
    this.totals = usageTotals([]); this.sessionTotals = usageTotals([]);
    this.purposeTotals = Object.fromEntries(['agent', 'compactor', 'subagent'].map(p => [p, usageTotals([])]));
    this.auditDirty = true;
    this.evaluationListener = () => { this.auditDirty = true; };
    evaluations.on('update', this.evaluationListener);
    this.nodeListener = node => {
      const { context_parts, ...metrics } = node;
      this.record({ type: 'node', ...metrics });
    };
    memory.on('node', this.nodeListener);
  }
  usage(record) { this.storage.usage(record); this.requests.push(record); }
  record(record) { this.storage.telemetry('metrics', record); this.events.push(record); }
  // Saved streams are append-only. Process each record once, including replayed
  // history, rather than rescanning them for every streamed UI update.
  syncHistory() {
    const add = (target, delta) => { for (const key of Object.keys(delta)) target[key] += delta[key]; };
    while (this.requestCount < this.requests.length) {
      const index = this.requestCount++, record = this.requests[index], delta = usageTotals([record]);
      add(this.totals, delta);
      if (index >= this.sessionStart) add(this.sessionTotals, delta);
      if (Object.hasOwn(this.purposeTotals, record.purpose)) add(this.purposeTotals[record.purpose], delta);
    }
    while (this.eventCount < this.events.length) {
      const record = this.events[this.eventCount++];
      if (record.type === 'node') { if (record.generated) this.generated++; else this.free++; }
      if (record.type === 'turn') {
        this.turns++; this.toolCalls += record.tool_calls; this.retrievals += record.retrievals;
        this.lastTurn = record;
      }
    }
    const root = this.memory.storage.root;
    while (this.rootCount < root.length) {
      const record = root[this.rootCount++];
      this.rawBytes += bytes(`${record.kind}: ${record.text}`);
    }
  }
  auditSnapshot() {
    if (!this.auditDirty) return this.auditTotals;
    const auditRecords = [...this.evaluations.latest.values()];
    const completed = auditRecords.filter(r => r.status === 'completed');
    const averages = Object.fromEntries(['unsupported_claim', 'user_decision_omitted', 'progress_inflated'].map(name =>
      [name, completed.length ? completed.reduce((sum, r) => sum + r.answers[name].noul, 0) / completed.length : null]));
    const latest = completed.reduce((last, record) => !last || (record.date ?? '').localeCompare(last.date ?? '') >= 0 ? record : last, null);
    this.auditTotals = { completed: completed.length, pending: auditRecords.filter(r => ['queued', 'running'].includes(r.status)).length, errors: auditRecords.filter(r => r.status === 'error').length, skipped: auditRecords.filter(r => r.status === 'skipped').length, averages, latest, input_tokens: completed.reduce((sum, r) => sum + number(r.usage?.input_tokens), 0), latency_ms: completed.reduce((sum, r) => sum + number(r.latency_ms), 0) };
    this.auditDirty = false;
    return this.auditTotals;
  }
  jevStatus() {
    const audit = this.auditSnapshot(), last = audit.latest;
    return {
      state: this.evaluations.reason, completed: audit.completed, pending: audit.pending,
      errors: audit.errors, skipped: audit.skipped,
      ...(last ? { risks: {
        unsupported: last.answers.unsupported_claim.noul,
        omitted: last.answers.user_decision_omitted.noul,
        inflated: last.answers.progress_inflated.noul,
      } } : {}),
    };
  }
  snapshot() {
    this.syncHistory();
    const memory = this.memory;
    const viewBytes = memory.viewBytes ?? memory.view.reduce((sum, p) => sum + bytes(memory.text(p)), 0);
    const audit = this.auditSnapshot();
    return {
      messages: memory.storage.root.length, nodes: memory.storage.nodes.size, raw_bytes: this.rawBytes, view_bytes: viewBytes,
      view_budget: memory.viewBudget, compression: viewBytes ? this.rawBytes / viewBytes : 0,
      pending_summaries: memory.view.filter(p => !memory.node(p.l, p.i)).length,
      compactor_running: [...memory.busy.values()].filter(e => !e.timer).length,
      compactor_retries: memory.failures?.size ?? [...memory.busy.values()].filter(e => e.timer).length,
      generated: this.generated, free: this.free,
      turns: this.turns, tool_calls: this.toolCalls, retrievals: this.retrievals,
      usage: { ...this.totals }, session: { ...this.sessionTotals },
      by_purpose: Object.fromEntries(Object.entries(this.purposeTotals).map(([p, totals]) => [p, { ...totals }])),
      jev: { ...audit, state: this.evaluations.reason, averages: { ...audit.averages } },
    };
  }
  compact() {
    const s = this.snapshot(), u = s.session;
    const lastTurn = this.lastTurn;
    const last = s.jev.latest;
    return [
      `[metrics] ${lastTurn ? `turn ${seconds(lastTurn.duration_ms)} · wait ${seconds(lastTurn.settle_ms)} · ` : ''}session tokens ${u.input} in / ${u.output} out · cached ${u.cacheKnown ? u.cached : 'n/a'} · zoom ${s.retrievals}`,
      `[memory] ${s.messages} messages · ${s.nodes} nodes · view ${s.view_bytes}/${s.view_budget} B · raw/view ${s.compression.toFixed(2)}x · ${s.pending_summaries} pending summaries`,
      `[jev] ${s.jev.state} · ${s.jev.completed} evaluated / ${s.jev.pending} pending / ${s.jev.errors} errors / ${s.jev.skipped} skipped${last ? ` · latest risks: unsupported ${percent(last.answers.unsupported_claim.noul)}, omitted ${percent(last.answers.user_decision_omitted.noul)}, inflated ${percent(last.answers.progress_inflated.noul)}` : ''}`,
    ].join('\n');
  }
  detailed() {
    const s = this.snapshot(), lastTurn = this.lastTurn, audit = s.jev, last = audit.latest;
    return [
      '## Activity',
      table(['Metric', 'Value'], [
        ['Last turn', lastTurn ? `${lastTurn.status ?? 'completed'} · ${seconds(lastTurn.duration_ms)}` : 'n/a'],
        ['Memory wait', lastTurn ? seconds(lastTurn.settle_ms) : 'n/a'],
        ['Saved turns', count(s.turns)], ['Tool calls', count(s.tool_calls)], ['Zoom retrievals', count(s.retrievals)],
      ]),
      '## Usage',
      table(['Metric', 'This session', 'All saved'], usageRows([s.session, s.usage])),
      '## Usage by role · all saved',
      table(['Metric', 'Agent', 'Compactor', 'Subagents'], usageRows([s.by_purpose.agent, s.by_purpose.compactor, s.by_purpose.subagent])),
      '## Memory',
      table(['Metric', 'Value'], [
        ['Messages', count(s.messages)], ['Saved nodes', count(s.nodes)],
        ['Raw text', `${count(s.raw_bytes)} B`], ['View size', `${count(s.view_bytes)} B`],
        ['View budget', `${count(s.view_budget)} B`], ['Raw / view', `${s.compression.toFixed(2)}x`],
        ['Pending summaries', count(s.pending_summaries)], ['Generated summaries', count(s.generated)],
        ['Exact-copy nodes', count(s.free)], ['Active compactors', count(s.compactor_running)],
        ['Waiting to retry', count(s.compactor_retries)],
      ]),
      '## Jev evaluations',
      table(['Metric', 'Value'], [
        ['State', audit.state], ['Completed', count(audit.completed)], ['Pending', count(audit.pending)],
        ['Errors', count(audit.errors)], ['Skipped', count(audit.skipped)],
        ['Input tokens', count(audit.input_tokens)],
        ['Avg latency', audit.completed ? seconds(audit.latency_ms / audit.completed) : 'n/a'],
      ]),
      table(['Risk', 'Latest', 'Average'], [
        ['Unsupported claims', percent(last?.answers.unsupported_claim.noul), percent(audit.averages.unsupported_claim)],
        ['Omitted decisions', percent(last?.answers.user_decision_omitted.noul), percent(audit.averages.user_decision_omitted)],
        ['Inflated progress', percent(last?.answers.progress_inflated.noul), percent(audit.averages.progress_inflated)],
      ]),
      'Reasoning tokens are included in output. Cached input is included in total input. n/a means no measurement is available.',
      'Raw / view compares text bytes, not tokens. Jev probabilities are model judgments, not accuracy scores.',
    ].join('\n\n');
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
  close() { this.memory.off('node', this.nodeListener); this.evaluations.off('update', this.evaluationListener); }
}
