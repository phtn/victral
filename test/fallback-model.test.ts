import { expect, test } from 'bun:test';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { FALLBACK_MODEL, FallbackModel, type ModelFactory } from '../src/fallback-model.js';
import { ProviderCallbackFailure, ProviderFailure, ProviderOutputLimit, type ProviderService } from '../src/providers/core.js';
import { Runner } from '../src/runner.js';
import { toolPromise } from '../src/tool-effects.js';
import type { Message } from '../src/types.js';

const result = { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'summary' }] } };
const unavailable = () => new ProviderFailure({ provider: 'primary', reason: 'http', status: 503, message: 'primary unavailable', cause: undefined });
function provider(model: string, run: ProviderService['chat']): { model: string; effects: ProviderService } { return { model, effects: { model, chat: run, stream: run } }; }

test('healthy requests preserve result identity and never construct or call the fallback', async () => {
  const constructed: string[] = []; let notices = 0;
  const model = new FallbackModel('luna6', {}, () => { notices++; }, id => { constructed.push(id); return provider(id, () => Effect.succeed(result)); });
  expect(await model.chat([])).toBe(result); expect(await model.stream([])).toBe(result);
  expect(constructed).toEqual(['gpt-6-luna']); expect(model.model).toBe('gpt-6-luna'); expect(notices).toBe(0);
});

test.each(['chat', 'stream'] as const)('%s errors switch once and later requests stay on muse-wonder-full', async method => {
  const calls: string[] = [], constructed: string[] = []; let notices = 0;
  const factory: ModelFactory = (id, options) => {
    constructed.push(id); expect(options.purpose).toBe('compactor');
    if (id === FALLBACK_MODEL) expect(options.apiKey).toBeUndefined();
    return provider(id, () => Effect.suspend(() => { calls.push(id); return id === FALLBACK_MODEL ? Effect.succeed(result) : Effect.fail(unavailable()); }));
  };
  const model = new FallbackModel('luna6', { purpose: 'compactor', apiKey: 'primary-only-key' }, () => { notices++; }, factory);
  expect(await model[method]([])).toBe(result); expect(await model[method]([])).toBe(result);
  expect(calls).toEqual(['gpt-6-luna', FALLBACK_MODEL, FALLBACK_MODEL]); expect(constructed).toEqual(['gpt-6-luna', FALLBACK_MODEL]);
  expect(notices).toBe(1); expect(model.model).toBe(FALLBACK_MODEL); expect(model.fallbackActive).toBe(true);
});

test('invalid configuration falls back during construction without a request', () => {
  const constructed: string[] = []; let notices = 0;
  const model = new FallbackModel('invalid-model', {}, () => { notices++; }, id => {
    constructed.push(id); if (id !== FALLBACK_MODEL) throw new Error('invalid configuration'); return provider(id, () => Effect.succeed(result));
  });
  expect(model.model).toBe(FALLBACK_MODEL); expect(constructed).toEqual(['invalid-model', FALLBACK_MODEL]); expect(notices).toBe(1);
});

test('both initialization failures are retained and an already-selected fallback is not initialized twice', () => {
  let calls = 0;
  const factory: ModelFactory = () => { calls++; throw new Error('missing credential'); };
  expect(() => new FallbackModel('luna6', {}, undefined, factory)).toThrow('muse-wonder-full fallback'); expect(calls).toBe(2);
  calls = 0; expect(() => new FallbackModel('mwfull', {}, undefined, factory)).toThrow('missing credential'); expect(calls).toBe(1);
});

test('failed fallback requests stop without a loop and retain both causes', async () => {
  const calls: string[] = [];
  const model = new FallbackModel('luna6', {}, undefined, id => provider(id, () => Effect.suspend(() => { calls.push(id); return Effect.fail(new ProviderFailure({ provider: id, reason: 'http', status: 503, message: 'unavailable', cause: undefined })); })));
  const exit = await Effect.runPromiseExit(model.effects.chat([]));
  expect(calls).toEqual(['gpt-6-luna', FALLBACK_MODEL]); expect(Exit.isFailure(exit) && exit.cause.reasons).toHaveLength(2);
});

test('canceling a primary request drains cleanup and never starts fallback', async () => {
  let constructed = 0, aborted = false;
  const model = new FallbackModel('luna6', {}, undefined, id => {
    constructed++; return provider(id, () => toolPromise(signal => new Promise<typeof result>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    })).pipe(Effect.orDie));
  });
  const work = Effect.runFork(model.effects.stream([])); await Bun.sleep(0); await Effect.runPromise(Fiber.interrupt(work));
  expect(aborted).toBe(true); expect(constructed).toBe(1); expect(model.model).toBe('gpt-6-luna');
});

test('callback failures and compound cleanup defects never trigger fallback', async () => {
  const callback = new ProviderCallbackFailure({ provider: 'primary', reason: 'provider', message: 'callback failed', cause: undefined });
  for (const cause of [Cause.fail(callback), Cause.combine(Cause.fail(unavailable()), Cause.die(new Error('cleanup defect')))]) {
    let constructed = 0;
    const model = new FallbackModel('luna6', {}, undefined, id => { constructed++; return provider(id, () => Effect.failCause(cause)); });
    const exit = await Effect.runPromiseExit(model.effects.stream([])); expect(constructed).toBe(1);
    expect(Exit.isFailure(exit) && exit.cause).toBe(cause);
  }
});

test('empty and incomplete compactor results use fallback, while oversized complete summaries retain normal byte feedback', async () => {
  for (const primary of [{ ...result, finish_reason: 'MAX_TOKENS' }, { ...result, message: { role: 'assistant', content: [] } }]) {
    const model = new FallbackModel('luna6', { purpose: 'compactor' }, undefined, id => provider(id, () => Effect.succeed(id === FALLBACK_MODEL ? result : primary)));
    expect(await model.chat([])).toBe(result); expect(model.model).toBe(FALLBACK_MODEL);
  }
  const oversized = { ...result, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600) }] } };
  const model = new FallbackModel('luna6', { purpose: 'compactor' }, undefined, id => provider(id, () => Effect.succeed(oversized)));
  expect(await model.chat([])).toBe(oversized); expect(model.model).toBe('gpt-6-luna');
});

test('native output-limit failures can use fallback without accepting partial results', async () => {
  const model = new FallbackModel('luna6', {}, undefined, id => provider(id, () => id === FALLBACK_MODEL ? Effect.succeed(result)
    : Effect.fail(new ProviderOutputLimit({ provider: 'primary', result: { ...result, finish_reason: 'MAX_TOKENS' } }))));
  expect(await model.stream([])).toBe(result); expect(model.model).toBe(FALLBACK_MODEL);
});

test('main fallback preserves partial saved output and executes only the fallback result tool once', async () => {
  const requests: Message[][] = [], saved: string[] = []; let fallbackCalls = 0, toolCalls = 0;
  const model = new FallbackModel('luna6', {}, undefined, id => {
    const effects: ProviderService = { model: id, chat: () => Effect.succeed(result), stream: (messages, options) => Effect.gen(function*() {
      requests.push(structuredClone(messages));
      if (id !== FALLBACK_MODEL) {
        yield* Effect.sync(() => { options?.onText?.('partial'); options?.onEntry?.('talk', 'partial'); });
        return yield* Effect.fail(unavailable());
      }
      if (++fallbackCalls === 1) return { finish_reason: 'TOOL_CALL', message: { role: 'assistant', content: [], tool_calls: [{ id: 'fallback-tool', function: { name: 'read', arguments: '{}' } }] } };
      yield* Effect.sync(() => { options?.onText?.('complete'); options?.onEntry?.('talk', 'complete'); });
      return result;
    }) };
    return { model: id, effects };
  });
  const runner = new Runner({ append: (_kind, text) => { saved.push(text); }, settle: async () => true, render: () => '', zoom: () => '', date: () => '' }, model,
    { definitions: [], execute: async () => { toolCalls++; return 'read result'; } }, '', { onError: text => { throw new Error(text); } });
  try {
    await runner.submit('task'); expect(toolCalls).toBe(1); expect(saved.filter(text => text === 'partial')).toHaveLength(1);
    expect(saved.filter(text => text === 'complete')).toHaveLength(1); expect(requests[1]).toEqual(requests[0]); expect(model.model).toBe(FALLBACK_MODEL);
  } finally { await runner.close(); }
});
