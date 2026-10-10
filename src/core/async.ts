import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { publicFailureMessage } from './errors.js';

// Pass Effect's signal into the actual I/O; interruption alone only stops waiting.
export const fromAbortablePromise = <A, E>(
  run: (signal: AbortSignal) => PromiseLike<A>,
  onError: (cause: unknown) => E,
): Effect.Effect<A, E> => Effect.tryPromise({ try: run, catch: onError });

export class EffectAdapterError extends Error {
  constructor(message: string, readonly kind: 'failure' | 'interruption' | 'defect', cause: Cause.Cause<unknown>) {
    super(message, { cause });
    this.name = kind === 'interruption' ? 'AbortError' : 'EffectAdapterError';
  }
}

// Temporary Promise/UI boundary for service-free (or already provided) effects.
// Use the session's ManagedRuntime when it is introduced; never create one here.
export async function toLegacyPromise<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  if (signal?.aborted) throw new EffectAdapterError('The operation was canceled.', 'interruption', Cause.interrupt());
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = exit.cause;
  if (Cause.hasInterruptsOnly(cause)) throw new EffectAdapterError('The operation was canceled.', 'interruption', cause);
  if (Cause.hasDies(cause)) throw new EffectAdapterError('An unexpected error occurred.', 'defect', cause);
  const failure = cause.reasons.find(Cause.isFailReason);
  throw new EffectAdapterError(publicFailureMessage(failure?.error), 'failure', cause);
}
