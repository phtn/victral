import { randomUUID } from 'node:crypto';
import type { WorkflowObserver, WorkflowEvent } from './workflow-events.js';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Schema from 'effect/Schema';
import { ProviderOutputLimit } from './providers/core.js';
import { runToolEffect, toolPromise } from './tool-effects.js';
import type { MemoryPort, ModelPort, AgentTools, Message, TurnRecord, ToolActivity, MessageKind } from './types.js';
import { errorMessage } from './types.js';
import { viewBlocks } from './view.js';
import { systemPrompt } from './prompt.js';
import { capResult } from './constants.js';
import { smoothResponseEffect } from './smooth-response.js';

export class TurnFailure extends Schema.TaggedError<TurnFailure>()('TurnFailure', {
  phase: Schema.Literals(['settle', 'model', 'tool', 'callback']), message: Schema.String, cause: Schema.Defect(),
}) {}
const turnFailure = <A>(effect: Effect.Effect<A, unknown>, phase: TurnFailure['phase']): Effect.Effect<A, TurnFailure> =>
  Effect.catchCause(effect, cause => Effect.failCause(Cause.map(cause, error => error instanceof TurnFailure ? error : new TurnFailure({ phase,
    message: phase === 'settle' ? 'Memory compaction failed. Send another message to retry.'
      : error instanceof ProviderOutputLimit ? 'Model output limit reached; response is incomplete.' : errorMessage(error), cause: error,
  }))));
const abortTurn = (signal: AbortSignal): Effect.Effect<void> => Effect.callback(resume => {
  const abort = () => resume(Effect.void);
  if (signal.aborted) { abort(); return; }
  signal.addEventListener('abort', abort, { once: true });
  return Effect.sync(() => signal.removeEventListener('abort', abort));
});
interface TurnState { id: string; started: number; settled?: number; toolCalls: number; retrievals: number }

interface RunnerOptions {
  maxModelSteps?: number;
  onWorkflow?: WorkflowObserver;
  runEffect?: (effect: Effect.Effect<void, never>) => Promise<void>;
  onText?: (text: string) => void; onThought?: (text: string) => void;
  onError?: (text: string) => void; onTurn?: (record: TurnRecord) => void;
  onTool?: (activity: ToolActivity) => void;
  onPhase?: (phase: string) => void;
}
export class Runner {
  system: string;
  queue: { text: string; logged: boolean; kind: MessageKind }[];
  maxModelSteps: number;
  active: boolean;
  inCall: boolean;
  controller: AbortController | null;
  closed: boolean;
  running?: Promise<void>;
  // Internal diagnostics only; never include raw causes in memory or events.
  lastFailure?: Cause.Cause<TurnFailure>;
  private readonly executeEffect: (effect: Effect.Effect<void, never>) => Promise<void>;
  private closing?: Promise<void>;
  private readonly onWorkflow: WorkflowObserver;
  onText: (text: string) => void;
  onThought: (text: string) => void;
  onError: (text: string) => void;
  onTurn: (record: TurnRecord) => void;
  onTool: (activity: ToolActivity) => void;
  onPhase: (phase: string) => void;
  constructor(public memory: MemoryPort, public model: ModelPort, public tools: AgentTools, instructions = '', { onText = () => {}, onThought = () => {}, onError = console.error, onTurn = () => {}, onTool = () => {}, onPhase = () => {}, maxModelSteps = Infinity, onWorkflow = () => {}, runEffect = effect => runToolEffect(effect) }: RunnerOptions = {}) {
    this.maxModelSteps = maxModelSteps;
    this.executeEffect = runEffect; this.onWorkflow = onWorkflow;
    this.onText = onText; this.onThought = onThought; this.onError = onError; this.onTurn = onTurn; this.onTool = onTool;
    this.onPhase = onPhase;
    this.system = systemPrompt(instructions);
    memory.configure?.(this.system, tools.definitions);
    this.queue = [];
    this.active = false;
    this.inCall = false;
    this.controller = null;
    this.closed = false;
  }
  submit(text: string, kind: MessageKind = 'user'): Promise<void> {
    const entry = { text, logged: false, kind };
    if (this.inCall) { this.memory.append(kind, text); entry.logged = true; }
    this.queue.push(entry);
    return this.active ? this.running! : this.run();
  }
  cancel() { this.controller?.abort(); }
  take() {
    const entries = this.queue.splice(0);
    for (const entry of entries) if (!entry.logged) { this.memory.append(entry.kind, entry.text); entry.logged = true; }
    return entries;
  }
  private emit(event: WorkflowEvent, signal?: AbortSignal) {
    // Optional observers (including audio) never fail or retry the workflow.
    try { this.onWorkflow(event, signal); } catch { /* Independent observer. */ }
  }
  private attempt<A>(phase: TurnFailure['phase'], run: () => A): Effect.Effect<A, TurnFailure> {
    return turnFailure(Effect.try({ try: run, catch: error => error }), phase);
  }
  private toolEffect(call: NonNullable<Message['tool_calls']>[number], messages: Message[], state: TurnState, signal: AbortSignal) {
    return Effect.gen({ self: this }, function*() {
      state.toolCalls++; if (call.function.name === 'zoom') state.retrievals++;
      yield* this.attempt('tool', () => signal.throwIfAborted());
      const started = performance.now(), operationId = `${state.id}/tool-${state.toolCalls}`;
      this.emit({ operationId, kind: 'tool', status: 'processing' }, signal);
      yield* this.attempt('callback', () => this.onTool({ name: call.function.name, status: 'running' }));
      const execute = Effect.gen({ self: this }, function*() {
        const args = yield* this.attempt('tool', () => {
          const args: unknown = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
          return args;
        });
        const nested = (name: string) => { state.toolCalls++; if (name === 'zoom') state.retrievals++; };
        const effect = yield* this.attempt('tool', () => this.tools.executeEffect
          ? this.tools.executeEffect(call.function.name, args, nested, signal)
          : toolPromise(actual => this.tools.execute(call.function.name, args, actual, nested)));
        return yield* turnFailure(effect, 'tool');
      }).pipe(Effect.onExit(exit => this.attempt('callback', () => {
        this.emit({ operationId, kind: 'tool', status: signal.aborted || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 'canceled' : Exit.isSuccess(exit) ? 'completed' : 'failed' }, signal);
        this.onTool({ name: call.function.name, status: Exit.isSuccess(exit) ? 'completed' : 'error', duration_ms: performance.now() - started });
      }).pipe(Effect.orDie)));
      const output = yield* Effect.catchCause(execute, cause => {
        if (signal.aborted || Cause.hasInterrupts(cause) || Cause.hasDies(cause) || cause.reasons.length > 1) return Effect.failCause(cause);
        return Effect.succeed(`Error: ${errorMessage(Cause.squash(cause))}`);
      });
      yield* this.attempt('tool', () => {
        const clipped = capResult(String(output));
        this.memory.append('echo', clipped);
        messages.push({ role: 'tool', tool_call_id: call.id, content: [{ type: 'text', text: clipped }] });
      });
    });
  }
  private turnEffect(state: TurnState, signal: AbortSignal): Effect.Effect<void, TurnFailure> {
    return Effect.gen({ self: this }, function*() {
      if (signal.aborted) return yield* Effect.interrupt;
      const ready = yield* turnFailure(this.memory.settleEffect ? this.memory.settleEffect(signal) : toolPromise(actual => this.memory.settle(actual)), 'settle');
      if (!ready) return yield* Effect.fail(new TurnFailure({ phase: 'settle', message: 'Memory compaction failed. Send another message to retry.', cause: undefined }));
      const messages = yield* this.attempt<Message[]>('callback', () => {
        state.settled = performance.now();
        const view = this.memory.render(); // Always before new input is logged.
        const entries = this.take(), context = this.tools.context?.();
        this.inCall = true;
        return [
          { role: 'system', content: this.system },
          { role: 'user', content: [...viewBlocks(view), ...(context ? [{ type: 'text', text: context }] : []), { type: 'text', text: entries.map(entry => entry.text).join('\n\n') }] },
        ] satisfies Message[];
      });
      let modelSteps = 0;
      for (;;) {
        yield* this.attempt('model', () => {
          if (modelSteps++ >= this.maxModelSteps) throw new Error(`Model step limit (${this.maxModelSteps}) reached; task is incomplete.`);
          this.onPhase('Waiting for response');
        });
        const operationId = `${state.id}/model-${modelSteps}`;
        this.emit({ operationId, kind: 'model', status: 'processing' }, signal);
        const calls = yield* Effect.gen({ self: this }, function*() {
          const result = yield* turnFailure(smoothResponseEffect(this.model, messages, {
            tools: this.tools.definitions, onText: this.onText, onThought: this.onThought,
            onEntry: (kind, text) => this.memory.append(kind, text),
          }), 'model');
          return yield* this.attempt('model', () => {
            messages.push(result.message); // Keep native provider content intact.
            if (result.finish_reason === 'MAX_TOKENS') throw new Error('Model output limit reached; response is incomplete.');
            if (result.finish_reason !== 'COMPLETE' && result.finish_reason !== 'TOOL_CALL') throw new Error(`Model response did not complete: ${result.finish_reason ?? 'missing finish reason'}.`);
            const calls = result.message.tool_calls ?? [];
            if (result.finish_reason === 'TOOL_CALL' && !calls.length) throw new Error('Model requested a tool step without tool calls.');
            return calls;
          });
        }).pipe(Effect.onExit(exit => Effect.sync(() => this.emit({ operationId, kind: 'model',
          status: signal.aborted || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 'canceled' : Exit.isSuccess(exit) ? 'completed' : 'failed',
        }, signal))));
        for (const call of calls) yield* this.toolEffect(call, messages, state, signal);
        // Inject user instructions and worker reports only at this boundary.
        const added = yield* this.attempt('callback', () => {
          if (!this.queue.length) return false;
          messages.push({ role: 'user', content: this.take().map(entry => entry.text).join('\n\n') });
          return true;
        });
        if (added) continue;
        if (!calls.length) break;
      }
    });
  }
  run(): Promise<void> {
    if (this.active) return this.running!;
    // Publish ownership and the shared drain Promise before any callbacks run.
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.running = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.active = true;
    const workflow = Effect.gen({ self: this }, function*() {
      while (this.queue.length && !this.closed) {
        const state: TurnState = { id: randomUUID(), started: performance.now(), toolCalls: 0, retrievals: 0 };
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.emit({ operationId: state.id, kind: 'turn', status: 'processing' }, signal);
        const exit = yield* Effect.scoped(Effect.gen({ self: this }, function*() {
          const turn = yield* Effect.forkScoped(this.turnEffect(state, signal), { startImmediately: true });
          yield* Effect.forkScoped(Effect.flatMap(abortTurn(signal), () => Fiber.interrupt(turn)), { startImmediately: true });
          // Await the worker's actual Exit. raceFirst would discard a losing
          // worker's cleanup defects when the abort watcher wins.
          return yield* Fiber.await(turn);
        }));
        yield* Effect.sync(() => {
          this.inCall = false;
          this.lastFailure = Exit.isFailure(exit) ? exit.cause : undefined;
          const canceled = signal.aborted || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
          const status: TurnRecord['status'] = canceled ? 'canceled' : Exit.isFailure(exit) ? 'error' : 'completed';
          try {
            if (state.settled === undefined) {
              this.take(); // Retain unanswered input when settle fails/cancels.
              if (!canceled) this.onError('Memory compaction failed. Send another message to retry.');
            } else if (Exit.isFailure(exit)) {
              this.onError(canceled ? 'Turn canceled. Completed entries remain saved.'
                : Cause.hasDies(exit.cause) ? 'An unexpected error occurred.' : errorMessage(Cause.squash(exit.cause)));
            }
          } finally {
            try {
              this.emit({ operationId: state.id, kind: 'turn', status: status === 'completed' ? 'completed' : status === 'canceled' ? 'canceled' : 'failed' }, signal);
              this.onTurn({ status, ...(state.settled === undefined ? {} : { model: this.model.model }),
                duration_ms: performance.now() - state.started, settle_ms: (state.settled ?? performance.now()) - state.started,
                tool_calls: state.toolCalls, retrievals: state.retrievals,
              });
            } finally { if (canceled) this.take(); }
          }
        });
        if (signal.aborted || state.settled === undefined) break;
      }
    }).pipe(Effect.ensuring(Effect.sync(() => { this.inCall = false; this.active = false; this.controller = null; })));
    try { void this.executeEffect(workflow).then(resolve, reject); }
    catch (error) { this.active = false; this.controller = null; reject(error); }
    return this.running;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.cancel();
    this.closing = this.finishClose();
    return this.closing;
  }
  private async finishClose() {
    const errors: unknown[] = [];
    try { await this.running; } catch (error) { errors.push(error); }
    this.take();
    try { await this.tools.close?.(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Runner cleanup failed.');
  }
}
