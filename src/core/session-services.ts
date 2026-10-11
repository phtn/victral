import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import { createModel } from '../models.js';
import { Storage } from '../storage.js';
import type { SessionOptions } from '../session.js';
import type { ModelPort } from '../types.js';
import { legacyExitValue } from './async.js';
import { IOError } from './errors.js';

export class SessionSettings extends Context.Service<SessionSettings, Readonly<SessionOptions>>()('victral/session/Settings') {}

export interface ModelOptions { purpose?: string; webSearch?: boolean; usage: (record: unknown) => void }
// Preserve the JS provider API until its separate I/O migration.
const modelFactory = createModel as unknown as (id: string, options: ModelOptions) => ModelPort;
export class SessionModels extends Context.Service<SessionModels, {
  readonly create: (id: string, options: ModelOptions) => Effect.Effect<ModelPort, unknown>;
}>()('victral/session/Models') {
  static readonly layer = Layer.succeed(SessionModels, {
    create: Effect.fn('SessionModels.create')((id: string, options: ModelOptions) =>
      Effect.try({ try: () => modelFactory(id, options), catch: cause => cause })),
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
    Effect.acquireRelease(
      Effect.tryPromise({ try: () => Storage.open(directory), catch: cause => cause }),
      storage => releaseSessionResource('Chat storage cleanup', () => storage.close()),
    ));
}

// A lone legacy failure keeps its existing Promise error and message. Combined
// startup/cleanup causes use a safe message and retain every original reason.
// Typed provider/storage failure classification belongs to their later migrations.
export function sessionExitValue<A>(exit: Exit.Exit<A, unknown>, operation: string): A {
  if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
    const reason = exit.cause.reasons[0]!;
    if (Cause.isFailReason(reason)) throw reason.error;
  }
  return legacyExitValue(exit, `${operation} failed.`);
}
