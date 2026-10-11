import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import type * as Scope from 'effect/Scope';
import { Storage, STORAGE_STREAMS, VIEW_FILES } from './storage.js';
import { Memory } from './memory.js';
import { formatModelsList, resolveModelId, PROVIDERS } from './models.js';
import { Evaluations } from './evaluations.js';
import { Metrics } from './metrics.js';
import { Runner } from './runner.js';
import { Integrations, loadIntegrations } from './integrations.js';
import { Subagents } from './subagents.js';
import { projectTools, readOnlyProjectTools } from './tools.js';
import { errorMessage, type ModelPort, type ToolActivity, type TurnRecord } from './types.js';
import type { JevStatus } from './jev-status.js';
import { COMMANDS } from './session-commands.js';
import { SessionSettings, SessionModels, SessionStorage, releaseSessionResource, sessionExitValue, type ModelOptions } from './core/session-services.js';
import { AudioNotifications } from './sfx/notifications.js';
export { COMMANDS } from './session-commands.js';

type SessionEnvironment = SessionSettings | SessionModels | SessionStorage | SessionInstance | AudioNotifications;
type SessionRuntime = ManagedRuntime.ManagedRuntime<SessionEnvironment, unknown>;
export interface SessionOptions {
  project: string; chatDir: string; model: string; compactorModel: string;
  instructions?: string; webSearch?: boolean; mcpConfig?: string; allowShell: boolean; jev: boolean; metrics: boolean;
}
export interface TranscriptEntry { id: number; role: 'you' | 'victral' | 'system' | 'error' | 'tool'; text: string; format?: 'markdown' }
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
  private runner!: Runner;
  private subagents!: Subagents;
  private evaluationListener = () => this.scheduleUpdate();

  private constructor(readonly options: SessionOptions, readonly storage: Storage, readonly memory: Memory, readonly evaluations: Evaluations, readonly metrics: Metrics, private readonly runtime: SessionRuntime) {
    super();
  }
  private initialize(model: ModelPort, integrations: Integrations, transferIntegrations: () => void): Effect.Effect<void, unknown, Scope.Scope> {
    const self = this, { options, storage, memory, evaluations, metrics } = this;
    const planStore = { load: () => storage.load('plans'), save: (plan: Parameters<Storage['savePlan']>[0]) => storage.savePlan(plan) };
    return Effect.gen(function*() {
      let tools: ReturnType<typeof projectTools> | undefined;
      self.subagents = yield* Effect.acquireRelease(Effect.try({ try: () => new Subagents({
        model: () => self.createModel(self.runner.model.model, { purpose: 'subagent', webSearch: options.webSearch, usage: record => metrics.usage(record) }),
        tools: () => readOnlyProjectTools(memory, options.project, { planStore }),
        context: () => memory.render(), instructions: () => self.instructions(),
        report: text => {
          if (self.closed || self.closing) return;
          self.add('system', text);
          void self.runner.submit(text, 'work')?.then(() => {
            if (!self.closed) { self.phase = 'Ready'; self.update(); self.emit('idle'); }
          }).catch(error => self.add('error', errorMessage(error)));
        },
      }), catch: cause => cause }), agents => tools ? Effect.void : releaseSessionResource('Research workers cleanup', () => agents.close()));
      const ports = yield* Effect.acquireRelease(Effect.try({ try: () => {
        const ports = projectTools(memory, options.project, { allowShell: options.allowShell, planStore, integrations, subagents: self.subagents });
        // Handoff occurs inside uninterruptible acquisition, before publication.
        tools = ports; transferIntegrations(); return ports;
      }, catch: cause => cause }), ports => releaseSessionResource('Agent tools cleanup', () => self.runner ? self.runner.close() : ports.close?.()));
      self.runner = yield* Effect.try({ try: () => new Runner(memory, model, ports, self.instructions(), {
        onText: text => {
          const last = self.entries.at(-1);
          if (last?.role === 'victral') last.text += text;
          else self.add('victral', text, false);
          self.phase = 'Responding'; self.emit('text', text); self.scheduleUpdate();
        },
        onThought: () => { self.phase = 'Thinking'; self.scheduleUpdate(); },
        onPhase: phase => { self.phase = phase; self.update(); },
        onError: text => { self.add('error', text); self.emit('errorText', text); },
        onTool: activity => {
          self.tool = activity;
          self.phase = activity.status === 'running' ? `Running ${activity.name}` : 'Thinking';
          if (activity.status !== 'running') self.add('tool', `${activity.name} · ${activity.status} · ${((activity.duration_ms ?? 0) / 1000).toFixed(2)}s`);
          self.emit('tool', activity); self.update();
        },
        onTurn: record => { metrics.record({ type: 'turn', ...record }); self.turn = record; },
      }), catch: cause => cause });
      yield* Effect.addFinalizer(() => releaseSessionResource('Session listeners cleanup', () => {
        self.closed = true; clearTimeout(self.updateTimer); evaluations.off('update', self.evaluationListener);
      }));
      yield* Effect.try({ try: () => {
        for (const record of storage.root.slice(-60)) {
          if (record.kind === 'user' || record.kind === 'talk') self.add(record.kind === 'user' ? 'you' : 'victral', record.text, false);
        }
        evaluations.on('update', self.evaluationListener);
        evaluations.pump(); memory.pump();
      }, catch: cause => cause });
    });
  }
  static async open(options: SessionOptions): Promise<Session> {
    const layer: Layer.Layer<SessionEnvironment, unknown> = Layer.effectContext(Effect.gen(function*() {
      const settings = yield* SessionSettings, models = yield* SessionModels;
      // Validate credentials and instructions before locking storage.
      yield* Effect.try({ try: () => {
        const instructionFile = settings.instructions ?? path.join(settings.project, 'AGENTS.md');
        if (settings.instructions && !fs.existsSync(instructionFile)) throw new Error('The instructions file does not exist.');
      }, catch: cause => cause });
      let ownedMetrics: Metrics | undefined, ownedEvaluations: Evaluations | undefined, integrationsTransferred = false;
      const usage = (record: unknown) => ownedMetrics?.usage(record);
      const model = yield* models.create(settings.model, { usage, webSearch: settings.webSearch });
      const integrations = yield* Effect.acquireRelease(Effect.tryPromise({
        try: async () => settings.mcpConfig ? loadIntegrations(path.resolve(settings.mcpConfig), settings.project) : new Integrations({}, settings.project),
        catch: cause => cause,
      }), integrations => integrationsTransferred ? Effect.void : releaseSessionResource('Integrations cleanup', () => integrations.close()));
      const compactor = yield* models.create(settings.compactorModel, { purpose: 'compactor', usage });
      const storage = yield* SessionStorage.acquire(settings.chatDir);
      // Register these before memory so its final work and evaluation shutdown
      // still reach metrics. Values are assigned inside synchronous construction.
      yield* Effect.addFinalizer(() => releaseSessionResource('Metrics cleanup', () => ownedMetrics?.close()));
      yield* Effect.addFinalizer(() => releaseSessionResource('Evaluations cleanup', () => ownedEvaluations?.close()));
      const memory = yield* Effect.acquireRelease(Effect.try({ try: () => new Memory(storage, compactor), catch: cause => cause }),
        memory => releaseSessionResource('Memory cleanup', () => memory.stop()));
      const evaluations = yield* Effect.try({ try: () => ownedEvaluations = new Evaluations(memory, { enabled: settings.jev }), catch: cause => cause });
      const metrics = yield* Effect.try({ try: () => ownedMetrics = new Metrics(storage, memory, evaluations), catch: cause => cause });
      const session = new Session(options, storage, memory, evaluations, metrics, runtime);
      yield* session.initialize(model, integrations, () => { integrationsTransferred = true; });
      return Context.make(SessionInstance, session).pipe(Context.add(SessionStorage, storage));
    })).pipe(Layer.provideMerge(Layer.mergeAll(Layer.succeed(SessionSettings, options), SessionModels.layer, AudioNotifications.layerSilent)));
    const runtime: SessionRuntime = ManagedRuntime.make(layer);
    const exit = await runtime.runPromiseExit(SessionInstance);
    if (Exit.isFailure(exit)) {
      const cleanup = await Effect.runPromiseExit(runtime.disposeEffect);
      if (Exit.isFailure(cleanup)) return sessionExitValue(Exit.failCause(Cause.combine(exit.cause, cleanup.cause)), 'Session startup');
    }
    return sessionExitValue(exit, 'Session startup');
  }
  private createModel(id: string, options: ModelOptions): ModelPort {
    return sessionExitValue(this.runtime.runSyncExit(Effect.flatMap(SessionModels, models => models.create(id, options))), 'Model creation');
  }
  private instructions(): string {
    const filename = this.options.instructions ?? path.join(this.options.project, 'AGENTS.md');
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
  }
  private add(role: TranscriptEntry['role'], text: string, emit = true, format?: 'markdown'): void {
    this.entries.push({ id: this.id++, role, text, ...(format ? { format } : {}) });
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
        if (output) { this.add('system', output, true, line.split(/\s+/)[0] === '/metrics' ? 'markdown' : undefined); this.emit('notice', output); }
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
    if (name === '/help') return COMMANDS.map(([cmd, description]) => `${cmd.padEnd(10)} ${description}`).join('\n') + '\n\nType / for suggestions · Tab completes a word · ↑↓ selects suggestions · Esc cancels · Ctrl+P commands · Ctrl+O metrics · Wheel / Shift+↑↓ / PgUp/PgDn scroll · Home/End jump · Ctrl+C cancel / close';
    if (name === '/tools') return this.runner.tools.definitions.map(t => `${t.function.name.padEnd(14)} ${t.function.description}`).join('\n') + `\n\nCommand execution: ${this.options.allowShell ? 'enabled' : 'disabled (start with --allow-shell)'}`;
    if (name === '/integrations') return this.runner.tools.execute(arg ? 'list_integration_tools' : 'list_integrations', arg ? { server: arg } : {});
    if (name === '/subagents') {
      if (!arg) return this.subagents.list();
      if (rest[0] === 'stop' && rest.length === 2) return this.subagents.stop({ subagent_id: rest[1] });
      if (rest.length === 1) return this.subagents.status({ subagent_id: arg });
      throw new Error('Usage: /subagents [ID | stop ID]');
    }
    if (name === '/metrics') return this.metrics.detailed();
    if (name === '/jev') return this.metrics.jevDetails();
    if (name === '/usage') return JSON.stringify(this.storage.load('usage').slice(-10), null, 2);
    if (name === '/view') return this.memory.render() || 'No saved messages yet.';
    if (name === '/plan') return this.runner.tools.execute('get_plan', {});
    if (name === '/jobs') return this.options.allowShell ? this.runner.tools.execute('list_commands', {}) : 'Command execution is disabled (start with --allow-shell).';
    if (name === '/model') {
      if (!arg || PROVIDERS.includes(arg.toLowerCase())) return `Agent: ${this.runner.model.model}\nCompactor: ${this.options.compactorModel} (fixed at startup)\nAvailable models:\n${formatModelsList(arg || undefined)}\n\nSwitch with /model <provider> <short name or ID>, e.g. /model openai luna6. Numbers and model-only shortcuts also work. Switching is session-local and keeps saved memory.`;
      if (this.runner.active) throw new Error('Switch models between turns; /cancel ends the current turn.');
      const selected = resolveModelId(arg);
      if (selected === this.runner.model.model) return `Already using ${selected}.`;
      this.runner.model = this.createModel(selected, { webSearch: this.options.webSearch, usage: record => this.metrics.usage(record) }); this.update();
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
    if (this.closed || this.closing) return;
    do {
      await this.subagents.drain(signal);
      await this.runner.running;
    } while (this.subagents.active || this.runner.active);
    signal.throwIfAborted();
    await this.memory.settle(signal);
    await this.evaluations.drain(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.closed = true;
    const exit = await Effect.runPromiseExit(this.runtime.disposeEffect);
    this.emit('closed');
    sessionExitValue(exit, 'Session cleanup');
  }
}

class SessionInstance extends Context.Service<SessionInstance, Session>()('victral/session/Instance') {}
