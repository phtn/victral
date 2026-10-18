import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as TestClock from 'effect/testing/TestClock';
import { Subagents, type SubagentOptions } from '../src/subagents.js';
import { Runner } from '../src/runner.js';
import { toolPromise } from '../src/tool-effects.js';
import { readOnlyProjectTools } from '../src/tools.js';
import type { AgentTools, Message, ModelPort } from '../src/types.js';
import type { WorkflowEvent } from '../src/workflow-events.js';

const owners: Subagents[] = [], runners: Runner[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runners.splice(0).map(runner => runner.close()));
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const complete = { message: { role: 'assistant', content: 'finding' }, finish_reason: 'COMPLETE' };
const tools: AgentTools = { definitions: [], async execute() { return ''; } };
function fixture(options: Partial<SubagentOptions> = {}) {
  const reports: string[] = [], events: WorkflowEvent[] = [];
  const agents = new Subagents({ model: () => ({ model: 'native', async stream() { return complete; } }), tools: () => tools,
    context: () => '', instructions: () => '', report: text => { reports.push(text); }, onWorkflow: event => events.push(event), ...options });
  owners.push(agents); return { agents, reports, events };
}
function heldModel(started: ReturnType<typeof deferred>, aborted: ReturnType<typeof deferred>, cleanup = Promise.resolve()): ModelPort {
  return { model: 'native', async stream() { throw new Error('Promise path must not run.'); }, effects: {
    stream: () => toolPromise(signal => new Promise<typeof complete>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(); void cleanup.then(() => reject(signal.reason)); }, { once: true }); started.resolve();
    })).pipe(Effect.orDie),
  } };
}
function status(agents: Subagents, id = 'subagent-1') { return JSON.parse(agents.statusOf(id)); }

test('native workers freeze model, context, instructions and tools at spawn and enforce read-only execution', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-native-workers-')); directories.push(directory);
  await fs.writeFile(path.join(directory, 'facts.txt'), 'frozen facts');
  let selected = 'model-A', context = 'context-A', instructions = 'instructions-A', calls = 0, factories = 0;
  const requests: Message[][] = [];
  const { agents, reports } = fixture({ model: () => {
    factories++; return { model: selected, async stream() { throw new Error('Promise path must not run.'); }, effects: {
      stream: (messages, options) => Effect.sync(() => {
        requests.push(structuredClone(messages));
        for (const name of ['write_file', 'shell', 'spawn_subagent', 'call_integration_tool']) expect(options?.tools?.some(tool => tool.function.name === name)).toBe(false);
        if (++calls === 1) return { message: { role: 'assistant', content: [], tool_calls: ['write_file', 'shell', 'spawn_subagent', 'call_integration_tool'].map((name, i) => ({ id: String(i), function: { name, arguments: '{}' } })) }, finish_reason: 'TOOL_CALL' };
        options?.onText?.('verified facts'); return complete;
      }),
    } };
  }, tools: () => readOnlyProjectTools({ zoom: () => '', date: () => '' }, directory), context: () => context, instructions: () => instructions });
  await Effect.runPromise(agents.spawnEffect({ name: 'inspect', task: ' literal task ' }));
  selected = 'model-B'; context = 'context-B'; instructions = 'instructions-B';
  await Effect.runPromise(agents.drainEffect());
  expect(factories).toBe(1); expect(status(agents).model).toBe('model-A'); expect(status(agents).task).toBe(' literal task ');
  expect(JSON.stringify(requests[0])).toContain('context-A'); expect(JSON.stringify(requests[0])).toContain('instructions-A');
  expect(JSON.stringify(requests[0])).not.toContain('context-B'); expect(JSON.stringify(requests[1])).toContain('Subagents cannot use');
  expect(await fs.readdir(directory)).toEqual(['facts.txt']); expect(reports).toHaveLength(1); expect(reports[0]).toContain('verified facts');
});

test('a completed parent turn retains its worker and a late work report enters the parent queue once', async () => {
  const workerStarted = deferred(), release = deferred(), handling = deferred(), reviewed = deferred();
  let calls = 0, parent!: Runner, reports = 0; const saved: string[] = [], requests: Message[][] = [];
  const { agents } = fixture({ model: () => ({ model: 'selected', async stream(_messages, options) { workerStarted.resolve(); await release.promise; options.onText('worker finding'); return complete; } }),
    report: text => { reports++; void parent.submit(text, 'work'); } });
  parent = new Runner({ append(kind, text) { saved.push(`${kind}:${text}`); }, settle: async () => true, render: () => '', zoom: () => '', date: () => '' }, {
    model: 'parent', async stream(messages) {
      requests.push(structuredClone(messages));
      if (++calls === 1) return { message: { role: 'assistant', content: [], tool_calls: [{ id: 'start', function: { name: 'spawn', arguments: '{}' } }] }, finish_reason: 'TOOL_CALL' };
      if (calls === 3) { reviewed.resolve(); await handling.promise; }
      return complete;
    },
  }, { definitions: [], async execute() { return ''; }, executeEffect: (_name, _args, _nested, origin) => agents.spawnEffect({ name: 'inspect', task: 'Research' }, origin) }); runners.push(parent);
  await parent.submit('start'); await workerStarted.promise;
  expect(status(agents).status).toBe('running'); expect(parent.active).toBe(false);
  release.resolve(); await agents.drain(); await reviewed.promise;
  expect(reports).toBe(1); expect(parent.active).toBe(true); expect(saved.filter(entry => entry.startsWith('work:'))).toHaveLength(1);
  expect(JSON.stringify(requests.at(-1))).toContain('worker finding'); handling.resolve(); await parent.running;
  await agents.drain(); expect(reports).toBe(1);
});

test('originating-turn abort and stop drain worker native cleanup before reporting', async () => {
  const started = deferred(), aborted = deferred(), cleanup = deferred(), origin = new AbortController();
  const { agents, reports } = fixture({ model: () => heldModel(started, aborted, cleanup.promise) });
  await Effect.runPromise(agents.spawnEffect({ name: 'inspect', task: 'Research' }, origin.signal)); await started.promise;
  origin.abort(); await aborted.promise;
  let stopped = false; const pending = agents.stopJob('subagent-1').then(value => { stopped = true; return value; });
  expect(stopped).toBe(false); expect(reports).toEqual([]); cleanup.resolve();
  expect(JSON.parse(await pending).status).toBe('canceled'); expect(reports).toHaveLength(1);
  await agents.stopJob('subagent-1'); expect(reports).toHaveLength(1);
});

test('the five-minute Effect deadline uses the borrowed Clock and cancels native worker I/O', async () => {
  const started = deferred(), aborted = deferred();
  const { agents, reports } = fixture({ model: () => heldModel(started, aborted) });
  await Effect.runPromise(Effect.gen(function*() {
    yield* agents.spawnEffect({ name: 'inspect', task: 'Research' });
    yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust(299_999); expect(status(agents).status).toBe('running');
    yield* TestClock.adjust(1); yield* Effect.promise(() => aborted.promise); yield* agents.drainEffect();
  }).pipe(Effect.provide(TestClock.layer())));
  expect(status(agents).status).toBe('canceled'); expect(status(agents).result).toContain('Subagent reached its 5-minute deadline.'); expect(reports).toHaveLength(1);
});

test('workers retain exactly 20 model steps and do not retry an incomplete task', async () => {
  let requests = 0;
  const { agents, reports } = fixture({ model: () => ({ model: 'selected', async stream() { requests++; return { message: { role: 'assistant', content: [], tool_calls: [{ id: String(requests), function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'TOOL_CALL' }; } }) });
  agents.spawnTask({ name: 'inspect', task: 'Research' }); await agents.drain();
  expect(requests).toBe(20); expect(status(agents).status).toBe('error'); expect(reports[0]).toContain('Model step limit (20)');
});

test('stop retains its reason and cleanup occupies the three-worker capacity until drained', async () => {
  const cleanup = deferred(), closing = deferred(); let closed = 0;
  const { agents } = fixture({ tools: () => ({ ...tools, async close() { if (++closed === 3) closing.resolve(); await cleanup.promise; } }) });
  for (const name of ['first', 'second', 'third']) agents.spawnTask({ name, task: 'Research' }); await closing.promise;
  expect(() => agents.spawnTask({ name: 'fourth', task: 'Research' })).toThrow('At most 3');
  let drained = false; const pending = agents.drain().then(() => { drained = true; }); expect(drained).toBe(false);
  cleanup.resolve(); await pending; agents.spawnTask({ name: 'fourth', task: 'Research' }); await agents.drain(); expect(closed).toBe(4);
  const started = deferred(), aborted = deferred(); const held = fixture({ model: () => heldModel(started, aborted) });
  held.agents.spawnTask({ name: 'inspect', task: 'Research' }); await started.promise;
  const result = JSON.parse(await held.agents.stopJob('subagent-1')); expect(result.status).toBe('canceled'); expect(result.result).toContain('Stopped by the parent agent or user.');
});

test('async report acceptance is awaited exactly once and rejected receipts remain visible', async () => {
  const accepted = deferred(), receipt = deferred(); let deliveries = 0;
  const { agents } = fixture({ report: async () => { deliveries++; accepted.resolve(); await receipt.promise; throw new Error('queue rejected'); } });
  agents.spawnTask({ name: 'inspect', task: 'Research' }); await accepted.promise;
  expect(agents.active).toBe(true); let drained = false;
  const pending = agents.drain().then(() => { drained = true; }); expect(drained).toBe(false); receipt.resolve(); await pending;
  expect(status(agents).status).toBe('error'); expect(status(agents).result).toContain('Report delivery failed: queue rejected');
  await agents.stopJob('subagent-1'); await agents.drain(); expect(deliveries).toBe(1); expect(agents.lastFailure).toBeDefined();
});

test('drain resnapshots workers started by a completion report', async () => {
  let reports = 0, agents!: Subagents;
  const f = fixture({ report: () => { if (++reports === 1) agents.spawnTask({ name: 'followup', task: 'Research' }); } }); agents = f.agents;
  agents.spawnTask({ name: 'first', task: 'Research' }); await agents.drain();
  expect(reports).toBe(2); expect(agents.active).toBe(false); expect(status(agents, 'subagent-2').status).toBe('completed');
});

test('closing workers is memoized, waits for cleanup and suppresses new report delivery', async () => {
  const started = deferred(), aborted = deferred(), cleanup = deferred(); let toolsClosed = 0;
  const { agents, reports } = fixture({ model: () => heldModel(started, aborted, cleanup.promise), tools: () => ({ ...tools, async close() { toolsClosed++; } }) });
  agents.spawnTask({ name: 'inspect', task: 'Research' }); await started.promise;
  const close = agents.close(); expect(agents.close()).toBe(close); await aborted.promise;
  expect(toolsClosed).toBe(0); cleanup.resolve(); await close;
  expect(toolsClosed).toBe(1); expect(agents.active).toBe(false); expect(reports).toEqual([]);
  expect(() => agents.spawnTask({ name: 'late', task: 'Research' })).toThrow('closed');
});

test('shutdown drains a report receipt already in flight without delivering it again', async () => {
  const started = deferred(), receipt = deferred(); let deliveries = 0, closed = false;
  const { agents } = fixture({ report: async () => { deliveries++; started.resolve(); await receipt.promise; } });
  agents.spawnTask({ name: 'inspect', task: 'Research' }); await started.promise;
  const close = agents.close().then(() => { closed = true; }); expect(closed).toBe(false);
  receipt.resolve(); await close; expect(deliveries).toBe(1); expect(closed).toBe(true);
});

test('native failed worker construction rolls back tools before rejecting and preserves compound causes', async () => {
  const started = deferred(), cleanup = deferred(), original = new Error('context failed'), releaseFailure = new Error('tools cleanup failed');
  const { agents } = fixture({ context() { throw original; }, tools: () => ({ ...tools, async close() { started.resolve(); await cleanup.promise; throw releaseFailure; } }) });
  let finished = false; const pending = Effect.runPromiseExit(agents.spawnEffect({ name: 'inspect', task: 'Research' })).then(exit => { finished = true; return exit; });
  await started.promise; expect(finished).toBe(false); expect(agents.list()).toBe('[]'); cleanup.resolve(); const exit = await pending;
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause) && Cause.hasDies(exit.cause)).toBe(true);
  if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(reason => Cause.isDieReason(reason) && reason.defect === releaseFailure)).toBe(true);
  expect(agents.lastFailure).toBeDefined();
});

test('legacy failed construction preserves the original error and owner close drains rollback', async () => {
  const started = deferred(), cleanup = deferred(), original = new Error('instructions failed'); let done = false;
  const { agents } = fixture({ instructions() { throw original; }, tools: () => ({ ...tools, async close() { started.resolve(); await cleanup.promise; done = true; } }) });
  expect(() => agents.spawnTask({ name: 'inspect', task: 'Research' })).toThrow(original); await started.promise;
  let closed = false; const pending = agents.close().then(() => { closed = true; }); expect(closed).toBe(false);
  cleanup.resolve(); await pending; expect(done).toBe(true);
});

test('drain cancellation stops every worker and awaits all native cleanup', async () => {
  const first = deferred(), second = deferred(), aborted = deferred(), cleanup = deferred(); let canceled = 0;
  const f = fixture({ model: () => heldModel(++canceled === 1 ? first : second, aborted, cleanup.promise) });
  f.agents.spawnTask({ name: 'first', task: 'Research' }); f.agents.spawnTask({ name: 'second', task: 'Research' }); await Promise.all([first.promise, second.promise]);
  const controller = new AbortController(); let ended = false;
  const pending = f.agents.drain(controller.signal).catch(error => { ended = true; return error; }); controller.abort(); await aborted.promise;
  expect(ended).toBe(false); cleanup.resolve(); expect(await pending).toBeInstanceOf(DOMException); expect(f.agents.active).toBe(false); expect(f.reports).toHaveLength(2);
});

test('workers keep the most recent 32 results and emit one payload-free terminal event per job', async () => {
  const { agents, reports, events } = fixture();
  for (let i = 0; i < 34; i++) { agents.spawnTask({ name: 'inspect', task: 'private task text' }); await agents.drain(); }
  const retained = JSON.parse(agents.list()); expect(retained).toHaveLength(32); expect(retained[0].subagent_id).toBe('subagent-3');
  expect(() => agents.statusOf('subagent-1')).toThrow('Unknown subagent_id'); expect(reports).toHaveLength(34);
  expect(events).toHaveLength(68); expect(JSON.stringify(events)).not.toContain('private task text');
  for (const event of events.filter(event => event.status === 'processing')) expect(events.filter(other => other.operationId === event.operationId).map(other => other.status)).toEqual(['processing', 'completed']);
});

test('a reentrant stop from the worker-start observer safely drains the published worker', async () => {
  let agents!: Subagents, stop: Promise<string> | undefined;
  const f = fixture({ onWorkflow: event => { if (event.status === 'processing') stop = agents.stopJob('subagent-1'); } }); agents = f.agents;
  agents.spawnTask({ name: 'inspect', task: 'Research' }); expect(JSON.parse(await stop!).status).toBe('canceled');
  expect(agents.active).toBe(false); expect(f.reports).toHaveLength(1);
});

test.each(['ask', 'pipe'])('CLI %s drains late workers and the parent report response before exit', async mode => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-worker-cli-')); directories.push(directory);
  const preload = path.join(directory, 'offline.js'), requests = path.join(directory, 'requests.jsonl'), chat = path.join(directory, 'chat');
  await fs.writeFile(preload, `import fs from 'node:fs';
let parentCalls = 0;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init.body)); fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(body) + '\\n');
  if (!body.stream) return Response.json({ content: [{ type: 'text', text: 'fixture summary' }], stop_reason: 'end_turn', usage: {} });
  const child = body.system.includes('You are a research subagent.');
  if (child) await new Promise(resolve => setTimeout(resolve, 60));
  const content = child ? [{ type: 'text', text: 'Worker found the facts.' }]
    : ++parentCalls === 1 ? [{ type: 'tool_use', id: 'spawn', name: 'spawn_subagent', input: { name: 'inspect', task: 'Research facts' } }]
    : [{ type: 'text', text: parentCalls === 2 ? 'Research running.' : 'Parent reviewed the research.' }];
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 20 } } },
    ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: { ...block, ...(block.type === 'text' ? { text: '' } : {}) } },
      ...(block.type === 'text' ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }] : []), { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' }];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''));
};`);
  const argv = [process.execPath, '--preload', preload, path.resolve(import.meta.dir, '../src/cli.ts'), '--plain', '--model', 'mw1.0', '--project', directory, '--chat-dir', chat, '--no-jev', '--no-metrics', ...(mode === 'ask' ? ['--ask', 'Research files'] : [])];
  const child = Bun.spawn(argv, { cwd: directory, env: { ...process.env, META_API_KEY: 'offline-worker-fixture' }, stdin: mode === 'pipe' ? new TextEncoder().encode('Research files\n') : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 4000);
  let output: string, error: string, code: number;
  try { [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); }
  finally { clearTimeout(timer); }
  expect(code).toBe(0); expect(error).toBe(''); expect(output).toContain('Parent reviewed the research.');
  const bodies = (await fs.readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(bodies.filter(body => body.stream && body.system.includes('You are a research subagent.'))).toHaveLength(1);
  expect(bodies.filter(body => body.stream && !body.system.includes('You are a research subagent.'))).toHaveLength(3);
  const { Storage } = await import('../src/storage.js');
  const storage = await Storage.open(chat);
  try {
    expect(storage.root.filter((entry: { kind: string; text: string }) => entry.kind === 'work' && entry.text.includes('[Subagent inspect; completed; muse-wonder-1.0]'))).toHaveLength(1);
    expect(storage.load('usage').filter((record: { purpose?: string }) => record.purpose === 'subagent')).toHaveLength(1);
  } finally { await storage.close(); }
});

test('workers started through a legacy registry still cancel nested native I/O on defects', async () => {
  const { ToolRegistry, schemaTool } = await import('../src/tool-registry.js'), { subagentTools } = await import('../src/subagent-tool-registry.js');
  const { parallelTools } = await import('../src/parallel-tools.js'), Schema = await import('effect/Schema');
  const started = deferred(); let canceled = false, origin: AbortSignal | undefined;
  const entry = schemaTool({ name: 'get_plan', schema: Schema.Struct({ fail: Schema.Boolean }), capabilities: ['read'], execute: () => '',
    executeEffect: (args, signal) => args.fail ? Effect.flatMap(Effect.promise(() => started.promise), () => Effect.die(new Error('native failure')))
      : toolPromise(actual => new Promise<string>((_resolve, reject) => {
        actual.addEventListener('abort', () => { canceled = true; reject(actual.reason); }, { once: true }); started.resolve();
      }), signal),
  });
  const reads: InstanceType<typeof ToolRegistry> = new ToolRegistry([entry, parallelTools((name, args) => reads.prepare(name, args))], ['read']);
  const { agents, reports } = fixture({ model: () => ({ model: 'selected', async stream() { return { message: { role: 'assistant', content: [], tool_calls: [{ id: 'batch', function: {
    name: 'parallel_tools', arguments: JSON.stringify({ calls: [true, false].map(fail => ({ tool: 'get_plan', arguments: { fail } })) }),
  } }] }, finish_reason: 'TOOL_CALL' }; } }), tools: () => ({ definitions: [], async execute() { return ''; },
    executeEffect: (name, args, nested, signal) => { origin = signal; return reads.executeEffect(name, args, nested, signal); },
  }) });
  const registry = new ToolRegistry(subagentTools(agents), ['read', 'subagents']);
  await registry.execute('spawn_subagent', { name: 'inspect', task: 'Research' }); await agents.drain();
  expect(status(agents).status).toBe('error'); expect(canceled).toBe(true); expect(origin?.aborted).toBe(false); expect(reports).toHaveLength(1);
});

test('canceling failed native startup still waits for resource rollback', async () => {
  const started = deferred(), cleanup = deferred(), controller = new AbortController(); let finished = false;
  const { agents } = fixture({ context() { throw new Error('context failed'); }, tools: () => ({ ...tools, async close() { started.resolve(); await cleanup.promise; } }) });
  const pending = Effect.runPromiseExit(agents.spawnEffect({ name: 'inspect', task: 'Research' }), { signal: controller.signal }).then(exit => { finished = true; return exit; });
  await started.promise; controller.abort(); await Bun.sleep(0); expect(finished).toBe(false);
  cleanup.resolve(); const exit = await pending; expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true); expect(agents.active).toBe(false);
});

test('worker tool cleanup failure is retained in status and diagnostics without retrying delivery', async () => {
  const failure = new Error('worker tools failed to close'); let released = 0;
  const { agents, reports } = fixture({ tools: () => ({ ...tools, async close() { released++; throw failure; } }) });
  agents.spawnTask({ name: 'inspect', task: 'Research' }); await agents.drain();
  expect(status(agents).status).toBe('error'); expect(status(agents).result).toContain(failure.message);
  expect(agents.lastFailure && Cause.hasDies(agents.lastFailure)).toBe(true);
  await agents.close(); expect(released).toBe(1); expect(reports).toHaveLength(1);
});

test('shutdown requested by the worker-start observer cannot leave an unowned runner', async () => {
  let agents!: Subagents, closed: Promise<void> | undefined, released = 0;
  const f = fixture({ tools: () => ({ ...tools, async close() { released++; } }), onWorkflow: event => {
    if (event.status === 'processing') closed = agents.close();
  } }); agents = f.agents;
  agents.spawnTask({ name: 'inspect', task: 'Research' }); await closed;
  expect(agents.active).toBe(false); expect(released).toBe(1); expect(f.reports).toEqual([]);
});
