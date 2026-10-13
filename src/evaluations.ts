import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Queue from 'effect/Queue';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Scope from 'effect/Scope';
import { auditSummaryEffect, AuditResult, JevFailure, validateAuditResult, type AuditOptions } from './jev.js';
import { checkedWire } from './providers/wire.js';
import { toolPromise } from './tool-effects.js';
import { bytes } from './constants.js';

import type { WorkflowObserver, WorkflowEvent } from './workflow-events.js';

const MAX_STATE_BYTES = 24_000;
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const EvaluationRecord = Schema.Struct({
  key: Schema.String, l: Index, i: Index,
  context_parts: Schema.optional(Schema.Array(Schema.Struct({ l: Index, i: Index }))),
  requested_model: Schema.optional(Schema.String),
  status: Schema.Literals(['queued', 'running', 'skipped', 'completed', 'error']),
  date: Schema.optional(Schema.String), state_bytes: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String), error: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String), answers: Schema.optional(AuditResult.fields.answers),
  usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)), latency_ms: Schema.optional(Schema.Number), retries: Schema.optional(Index),
});
export type EvaluationRecord = typeof EvaluationRecord.Type;
export interface EvaluationMemory extends Pick<EventEmitter, 'on' | 'off'> {
  node(l: number, i: number): { text: string } | undefined;
  storage: { root: { kind: string; text: string }[]; load(stream: string): unknown[]; telemetry(stream: string, record: unknown): unknown };
}
export interface EvaluationOptions {
  enabled?: boolean; apiKey?: string; model?: string;
  audit?: (source: string, summary: string, options: AuditOptions) => Promise<unknown>;
  concurrency?: number; retryMs?: number; onWorkflow?: WorkflowObserver;
}
export class Evaluations extends EventEmitter {
  readonly enabled: boolean; readonly reason: string;
  readonly apiKey?: string; readonly model: string;
  readonly queue: EvaluationRecord[] = [];
  readonly active = new Map<string, { controller: AbortController }>();
  readonly latest = new Map<string, EvaluationRecord>();
  private readonly scope = Scope.makeUnsafe('parallel');
  private readonly work = Effect.runSync(Queue.unbounded<EvaluationRecord>());
  private started = false; private closed = false; private closing?: Promise<void>;
  private readonly prefix = randomUUID();
  private nodeListener: (node: { generated?: boolean; l: number; i: number; context_parts?: { l: number; i: number }[] }) => void;
  onWorkflow?: WorkflowObserver;
  lastFailure?: Cause.Cause<unknown>;
  constructor(readonly memory: EvaluationMemory, private readonly options: EvaluationOptions = {}) {
    super();
    this.apiKey = options.apiKey ?? Bun.env.TYPESAFE_API_KEY;
    this.model = options.model ?? (Bun.env.TYPESAFE_MODEL || 'jev-latest');
    this.enabled = (options.enabled ?? true) && Boolean(this.apiKey);
    this.reason = options.enabled === false ? 'disabled' : !this.apiKey ? 'missing TYPESAFE_API_KEY' : 'enabled';
    this.onWorkflow = options.onWorkflow;
    for (const input of memory.storage.load('evaluations')) {
      const record = checkedWire(EvaluationRecord, input); this.latest.set(record.key, record);
    }
    for (const record of this.latest.values()) if (record.status === 'queued' || record.status === 'running') this.queue.push(record);
    this.nodeListener = node => {
      if (this.closed || !node.generated) return;
      const key = `${node.l}:${node.i}`;
      if (this.latest.has(key)) return;
      const job: EvaluationRecord = { key, l: node.l, i: node.i, context_parts: node.context_parts, requested_model: this.model, status: 'queued' };
      this.save(job); this.queue.push(job);
      if (this.started) Queue.offerUnsafe(this.work, job); else this.pump();
    };
    memory.on('node', this.nodeListener);
  }
  save(record: EvaluationRecord) {
    record = { ...record, date: new Date().toISOString() };
    this.memory.storage.telemetry('evaluations', record);
    this.latest.set(record.key, record); this.emit('update', record);
  }
  state(job: EvaluationRecord) {
    const { memory } = this;
    const summary = memory.node(job.l, job.i)?.text;
    const source = job.l === 0
      ? `${memory.storage.root[job.i].kind}: ${memory.storage.root[job.i].text}`
      : (() => {
        const left = memory.node(job.l - 1, 2 * job.i), right = memory.node(job.l - 1, 2 * job.i + 1);
        if (!left || !right) throw new Error('Missing saved evaluation source.');
        return `${left.text}\n${right.text}`;
      })();
    const lines = (job.context_parts ?? []).map(part => {
      const text = memory.node(part.l, part.i)?.text;
      if (text === undefined) throw new Error('Missing saved evaluation context.');
      return text.replace(/\r?\n/g, ' ');
    });
    if (summary === undefined) throw new Error('Missing saved summary.');
    return { source, summary, context: `<chat>\n${lines.join('\n')}\n</chat>` };
  }

  private event(job: EvaluationRecord, status: WorkflowEvent['status'], signal: AbortSignal) {
    try { this.onWorkflow?.({ operationId: `${this.prefix}/${job.key}`, kind: 'evaluation', status }, signal); } catch { /* Optional observers cannot fail an audit. */ }
  }
  // A native caller lends its Clock/context once; the owner scope supervises
  // two long-lived consumers independently of turns and drain waiters.
  pumpEffect(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() { this.start(yield* Effect.context<never>()); });
  }
  pump() { this.start(Context.empty()); }
  private start(context: Context.Context<never>) {
    if (!this.enabled || this.closed || this.started) return;
    this.started = true;
    for (const job of this.queue) Queue.offerUnsafe(this.work, job);
    const worker = Effect.gen({ self: this }, function*() {
      for (;;) {
        const job = yield* Queue.take(this.work);
        yield* Effect.sync(() => this.queue.splice(this.queue.indexOf(job), 1));
        const controller = new AbortController(); this.active.set(job.key, { controller });
        yield* this.runEffect(job, controller.signal).pipe(Effect.ensuring(Effect.sync(() => {
          controller.abort(); this.active.delete(job.key); this.emit('idle');
        })));
      }
    });
    for (let i = 0; i < (this.options.concurrency ?? 2); i++) {
      Effect.runSync(Effect.forkIn(worker.pipe(Effect.provideContext(context)), this.scope, { startImmediately: true }));
    }
  }
  private runEffect(job: EvaluationRecord, signal: AbortSignal): Effect.Effect<void> {
    const self = this; let retries = 0; const started = performance.now();
    return Effect.gen(function*() {
      const state = yield* Effect.try({ try: () => self.state(job), catch: cause => cause });
      const stateBytes = bytes(JSON.stringify(state));
      if (stateBytes > MAX_STATE_BYTES) {
        self.save({ ...job, status: 'skipped', state_bytes: stateBytes, reason: 'Complete audit state exceeds the 24,000-byte guard; source/context were not truncated.' }); return;
      }
      self.save({ ...job, status: 'running', state_bytes: stateBytes }); self.event(job, 'processing', signal);
      let attempts = 0, retryable = false;
      const attempt = Effect.suspend(() => {
        if (attempts++) { retries++; self.event(job, 'retry', signal); }
        const options: AuditOptions = { apiKey: self.apiKey, model: job.requested_model || self.model, context: state.context };
        const audit = self.options.audit
          ? toolPromise(nativeSignal => self.options.audit!(state.source, state.summary, { ...options, signal: nativeSignal })).pipe(
            Effect.catchCause(cause => Effect.failCause(Cause.map(cause, error => {
              if (error instanceof JevFailure) return error;
              const message = error instanceof Error ? error.message : 'Jev audit failed.';
              const match = /HTTP (429|503|529)\b/.exec(message);
              return new JevFailure({ message, ...(match ? { status: Number(match[1]) } : {}), cause: error });
            }))))
          : auditSummaryEffect(state.source, state.summary, options);
        return audit.pipe(Effect.timeoutOrElse({ duration: 60_000,
          orElse: () => Effect.fail(new JevFailure({ message: 'Jev audit timed out.', cause: undefined })) }),
          Effect.flatMap(result => Effect.try({ try: () => validateAuditResult(result), catch: cause => cause })));
      });
      const schedule = Schedule.exponential(self.options.retryMs ?? 1000).pipe(Schedule.while(({ attempt }) => Effect.succeed(attempt <= 2)));
      const result = yield* attempt.pipe(Effect.onExit(exit => Effect.sync(() => {
        // A transient status accompanied by a cleanup defect must not retry.
        retryable = Exit.isFailure(exit) && exit.cause.reasons.length === 1 && Cause.isFailReason(exit.cause.reasons[0]!);
      })), Effect.retry({ schedule,
        while: error => retryable && error instanceof JevFailure && [429, 503, 529].includes(error.status ?? 0) }));
      self.save({ ...job, status: 'completed', state_bytes: stateBytes, model: result.model, answers: result.answers, usage: result.usage, latency_ms: performance.now() - started, retries });
      self.event(job, 'completed', signal);
    }).pipe(Effect.onExit(exit => Effect.sync(() => {
      if (Exit.isSuccess(exit)) return;
      self.lastFailure = exit.cause;
      const canceled = self.closed || Cause.hasInterruptsOnly(exit.cause);
      const error = Cause.squash(exit.cause);
      self.save({ ...job, status: canceled ? 'queued' : 'error', latency_ms: performance.now() - started,
        ...(canceled ? {} : { error: (error instanceof Error ? error.message : 'Jev audit failed.').replaceAll(self.apiKey || '\0', '[redacted]') }) });
      self.event(job, canceled ? 'canceled' : 'failed', signal);
    })), Effect.catchCause(() => Effect.void));
  }
  async drain(signal?: AbortSignal): Promise<boolean> {
    if (!this.enabled || this.closed) return false;
    this.pump();
    while (this.queue.length || this.active.size) {
      if (signal?.aborted || this.closed) return false;
      await new Promise<void>(resolve => {
        const done = () => { this.off('idle', done); signal?.removeEventListener('abort', done); resolve(); };
        this.once('idle', done); signal?.addEventListener('abort', done, { once: true });
      });
    }
    return true;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.memory.off('node', this.nodeListener);
    for (const entry of this.active.values()) entry.controller.abort();
    this.closing = Effect.runPromise(Scope.close(this.scope, Exit.void)).finally(() => this.emit('idle'));
    return this.closing;
  }
}
