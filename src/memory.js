import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { NODE, VIEW, JOBS, TRIES, RETRY, bytes, cutBytes } from './constants.js';

const COMPACT = fs.readFileSync(new URL('./COMPACT.txt', import.meta.url), 'utf8').trimEnd();
// A constant, realistic 512-byte scale line; not a changing timestamp or state.
const example = 'user: Build the project agent with durable chat memory; keep original decisions and retrieve their sources before acting. echo: Read src/storage.js: daily JSONL records, fsync, and one writer per chat. talk: Storage and binary summaries are implemented; restart recovery was checked. user: Keep the original prompts and limits; do not silently replace the model. echo: A provider request succeeded; caching is not yet verified. talk: Next connect the summary view to fresh turns and test old-decision retrieval.';
export const SCALE = cutBytes(example, NODE).padEnd(NODE, '.');

// One ordered queue per level preserves the pump's (level, index) priority,
// including nodes whose sources finish out of order and retries of older work.
class IndexQueue {
  items = [];
  peek() { return this.items[0]; }
  push(value) {
    const items = this.items;
    let at = items.length;
    items.push(value);
    while (at > 0) {
      const parent = Math.floor((at - 1) / 2);
      if (items[parent] <= value) break;
      items[at] = items[parent]; at = parent;
    }
    items[at] = value;
  }
  pop() {
    const items = this.items, first = items[0], last = items.pop();
    if (items.length) {
      let at = 0;
      while (2 * at + 1 < items.length) {
        let child = 2 * at + 1;
        if (child + 1 < items.length && items[child + 1] < items[child]) child++;
        if (items[child] >= last) break;
        items[at] = items[child]; at = child;
      }
      items[at] = last;
    }
    return first;
  }
}

export class Memory extends EventEmitter {
  constructor(storage, model, { viewBudget = VIEW, nodeBudget = NODE, jobs = JOBS, retry = RETRY, report = console.error } = {}) {
    super();
    Object.assign(this, { storage, model, viewBudget, nodeBudget, jobs, retry, report });
    this.view = [];
    this.viewKeys = new Set();
    this.viewBytes = 0;
    this.merges = new Map();
    this.ready = [];
    this.queued = new Set();
    this.remaining = 0;
    this.busy = new Map();
    this.failures = new Set();
    this.stopped = false;
    // Replay with T at each append, exactly as when messages originally arrived.
    for (let i = 0; i < storage.root.length; i++) { this.addPart({ l: 0, i }); this.fit(i + 1); }
    // Index unfinished work once on restart. Afterwards only appends, finished
    // children, and retry timers introduce candidates; idle pumps read no nodes.
    for (let l = 0; 2 ** l <= storage.root.length; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= storage.root.length; i++) {
        if (this.node(l, i)) continue;
        this.remaining++;
        this.enqueue(l, i);
      }
    }
  }
  node(l, i) { return this.storage.nodes.get(`${l}:${i}`); }
  start(part) { return part.i * 2 ** part.l; }
  end(part) { return (part.i + 1) * 2 ** part.l; }
  text(part) { return this.node(part.l, part.i)?.text ?? '(not summarized yet: zoom it)'; }
  size(part) { return this.node(part.l, part.i)?.size ?? bytes(this.text(part)); }
  addPart(part) {
    this.view.push(part); this.viewKeys.add(`${part.l}:${part.i}`);
    this.viewBytes += this.size(part);
    this.offerMerge(part.l + 1, Math.floor(part.i / 2));
  }
  offerMerge(l, i) {
    if (l > 0 && this.viewKeys.has(`${l - 1}:${2 * i}`) && this.viewKeys.has(`${l - 1}:${2 * i + 1}`) && this.node(l, i)) {
      this.merges.set(`${l}:${i}`, { l, i });
    }
  }
  fit(T = this.storage.root.length) {
    // Only built parents whose two children are in the view can fold. In a
    // backlog with no summaries, this avoids repeatedly scanning every message.
    while (this.viewBytes > this.viewBudget && this.merges.size) {
      let parent, weight = -Infinity;
      for (const candidate of this.merges.values()) {
        const due = (T - this.start(candidate)) / 2 ** (candidate.l + 1);
        if (!parent || due > weight || (due === weight && this.start(candidate) < this.start(parent))) {
          parent = candidate; weight = due;
        }
      }
      const a = { l: parent.l - 1, i: 2 * parent.i }, b = { l: a.l, i: a.i + 1 };
      const best = this.view.findIndex(part => part.l === a.l && part.i === a.i);
      this.viewBytes += this.size(parent) - this.size(a) - this.size(b);
      this.viewKeys.delete(`${a.l}:${a.i}`); this.viewKeys.delete(`${b.l}:${b.i}`);
      this.viewKeys.add(`${parent.l}:${parent.i}`);
      this.merges.delete(`${parent.l}:${parent.i}`);
      this.view.splice(best, 2, parent);
      this.offerMerge(parent.l + 1, Math.floor(parent.i / 2));
    }
    this.emit('change');
  }
  append(kind, text) {
    const record = this.storage.append(kind, text);
    this.addPart({ l: 0, i: record.i });
    const T = this.storage.root.length;
    for (let l = 0; T % 2 ** l === 0; l++) this.remaining++;
    this.enqueue(0, record.i);
    this.fit(); this.pump();
    return record;
  }
  render(ids = true, end = Infinity) {
    const lines = this.view.filter(part => this.end(part) <= end).map(part =>
      `${ids ? `${this.start(part)}+${2 ** part.l}|` : ''}${this.text(part).replace(/\r?\n/g, ' ')}`);
    return `<chat>\n${lines.join('\n')}\n</chat>`;
  }
  first() {
    const part = this.view.find(part => !this.node(part.l, part.i));
    return part ? this.start(part) : this.storage.root.length;
  }
  enqueue(l, i) {
    const key = `${l}:${i}`;
    if (this.node(l, i) || this.busy.has(key) || this.queued.has(key)) return;
    if (l > 0 && (!this.node(l - 1, 2 * i) || !this.node(l - 1, 2 * i + 1))) return;
    (this.ready[l] ??= new IndexQueue()).push(i);
    this.queued.add(key);
  }
  saveNode(l, i, text) {
    const key = `${l}:${i}`;
    const oldSize = this.viewKeys.has(key) ? this.size({ l, i }) : 0;
    this.storage.saveNode(l, i, text);
    if (this.viewKeys.has(key)) this.viewBytes += this.size({ l, i }) - oldSize;
    this.offerMerge(l, i);
    this.remaining--;
    if ((Math.floor(i / 2) + 1) * 2 ** (l + 1) <= this.storage.root.length) this.enqueue(l + 1, Math.floor(i / 2));
  }
  pump() {
    if (this.stopped) return;
    for (let l = 0; l < this.ready.length; l++) {
      const queue = this.ready[l];
      while (queue?.peek() !== undefined) {
        if (this.busy.size >= this.jobs) return;
        const i = queue.peek();
        const key = `${l}:${i}`;
        const end = l === 0 ? i : (i + 1) * 2 ** l;
        if (end > this.first()) break;
        queue.pop(); this.queued.delete(key);
        const controller = new AbortController();
        this.busy.set(key, { controller });
        const promise = this.build(l, i, controller.signal).then(() => {
          this.busy.delete(key); this.failures.delete(key); this.fit(); this.pump();
        }).catch(error => {
          if (this.stopped) { this.busy.delete(key); return; }
          if (!this.failures.has(key)) { this.report(`Compactor ${key}: ${error.message}; retrying in ${this.retry / 1000} seconds.`); this.failures.add(key); }
          const timer = setTimeout(() => { this.busy.delete(key); this.enqueue(l, i); this.pump(); }, this.retry);
          this.busy.set(key, { controller, timer });
        });
        const entry = this.busy.get(key);
        if (entry) entry.promise = promise;
      }
    }
  }
  async build(l, i, signal) {
    const started = performance.now();
    const source = l === 0
      ? `${this.storage.root[i].kind}: ${this.storage.root[i].text}`
      : `${this.node(l - 1, 2 * i).text}\n${this.node(l - 1, 2 * i + 1).text}`;
    if (bytes(source) <= this.nodeBudget) {
      this.saveNode(l, i, source);
      this.emit('node', { l, i, generated: false, attempts: 0, source_bytes: bytes(source), summary_bytes: bytes(source), duration_ms: performance.now() - started });
      return;
    }
    const contextEnd = l === 0 ? i : (i + 1) * 2 ** l;
    const contextParts = this.view.filter(part => this.end(part) <= contextEnd).map(part => ({ ...part }));
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
    const summary = attempts.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
    this.saveNode(l, i, summary);
    this.emit('node', { l, i, generated: true, context_parts: contextParts, attempts: attempts.length, source_bytes: bytes(source), summary_bytes: bytes(summary), duration_ms: performance.now() - started });
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
      if (this.remaining === 0) return true;
      await new Promise(resolve => {
        const done = () => { this.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
        this.once('change', done); signal?.addEventListener('abort', done, { once: true });
        if (this.stopped || signal?.aborted) done();
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
