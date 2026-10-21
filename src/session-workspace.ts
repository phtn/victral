import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Sessions, type SessionSummary } from './sessions.js';
import { Session, type SessionOptions, type SessionState } from './session.js';
import { errorMessage } from './types.js';

/** Keeps one saved session active while the CLI/TUI and their subscriptions stay mounted. */
export class SessionWorkspace extends EventEmitter {
  private switching?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private relays = new Map<string, (...args: unknown[]) => void>();
  lastFailure?: unknown;

  private constructor(private session: Session, private catalog: Sessions) {
    super();
    this.attach(session);
  }

  static async open(options: SessionOptions): Promise<SessionWorkspace> {
    const catalog = await Sessions.open(path.resolve(options.chatDir));
    let session: Session | undefined;
    try {
      const active = catalog.active;
      const directory = catalog.directoryFor(active.id);
      if (active.id !== 'default' && !fs.existsSync(directory)) throw new Error('The selected session directory is missing. Restore it from backup.');
      session = await Session.open({ ...options, chatDir: directory });
      catalog.saveCurrent();
      return new SessionWorkspace(session, catalog);
    } catch (error) {
      const cleanup = await Promise.allSettled([session?.close(), catalog.close()]);
      const errors = [error, ...cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])];
      throw errors.length === 1 ? error : new AggregateError(errors, 'Workspace startup failed.');
    }
  }

  get options(): SessionOptions { return this.session.options; }
  get metrics(): Session['metrics'] { return this.session.metrics; }

  snapshot(): SessionState {
    return { ...this.session.snapshot(), session: this.catalog.active, sessions: this.catalog.list(), ...(this.switching ? { switching: true } : {}) };
  }

  private attach(session: Session): void {
    for (const event of ['update', 'text', 'notice', 'errorText', 'idle', 'tool']) {
      const relay = (...args: unknown[]) => this.emit(event, ...args);
      this.relays.set(event, relay);
      session.on(event, relay);
    }
  }

  private detach(session: Session): void {
    for (const [event, relay] of this.relays) session.off(event, relay);
    this.relays.clear();
  }

  cancel(): void { this.session.cancel(); }

  private sessionList(): string {
    const active = this.catalog.active;
    return `Current session: ${active.name} (${active.id})\n\n` + this.catalog.list().map((session, index) =>
      `${session.id === active.id ? '●' : ' '} ${index + 1}. ${session.id.padEnd(8)} ${session.name}`).join('\n')
      + '\n\n/new [NAME] creates a fresh session. /session ID, number, or exact name opens a saved session.';
  }

  async submit(input: string): Promise<void> {
    while (this.switching) await this.switching.catch(() => {});
    if (this.closed || this.closing) return;
    const line = input.trim();
    if (!line) return;
    const [command, ...args] = line.split(/\s+/);
    const argument = args.join(' ');
    if (command === '/exit') { await this.close(); return; }
    if (!['/new', '/sessions', '/session'].includes(command!)) { await this.session.submit(input); return; }
    try {
      if (command === '/sessions' || (command === '/session' && !argument)) {
        if (command === '/sessions' && argument) throw new Error('Usage: /sessions');
        this.session.notify(this.sessionList());
        return;
      }
      if (!this.session.canSwitchSessions) throw new Error('Switch sessions between turns; /cancel ends the current turn.');
      const isNew = command === '/new';
      const target = isNew ? this.catalog.create(argument) : this.catalog.resolve(argument);
      if (target.id === this.catalog.active.id) {
        this.session.notify(`Already in ${target.name} (${target.id}).`);
        return;
      }
      const pending = this.openSession(target, isNew);
      this.switching = pending;
      this.emit('update');
      try { await pending; }
      finally { this.switching = undefined; this.emit('update'); }
    } catch (error) {
      this.lastFailure = error;
      this.session.notify(errorMessage(error), true);
    }
  }

  private async openSession(target: SessionSummary, isNew: boolean): Promise<void> {
    const previous = this.session;
    const directory = this.catalog.directoryFor(target.id);
    let next: Session | undefined;
    let selected = false;
    let selectionError: unknown;
    try {
      if (!fs.existsSync(directory)) throw new Error('This session directory is missing. Restore it from backup.');
      next = await Session.open({ ...previous.options, model: previous.snapshot().model, chatDir: directory });
      try { this.catalog.select(target.id); selected = true; }
      catch (error) {
        if (this.catalog.active.id !== target.id) throw error;
        selected = true;
        selectionError = error;
      }
      this.detach(previous);
      this.session = next;
      this.attach(next);
      this.emit('update');
      try { await previous.close(); }
      catch (error) {
        this.lastFailure = error;
        next.notify('Session opened, but the previous session reported a cleanup failure.', true);
      }
      next.notify(`${isNew ? 'Created' : 'Opened'} ${target.name} (${target.id}).`);
      if (selectionError) {
        this.lastFailure = selectionError;
        next.notify('Session opened, but saving the last-selected session reported a disk sync failure.', true);
      }
    } catch (error) {
      const errors: unknown[] = [error];
      if (next && !selected) {
        try { await next.close(); } catch (cleanup) { errors.push(cleanup); }
      }
      if (isNew && !selected) {
        try { this.catalog.removeCreated(target); } catch (cleanup) { errors.push(cleanup); }
      }
      if (errors.length === 1) throw error;
      throw new AggregateError(errors, 'Session switch and cleanup failed.');
    }
  }

  async settle(signal?: AbortSignal): Promise<void> {
    while (this.switching) await this.switching.catch(() => {});
    await this.session.settle(signal);
  }

  close(): Promise<void> { return this.closing ??= this.shutdown(); }

  private async shutdown(): Promise<void> {
    this.closed = true;
    await this.switching?.catch(() => {});
    const errors: unknown[] = [];
    try { await this.session.close(); } catch (error) { errors.push(error); }
    this.detach(this.session);
    try { await this.catalog.close(); } catch (error) { errors.push(error); }
    this.emit('closed');
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Workspace cleanup failed.');
  }
}
