import { EventEmitter } from 'node:events';
import { NODE, VIEW, VIEW_MIN, COMPACT_VIEW, COMPACT_VIEW_MIN, JOBS, TRIES, CAP, bytes, cutBytes, splitText, capResult } from './constants.js';
import { SummaryView, pairs, restoreParts } from './summary-view.js';
import { systemPrompt } from './prompt.js';
import { viewBlocks } from './view.js';

export const SCALE = '-'.repeat(NODE);

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
  constructor(storage, model, { viewBudget = VIEW, viewMinimum = viewBudget === VIEW ? VIEW_MIN : Math.floor(viewBudget / 2), compactBudget = COMPACT_VIEW, compactMinimum = compactBudget === COMPACT_VIEW ? COMPACT_VIEW_MIN : Math.floor(compactBudget / 2), nodeBudget = NODE, jobs = JOBS, report = console.error } = {}) {
    super();
    Object.assign(this, { storage, model, viewBudget, viewMinimum, compactBudget, compactMinimum, nodeBudget, jobs, report });
    this.system = systemPrompt(); this.tools = [];
    this.ready = [];
    this.queued = new Set();
    this.remaining = 0;
    this.busy = new Map();
    this.failures = new Set();
    this.stopped = false;
    this.builtThrough = 0;
    this.builtAhead = new Set();
    for (let i = 0; i < storage.root.length; i++) if (this.node(0, i)) this.builtAhead.add(i);
    this.advance();
    const saved = storage.loadView?.();
    const parts = saved === null || saved === undefined ? [] : restoreParts(saved, this);
    this.mainView = new SummaryView(this, viewBudget, viewMinimum, parts, storage.loadView?.('view-batch') === true);
    // Only recover a suffix committed after the last atomic view write. Older
    // installations have no view.json: initialize once and persist immediately.
    const end = parts.length ? this.end(parts.at(-1)) : 0;
    for (let i = end; i < storage.root.length; i++) this.mainView.append({ l: 0, i });
    if (this.mainView.shrinking || this.viewBytes > viewBudget) storage.saveView?.(true, 'view-batch');
    const merged = (saved == null || end < storage.root.length || this.mainView.shrinking || this.viewBytes > viewBudget) ? this.mainView.fit(storage.root.length) : 0;
    const compact = storage.loadView?.('compaction-view');
    this.compactView = compact == null ? null : new SummaryView(this, compactBudget, compactMinimum, restoreParts(compact.parts, this, { built: true }), compact.shrinking === true);
    if (merged) this.syncCompact(true);
    this.persistView();
    // Index unfinished work once on restart. Afterwards only appends, finished
    // children, and new-message retries introduce candidates; idle pumps read no nodes.
    for (let l = 0; 2 ** l <= storage.root.length; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= storage.root.length; i++) {
        if (this.node(l, i)) continue;
        this.remaining++;
        this.enqueue(l, i);
      }
    }
  }
  get view() { return this.mainView.parts; }
  get viewBytes() { return this.mainView.bytes; }
  get viewKeys() { return this.mainView.keys; }
  get merges() { return this.mainView.merges; }
  configure(system, tools) { this.system = system; this.tools = tools; }
  advance() {
    while (this.builtAhead.delete(this.builtThrough)) this.builtThrough++;
  }
  node(l, i) { return this.storage.nodes.get(`${l}:${i}`); }
  start(part) { return part.i * 2 ** part.l; }
  end(part) { return (part.i + 1) * 2 ** part.l; }
  text(part) { return this.node(part.l, part.i)?.text ?? '(not summarized yet: zoom it)'; }
  size(part) { return this.mainView.size(part); }
  addPart(part) { this.mainView.append(part); }
  persistView() {
    if (this.persistedViewRevision !== this.mainView.revision) {
      this.storage.saveView?.(pairs(this.view)); this.persistedViewRevision = this.mainView.revision;
    }
    if (this.persistedShrinking !== this.mainView.shrinking) {
      this.storage.saveView?.(this.mainView.shrinking, 'view-batch'); this.persistedShrinking = this.mainView.shrinking;
    }
  }
  fit(T = this.storage.root.length) {
    const batching = this.mainView.shrinking || this.viewBytes > this.viewBudget;
    // Persist intent BEFORE changing a batch, including one stalled on parents.
    if (batching && this.persistedShrinking !== true) {
      this.storage.saveView?.(true, 'view-batch'); this.persistedShrinking = true;
    }
    const merged = this.mainView.fit(T);
    this.persistView();
    if (merged) this.syncCompact(true);
    this.emit('change');
  }
  append(kind, text) {
    const chunks = kind === 'echo' ? [capResult(text)] : splitText(text);
    let record;
    this.retryFailed();
    for (const chunk of chunks) {
      const next = this.storage.append(kind, chunk); record ??= next;
      this.addPart({ l: 0, i: next.i });
      const T = this.storage.root.length;
      for (let l = 0; T % 2 ** l === 0; l++) this.remaining++;
      this.enqueue(0, next.i);
      this.fit();
    }
    this.pump();
    return record;
  }
  render(ids = true, end = Infinity) {
    return this.mainView.render(this.mainView.prefix(end), ids);
  }
  first() { return this.builtThrough; }
  retryFailed() {
    const failed = [...this.failures]; this.failures.clear();
    for (const key of failed) { const [l, i] = key.split(':').map(Number); this.enqueue(l, i); }
  }
  syncCompact(reset = false) {
    const end = this.first();
    if (!this.compactView || reset) {
      this.compactView = new SummaryView(this, this.compactBudget, this.compactMinimum, this.mainView.prefix(end));
      this.compactView.fit(this.storage.root.length, true);
    } else {
      const parts = this.compactView.parts;
      const covered = parts.length ? this.end(parts.at(-1)) : 0;
      for (let i = covered; i < end; i++) this.compactView.append({ l: 0, i });
      this.compactView.fit(this.storage.root.length);
    }
    if (this.persistedCompact !== this.compactView || this.persistedCompactRevision !== this.compactView.revision || this.persistedCompactShrinking !== this.compactView.shrinking) {
      this.storage.saveView?.({ parts: pairs(this.compactView.parts), shrinking: this.compactView.shrinking }, 'compaction-view');
      this.persistedCompact = this.compactView; this.persistedCompactRevision = this.compactView.revision;
      this.persistedCompactShrinking = this.compactView.shrinking;
    }
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
    if (this.viewKeys.has(key)) this.mainView.bytes += this.size({ l, i }) - oldSize;
    this.mainView.offer(l, i); this.compactView?.offer(l, i);
    if (l === 0) { this.builtAhead.add(i); this.advance(); }
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
        if (l === 0 && i - this.first() - [...this.builtAhead].filter(index => index < i).length >= this.jobs) break;
        queue.pop(); this.queued.delete(key);
        const controller = new AbortController();
        this.busy.set(key, { controller });
        const promise = this.build(l, i, controller.signal).then(() => {
          this.busy.delete(key); this.failures.delete(key); this.fit(); this.pump();
        }).catch(error => {
          if (this.stopped) { this.busy.delete(key); return; }
          this.busy.delete(key); this.failures.add(key);
          this.report(`Compactor ${key}: ${error.message}; retrying at the next message.`);
          this.emit('change'); this.pump();
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
    this.syncCompact();
    const contextParts = this.compactView.prefix(Math.min(contextEnd, this.first())).map(part => ({ ...part }));
    const stepSource = l === 0 ? source : [this.node(l - 1, 2 * i).text, this.node(l - 1, 2 * i + 1).text].map(text => text.replace(/\r?\n/g, ' ')).join('\n');
    const start = i * 2 ** l, n = 2 ** l;
    const instruction = l === 0
      ? `Compaction: compress message ${i} into one line of at most ${this.nodeBudget} bytes\n(about 70 words), the length of this ruler:\n${'-'.repeat(this.nodeBudget)}`
      : `Compaction: merge lines ${start}+${n / 2} and ${start + n / 2}+${n / 2}, adjacent, into one line of at most\n${this.nodeBudget} bytes (about 70 words), the length of this ruler:\n${'-'.repeat(this.nodeBudget)}\n<chat> may hold their messages, ${start} to ${start + n - 1}, in more detail: take details\nof them from there too.`;
    const step = `${instruction}\n<input>\n${stepSource}\n</input>`;
    const messages = [
      { role: 'system', content: this.system },
      { role: 'user', content: [...viewBlocks(this.compactView.render(contextParts)), { type: 'text', text: step }] },
    ];
    const attempts = [];
    for (let t = 0; t < TRIES; t++) {
      const result = await this.model.chat(messages, { tools: this.tools, signal });
      const line = result.message.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim();
      if (!line) throw new Error('Empty compactor response.');
      if (result.finish_reason !== 'COMPLETE') throw new Error(`Incomplete compactor response: ${result.finish_reason}`);
      attempts.push(line);
      if (bytes(line) <= this.nodeBudget) break;
      messages.push(result.message, { role: 'user', content: `Too long: your line is ${bytes(line)} bytes, over the ${this.nodeBudget}-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cutBytes(line, this.nodeBudget)}| ← LIMIT` });
    }
    if (signal.aborted) throw signal.reason;
    const summary = attempts.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
    this.saveNode(l, i, summary);
    this.emit('node', { l, i, generated: true, context_parts: contextParts, attempts: attempts.length, source_bytes: bytes(source), summary_bytes: bytes(summary), duration_ms: performance.now() - started });
  }
  settle(signal) {
    this.retryFailed();
    this.pump();
    return new Promise(resolve => {
      const check = () => {
        const failed = !this.busy.size && this.failures.size && this.first() < this.storage.root.length;
        if (signal?.aborted || this.stopped || failed || this.first() === this.storage.root.length) {
          this.off('change', check); signal?.removeEventListener('abort', check);
          resolve(!signal?.aborted && !this.stopped && !failed);
        }
      };
      this.on('change', check); signal?.addEventListener('abort', check, { once: true }); check();
    });
  }
  async drain(signal) {
    while (!this.stopped && !signal?.aborted) {
      this.pump();
      if (this.remaining === 0) return true;
      if (!this.busy.size && this.failures.size) return false;
      await new Promise(resolve => {
        const done = () => { this.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
        this.once('change', done); signal?.addEventListener('abort', done, { once: true });
        if (this.stopped || signal?.aborted) done();
      });
    }
    return false;
  }
  zoom(id, n, page = 0) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.storage.root.length) return `No line ${id}+${n}.`;
    if (!Number.isSafeInteger(page) || page < 0 || (n !== 1 && page)) return 'Pages are nonnegative integers for single messages only.';
    if (n === 1) {
      // Leave room for the range label and paging instructions inside CAP.
      const r = this.storage.root[id], pages = splitText(r.text, CAP - 512);
      if (page >= pages.length) return `No page ${page} for message ${id}.`;
      const next = page + 1 < pages.length ? `zoom(${id}, 1, page: ${page + 1}) for the next page` : 'end of message';
      return `${id}+0|${r.kind}: ${pages[page]}${pages.length > 1 ? `\n[page ${page + 1}/${pages.length}; ${next}]` : ''}`;
    }
    const l = Math.log2(n) - 1, i = 2 * id / n;
    const a = this.node(l, i), b = this.node(l, i + 1);
    if (!a || !b) return `No line ${id}+${n}.`;
    return `${id}+${n / 2}|${a.text.replace(/\r?\n/g, ' ')}\n${id + n / 2}+${n / 2}|${b.text.replace(/\r?\n/g, ' ')}`;
  }
  date(id) { return this.storage.root[id] ? new Date(this.storage.root[id].date).toLocaleString() : `No message ${id}.`; }
  async stop() {
    this.stopped = true;
    const promises = [];
    for (const entry of this.busy.values()) { entry.controller.abort(); if (entry.promise) promises.push(entry.promise); }
    this.emit('change');
    await Promise.allSettled(promises);
    this.busy.clear();
  }
}
