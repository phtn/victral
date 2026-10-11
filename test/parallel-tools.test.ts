import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Schema from 'effect/Schema';
import { ToolAccessDenied, ValidationError } from '../src/core/errors.js';
import { parallelTools, ParallelToolsSchema } from '../src/parallel-tools.js';
import { ToolRegistry, schemaTool } from '../src/tool-registry.js';
import { ArgumentsObjectSchema } from '../src/tool-argument-schema.js';
import { Integrations, parseIntegrations } from '../src/integrations.js';
import { Subagents } from '../src/subagents.js';
import { projectTools, readOnlyProjectTools } from '../src/tools.js';
import type { AgentTools } from '../src/types.js';
import legacy from './fixtures/effect-migration/legacy-parallel-tools.json';

const directories: string[] = [], toolsets: AgentTools[] = [];
afterEach(async () => {
  await Promise.all(toolsets.splice(0).map(tools => tools.close?.()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-parallel-')); directories.push(root); return root;
}

test('registered batches preserve legacy preparation, signal forwarding, ordered output and UTF-8 caps', async () => {
  for (const scenario of legacy.cases) {
    const prepared: unknown[] = [], invoked: unknown[] = [], nested: string[] = [];
    const signal = new AbortController().signal;
    const registry = new ToolRegistry([parallelTools((tool, args) => {
      const i = prepared.length; prepared.push({ tool, arguments: args });
      return async forwarded => {
        invoked.push({ tool, signal: forwarded === signal });
        if (scenario.outputs[i] === null) throw new Error('Fixture runtime failure.');
        return scenario.outputs[i]!;
      };
    })], ['read']);
    const invoke = registry.prepare('parallel_tools', { calls: scenario.calls, extra: 'ignored' });
    expect(prepared).toEqual(scenario.prepared); expect(invoked).toEqual([]); expect(nested).toEqual([]);
    expect(await invoke(signal, name => nested.push(name))).toBe(scenario.output);
    expect(invoked).toEqual(scenario.invoked); expect(nested).toEqual(scenario.calls.map(call => call.tool));
  }
});

test('batch codecs ignore envelope extras and preserve every nested JSON argument key', () => {
  const input = JSON.parse('{"calls":[{"tool":"get_plan","arguments":{"__proto__":{"retained":true},"constructor":"literal","nested":[null,{"value":"🦓"}]},"extra":"ignored"}],"extra":"ignored"}');
  const expected = { calls: [{ tool: 'get_plan' as const, arguments: input.calls[0].arguments }] };
  const decoded = Schema.decodeUnknownSync(ParallelToolsSchema)(input);
  expect(decoded).toEqual(expected); expect(Schema.encodeSync(ParallelToolsSchema)(decoded)).toEqual(expected);
  expect(Object.hasOwn(decoded.calls[0]!.arguments, '__proto__')).toBe(true);
});

test('malformed batch envelopes fail with safe paths before nested preparation, I/O or telemetry', async () => {
  let prepared = 0, executed = 0;
  const nested: string[] = [], valid = { tool: 'fetch_url', arguments: { url: 'https://example.test' } };
  const registry = new ToolRegistry([parallelTools(() => { prepared++; return async () => { executed++; return ''; }; })], ['read']);
  const cases: [unknown, string | undefined][] = [
    [null, undefined], [[], undefined], [0, undefined], ['secret-envelope', undefined], [{}, 'calls'],
    [{ calls: null }, 'calls'], [{ calls: {} }, 'calls'], [{ calls: [] }, 'calls'],
    [{ calls: Array.from({ length: 9 }, () => valid) }, 'calls'], [{ calls: Array(2) }, 'calls'],
    ...[null, [], 0, 'secret-call', {}, { arguments: {} }, { tool: 1, arguments: {} },
      { tool: 'secret-unknown-tool', arguments: {} }, { tool: 'parallel_tools', arguments: {} },
      { tool: 'write_file', arguments: {} }, { tool: 'get_plan' },
      ...[null, [], 0, 'secret-arguments'].map(argumentsValue => ({ tool: 'get_plan', arguments: argumentsValue })),
    ].map(call => [{ calls: [valid, call] }, 'calls'] as [unknown, string]),
  ];
  for (const [value, field] of cases) {
    const error: unknown = await registry.execute('parallel_tools', value, undefined, name => nested.push(name)).catch(error => error);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw new Error('Expected validation failure.');
    expect(error.boundary).toBe('parallel_tools arguments'); expect(error.cause).toBeInstanceOf(Schema.SchemaError);
    if (field) expect(error.message).toContain(field);
    expect(error.message).not.toContain('secret-');
  }
  expect(prepared).toBe(0); expect(executed).toBe(0); expect(nested).toEqual([]);
});

test('batch preparation validates all nested schemas and captures decoded values before returning', async () => {
  let executed = 0;
  const registry: ToolRegistry = new ToolRegistry([
    schemaTool({ name: 'fetch_url', schema: Schema.Struct({ url: Schema.String }), capabilities: ['read'],
      execute: args => { executed++; return args.url; } }),
    schemaTool({ name: 'get_plan', schema: ArgumentsObjectSchema, capabilities: ['read'], execute: () => { executed++; return 'plan'; } }),
    parallelTools((name, args) => registry.prepare(name, args)),
  ], ['read']);
  expect(() => registry.prepare('parallel_tools', { calls: [
    { tool: 'get_plan', arguments: {} }, { tool: 'fetch_url', arguments: { url: 1 } },
  ] })).toThrow(ValidationError);
  expect(executed).toBe(0);
  const input = { calls: [{ tool: 'fetch_url', arguments: { url: 'original' } }] };
  const invoke = registry.prepare('parallel_tools', input);
  input.calls[0]!.arguments.url = 'changed'; input.calls.push({ tool: 'fetch_url', arguments: { url: 'later' } });
  expect(executed).toBe(0);
  expect(await invoke()).toBe('[1/1 fetch_url; status: completed]\noriginal'); expect(executed).toBe(1);
});

test('batch execution is concurrent and results retain input order after later calls finish first', async () => {
  const started: number[] = [], finished: number[] = [], release: (() => void)[] = [];
  const gates = [0, 1].map(i => new Promise<void>(resolve => { release[i] = resolve; }));
  let i = 0;
  const registry = new ToolRegistry([parallelTools(() => {
    const index = i++;
    return async () => { started.push(index); await gates[index]; finished.push(index); return `result ${index}`; };
  })], ['read']);
  const pending = registry.execute('parallel_tools', { calls: [0, 1].map(() => ({ tool: 'get_plan', arguments: {} })) });
  expect(started).toEqual([0, 1]); release[1]!(); await gates[1]; expect(finished).toEqual([1]); release[0]!();
  expect(await pending).toBe('[1/2 get_plan; status: completed]\nresult 0\n\n[2/2 get_plan; status: completed]\nresult 1');
  expect(finished).toEqual([1, 0]);
});

test('batch capability denial and pre-aborted execution precede decoding and nested work', async () => {
  let prepared = 0, executed = 0;
  const nested: string[] = [], entry = parallelTools(() => { prepared++; return async () => { executed++; return ''; }; });
  const denied = new ToolRegistry([entry], []);
  await expect(denied.execute('parallel_tools', null)).rejects.toBeInstanceOf(ToolAccessDenied);
  expect(prepared).toBe(0);
  const registry = new ToolRegistry([entry], ['read']), controller = new AbortController();
  const reason = new Error('Fixture cancellation.'); controller.abort(reason);
  await expect(registry.execute('parallel_tools', null, controller.signal)).rejects.toBe(reason); expect(prepared).toBe(0);
  const invoke = registry.prepare('parallel_tools', { calls: [{ tool: 'get_plan', arguments: {} }] });
  await expect(invoke(controller.signal, name => nested.push(name))).rejects.toBe(reason);
  expect(prepared).toBe(1); expect(executed).toBe(0); expect(nested).toEqual([]);
});

test('in-flight batch cancellation reaches every nested call and escapes individual result formatting', async () => {
  const signals: (AbortSignal | undefined)[] = [], nested: string[] = [], controller = new AbortController();
  const registry = new ToolRegistry([parallelTools(() => signal => new Promise((_resolve, reject) => {
    signals.push(signal); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }))], ['read']);
  const pending = registry.execute('parallel_tools', { calls: [0, 1].map(() => ({ tool: 'get_plan', arguments: {} })) }, controller.signal, name => nested.push(name));
  expect(signals).toEqual([controller.signal, controller.signal]); expect(nested).toEqual(['get_plan', 'get_plan']);
  const reason = new Error('Fixture cancellation.'); controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test('disabled command reads retain legacy per-call failures in both project and worker batches', async () => {
  const root = await directory();
  for (const create of [projectTools, readOnlyProjectTools]) {
    const tools = create({ zoom: () => '', date: () => '' }, root); toolsets.push(tools);
    const nested: string[] = [];
    expect(await tools.execute('parallel_tools', { calls: legacy.disabledCommands.calls, extra: 'ignored' }, undefined, name => nested.push(name))).toBe(legacy.disabledCommands.output);
    expect(nested).toEqual(legacy.disabledCommands.nested);
    expect(tools.definitions.some(tool => ['command_status', 'list_commands'].includes(tool.function.name))).toBe(false);
  }
});

test('every enabled provider tool has a validating registry boundary before service acquisition', async () => {
  let acquired = 0;
  const unexpected = () => { acquired++; throw new Error('Must not acquire resources'); };
  const root = await directory();
  const integrations = new Integrations(parseIntegrations({ servers: {} }), root);
  const subagents = new Subagents({ model: unexpected, tools: unexpected, context: unexpected, instructions: unexpected, report: unexpected });
  const fetchImpl = Object.assign(unexpected, { preconnect: unexpected });
  const tools = projectTools({ zoom: unexpected, date: unexpected }, root, { allowShell: true, integrations, subagents, fetchImpl }); toolsets.push(tools);
  for (const tool of tools.definitions) {
    for (const input of [null, [], 'secret-envelope']) {
      const error: unknown = await tools.execute(tool.function.name, input).catch(error => error);
      expect(error).toBeInstanceOf(ValidationError);
    }
  }
  await expect(tools.execute('unregistered', null)).rejects.toThrow('Unknown or disabled tool: unregistered');
  expect(acquired).toBe(0);
});
