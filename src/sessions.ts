import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Schema from 'effect/Schema';
import { acquireLock } from './storage.js';
import { checkedWire } from './providers/wire.js';
import { safeText } from './terminal-text.js';

export interface SessionSummary { id: string; name: string }

const SessionId = Schema.String.check(Schema.isPattern(/^(?:default|[0-9a-f]{8})$/));
const SessionName = Schema.NonEmptyString.check(Schema.isMaxLength(80), Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f]+$/));
const Catalog = Schema.Struct({ version: Schema.Literal(1), active: SessionId,
  sessions: Schema.Array(Schema.Struct({ id: SessionId, name: SessionName })).check(Schema.isMinLength(1)) });
type CatalogState = typeof Catalog.Type;

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Keeps the original session at the configured chat directory for compatibility. */
export class Sessions {
  private state: CatalogState;
  private closing?: Promise<void>;

  private constructor(readonly directory: string, private release: () => Promise<void>) {
    const filename = path.join(directory, 'sessions.json');
    if (!fs.existsSync(filename)) {
      this.state = { version: 1, active: 'default', sessions: [{ id: 'default', name: 'Original session' }] };
      return;
    }
    try {
      const state = checkedWire(Catalog, JSON.parse(fs.readFileSync(filename, 'utf8')));
      const ids = new Set(state.sessions.map(session => session.id));
      if (ids.size !== state.sessions.length || !ids.has(state.active) || !ids.has('default')) throw new Error('Invalid session references.');
      this.state = state;
    } catch { throw new Error('Invalid sessions.json; restore it from backup before continuing.'); }
  }

  static async open(directory: string): Promise<Sessions> {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(path.join(directory, '.sessions-lock'));
    try { return new Sessions(directory, release); }
    catch (error) {
      try { await release(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Session catalog startup and cleanup failed.'); }
      throw error;
    }
  }

  get active(): SessionSummary { return { ...this.state.sessions.find(session => session.id === this.state.active)! }; }
  list(): SessionSummary[] { return this.state.sessions.map(session => ({ ...session })); }

  directoryFor(id: string): string {
    if (!this.state.sessions.some(session => session.id === id)) throw new Error('Unknown session. Use /sessions to list saved sessions.');
    return id === 'default' ? this.directory : path.join(this.directory, 'sessions', id);
  }

  resolve(selection: string): SessionSummary {
    const exact = this.state.sessions.find(session => session.id === selection.toLowerCase());
    if (exact) return { ...exact };
    if (/^[1-9]\d*$/.test(selection)) {
      const numbered = this.state.sessions[Number(selection) - 1];
      if (numbered) return { ...numbered };
    }
    const named = this.state.sessions.filter(session => session.name.toLowerCase() === selection.toLowerCase());
    if (named.length > 1) throw new Error('Multiple sessions have that name. Select an ID from /sessions.');
    if (named[0]) return { ...named[0] };
    throw new Error('Unknown session. Use /sessions to list saved sessions.');
  }

  create(name: string): SessionSummary {
    const normalized = safeText(name).replace(/\s+/g, ' ').trim() || `Session ${this.state.sessions.length + 1}`;
    try { checkedWire(SessionName, normalized); }
    catch { throw new Error('Session names must contain between 1 and 80 characters.'); }
    let id: string;
    do { id = randomUUID().slice(0, 8); }
    while (this.state.sessions.some(session => session.id === id) || fs.existsSync(path.join(this.directory, 'sessions', id)));
    const session = { id, name: normalized };
    const parent = path.join(this.directory, 'sessions');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(parent, id), { mode: 0o700 });
    syncDirectory(parent);
    this.save({ ...this.state, sessions: [...this.state.sessions, session] });
    return session;
  }

  select(id: string): void {
    this.directoryFor(id);
    this.save({ ...this.state, active: id });
  }

  /** Rolls back a just-created, still-unselected session if it cannot be opened. */
  removeCreated(session: SessionSummary): void {
    if (session.id === 'default' || this.state.active === session.id) throw new Error('Cannot remove the active or original session.');
    if (this.state.sessions.some(item => item.id === session.id)) {
      this.save({ ...this.state, sessions: this.state.sessions.filter(item => item.id !== session.id) });
    }
    const directory = path.join(this.directory, 'sessions', session.id);
    fs.rmSync(directory, { recursive: true, force: true });
    syncDirectory(path.dirname(directory));
  }

  saveCurrent(): void { this.save(this.state); }

  private save(state: CatalogState): void {
    const filename = path.join(this.directory, 'sessions.json');
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        const data = Buffer.from(JSON.stringify(state) + '\n');
        if (fs.writeSync(fd, data) !== data.length) throw new Error('Short session catalog write.');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    this.state = state;
    syncDirectory(this.directory);
  }

  close(): Promise<void> { return this.closing ??= this.release(); }
}
