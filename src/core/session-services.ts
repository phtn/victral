import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import { createModel } from '../models.js';
import { FallbackModel } from '../fallback-model.js';
import { Storage } from '../storage.js';
import type { Memory } from '../memory.js';
import type { Evaluations } from '../evaluations.js';
import type { Metrics } from '../metrics.js';
import type { SessionOptions } from '../session.js';
import type { ProviderPurpose } from '../providers/types.js';
import type { ModelPort } from '../types.js';
import { legacyExitValue } from './async.js';
import { IOError } from './errors.js';

export class SessionSettings extends Context.Service<SessionSettings, Readonly<SessionOptions>>()('victral/session/Settings') {}

// These keys expose the already-acquired session owners, without acquiring a
// second instance or changing durable callback/cleanup ordering.
export class SessionMemory extends Context.Service<SessionMemory, Memory>()('victral/session/Memory') {}
export class SessionEvaluations extends Context.Service<SessionEvaluations, Evaluations>()('victral/session/Evaluations') {}
export class SessionMetrics extends Context.Service<SessionMetrics, Metrics>()('victral/session/Metrics') {}

export interface ModelOptions { purpose?: ProviderPurpose; webSearch?: boolean; usage: (record: unknown) => void; fallback?: boolean; onFallback?: (model: string) => void }
// Model construction is synchronous; its native provider effects run in the owner scopes.
const modelFactory = createModel;
export class SessionModels extends Context.Service<SessionModels, {
  readonly create: (id: string, options: ModelOptions) => Effect.Effect<ModelPort, unknown>;
}>()('victral/session/Models') {
  static readonly layer = Layer.succeed(SessionModels, {
    create: Effect.fn('SessionModels.create')((id: string, options: ModelOptions) =>
      Effect.try({ try: () => options.fallback ? new FallbackModel(id, options, options.onFallback, modelFactory) : modelFactory(id, options), catch: cause => cause })),
  });
}

export function releaseSessionResource(operation: string, close: () => void | PromiseLike<void>): Effect.Effect<void> {
  return Effect.tryPromise({ try: async () => { await close(); },
    catch: cause => new IOError({ operation, cause }),
  }).pipe(Effect.orDie);
}

// This scope owns the lock. Expose the original object so savePlan/append and
// persistence callbacks keep their synchronous, durable behavior and format.
export class SessionStorage extends Context.Service<SessionStorage, Storage>()('victral/session/Storage') {
  static readonly acquire = Effect.fn('SessionStorage.acquire')((directory: string) =>
    Storage.acquire(directory));
}

// A lone legacy failure keeps its existing Promise error and message. Combined
// startup/cleanup causes use a safe message and retain every original reason.
// Native provider and storage failures retain their typed diagnostic causes.
export function sessionExitValue<A>(exit: Exit.Exit<A, unknown>, operation: string): A {
  if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
    const reason = exit.cause.reasons[0]!;
    if (Cause.isFailReason(reason)) throw reason.error;
  }
  return legacyExitValue(exit, `${operation} failed.`);
}
