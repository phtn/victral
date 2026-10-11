import { randomUUID } from 'node:crypto';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import { EffectAdapterError, legacyExitValue } from '../core/async.js';
import { Http, HttpFailure, readResponseBytes, responseAbort } from '../core/http.js';
import type { Message } from '../types.js';
import type { ProviderOptions, ProviderResult, ProviderPurpose, StreamOptions, RequestOptions, UsageRecord } from './types.js';

export class ProviderFailure extends Schema.TaggedError<ProviderFailure>()('ProviderFailure', {
  provider: Schema.String, reason: Schema.Literals(['transport', 'http', 'malformed', 'truncated', 'provider']),
  message: Schema.String, status: Schema.optional(Schema.Int), cause: Schema.Defect(),
}) {}
// A limit retains partial/native output. Current Promise callers recover the
// result as MAX_TOKENS; no retry or fallback is performed at this boundary.
export class ProviderOutputLimit extends Schema.TaggedError<ProviderOutputLimit>()('ProviderOutputLimit', {
  provider: Schema.String, result: Schema.Unknown,
}) { declare readonly result: ProviderResult; }
export type ProviderError = ProviderFailure | ProviderOutputLimit;
export interface ProviderService {
  readonly model: string;
  readonly chat: (messages: Message[], options?: Omit<RequestOptions, 'signal'>) => Effect.Effect<ProviderResult, ProviderError>;
  readonly stream: (messages: Message[], options?: Omit<StreamOptions, 'signal'>) => Effect.Effect<ProviderResult, ProviderError>;
}
export class ProviderModel extends Context.Service<ProviderModel, ProviderService>()('victral/providers/Model') {
  static layer(service: ProviderService): Layer.Layer<ProviderModel> { return Layer.succeed(ProviderModel, service); }
}
export const providerOutcome = (provider: string, result: ProviderResult): Effect.Effect<ProviderResult, ProviderOutputLimit> =>
  result.finish_reason === 'MAX_TOKENS' ? Effect.fail(new ProviderOutputLimit({ provider, result })) : Effect.succeed(result);

export abstract class ProviderAdapter {
  readonly apiKey: string;
  readonly model: string;
  readonly purpose: ProviderPurpose;
  readonly webSearch: boolean;
  fetchImpl: typeof fetch;
  private readonly usage: (record: UsageRecord) => void;
  private readonly instrument: boolean;
  protected constructor(readonly provider: string, apiKey: string, options: ProviderOptions, defaultModel: string) {
    this.apiKey = apiKey; this.model = options.model ?? defaultModel; this.purpose = options.purpose ?? 'agent';
    this.webSearch = options.webSearch ?? false; this.fetchImpl = options.fetchImpl ?? fetch;
    this.usage = options.usage ?? (() => {}); this.instrument = options.instrument ?? false;
    this.effects = {
      model: this.model,
      chat: Effect.fn('Provider.chat')((messages, options = {}) => this.record(messages, options, false)),
      stream: Effect.fn('Provider.stream')((messages, options = {}) => this.record(messages, options, true)),
    };
  }
  readonly effects: ProviderService;
  protected abstract readonly rawEffects: ProviderService;
  redact(text: string): string { return text.replaceAll(this.apiKey, '[redacted]'); }
  failure(reason: ProviderFailure['reason'], message: string, cause?: unknown, status?: number): ProviderFailure {
    return new ProviderFailure({ provider: this.provider, reason, message: this.redact(message), cause, ...(status !== undefined ? { status } : {}) });
  }
  protected response<A, R>(url: string, body: unknown, headers: Record<string, string>,
    consume: (response: Response) => Effect.Effect<A, ProviderError | HttpFailure, R>): Effect.Effect<A, ProviderError, Exclude<R, Scope.Scope>> {
    return Http.service(this.fetchImpl).withRequest(url, { method: 'POST', headers, body: JSON.stringify(body) },
      response => Effect.gen({ self: this }, function*() {
        if (!response.ok) {
          const bytes = yield* readResponseBytes(response);
          return yield* Effect.fail(new ProviderFailure({ provider: this.provider, reason: 'http', status: response.status, cause: undefined,
            message: `${this.provider} HTTP ${response.status}: ${this.redact(new TextDecoder().decode(bytes)).slice(0, 1500)}`,
          }));
        }
        return yield* consume(response);
      })).pipe(Effect.catchCause(cause => Effect.failCause(Cause.map(cause, error =>
        error instanceof HttpFailure ? this.failure('transport', `${this.provider} request failed.`, error) : error))));
  }
  protected json(response: Response): Effect.Effect<unknown, ProviderFailure | HttpFailure, Scope.Scope> {
    return Effect.flatMap(readResponseBytes(response), bytes => Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      catch: cause => this.failure('malformed', `${this.provider} response is malformed.`, cause),
    }));
  }
  protected parse<A>(run: () => A): Effect.Effect<A, ProviderFailure> {
    return Effect.try({ try: run, catch: cause => cause instanceof ProviderFailure ? cause
      : this.failure('malformed', `${this.provider} response is malformed.`, cause) });
  }
  protected textCallback(run: () => void): Effect.Effect<void, ProviderFailure> {
    return Effect.try({ try: run, catch: cause => this.failure('provider', `${this.provider} response callback failed.`, cause) });
  }
  protected callback(run: () => unknown): Effect.Effect<void, ProviderFailure> {
    return Effect.scoped(Effect.gen({ self: this }, function*() {
      const abort = yield* responseAbort;
      let work: Promise<unknown> | undefined;
      yield* Effect.addFinalizer(exit => Effect.promise(async () => {
        if (Exit.isFailure(exit)) abort();
        if (work) await work.catch(() => {});
      }));
      yield* Effect.tryPromise({ try: () => work = Promise.resolve().then(run),
        catch: cause => this.failure('provider', `${this.provider} response callback failed.`, cause) });
    }));
  }
  chat(messages: Message[], options: RequestOptions = {}): Promise<ProviderResult> { return this.run(messages, options, false); }
  stream(messages: Message[], options: StreamOptions = {}): Promise<ProviderResult> { return this.run(messages, options, true); }
  private record(messages: Message[], options: StreamOptions, streaming: boolean): Effect.Effect<ProviderResult, ProviderError> {
    return Effect.suspend(() => {
      const start = performance.now(), requestId = this.instrument ? randomUUID() : undefined;
      let ttft: number | undefined;
      const callbacks = streaming ? { ...options, onText: (text: string) => {
        if (text && ttft === undefined) ttft = performance.now() - start;
        options.onText?.(text);
      } } : options;
      const effect = streaming ? this.rawEffects.stream(messages, callbacks) : this.rawEffects.chat(messages, options);
      return effect.pipe(Effect.onExit(exit => Effect.sync(() => {
        const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;
        const result = Exit.isSuccess(exit) ? exit.value : failure instanceof ProviderOutputLimit && Exit.isFailure(exit) && !Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause) ? failure.result : undefined;
        if (result) {
          this.usage({ purpose: this.purpose, model: this.model, usage: result.usage ?? {}, finish_reason: result.finish_reason,
            ...(this.instrument ? { request_id: requestId, status: 'completed', latency_ms: performance.now() - start,
              ...(ttft !== undefined ? { ttft_ms: ttft } : {}) } : {}) });
        } else if (this.instrument) {
          const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
          this.usage({ request_id: requestId, purpose: this.purpose, model: this.model,
            status: interrupted ? 'canceled' : 'error', latency_ms: performance.now() - start,
            error_type: interrupted ? 'AbortError' : 'EffectAdapterError' });
        }
      })));
    });
  }
  private async run(messages: Message[], options: StreamOptions, streaming: boolean): Promise<ProviderResult> {
    if (options.signal?.aborted) {
      if (this.instrument) this.usage({ request_id: randomUUID(), purpose: this.purpose, model: this.model,
        status: 'canceled', latency_ms: 0, error_type: 'AbortError' });
      options.signal.throwIfAborted();
    }
    const raw = streaming ? this.effects.stream(messages, options) : this.effects.chat(messages, options);
    const exit = await Effect.runPromiseExit(raw, { signal: options.signal });
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) throw new EffectAdapterError('Aborted', 'interruption', exit.cause);
      const reason = exit.cause.reasons.find(Cause.isFailReason);
      // Recover only a lone limit. catchTag would also handle a mixed Cause and
      // could erase a reader cleanup defect or interruption alongside the limit.
      if (exit.cause.reasons.length === 1 && reason?.error instanceof ProviderOutputLimit) return reason.error.result;
      return legacyExitValue(exit, reason?.error instanceof ProviderFailure ? reason.error.message : undefined);
    }
    return exit.value;
  }
}
