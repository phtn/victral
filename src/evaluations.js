import { EventEmitter } from 'node:events';
import { auditSummary } from './jev.js';
import { bytes } from './constants.js';

// Conservative byte guard, not a token estimate: do not silently truncate an audit.
const MAX_STATE_BYTES = 24_000;
export class Evaluations extends EventEmitter {
  constructor(memory, { enabled = true, apiKey = Bun.env.TYPESAFE_API_KEY, model = Bun.env.TYPESAFE_MODEL || 'jev-latest', audit = auditSummary, concurrency = 2, retryMs = 1000 } = {}) {
    super();
    Object.assign(this, { memory, apiKey, model, audit, concurrency, retryMs });
    this.enabled = enabled && Boolean(apiKey);
    this.reason = !enabled ? 'disabled' : !apiKey ? 'missing TYPESAFE_API_KEY' : 'enabled';
    this.queue = [];
    this.active = new Map();
    this.latest = new Map();
    this.closed = false;
    for (const record of memory.storage.load('evaluations')) this.latest.set(record.key, record);
    for (const record of this.latest.values()) if (['queued', 'running'].includes(record.status)) this.queue.push(record);
    this.nodeListener = node => {
      if (!node.generated) return; // Exact copies have no summarization loss to evaluate.
      const key = `${node.l}:${node.i}`;
      if (this.latest.has(key)) return;
      const job = { key, l: node.l, i: node.i, context_parts: node.context_parts, requested_model: this.model, status: 'queued' };
      this.save(job); this.queue.push(job); this.pump();
    };
    memory.on('node', this.nodeListener);
  }
  save(record) {
    record = { ...record, date: new Date().toISOString() };
    this.memory.storage.telemetry('evaluations', record);
    this.latest.set(record.key, record);
    this.emit('update', record);
  }
  state(job) {
    const { memory } = this;
    const summary = memory.node(job.l, job.i)?.text;
    const source = job.l === 0
      ? `${memory.storage.root[job.i].kind}: ${memory.storage.root[job.i].text}`
      : `${memory.node(job.l - 1, 2 * job.i).text}\n${memory.node(job.l - 1, 2 * job.i + 1).text}`;
    const lines = (job.context_parts ?? []).map(part => {
      const text = memory.node(part.l, part.i)?.text;
      if (text === undefined) throw new Error('Missing saved evaluation context.');
      return text.replace(/\r?\n/g, ' ');
    });
    if (summary === undefined) throw new Error('Missing saved summary.');
    return { source, summary, context: `<chat>\n${lines.join('\n')}\n</chat>` };
  }
  pump() {
    if (!this.enabled || this.closed) return;
    while (this.queue.length && this.active.size < this.concurrency) {
      const job = this.queue.shift(), controller = new AbortController();
      const entry = { controller };
      this.active.set(job.key, entry);
      entry.promise = this.run(job, controller.signal).finally(() => {
        this.active.delete(job.key); this.emit('idle'); this.pump();
      });
    }
  }
  async run(job, signal) {
    const started = performance.now();
    try {
      const state = this.state(job), stateBytes = bytes(JSON.stringify(state));
      if (stateBytes > MAX_STATE_BYTES) {
        this.save({ ...job, status: 'skipped', state_bytes: stateBytes, reason: 'Complete audit state exceeds the 24,000-byte guard; source/context were not truncated.' });
        return;
      }
      this.save({ ...job, status: 'running', state_bytes: stateBytes });
      let result, retries = 0;
      for (;;) {
        try {
          result = await this.audit(state.source, state.summary, { apiKey: this.apiKey, model: job.requested_model || this.model, context: state.context, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
          break;
        } catch (error) {
          // TypeSafe also returns 503 model_unavailable during intermittent failures.
          if (signal.aborted || retries >= 2 || !/HTTP (429|503|529)\b/.test(error.message)) throw error;
          retries++;
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, this.retryMs * 2 ** (retries - 1));
            signal.addEventListener('abort', abort, { once: true });
          });
        }
      }
      this.save({ ...job, status: 'completed', state_bytes: stateBytes, model: result.model, answers: result.answers, usage: result.usage, latency_ms: performance.now() - started, retries });
    } catch (error) {
      // Pending jobs survive shutdown and resume on the next launch.
      this.save({ ...job, status: signal.aborted ? 'queued' : 'error', latency_ms: performance.now() - started, ...(signal.aborted ? {} : { error: error.message.replaceAll(this.apiKey || '\0', '[redacted]') }) });
    }
  }
  async drain(signal) {
    if (!this.enabled) return false;
    this.pump();
    while (this.queue.length || this.active.size) {
      if (signal?.aborted) return false;
      await new Promise(resolve => {
        const done = () => { this.off('idle', done); signal?.removeEventListener('abort', done); resolve(); };
        this.once('idle', done); signal?.addEventListener('abort', done, { once: true });
      });
    }
    return true;
  }
  async close() {
    this.closed = true;
    this.memory.off('node', this.nodeListener);
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
  }
}
