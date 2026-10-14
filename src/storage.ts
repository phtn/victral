import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { bytes } from './constants.js';
import { checkStream, checkView, type StorageStream, type StreamRecord, type MessageRecord, type TreeRecord, type ViewName, type ViewState } from './storage-schema.js';

export class StorageFailure extends Schema.TaggedError<StorageFailure>()('StorageFailure', {
  operation: Schema.String, message: Schema.String, cause: Schema.Defect(),
}) {}
function failure(operation: string, cause: unknown) {
  return new StorageFailure({ operation, message: cause instanceof Error ? cause.message : 'Chat storage failed.', cause });
}

export const STORAGE_STREAMS = ['main', 'tree', 'usage', 'metrics', 'evaluations', 'plans'] as const;
export const VIEW_FILES = ['view.json', 'view-batch.json', 'compaction-view.json'];

export function day(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function syncDirectory(dir: string) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function appendLine(filename: string, record: unknown) {
  const fresh = !fs.existsSync(filename);
  const fd = fs.openSync(filename, 'a', 0o600);
  try {
    const data = Buffer.from(JSON.stringify(record) + '\n');
    if (fs.writeSync(fd, data) !== data.length) throw new Error('Short log write; restart to recover.');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (fresh) syncDirectory(path.dirname(filename));
}
export async function acquireLock(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'lock');
  const bind = () => new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer(socket => socket.end());
    server.once('error', reject);
    server.listen(filename, () => { server.removeListener('error', reject); resolve(server); });
  });
  let server;
  try { server = await bind(); } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = fs.lstatSync(filename);
    const stale = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(filename);
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', err => {
        if ('code' in err && ['ECONNREFUSED', 'ENOENT'].includes(String(err.code))) resolve(true);
        else reject(err);
      });
    });
    if (!stale) throw new Error('This chat is already open in another process.');
    const after = fs.existsSync(filename) ? fs.lstatSync(filename) : null;
    if (after && after.ino !== before.ino) throw new Error('Chat lock changed; retry opening it.');
    if (after) fs.unlinkSync(filename);
    server = await bind();
  }
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export class Storage {
  readonly root: MessageRecord[];
  readonly nodes = new Map<string, TreeRecord>();
  private closing?: Promise<void>;
  static acquire(directory: string, report: (text: string) => void = console.error) {
    return Effect.acquireRelease(
      Effect.tryPromise({ try: () => Storage.open(directory, report), catch: cause => failure('Open chat storage', cause) }),
      storage => Effect.tryPromise({ try: () => storage.close(), catch: cause => failure('Close chat storage', cause) }).pipe(Effect.orDie),
    );
  }
  static async open(directory: string, report: (text: string) => void = console.error) {
    const release = await acquireLock(directory);
    try { return new Storage(directory, release, report); }
    catch (error) {
      try { await release(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Storage startup and cleanup failed.'); }
      throw error;
    }
  }
  constructor(readonly directory: string, readonly release: () => Promise<void>, readonly report: (text: string) => void) {
    for (const sub of STORAGE_STREAMS) {
      fs.mkdirSync(path.join(directory, sub), { recursive: true, mode: 0o700 });
    }
    this.root = this.load('main');
    this.root.sort((a, b) => a.i - b.i);
    this.root.forEach((record, i) => {
      if (record.i !== i || typeof record.text !== 'string' || !['user', 'talk', 'tool', 'echo', 'work', 'note'].includes(record.kind)) {
        throw new Error('Invalid message IDs or records. Restore the log from backup before continuing.');
      }
    });
    for (const node of this.load('tree')) {
      if (!Number.isSafeInteger(node.l) || node.l < 0 || !Number.isSafeInteger(node.i) || node.i < 0 || typeof node.text !== 'string') {
        throw new Error('Invalid tree record.');
      }
      if ((node.i + 1) * 2 ** node.l > this.root.length) throw new Error('Tree node extends beyond saved history.');
      this.nodes.set(`${node.l}:${node.i}`, { ...node, size: bytes(node.text) });
    }
  }
  load<S extends StorageStream>(sub: S): StreamRecord<S>[] {
    const directory = path.join(this.directory, sub);
    const records: StreamRecord<S>[] = [];
    for (const filename of fs.readdirSync(directory).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
      const full = path.join(directory, filename);
      const contents = fs.readFileSync(full, 'utf8');
      const lines = contents.split('\n');
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        let input: unknown;
        try { input = JSON.parse(line); }
        catch { this.report(`Skipped invalid JSON at ${sub}/${filename}:${i + 1}`); return; }
        try { records.push(checkStream(sub, input)); }
        catch {
          const message = sub === 'main' ? 'Invalid message IDs or records. Restore the log from backup before continuing.'
            : sub === 'tree' ? 'Invalid tree record.' : `Invalid ${sub} record. Restore the log from backup before continuing.`;
          throw new Error(message);
        }
      });
      if (contents && !contents.endsWith('\n')) {
        const fd = fs.openSync(full, 'a');
        try { if (fs.writeSync(fd, '\n') !== 1) throw new Error('Short log repair write; restart to recover.'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    }
    return records;
  }
  append(kind: MessageRecord['kind'], text: string) {
    if (!['user', 'talk', 'tool', 'echo', 'work', 'note'].includes(kind) || typeof text !== 'string') throw new Error('Invalid message.');
    const date = new Date();
    const record = { i: this.root.length, kind, text, size: bytes(`${kind}: ${text}`), date: date.toISOString() };
    appendLine(path.join(this.directory, 'main', `${day(date)}.jsonl`), record);
    this.root.push(record);
    return record;
  }
  saveNode(l: number, i: number, text: string) {
    const key = `${l}:${i}`;
    if (this.nodes.has(key)) throw new Error('Cannot replace a persisted node.');
    const record = { l, i, text, size: bytes(text) };
    checkStream('tree', record);
    if ((i + 1) * 2 ** l > this.root.length) throw new Error('Tree node extends beyond saved history.');
    appendLine(path.join(this.directory, 'tree', `${day()}.jsonl`), record);
    this.nodes.set(key, record);
    return record;
  }
  loadView<N extends ViewName = 'view'>(name: N = 'view' as N): ViewState<N> | null {
    if (!VIEW_FILES.includes(`${name}.json`)) throw new Error('Invalid view file.');
    const filename = path.join(this.directory, `${name}.json`);
    if (!fs.existsSync(filename)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      return checkView(name, value);
    }
    catch { throw new Error(`Invalid ${name}.json; restore it from backup.`); }
  }
  saveView<N extends ViewName = 'view'>(value: ViewState<N>, name: N = 'view' as N) {
    if (!VIEW_FILES.includes(`${name}.json`)) throw new Error('Invalid view file.');
    checkView(name, value);
    const filename = path.join(this.directory, `${name}.json`), temporary = `${filename}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      const data = Buffer.from(JSON.stringify(value) + '\n');
      if (fs.writeSync(fd, data) !== data.length) throw new Error('Short view write.');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename); syncDirectory(this.directory);
  }
  usage(record: StreamRecord<'usage'>) {
    checkStream('usage', record);
    appendLine(path.join(this.directory, 'usage', `${day()}.jsonl`), { date: new Date().toISOString(), ...record });
  }
  telemetry(stream: 'metrics' | 'evaluations', record: unknown) {
    if (!['metrics', 'evaluations'].includes(stream)) throw new Error('Invalid telemetry stream.');
    const checked = checkStream(stream, record);
    appendLine(path.join(this.directory, stream, `${day()}.jsonl`), { date: new Date().toISOString(), ...checked });
  }
  savePlan(record: StreamRecord<'plans'>) {
    checkStream('plans', record);
    appendLine(path.join(this.directory, 'plans', `${day()}.jsonl`), record);
  }
  // Each durable operation is one synchronous section: validate/write/fsync,
  // then publish. No interruptible yield is permitted between those steps.
  appendEffect(kind: MessageRecord['kind'], text: string) {
    return Effect.uninterruptible(Effect.try({ try: () => this.append(kind, text), catch: cause => failure('Append message', cause) }));
  }
  saveNodeEffect(l: number, i: number, text: string) {
    return Effect.uninterruptible(Effect.try({ try: () => this.saveNode(l, i, text), catch: cause => failure('Save tree node', cause) }));
  }
  saveViewEffect<N extends ViewName>(value: ViewState<N>, name: N) {
    return Effect.uninterruptible(Effect.try({ try: () => this.saveView(value, name), catch: cause => failure('Save view', cause) }));
  }
  loadEffect<S extends StorageStream>(stream: S) {
    return Effect.try({ try: () => this.load(stream), catch: cause => failure('Load chat records', cause) });
  }
  close(): Promise<void> { return this.closing ??= this.release(); }
}
