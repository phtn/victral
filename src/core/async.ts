import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import { publicFailureMessage } from './errors.js';

export class EffectAdapterError extends Error {
  constructor(message: string, readonly kind: 'failure' | 'interruption' | 'defect', cause: Cause.Cause<unknown>) {
    super(message, { cause });
    this.name = kind === 'interruption' ? 'AbortError' : 'EffectAdapterError';
  }
}

// Share Cause handling between service-free adapters and session runtime edges.
// An override must be an application-owned message, never a diagnostic cause.
export function legacyExitValue<A, E>(exit: Exit.Exit<A, E>, message?: string): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = exit.cause;
  if (Cause.hasInterruptsOnly(cause)) throw new EffectAdapterError('The operation was canceled.', 'interruption', cause);
  if (Cause.hasDies(cause)) throw new EffectAdapterError(message ?? 'An unexpected error occurred.', 'defect', cause);
  const failure = cause.reasons.find(Cause.isFailReason);
  throw new EffectAdapterError(message ?? publicFailureMessage(failure?.error), 'failure', cause);
}
