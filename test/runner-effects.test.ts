import { afterEach, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { Runner } from '../src/runner.js';
import { toolPromise } from '../src/tool-effects.js';
import type { AgentTools, MemoryPort, Message, MessageKind, ModelPort, TurnRecord } from '../src/types.js';
import type { WorkflowEvent } from '../src/workflow-events.js';

const runners: Runner[] = [];
afterEach(async () => { await Promise.allSettled(runners.splice(0).map(runner => runner.close())); });
const complete = { message: { role: 'assistant', content: 'done' }, finish_reason: 'COMPLETE' };
const toolResult = { message: { role: 'assistant', content: [], tool_calls: [{ id: 'call', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'TOOL_CALL' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const noTools: AgentTools = { definitions: [], async execute() { return 'data'; } };
function fixture(model: ModelPort, tools = noTools, settle: MemoryPort['settle'] = async () => true, options: ConstructorParameters<typeof Runner>[4] = {}) {
  const saved: Array<{ kind: MessageKind; text: string }> = [], turns: TurnRecord[] = [], errors: string[] = [];
  const memory: MemoryPort = { append(kind, text) { saved.push({ kind, text }); }, settle,
    render: () => saved.map(entry => `${entry.kind}: ${entry.text}`).join('\n'), zoom: () => '', date: () => '' };
  const runner = new Runner(memory, model, tools, '', { onTurn: turn => turns.push(turn), onError: text => errors.push(text), ...options }); runners.push(runner);
  return { runner, saved, turns, errors, memory };
}

test('native turn execution preserves settle/render/input/model/tool/boundary ordering and native replay', async () => {
  let calls = 0, legacy = 0;
  const requests: Message[][] = [], order: string[] = [], events: WorkflowEvent[] = [];
  const native: Message = { ...toolResult.message, content: [{ type: 'encrypted', signature: 'opaque', extra: { b: 2, a: 1 } }], _openaiOutput: [{ type: 'reasoning', encrypted: 'exact' }] };
  let runner!: Runner;
  const model: ModelPort = { model: 'native', async stream() { legacy++; return complete; }, effects: {
    stream: (messages, options) => Effect.sync(() => {
      requests.push(structuredClone(messages)); order.push(`model-${++calls}`);
      if (calls === 1) { options?.onEntry?.('talk', 'saved partial'); return { message: native, finish_reason: 'TOOL_CALL' }; }
      return complete;
    }),
  } };
  const tools: AgentTools = { definitions: [], async execute() { legacy++; return 'legacy'; }, context: () => 'current plan',
    executeEffect: () => Effect.sync(() => { order.push('tool'); runner.submit('follow up'); runner.submit('worker findings', 'work'); return 'native data'; }) };
  const state = fixture(model, tools, async () => { order.push('settle'); return true; }, { onWorkflow: event => events.push(event) }); runner = state.runner;
  state.memory.render = () => { order.push('render'); expect(state.saved).toEqual([]); return 'previous view'; };
  await runner.submit('first');
  expect(order).toEqual(['settle', 'render', 'model-1', 'tool', 'model-2']); expect(legacy).toBe(0);
  expect(requests[0]![1]!.content).toEqual([{ type: 'text', text: 'previous view' }, { type: 'text', text: 'current plan' }, { type: 'text', text: 'first' }]);
  expect(requests[1]![2]).toEqual(native); expect(JSON.stringify(requests[1]![2])).toBe(JSON.stringify(native));
  expect(requests[1]!.at(-1)).toEqual({ role: 'user', content: 'follow up\n\nworker findings' });
  expect(state.saved).toEqual([{ kind: 'user', text: 'first' }, { kind: 'talk', text: 'saved partial' }, { kind: 'user', text: 'follow up' }, { kind: 'work', text: 'worker findings' }, { kind: 'echo', text: 'native data' }]);
  expect(state.turns).toHaveLength(1); expect(state.turns[0]).toMatchObject({ status: 'completed', tool_calls: 1 });
  for (const event of events.filter(event => event.status === 'processing')) expect(events.filter(other => other.operationId === event.operationId)).toHaveLength(2);
  expect(events.some(event => event.status === 'retry')).toBe(false);
});

test('submissions during settle share one owner and remain absent from the prior view', async () => {
  const gate = deferred(), started = deferred(), requests: Message[][] = [];
  const state = fixture({ model: 'fake', async stream(messages) { requests.push(structuredClone(messages)); return complete; } }, noTools,
    async () => { started.resolve(); await gate.promise; return true; });
  const first = state.runner.submit('first'); await started.promise;
  expect(state.runner.submit('second')).toBe(first); expect(state.runner.submit('report', 'work')).toBe(first);
  expect(state.saved).toEqual([]); gate.resolve(); await first;
  const content = requests[0]![1]!.content;
  expect(Array.isArray(content) && content.at(-1)?.text).toBe('first\n\nsecond\n\nreport');
  expect(state.saved.map(entry => entry.kind)).toEqual(['user', 'user', 'work']); expect(state.turns).toHaveLength(1);
});

test('settle cancellation drains native cleanup, retains all input and reports one canceled turn', async () => {
  const started = deferred(), aborted = deferred(), cleanup = deferred(); let settles = 0, modelCalls = 0;
  const state = fixture({ model: 'fake', async stream() { modelCalls++; return complete; } }, noTools,
    signal => ++settles > 1 ? Promise.resolve(true) : new Promise(resolve => {
      signal?.addEventListener('abort', () => { aborted.resolve(); void cleanup.promise.then(() => resolve(false)); }, { once: true }); started.resolve();
    }));
  const pending = state.runner.submit('first'); await started.promise;
  state.runner.submit('findings', 'work'); state.runner.cancel(); await aborted.promise;
  expect(state.runner.active).toBe(true); expect(state.turns).toEqual([]); cleanup.resolve(); await pending;
  expect(modelCalls).toBe(0); expect(state.errors).toEqual([]);
  expect(state.saved).toEqual([{ kind: 'user', text: 'first' }, { kind: 'work', text: 'findings' }]);
  expect(state.turns).toHaveLength(1); expect(state.turns[0]).toMatchObject({ status: 'canceled', tool_calls: 0, retrievals: 0 });
  expect(state.turns[0]!.model).toBeUndefined(); expect(state.runner.active).toBe(false);
  await state.runner.submit('retry'); expect(modelCalls).toBe(1); expect(state.saved.filter(entry => entry.text === 'first')).toHaveLength(1);
});

test.each([false, new Error('private memory diagnostic')])('failed settle retains input and reports one safe metric: %s', async outcome => {
  let calls = 0;
  const state = fixture({ model: 'fake', async stream() { calls++; return complete; } }, noTools,
    async () => { if (outcome instanceof Error) throw outcome; return outcome; });
  await state.runner.submit('unanswered');
  expect(state.saved).toEqual([{ kind: 'user', text: 'unanswered' }]); expect(calls).toBe(0);
  expect(state.errors).toEqual(['Memory compaction failed. Send another message to retry.']);
  expect(state.turns).toHaveLength(1); expect(state.turns[0]!.status).toBe('error');
});

test('tool cancellation drains cleanup before ending the turn and retains injected work and partial entries', async () => {
  const started = deferred(), aborted = deferred(), cleanup = deferred(); let calls = 0;
  const state = fixture({ model: 'fake', async stream(_messages, options) { calls++; options.onEntry('talk', 'partial saved'); return toolResult; } }, {
    definitions: [], async execute() { throw new Error('Promise path must not run.'); },
    executeEffect: () => toolPromise(signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(); void cleanup.promise.then(() => reject(signal.reason)); }, { once: true }); started.resolve();
    })),
  });
  const pending = state.runner.submit('first'); await started.promise; state.runner.submit('late findings', 'work');
  state.runner.cancel(); await aborted.promise; expect(state.turns).toEqual([]); cleanup.resolve(); await pending;
  expect(calls).toBe(1); expect(state.turns).toHaveLength(1);
  expect(state.turns[0]).toMatchObject({ status: 'canceled', tool_calls: 1 });
  expect(state.saved.map(entry => entry.kind)).toEqual(['user', 'talk', 'work']);
  expect(state.runner.queue).toEqual([]); expect(state.errors).toEqual(['Turn canceled. Completed entries remain saved.']);
});

test('a work report arriving during a tool-free response is injected at the same turn boundary', async () => {
  const requests: Message[][] = []; let runner!: Runner;
  const state = fixture({ model: 'fake', async stream(messages) { requests.push(structuredClone(messages)); if (requests.length === 1) runner.submit('late work', 'work'); return complete; } }); runner = state.runner;
  await runner.submit('first');
  expect(requests).toHaveLength(2); expect(requests[1]!.at(-1)).toEqual({ role: 'user', content: 'late work' });
  expect(state.saved.filter(entry => entry.kind === 'work')).toEqual([{ kind: 'work', text: 'late work' }]); expect(state.turns).toHaveLength(1);
});

test('a reentrant submission from turn completion starts the next turn in the same owner', async () => {
  let calls = 0, settles = 0, runner!: Runner; const statuses: string[] = [];
  const state = fixture({ model: 'fake', async stream() { calls++; return complete; } }, noTools, async () => { settles++; return true; }, {
    onTurn: turn => { statuses.push(turn.status); if (statuses.length === 1) runner.submit('second'); },
  }); runner = state.runner; await runner.submit('first');
  expect(calls).toBe(2); expect(settles).toBe(2); expect(statuses).toEqual(['completed', 'completed']);
  expect(state.saved.map(entry => entry.text)).toEqual(['first', 'second']); expect(runner.active).toBe(false);
});

test('ordinary tool failures remain model-visible error results and nested metrics count once', async () => {
  let calls = 0; const requests: Message[][] = [];
  const state = fixture({ model: 'fake', async stream(messages) { requests.push(structuredClone(messages)); return ++calls === 1 ? toolResult : complete; } }, {
    definitions: [], async execute() { return 'unused'; }, executeEffect: (_name, _args, nested) => Effect.try({ try: () => {
      nested?.('zoom'); nested?.('read_file'); throw new Error('missing file');
    }, catch: error => error }),
  });
  await state.runner.submit('first'); expect(requests[1]!.at(-1)!.content).toEqual([{ type: 'text', text: 'Error: missing file' }]);
  expect(state.turns[0]).toMatchObject({ status: 'completed', tool_calls: 3, retrievals: 1 }); expect(state.errors).toEqual([]);
});

test('step limits and failed finish checks produce failed workflow events without a retry', async () => {
  const events: WorkflowEvent[] = []; let calls = 0;
  const state = fixture({ model: 'fake', async stream() { calls++; return toolResult; } }, noTools, undefined, { maxModelSteps: 2, onWorkflow: event => events.push(event) });
  await state.runner.submit('first'); expect(calls).toBe(2); expect(state.turns).toHaveLength(1);
  expect(state.turns[0]!.status).toBe('error'); expect(state.errors[0]).toContain('Model step limit (2)');
  expect(events.at(-1)?.status).toBe('failed'); expect(events.some(event => event.status === 'retry')).toBe(false);
  const badEvents: WorkflowEvent[] = [];
  const bad = fixture({ model: 'fake', async stream() { return { ...complete, finish_reason: 'ERROR' }; } }, noTools, undefined, { onWorkflow: event => badEvents.push(event) });
  await bad.runner.submit('first'); expect(badEvents.filter(event => event.kind === 'model').map(event => event.status)).toEqual(['processing', 'failed']);
});

test('an optional workflow observer cannot fail or retry the turn', async () => {
  let calls = 0;
  const state = fixture({ model: 'fake', async stream() { calls++; return complete; } }, noTools, undefined,
    { onWorkflow() { throw new Error('observer failed'); } });
  await state.runner.submit('first'); expect(calls).toBe(1); expect(state.turns[0]!.status).toBe('completed'); expect(state.errors).toEqual([]);
});

test('an error callback failure still records exactly one turn and resets ownership', async () => {
  let turns = 0;
  const state = fixture({ model: 'fake', async stream() { throw new Error('provider failed'); } }, noTools, undefined,
    { onError() { throw new Error('error observer failed'); }, onTurn() { turns++; } });
  await expect(state.runner.submit('first')).rejects.toThrow('error observer failed');
  expect(turns).toBe(1); expect(state.runner.active).toBe(false); expect(state.runner.inCall).toBe(false);
});

test('closing an active turn is memoized and waits for native work before tools close', async () => {
  const started = deferred(), cleanup = deferred(), aborted = deferred(), order: string[] = [];
  const state = fixture({ model: 'fake', async stream(_messages, options) {
    started.resolve(); await new Promise<void>(resolve => options.signal.addEventListener('abort', () => { aborted.resolve(); void cleanup.promise.then(resolve); }, { once: true }));
    order.push('provider-cleaned'); options.signal.throwIfAborted(); return complete;
  } }, { ...noTools, async close() { order.push('tools-closed'); } });
  const pending = state.runner.submit('first'); await started.promise;
  const close = state.runner.close(); expect(state.runner.close()).toBe(close); await aborted.promise;
  expect(order).toEqual([]); cleanup.resolve(); await close; await pending;
  expect(order).toEqual(['provider-cleaned', 'tools-closed']); expect(state.turns).toHaveLength(1); expect(state.turns[0]!.status).toBe('canceled');
});

test('native typed output limits preserve partial entries and stop before tool execution', async () => {
  const { ProviderOutputLimit } = await import('../src/providers/core.js');
  let tools = 0;
  const state = fixture({ model: 'native', async stream() { throw new Error('Promise path must not run.'); }, effects: {
    stream: (_messages, options) => Effect.gen(function*() {
      options?.onEntry?.('talk', 'partial saved'); options?.onText?.('Partial response');
      return yield* Effect.fail(new ProviderOutputLimit({ provider: 'test', result: { ...toolResult, finish_reason: 'MAX_TOKENS' } }));
    }),
  } }, { definitions: [], async execute() { tools++; return 'data'; } });
  await state.runner.submit('first');
  expect(tools).toBe(0); expect(state.saved).toEqual([{ kind: 'user', text: 'first' }, { kind: 'talk', text: 'partial saved' }]);
  expect(state.errors).toEqual(['Model output limit reached; response is incomplete.']);
  expect(state.turns).toHaveLength(1); expect(state.turns[0]).toMatchObject({ status: 'error', tool_calls: 0 });
});


test('a reentrant start observer receives the shared Promise and cannot create another owner', async () => {
  let runner!: Runner, nested: Promise<void> | undefined, starts = 0;
  const state = fixture({ model: 'fake', async stream() { return complete; } }, noTools, undefined, {
    onWorkflow: event => { if (event.kind === 'turn' && event.status === 'processing' && ++starts === 1) nested = runner.submit('second'); },
  }); runner = state.runner;
  const first = runner.submit('first'); expect(nested).toBe(first); expect(runner.run()).toBe(first); await first;
  expect(starts).toBe(1); expect(state.saved.map(entry => entry.text)).toEqual(['first', 'second']); expect(state.turns).toHaveLength(1);
});


test('a cleanup defect during canceled tool execution remains available in turn diagnostics', async () => {
  const Cause = await import('effect/Cause'), started = deferred(), failure = new Error('rollback failed');
  const state = fixture({ model: 'fake', async stream() { return toolResult; } }, {
    definitions: [], async execute() { return 'unused'; },
    executeEffect: () => toolPromise(signal => new Promise<string>((_resolve, reject) => {
      started.resolve(); signal.addEventListener('abort', () => reject(failure), { once: true });
    })),
  });
  const pending = state.runner.submit('first'); await started.promise; state.runner.cancel(); await pending;
  expect(state.turns).toHaveLength(1); expect(state.turns[0]!.status).toBe('canceled');
  expect(state.runner.lastFailure).toBeDefined();
  if (state.runner.lastFailure) {
    expect(Cause.hasInterrupts(state.runner.lastFailure)).toBe(true); expect(Cause.hasDies(state.runner.lastFailure)).toBe(true);
    expect(state.runner.lastFailure.reasons.some(reason => Cause.isDieReason(reason) && reason.defect === failure)).toBe(true);
  }
});


test('native nested tool interruption reaches I/O while its originating turn signal remains live', async () => {
  const { ToolRegistry, schemaTool } = await import('../src/tool-registry.js');
  const { parallelTools } = await import('../src/parallel-tools.js'), Schema = await import('effect/Schema');
  const started = deferred(), defect = new Error('native tool defect'); let canceled = false, origin: AbortSignal | undefined;
  const entry = schemaTool({ name: 'get_plan', schema: Schema.Struct({ fail: Schema.Boolean }), capabilities: ['read'], execute: () => '',
    executeEffect: (args, signal) => args.fail
      ? Effect.flatMap(Effect.promise(() => started.promise), () => Effect.die(defect))
      : toolPromise(actual => new Promise<string>((_resolve, reject) => {
        actual.addEventListener('abort', () => { canceled = true; reject(actual.reason); }, { once: true }); started.resolve();
      }), signal),
  });
  const registry: InstanceType<typeof ToolRegistry> = new ToolRegistry([entry, parallelTools((name, args) => registry.prepare(name, args))], ['read']);
  const state = fixture({ model: 'fake', async stream() { return { message: { role: 'assistant', content: [], tool_calls: [{ id: 'batch', function: {
    name: 'parallel_tools', arguments: JSON.stringify({ calls: [true, false].map(fail => ({ tool: 'get_plan', arguments: { fail } })) }),
  } }] }, finish_reason: 'TOOL_CALL' }; } }, {
    definitions: [], async execute() { return 'unused'; },
    executeEffect: (name, args, nested, signal) => { origin = signal; return registry.executeEffect(name, args, nested, signal); },
  });
  await state.runner.submit('first');
  expect(state.turns[0]!.status).toBe('error'); expect(canceled).toBe(true); expect(origin?.aborted).toBe(false);
});
