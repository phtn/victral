import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import { ProviderOutputLimit, type ProviderService } from './providers/core.js';
import type { ProviderResult } from './providers/types.js';
import type { Message, ToolDefinition } from './types.js';
import { nativeToolEffect, toolPromise } from './tool-effects.js';

export interface CompactorJob { controller: AbortController; promise?: Promise<void>; fiber?: Fiber.Fiber<void> }
// This owner supervises lifetimes only. Memory retains the level/index heap,
// source availability, early-message window and eight-slot admission policy.
export class MemoryJobs {
  readonly active = new Map<string, CompactorJob>();
  private readonly scope = Scope.makeUnsafe('parallel');
  private context = Context.empty();
  private borrowed = false;
  private closed = false;
  private closing?: Promise<void>;
  lastFailure?: Cause.Cause<unknown>;
  borrow(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      if (!this.borrowed) { this.context = yield* Effect.context<never>(); this.borrowed = true; }
    });
  }
  launch(key: string, run: (signal: AbortSignal) => Effect.Effect<void, unknown>, finish: (exit: Exit.Exit<void, unknown>) => void): void {
    if (this.closed) return;
    const entry: CompactorJob = { controller: new AbortController() };
    this.active.set(key, entry);
    const work = Effect.suspend(() => run(entry.controller.signal)).pipe(
      Effect.onExit(exit => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
        if (Exit.isFailure(exit)) this.lastFailure = exit.cause;
        this.active.delete(key); finish(exit);
      })))),
      Effect.catchCause(cause => Effect.sync(() => { this.lastFailure = cause; })),
    );
    entry.fiber = Effect.runSync(Effect.forkIn(nativeToolEffect(work).pipe(Effect.provideContext(this.context)), this.scope, { startImmediately: true }));
    entry.promise = Effect.runPromise(Fiber.await(entry.fiber)).then(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.active.values()) entry.controller.abort();
    return this.closing = Effect.runPromise(Scope.close(this.scope, Exit.void));
  }
}

// The Promise provider adapter exposes a native output limit as MAX_TOKENS.
// Preserve that existing compactor diagnostic without accepting its partial text
// or hiding any additional response-cleanup defect in a compound Cause.
interface CompactorModel {
  chat(messages: Message[], options: { tools: ToolDefinition[]; signal: AbortSignal }): PromiseLike<ProviderResult>;
  effects?: Pick<ProviderService, 'chat'>;
}
export function compactorChat(model: CompactorModel, messages: Message[], tools: ToolDefinition[], signal?: AbortSignal): Effect.Effect<ProviderResult, unknown> {
  if (!model.effects) return toolPromise(actual => model.chat(messages, { tools, signal: actual }), signal);
  return model.effects.chat(messages, { tools }).pipe(Effect.catchCause(cause => {
    const reason = cause.reasons[0];
    return cause.reasons.length === 1 && reason && Cause.isFailReason(reason) && reason.error instanceof ProviderOutputLimit
      ? Effect.succeed(reason.error.result) : Effect.failCause(cause);
  }));
}
