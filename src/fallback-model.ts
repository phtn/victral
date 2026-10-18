import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { createModel } from './models.js';
import { resolveModelId } from './model-catalog.js';
import { ProviderCallbackFailure, ProviderFailure, ProviderOutputLimit, type ProviderService } from './providers/core.js';
import type { ProviderOptions, ProviderResult, RequestOptions, StreamOptions } from './providers/types.js';
import type { Message } from './types.js';
import { toolExitValue } from './tool-effects.js';

export const FALLBACK_MODEL = 'muse-wonder-full';
type Provider = { model: string; effects: ProviderService };
export type ModelFactory = (model: string, options: ProviderOptions) => Provider;
// Startup configuration may be invalid: let the owning model attempt fallback.
// Explicit interactive /model commands still use the strict resolver.
export function configuredModelId(input: string): string {
  try { return resolveModelId(input); } catch { return input; }
}

export class FallbackModel {
  readonly configuredModel: string;
  private current: Provider;
  private fallback?: Provider;
  readonly effects: ProviderService;
  constructor(model: string, private options: ProviderOptions, private onFallback: () => void = () => {}, private factory: ModelFactory = createModel) {
    this.configuredModel = configuredModelId(model);
    try { this.current = factory(this.configuredModel, options); }
    catch (primary) {
      if (this.configuredModel === FALLBACK_MODEL) throw primary;
      try { this.current = this.getFallback(); }
      catch (fallback) { throw new AggregateError([primary, fallback], 'Unable to initialize configured model or muse-wonder-full fallback. Check model configuration and Meta credentials.'); }
      this.notify();
    }
    const owner = this;
    this.effects = { get model() { return owner.model; },
      chat: (messages, options) => this.request('chat', messages, options),
      stream: (messages, options) => this.request('stream', messages, options),
    };
  }
  get model(): string { return this.current.model; }
  get fallbackActive(): boolean { return this.configuredModel !== FALLBACK_MODEL && this.model === FALLBACK_MODEL; }
  private getFallback(): Provider { return this.fallback ??= this.factory(FALLBACK_MODEL, { ...this.options, apiKey: undefined }); }
  private notify() { try { this.onFallback(); } catch { /* Presentation cannot fail a model request. */ } }
  private validate(result: ProviderResult): Effect.Effect<ProviderResult, ProviderFailure> {
    const complete = result.finish_reason === 'COMPLETE' || (this.options.purpose !== 'compactor'
      && result.finish_reason === 'TOOL_CALL' && !!result.message.tool_calls?.length);
    const hasText = Array.isArray(result.message.content) && result.message.content.some(block => block.type === 'text' && block.text?.trim());
    if (!complete || (this.options.purpose === 'compactor' && !hasText)) return Effect.fail(new ProviderFailure({
      provider: this.model, reason: 'malformed', message: 'Model response is incomplete or empty.', cause: undefined,
    }));
    return Effect.succeed(result);
  }
  private request(method: 'chat' | 'stream', messages: Message[], options: Omit<StreamOptions, 'signal'> = {}): Effect.Effect<ProviderResult, ProviderFailure | ProviderOutputLimit> {
    return Effect.suspend(() => {
      const primary = this.current;
      const run = (provider: Provider) => provider.effects[method](messages, options).pipe(Effect.flatMap(result => this.validate(result)));
      return run(primary).pipe(Effect.catchCause(cause => {
        const reason = cause.reasons[0];
        // No replay after cancellation, cleanup defects, or consumer/persistence
        // callback failure. Native response scopes have finished before this runs.
        if (primary.model === FALLBACK_MODEL || cause.reasons.length !== 1 || !reason || !Cause.isFailReason(reason)
          || reason.error instanceof ProviderCallbackFailure
          || !(reason.error instanceof ProviderFailure || reason.error instanceof ProviderOutputLimit)) return Effect.failCause(cause);
        return Effect.gen({ self: this }, function*() {
          const fallback = yield* Effect.try({ try: () => this.getFallback(), catch: error => new ProviderFailure({
            provider: FALLBACK_MODEL, reason: 'provider', message: 'Unable to initialize muse-wonder-full fallback. Check Meta credentials.', cause: error,
          }) }).pipe(Effect.catchCause(fallbackCause => Effect.failCause(Cause.combine(cause, fallbackCause))));
          const changed = this.current.model !== FALLBACK_MODEL;
          this.current = fallback;
          if (changed) this.notify();
          return yield* run(fallback).pipe(Effect.catchCause(fallbackCause => Effect.failCause(Cause.combine(cause, fallbackCause))));
        });
      }));
    });
  }
  chat(messages: Message[], options: RequestOptions = {}): Promise<ProviderResult> { return this.run('chat', messages, options); }
  stream(messages: Message[], options: StreamOptions = {}): Promise<ProviderResult> { return this.run('stream', messages, options); }
  private async run(method: 'chat' | 'stream', messages: Message[], options: StreamOptions): Promise<ProviderResult> {
    options.signal?.throwIfAborted();
    const exit = await Effect.runPromiseExit(this.request(method, messages, options), { signal: options.signal });
    if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
      const reason = exit.cause.reasons[0];
      if (reason && Cause.isFailReason(reason) && reason.error instanceof ProviderOutputLimit) return reason.error.result;
    }
    return toolExitValue(exit, options.signal);
  }
}
