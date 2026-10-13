import * as Context from 'effect/Context';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

// Only legacy Promise entry points preserve caller-signal object identity.
// Native scopes must combine origin lifetime with actual fiber interruption.
const LegacyToolSignal = Context.Reference<boolean>('victral/tools/LegacySignal', { defaultValue: () => false });
export const legacyToolEffect = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(LegacyToolSignal, true));
export const nativeToolEffect = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(LegacyToolSignal, false));

// Await already-started native work on interruption, including patch rollback and
// pipe cleanup. tryPromise alone only interrupts the wait for that work.
export function toolPromise<A>(run: (signal: AbortSignal) => A | PromiseLike<A>, origin?: AbortSignal): Effect.Effect<A, unknown> {
  return Effect.flatMap(LegacyToolSignal, legacy => Effect.callback<A, unknown>((resume, signal) => {
    const operationSignal = origin ? legacy ? origin : AbortSignal.any([origin, signal]) : signal;
    let pending: Promise<A>;
    try { operationSignal.throwIfAborted(); pending = Promise.resolve(run(operationSignal)); }
    catch (error) { resume(Effect.fail(error)); return; }
    void pending.then(value => resume(Effect.succeed(value)), error => resume(Effect.fail(error)));
    return Effect.promise(() => pending.then(() => {}, error => {
      // The expected abort rejection is already represented by interruption.
      // A rollback/cleanup error that arrives while draining must remain a defect.
      if (error !== operationSignal.reason && !(error instanceof Error && error.name === 'AbortError')) throw error;
    }));
  }));
}

// Keep the public tool's existing validation and domain error messages. Compound
// failures retain every reason; never hide cleanup failure behind a typed error.
export async function runToolEffect<A>(effect: Effect.Effect<A, unknown>, signal?: AbortSignal): Promise<A> {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(effect, { signal });
  return toolExitValue(exit, signal);
}

export function toolExitValue<A>(exit: Exit.Exit<A, unknown>, signal?: AbortSignal): A {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    signal?.throwIfAborted();
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  if (exit.cause.reasons.length === 1) throw Cause.squash(exit.cause);
  throw new AggregateError(exit.cause.reasons.map(reason => Cause.squash(Cause.fromReasons([reason]))), 'Tool execution and cleanup failed.', { cause: exit.cause });
}
