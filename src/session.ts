import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Storage, STORAGE_STREAMS, VIEW_FILES } from './storage.js';
import { Memory } from './memory.js';
import { createModel, formatModelsList, resolveModelId } from './models.js';
import { Evaluations } from './evaluations.js';
import { Metrics } from './metrics.js';
import { Runner } from './runner.js';
import { projectTools } from './tools.js';
import { errorMessage, type ModelPort, type ToolActivity, type TurnRecord } from './types.js';
import type { JevStatus } from './jev-status.js';
import { COMMANDS } from './session-commands.js';
export { COMMANDS } from './session-commands.js';

// Provider/storage implementations retain their existing JS API during migration.
const modelFactory = createModel as unknown as (id: string, options: { purpose?: string; usage: (record: unknown) => void }) => ModelPort;
export interface SessionOptions {
  project: string; chatDir: string; model: string; compactorModel: string;
  instructions?: string; allowShell: boolean; jev: boolean; metrics: boolean;
}
export interface TranscriptEntry { id: number; role: 'you' | 'victral' | 'system' | 'error' | 'tool'; text: string }
export interface SessionState {
  entries: readonly TranscriptEntry[]; model: string; active: boolean;
  phase: string; tool?: ToolActivity; turn?: TurnRecord; metrics: string; jev?: JevStatus;
}
export class Session extends EventEmitter {
  entries: TranscriptEntry[] = [];
  phase = 'Ready';
  tool?: ToolActivity;
  turn?: TurnRecord;
  private id = 0;
  private closed = false;
  private closing?: Promise<void>;
  private updateTimer?: ReturnType<typeof setTimeout>;
  private runner: Runner;
  private evaluationListener: () => void;

  private constructor(readonly options: SessionOptions, readonly storage: Storage, readonly memory: Memory, readonly evaluations: Evaluations, readonly metrics: Metrics, model: ModelPort) {
    super();
    this.runner = new Runner(memory, model, projectTools(memory, options.project, { allowShell: options.allowShell,
      planStore: { load: () => storage.load('plans'), save: plan => storage.savePlan(plan) },
    }), this.instructions(), {
      onText: text => {
        const last = this.entries.at(-1);
        if (last?.role === 'victral') last.text += text;
        else this.add('victral', text, false);
        this.phase = 'Responding'; this.emit('text', text); this.scheduleUpdate();
      },
      onThought: () => { this.phase = 'Thinking'; this.scheduleUpdate(); },
      onPhase: phase => { this.phase = phase; this.update(); },
      onError: text => { this.add('error', text); this.emit('errorText', text); },
      onTool: activity => {
        this.tool = activity;
        this.phase = activity.status === 'running' ? `Running ${activity.name}` : 'Thinking';
        if (activity.status !== 'running') this.add('tool', `${activity.name} · ${activity.status} · ${((activity.duration_ms ?? 0) / 1000).toFixed(2)}s`);
        this.emit('tool', activity); this.update();
      },
      onTurn: record => { metrics.record({ type: 'turn', ...record }); this.turn = record; },
    });
    for (const record of storage.root.slice(-60)) {
      if (record.kind === 'user' || record.kind === 'talk') this.add(record.kind === 'user' ? 'you' : 'victral', record.text, false);
    }
    this.evaluationListener = () => this.scheduleUpdate();
    evaluations.on('update', this.evaluationListener);
    evaluations.pump(); memory.pump();
  }
  static async open(options: SessionOptions): Promise<Session> {
    // Validate credentials and instructions before locking storage.
    const instructionFile = options.instructions ?? path.join(options.project, 'AGENTS.md');
    if (options.instructions && !fs.existsSync(instructionFile)) throw new Error('The instructions file does not exist.');
    let metrics: Metrics | undefined;
    const usage = (record: unknown) => metrics?.usage(record);
    const model = modelFactory(options.model, { usage });
    const compactor = modelFactory(options.compactorModel, { purpose: 'compactor', usage });
    const storage = await Storage.open(options.chatDir);
    let memory: Memory | undefined, evaluations: Evaluations | undefined;
    try {
      memory = new Memory(storage, compactor);
      evaluations = new Evaluations(memory, { enabled: options.jev });
      metrics = new Metrics(storage, memory, evaluations);
      return new Session(options, storage, memory, evaluations, metrics, model);
    } catch (error) {
      metrics?.close(); await evaluations?.close(); await memory?.stop(); await storage.close(); throw error;
    }
  }
  private instructions(): string {
    const filename = this.options.instructions ?? path.join(this.options.project, 'AGENTS.md');
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
  }
  private add(role: TranscriptEntry['role'], text: string, emit = true): void {
    this.entries.push({ id: this.id++, role, text });
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    if (emit) this.update();
  }
  private scheduleUpdate(): void {
    if (!this.updateTimer) this.updateTimer = setTimeout(() => { this.updateTimer = undefined; this.update(); }, 40);
  }
  private update(): void { if (!this.closed) this.emit('update'); }
  snapshot(): SessionState {
    return { entries: [...this.entries], model: this.runner.model.model, active: this.runner.active,
      phase: this.phase, tool: this.tool, turn: this.turn, metrics: this.options.metrics ? this.metrics.compact() : '',
      jev: this.options.metrics ? this.metrics.jevStatus() : undefined };
  }
  cancel(): void { this.runner.cancel(); this.phase = 'Canceling'; this.update(); }
  async submit(input: string): Promise<void> {
    if (this.closed || this.closing) return;
    const line = input.trim();
    if (!line) return;
    if (line.startsWith('/')) {
      try {
        const output = await this.command(line);
        if (output) { this.add('system', output); this.emit('notice', output); }
      } catch (error) { this.add('error', errorMessage(error)); this.emit('errorText', errorMessage(error)); }
      return;
    }
    this.add('you', line, false); this.phase = this.runner.active ? 'Message received · input queued' : 'Message received · preparing memory'; this.tool = undefined;
    const running = this.runner.submit(line); this.update();
    await running;
    this.phase = this.turn?.status === 'error' ? 'Turn failed' : this.turn?.status === 'canceled' ? 'Canceled' : 'Ready';
    this.update(); this.emit('idle');
  }
  private async command(line: string): Promise<string | undefined> {
    const [name, ...rest] = line.split(/\s+/); const arg = rest.join(' ');
    if (name === '/exit') { await this.close(); return; }
    if (name === '/cancel') { this.cancel(); return; }
    if (name === '/help') return COMMANDS.map(([cmd, description]) => `${cmd.padEnd(10)} ${description}`).join('\n') + '\n\nEsc cancels · Ctrl+P commands · Ctrl+O metrics · PgUp/PgDn scroll · Ctrl+C cancel / close';
    if (name === '/tools') return this.runner.tools.definitions.map(t => `${t.function.name.padEnd(14)} ${t.function.description}`).join('\n') + `\n\nCommand execution: ${this.options.allowShell ? 'enabled' : 'disabled (start with --allow-shell)'}`;
    if (name === '/metrics') return this.metrics.detailed();
    if (name === '/jev') return this.metrics.jevDetails();
    if (name === '/usage') return JSON.stringify(this.storage.load('usage').slice(-10), null, 2);
    if (name === '/view') return this.memory.render() || 'No saved messages yet.';
    if (name === '/plan') return this.runner.tools.execute('get_plan', {});
    if (name === '/jobs') return this.options.allowShell ? this.runner.tools.execute('list_commands', {}) : 'Command execution is disabled (start with --allow-shell).';
    if (name === '/model') {
      if (!arg) return `Agent: ${this.runner.model.model}\nCompactor: ${this.options.compactorModel} (fixed at startup)\nAvailable models:\n${formatModelsList()}\n\nSwitch with /model <number, short name, or ID>, e.g. /model ms1.3c. Switching is session-local and keeps saved memory.`;
      if (this.runner.active) throw new Error('Switch models between turns; /cancel ends the current turn.');
      const selected = resolveModelId(arg);
      if (selected === this.runner.model.model) return `Already using ${selected}.`;
      this.runner.model = modelFactory(selected, { usage: record => this.metrics.usage(record) }); this.update();
      return `Switched agent to ${selected}. Session-local; saved memory kept. Compactor unchanged (${this.options.compactorModel}).`;
    }
    if (name === '/zoom' || name === '/date') {
      if (!/^\d+$/.test(rest[0] ?? '')) throw new Error(`Usage: ${name} ID${name === '/zoom' ? ' N' : ''}`);
      const id = Number(rest[0]);
      if (!Number.isSafeInteger(id)) throw new Error('ID is too large.');
      if (name === '/date') return this.memory.date(id);
      if (!/^\d+$/.test(rest[1] ?? '') || (rest[2] !== undefined && !/^\d+$/.test(rest[2]))) throw new Error('Usage: /zoom ID N [PAGE]');
      return this.memory.zoom(id, Number(rest[1]), Number(rest[2] ?? 0));
    }
    if (name === '/import') {
      if (this.runner.active) throw new Error('Import history between turns.');
      if (!arg) throw new Error('Usage: /import FILE');
      this.memory.append('note', fs.readFileSync(path.resolve(arg), 'utf8'));
      return 'Imported as a historical note.';
    }
    if (name === '/backup') {
      if (!arg) throw new Error('Usage: /backup NEW_PATH');
      const destination = path.resolve(arg);
      // Resolve the parent too, so symlinks cannot put the backup inside live logs.
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const resolved = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
      if (resolved === this.storage.directory || resolved.startsWith(this.storage.directory + path.sep)) throw new Error('Choose a backup path outside the live chat directory.');
      if (fs.existsSync(destination)) throw new Error('Backup destination already exists; choose a new path.');
      fs.mkdirSync(destination, { mode: 0o700 });
      for (const sub of STORAGE_STREAMS) fs.cpSync(path.join(this.storage.directory, sub), path.join(destination, sub), { recursive: true });
      for (const file of VIEW_FILES) {
        const source = path.join(this.storage.directory, file);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, file));
      }
      return `Backup saved to ${destination}`;
    }
    throw new Error('Unknown command. Use /help or Ctrl+P.');
  }
  async settle(signal: AbortSignal): Promise<void> {
    await this.memory.settle(signal);
    await this.evaluations.drain(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.closed = true;
    clearTimeout(this.updateTimer);
    this.evaluations.off('update', this.evaluationListener);
    try { await this.runner.close(); }
    finally {
      try { await this.memory.stop(); }
      finally { try { await this.evaluations.close(); } finally { this.metrics.close(); await this.storage.close(); this.emit('closed'); } }
    }
  }
}
