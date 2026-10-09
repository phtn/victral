import { bytes } from './constants.js';

const key = part => `${part.l}:${part.i}`;
export const pairs = parts => parts.map(({ l, i }) => [l, i]);
export function restoreParts(saved, memory, { built = false } = {}) {
  if (!Array.isArray(saved)) throw new Error('Invalid saved view; restore it from backup.');
  let cursor = 0;
  return saved.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid saved view range.');
    const [l, i] = pair, part = { l, i };
    if (!Number.isSafeInteger(l) || l < 0 || l > 52 || !Number.isSafeInteger(i) || i < 0 ||
        memory.start(part) !== cursor || memory.end(part) > memory.storage.root.length ||
        ((built || l > 0) && !memory.node(l, i))) throw new Error('Invalid saved view coverage or missing tree node.');
    cursor = memory.end(part);
    return part;
  });
}

// Both views use the same merge order. Only the batch thresholds differ.
export class SummaryView {
  constructor(memory, high, low, parts = [], shrinking = false) {
    Object.assign(this, { memory, high, low, shrinking });
    this.parts = []; this.keys = new Set(); this.merges = new Map(); this.revision = 0;
    this.bytes = bytes('<chat>\n</chat>');
    for (const part of parts) this.append(part);
  }
  size(part) { return bytes(this.line(part) + '\n'); }
  line(part, ids = true) {
    return `${ids ? `${this.memory.start(part)}+${2 ** part.l}|` : ''}${this.memory.text(part).replace(/\r\n|\r|\n/g, ' ')}`;
  }
  append(part) {
    this.parts.push(part); this.keys.add(key(part)); this.bytes += this.size(part);
    this.revision++;
    this.offer(part.l + 1, Math.floor(part.i / 2));
  }
  offer(l, i) {
    if (l > 0 && this.keys.has(`${l - 1}:${2 * i}`) && this.keys.has(`${l - 1}:${2 * i + 1}`) && this.memory.node(l, i)) {
      this.merges.set(`${l}:${i}`, { l, i });
    }
  }
  fit(T, force = false) {
    if (force || this.bytes > this.high) this.shrinking = true;
    let merged = 0;
    while (this.shrinking && this.bytes > this.low && this.merges.size) {
      let parent, weight = -Infinity;
      for (const candidate of this.merges.values()) {
        // Age is measured from the pair's LAST message, in child-line units.
        const due = (T - (this.memory.end(candidate) - 1)) / 2 ** (candidate.l - 1);
        if (!parent || due > weight || (due === weight && this.memory.start(candidate) < this.memory.start(parent))) {
          parent = candidate; weight = due;
        }
      }
      const a = { l: parent.l - 1, i: 2 * parent.i }, b = { l: a.l, i: a.i + 1 };
      const at = this.parts.findIndex(part => key(part) === key(a));
      this.bytes += this.size(parent) - this.size(a) - this.size(b);
      this.keys.delete(key(a)); this.keys.delete(key(b)); this.keys.add(key(parent));
      this.merges.delete(key(parent)); this.parts.splice(at, 2, parent);
      this.revision++;
      this.offer(parent.l + 1, Math.floor(parent.i / 2)); merged++;
    }
    if (this.bytes <= this.low) this.shrinking = false;
    return merged;
  }
  prefix(end) {
    const parts = [];
    const visit = part => {
      if (this.memory.start(part) >= end) return;
      if (this.memory.end(part) <= end) { parts.push(part); return; }
      // Only the boundary node is opened to stop exactly at the task's end.
      if (part.l > 0) { visit({ l: part.l - 1, i: 2 * part.i }); visit({ l: part.l - 1, i: 2 * part.i + 1 }); }
    };
    for (const part of this.parts) { if (this.memory.start(part) >= end) break; visit(part); }
    return parts;
  }
  render(parts = this.parts, ids = true) {
    return `<chat>\n${parts.map(part => this.line(part, ids)).join('\n')}${parts.length ? '\n' : ''}</chat>`;
  }
}
