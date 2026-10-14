import { expect, test } from 'bun:test';
import { Cause, Effect, Exit } from 'effect';
import { EffectAdapterError, legacyExitValue } from '../src/core/async.js';
import { IOError, ProtocolError, TimeoutError, ToolAccessDenied, ToolExecutionError, ValidationError, publicFailureMessage } from '../src/core/errors.js';
import { ProviderModel } from '../src/providers/core.js';
import { toolPromise } from '../src/tool-effects.js';
import { schemaTool, ToolRegistry } from '../src/tool-registry.js';
import * as Schema from 'effect/Schema';
import type { AgentTools, ModelPort } from '../src/types.js';

// The public Cause adapter remains shared; this service-free harness only runs
// fully provided examples, rather than exporting a second application runtime API.
async function toLegacyPromise<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  if (signal?.aborted) throw new EffectAdapterError('The operation was canceled.', 'interruption', Cause.interrupt());
  return legacyExitValue(await Effect.runPromiseExit(effect, { signal }));
}
const fromAbortablePromise = <A, E>(run: (signal: AbortSignal) => PromiseLike<A>, onError: (cause: unknown) => E) =>
  Effect.tryPromise({ try: run, catch: onError });

const callbacks = { tools: [], onText: (_text: string) => {}, onThought: (_text: string) => {}, onEntry: () => {} };

test('Effect v4 service/layer example preserves model results, callbacks, definitions and nested tools', async () => {
  const messages = [{ role: 'user', content: 'Question 🦓' }];
  const result = { message: { role: 'assistant', content: 'Answer 🦓', _native: { encrypted: 'fixture' } }, finish_reason: 'COMPLETE' };
  const nested: string[] = [];
  const model: ModelPort = { model: 'selected-model', async stream(input, options) {
    expect(input).toBe(messages); expect(options.onText).toBe(callbacks.onText); expect(options.signal.aborted).toBe(false); return result;
  } };
  let calls = 0, closed = 0;
  const tools: AgentTools = { definitions: [], async execute(name, args, signal, onNestedCall) {
    calls++; expect(name).toBe('parallel_tools'); expect(args).toEqual({ calls: [] }); expect(signal?.aborted).toBe(false);
    onNestedCall?.('zoom'); return 'unchanged result';
  }, async close() { closed++; } };
  const registry = new ToolRegistry([schemaTool({ name: 'parallel_tools', schema: Schema.Record(Schema.String, Schema.Unknown), capabilities: ['read'],
    execute: () => '', executeEffect: args => toolPromise(signal => tools.execute('parallel_tools', args, signal, name => nested.push(name))),
  })], ['read']);
  const program = Effect.gen(function*() {
    const provider = yield* ProviderModel;
    expect(provider.model).toBe(model.model);
    expect(yield* provider.stream(messages, callbacks)).toBe(result);
    return yield* registry.executeEffect('parallel_tools', { calls: [] });
  }).pipe(Effect.provide(ProviderModel.layer({ model: model.model, chat: () => Effect.succeed(result),
    stream: (input, options) => toolPromise(signal => model.stream(input, { ...callbacks, ...options, signal })).pipe(Effect.orDie),
  })));
  expect(calls).toBe(0);
  expect(await toLegacyPromise(program)).toBe('unchanged result');
  expect(calls).toBe(1); expect(nested).toEqual(['zoom']); expect(closed).toBe(0);
});

test('expected Promise rejections and synchronous throws retain causes without exposing credentials', async () => {
  const secret = new Error('credential-fixture-secret');
  const fail = (cause: unknown) => new IOError({ operation: 'Fixture read', cause });
  for (const operation of [() => Promise.reject(secret), () => { throw secret; }]) {
    const effect = fromAbortablePromise(operation, fail);
    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find(Cause.isFailReason);
      expect(reason?.error).toBeInstanceOf(IOError); expect(reason?.error.cause).toBe(secret);
    }
    const rejection = await toLegacyPromise(effect).catch(error => error);
    expect(rejection).toBeInstanceOf(EffectAdapterError);
    expect(rejection.kind).toBe('failure'); expect(rejection.message).toBe('Fixture read failed.');
    expect(Cause.hasFails(rejection.cause)).toBe(true);
  }
  expect(publicFailureMessage(new TimeoutError({ operation: 'Fixture read', cause: secret }))).toBe('Fixture read timed out.');
  expect(publicFailureMessage(new ProtocolError({ operation: 'Fixture read', cause: secret }))).toBe('Fixture read returned an invalid response.');
  expect(publicFailureMessage(new ToolAccessDenied({ tool: 'secret-tool' }))).toBe('This tool is not permitted.');
  expect(publicFailureMessage(new ValidationError({ boundary: 'fixture', message: 'Invalid fixture at args.', cause: secret }))).toBe('Invalid fixture at args.');
});

test('legacy cancellation aborts real work and waits for scoped finalizers before rejecting', async () => {
  let started!: () => void, ioSignal: AbortSignal | undefined, released = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const effect = Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.succeed('resource'), () => Effect.sync(() => { released++; }));
    return yield* fromAbortablePromise(signal => {
      ioSignal = signal; started();
      return new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true }); });
    }, cause => new IOError({ operation: 'Fixture read', cause }));
  }).pipe(Effect.scoped);
  const controller = new AbortController();
  const pending = toLegacyPromise(effect, controller.signal).catch(error => error);
  await ready; controller.abort('private abort reason');
  const rejection = await pending;
  expect(ioSignal?.aborted).toBe(true); expect(released).toBe(1);
  expect(rejection.kind).toBe('interruption'); expect(rejection.name).toBe('AbortError');
  expect(rejection.message).toBe('The operation was canceled.'); expect(Cause.hasInterruptsOnly(rejection.cause)).toBe(true);
});

test('pre-canceled work never starts and defects are distinct from expected failures', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort('private reason');
  const interrupted = await toLegacyPromise(Effect.sync(() => { calls++; }), controller.signal).catch(error => error);
  expect(calls).toBe(0); expect(interrupted.kind).toBe('interruption');
  const defect = new Error('private implementation detail');
  const rejection = await toLegacyPromise(Effect.die(defect)).catch(error => error);
  expect(rejection.kind).toBe('defect'); expect(rejection.message).toBe('An unexpected error occurred.');
  expect(Cause.hasDies(rejection.cause)).toBe(true);
});

test('registry Promise boundaries retain typed failures and propagate interruption to the port', async () => {
  const secret = new Error('fixture-secret');
  let ioSignal: AbortSignal | undefined, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const tools: AgentTools = { definitions: [], async execute(name, _args, signal) {
    if (name === 'fail') throw secret;
    ioSignal = signal; started();
    return new Promise<string>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } };
  const registry = new ToolRegistry(['fail', 'wait'].map(name => schemaTool({ name, schema: Schema.Record(Schema.String, Schema.Unknown), capabilities: ['read'],
    execute: () => '', executeEffect: args => toolPromise(signal => tools.execute(name, args, signal)).pipe(
      Effect.catchCause(cause => Effect.failCause(Cause.map(cause, error => new ToolExecutionError({ tool: name, cause: error }))))),
  })), ['read']);
  const failed = await Effect.runPromiseExit(registry.executeEffect('fail', {}));
  if (Exit.isFailure(failed)) {
    const reason = failed.cause.reasons.find(Cause.isFailReason);
    expect(reason?.error).toBeInstanceOf(ToolExecutionError);
    if (reason?.error instanceof ToolExecutionError) expect(reason.error.cause).toBe(secret);
  } else throw new Error('Tool must fail.');
  const controller = new AbortController();
  const pending = toLegacyPromise(registry.executeEffect('wait', {}), controller.signal).catch(error => error);
  await ready; controller.abort();
  expect((await pending).kind).toBe('interruption'); expect(ioSignal?.aborted).toBe(true);
});

test('a cleanup defect preserves both the original failure and the cleanup cause', async () => {
  const original = new IOError({ operation: 'Fixture read', cause: new Error('private read detail') });
  const cleanup = new Error('private cleanup detail');
  const effect = Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.succeed('resource'), () => Effect.die(cleanup));
    return yield* Effect.fail(original);
  }).pipe(Effect.scoped);
  const rejection = await toLegacyPromise(effect).catch(error => error);
  expect(rejection.kind).toBe('defect');
  expect(rejection.cause.reasons.find(Cause.isFailReason)?.error).toBe(original);
  expect(rejection.cause.reasons.find(Cause.isDieReason)?.defect).toBe(cleanup);
  expect(rejection.message).toBe('An unexpected error occurred.');
});
