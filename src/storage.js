import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { bytes } from './constants.js';

export function day(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function appendLine(filename, record) {
  const fresh = !fs.existsSync(filename);
  const fd = fs.openSync(filename, 'a', 0o600);
  try {
    const data = Buffer.from(JSON.stringify(record) + '\n');
    if (fs.writeSync(fd, data) !== data.length) throw new Error('Short log write; restart to recover.');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (fresh) syncDirectory(path.dirname(filename));
}
export async function acquireLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'lock');
  const bind = () => new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.end());
    server.once('error', reject);
    server.listen(filename, () => { server.removeListener('error', reject); resolve(server); });
  });
  let server;
  try { server = await bind(); } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const before = fs.lstatSync(filename);
    const stale = await new Promise((resolve, reject) => {
      const socket = net.createConnection(filename);
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', err => {
        if (['ECONNREFUSED', 'ENOENT'].includes(err.code)) resolve(true);
        else reject(err);
      });
    });
    if (!stale) throw new Error('This chat is already open in another process.');
    const after = fs.existsSync(filename) ? fs.lstatSync(filename) : null;
    if (after && after.ino !== before.ino) throw new Error('Chat lock changed; retry opening it.');
    if (after) fs.unlinkSync(filename);
    server = await bind();
  }
  return () => new Promise(resolve => server.close(resolve));
}

export class Storage {
  static async open(directory, report = console.error) {
    const release = await acquireLock(directory);
    try { return new Storage(directory, release, report); }
    catch (error) { await release(); throw error; }
  }
  constructor(directory, release, report) {
    this.directory = directory;
    this.release = release;
    this.report = report;
    for (const sub of ['main', 'tree', 'usage', 'metrics', 'evaluations']) {
      fs.mkdirSync(path.join(directory, sub), { recursive: true, mode: 0o700 });
    }
    this.root = this.load('main');
    this.root.sort((a, b) => a.i - b.i);
    this.root.forEach((record, i) => {
      if (record.i !== i || typeof record.text !== 'string' || !['user', 'talk', 'tool', 'echo', 'note'].includes(record.kind)) {
        throw new Error('Invalid message IDs or records. Restore the log from backup before continuing.');
      }
    });
    this.nodes = new Map();
    for (const node of this.load('tree')) {
      if (!Number.isSafeInteger(node.l) || node.l < 0 || !Number.isSafeInteger(node.i) || node.i < 0 || typeof node.text !== 'string') {
        throw new Error('Invalid tree record.');
      }
      if ((node.i + 1) * 2 ** node.l > this.root.length) throw new Error('Tree node extends beyond saved history.');
      this.nodes.set(`${node.l}:${node.i}`, { ...node, size: bytes(node.text) });
    }
  }
  load(sub) {
    const directory = path.join(this.directory, sub);
    const records = [];
    for (const filename of fs.readdirSync(directory).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
      const full = path.join(directory, filename);
      const contents = fs.readFileSync(full, 'utf8');
      const lines = contents.split('\n');
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        try { records.push(JSON.parse(line)); }
        catch { this.report(`Skipped invalid JSON at ${sub}/${filename}:${i + 1}`); }
      });
      if (contents && !contents.endsWith('\n')) {
        const fd = fs.openSync(full, 'a');
        try { fs.writeSync(fd, '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    }
    return records;
  }
  append(kind, text) {
    if (!['user', 'talk', 'tool', 'echo', 'note'].includes(kind) || typeof text !== 'string') throw new Error('Invalid message.');
    const date = new Date();
    const record = { i: this.root.length, kind, text, size: bytes(`${kind}: ${text}`), date: date.toISOString() };
    appendLine(path.join(this.directory, 'main', `${day(date)}.jsonl`), record);
    this.root.push(record);
    return record;
  }
  saveNode(l, i, text) {
    const key = `${l}:${i}`;
    if (this.nodes.has(key)) throw new Error('Cannot replace a persisted node.');
    const record = { l, i, text, size: bytes(text) };
    appendLine(path.join(this.directory, 'tree', `${day()}.jsonl`), record);
    this.nodes.set(key, record);
    return record;
  }
  usage(record) {
    appendLine(path.join(this.directory, 'usage', `${day()}.jsonl`), { date: new Date().toISOString(), ...record });
  }
  telemetry(stream, record) {
    if (!['metrics', 'evaluations'].includes(stream)) throw new Error('Invalid telemetry stream.');
    appendLine(path.join(this.directory, stream, `${day()}.jsonl`), { date: new Date().toISOString(), ...record });
  }
  async close() { await this.release(); }
}
