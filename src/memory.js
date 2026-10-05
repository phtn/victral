import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { NODE, VIEW, JOBS, TRIES, RETRY, bytes, cutBytes } from './constants.js';

const COMPACT = fs.readFileSync(new URL('./COMPACT.txt', import.meta.url), 'utf8').trimEnd();
// A constant, realistic 512-byte scale line; not a changing timestamp or state.
const example = 'user: Build the project agent with durable chat memory; keep original decisions and retrieve their sources before acting. echo: Read src/storage.js: daily JSONL records, fsync, and one writer per chat. talk: Storage and binary summaries are implemented; restart recovery was checked. user: Keep the original prompts and limits; do not silently replace the model. echo: A provider request succeeded; caching is not yet verified. talk: Next connect the summary view to fresh turns and test old-decision retrieval.';
export const SCALE = cutBytes(example, NODE).padEnd(NODE, '.');

export class Memory extends EventEmitter {
  constructor(storage, model, { viewBudget = VIEW, nodeBudget = NODE, jobs = JOBS, retry = RETRY, report = console.error } = {}) {
    super();
    Object.assign(this, { storage, model, viewBudget, nodeBudget, jobs, retry, report });
    this.view = [];
    this.busy = new Map();
    this.failures = new Set();
    this.stopped = false;
    // Replay with T at each append, exactly as when messages originally arrived.
    for (let i = 0; i < storage.root.length; i++) { this.view.push({ l: 0, i }); this.fit(i + 1); }
  }
  node(l, i) { return this.storage.nodes.get(`${l}:${i}`); }
  start(part) { return part.i * 2 ** part.l; }
  end(part) { return (part.i + 1) * 2 ** part.l; }
  text(part) { return this.node(part.l, part.i)?.text ?? '(not summarized yet: zoom it)'; }
  fit(T = this.storage.root.length) {
    let size = this.view.reduce((sum, part) => sum + bytes(this.text(part)), 0);
    while (size > this.viewBudget) {
      let best = -1, weight = -Infinity;
      for (let j = 0; j + 1 < this.view.length; j++) {
        const a = this.view[j], b = this.view[j + 1];
        if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1 || !this.node(a.l + 1, a.i / 2)) continue;
        const due = (T - this.start(a)) / 2 ** (a.l + 2);
        if (due > weight) { best = j; weight = due; }
      }
      if (best < 0) break;
      const a = this.view[best], b = this.view[best + 1];
      const parent = { l: a.l + 1, i: a.i / 2 };
      size += bytes(this.text(parent)) - bytes(this.text(a)) - bytes(this.text(b));
      this.view.splice(best, 2, parent);
    }
    this.emit('change');
  }
  append(kind, text) {
    const record = this.storage.append(kind, text);
    this.view.push({ l: 0, i: record.i });
    this.fit(); this.pump();
    return record;
  }
  render(ids = true, end = Infinity) {
    const lines = this.view.filter(part => this.end(part) <= end).map(part =>
      `${ids ? `${this.start(part)}+${2 ** part.l}|` : ''}${this.text(part).replace(/\r?\n/g, ' ')}`);
    return `<chat>\n${lines.join('\n')}\n</chat>`;
  }
  first() { return this.view.find(part => !this.node(part.l, part.i))?.i ?? this.storage.root.length; }
  pump() {
    if (this.stopped) return;
    const T = this.storage.root.length;
    for (let l = 0; 2 ** l <= T; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= T; i++) {
        if (this.busy.size >= this.jobs) return;
        const key = `${l}:${i}`;
        const end = l === 0 ? i : (i + 1) * 2 ** l;
        if (this.node(l, i) || this.busy.has(key) || end > this.first()) continue;
        if (l > 0 && (!this.node(l - 1, 2 * i) || !this.node(l - 1, 2 * i + 1))) continue;
        const controller = new AbortController();
        this.busy.set(key, { controller });
        const promise = this.build(l, i, controller.signal).then(() => {
          this.busy.delete(key); this.failures.delete(key); this.fit(); this.pump();
        }).catch(error => {
          if (this.stopped) { this.busy.delete(key); return; }
          if (!this.failures.has(key)) { this.report(`Compactor ${key}: ${error.message}; retrying in 10 seconds.`); this.failures.add(key); }
          const timer = setTimeout(() => { this.busy.delete(key); this.pump(); }, this.retry);
          this.busy.set(key, { controller, timer });
        });
        const entry = this.busy.get(key);
        if (entry) entry.promise = promise;
      }
    }
  }
  async build(l, i, signal) {
    const source = l === 0
      ? `${this.storage.root[i].kind}: ${this.storage.root[i].text}`
      : `${this.node(l - 1, 2 * i).text}\n${this.node(l - 1, 2 * i + 1).text}`;
    if (bytes(source) <= this.nodeBudget) { this.storage.saveNode(l, i, source); return; }
    const contextEnd = l === 0 ? i : (i + 1) * 2 ** l;
    const instruction = l === 0 ? 'Compress this message' : 'Merge these two lines';
    const stepSource = l === 0 ? source : [this.node(l - 1, 2 * i).text, this.node(l - 1, 2 * i + 1).text].map(text => text.replace(/\r?\n/g, ' ')).join('\n');
    const step = `For scale, this line is exactly 512 bytes:\n${SCALE}\n\n${instruction} into one line, in at most ${this.nodeBudget} bytes:\n${stepSource}`;
    const messages = [
      { role: 'system', content: COMPACT },
      { role: 'user', content: [{ type: 'text', text: this.render(false, contextEnd) }, { type: 'text', text: step }] },
    ];
    const attempts = [];
    for (let t = 0; t < TRIES; t++) {
      const result = await this.model.chat(messages, { signal });
      const line = result.message.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim();
      if (!line) throw new Error('Empty compactor response.');
      if (result.finish_reason !== 'COMPLETE') throw new Error(`Incomplete compactor response: ${result.finish_reason}`);
      attempts.push(line);
      if (bytes(line) <= this.nodeBudget) break;
      messages.push(result.message, { role: 'user', content: `That line is ${bytes(line)} bytes; the limit is ${this.nodeBudget}. It must end where it is cut here:\n${cutBytes(line, this.nodeBudget)}| ← LIMIT` });
    }
    if (signal.aborted) throw signal.reason;
    this.storage.saveNode(l, i, attempts.reduce((a, b) => bytes(a) <= bytes(b) ? a : b));
  }
  settle(signal) {
    this.pump();
    return new Promise(resolve => {
      const check = () => {
        if (signal?.aborted || this.stopped || this.view.every(part => this.node(part.l, part.i))) {
          this.off('change', check); signal?.removeEventListener('abort', check);
          resolve(!signal?.aborted && !this.stopped);
        }
      };
      this.on('change', check); signal?.addEventListener('abort', check, { once: true }); check();
    });
  }
  async drain(signal) {
    while (!this.stopped && !signal?.aborted) {
      this.pump();
      const T = this.storage.root.length;
      let complete = true;
      for (let l = 0; 2 ** l <= T; l++) for (let i = 0; (i + 1) * 2 ** l <= T; i++) if (!this.node(l, i)) complete = false;
      if (complete) return true;
      await new Promise(resolve => {
        const done = () => { this.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
        this.once('change', done); signal?.addEventListener('abort', done, { once: true });
      });
    }
    return false;
  }
  zoom(id, n) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.storage.root.length) return `No line ${id}+${n}.`;
    if (n === 1) { const r = this.storage.root[id]; return `${id}+0|${r.kind}: ${r.text}`; }
    const l = Math.log2(n) - 1, i = 2 * id / n;
    const a = this.node(l, i), b = this.node(l, i + 1);
    if (!a || !b) return `No line ${id}+${n}.`;
    return `${id}+${n / 2}|${a.text.replace(/\r?\n/g, ' ')}\n${id + n / 2}+${n / 2}|${b.text.replace(/\r?\n/g, ' ')}`;
  }
  date(id) { return this.storage.root[id] ? new Date(this.storage.root[id].date).toLocaleString() : `No message ${id}.`; }
  async stop() {
    this.stopped = true;
    const promises = [];
    for (const entry of this.busy.values()) { clearTimeout(entry.timer); entry.controller.abort(); if (entry.promise) promises.push(entry.promise); }
    this.emit('change');
    await Promise.allSettled(promises);
    this.busy.clear();
  }
}
