import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { legacyExitValue } from './async.js';
import { HttpFailure } from './http.js';
import { McpFailure } from './mcp.js';

// Keep existing safe browsing diagnostics and redacted MCP diagnostics, while
// retaining the complete typed Cause and distinguishing interruption/defects.
export async function toExternalPromise<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isFailure(exit)) {
    const reason = exit.cause.reasons.find(Cause.isFailReason);
    if (reason && (reason.error instanceof HttpFailure || reason.error instanceof McpFailure)) {
      return legacyExitValue(exit, reason.error.message);
    }
  }
  return legacyExitValue(exit);
}
