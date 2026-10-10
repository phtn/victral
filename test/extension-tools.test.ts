import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Schema from 'effect/Schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Integrations, parseIntegrations } from '../src/integrations.js';
import { Subagents, type SubagentOptions } from '../src/subagents.js';
import { integrationTools } from '../src/integration-tool-registry.js';
import { subagentTools } from '../src/subagent-tool-registry.js';
import { CallIntegrationToolSchema } from '../src/integration-tool-schema.js';
import { SpawnSubagentSchema, SubagentStatusSchema } from '../src/subagent-tool-schema.js';
import { ToolAccessDenied, ValidationError } from '../src/core/errors.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { projectTools, readOnlyProjectTools, type ToolOptions } from '../src/tools.js';
import type { AgentTools, ModelPort } from '../src/types.js';
import legacy from './fixtures/effect-migration/legacy-extension-tools.json';

const directories: string[] = [], toolsets: AgentTools[] = [], resources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  setSystemTime();
  await Promise.all(toolsets.splice(0).map(tools => tools.close?.()));
  await Promise.all(resources.splice(0).map(resource => resource.close()));
  mock.restore();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(options: ToolOptions = {}, readOnly = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'victral-extensions-'))); directories.push(root);
  const tools = (readOnly ? readOnlyProjectTools : projectTools)({ zoom: () => '', date: () => '' }, root, options); toolsets.push(tools);
  return tools;
}
const workerNames = ['spawn_subagent', 'list_subagents', 'subagent_status', 'stop_subagent'];
const integrationNames = ['list_integrations', 'list_integration_tools', 'call_integration_tool'];
function workers(options: Partial<SubagentOptions> = {}) {
  let factories = 0;
  const agents = new Subagents({ model: () => { factories++; throw new Error('Must not create a model'); },
    tools: () => { factories++; throw new Error('Must not create tools'); }, context: () => { factories++; return ''; },
    instructions: () => { factories++; return ''; }, report: () => { factories++; }, ...options });
  resources.push(agents); return { agents, factories: () => factories };
}
function integrations(config: unknown = { servers: { docs: { url: 'https://example.test/mcp', allowTools: ['lookup', '*'] } } }) {
  const parsed = parseIntegrations(config), service = new Integrations(parsed, '/fixture/project'); resources.push(service);
  return { parsed, service, registry: new ToolRegistry(integrationTools(service), ['read', 'integrations']) };
}
function assertValidation(error: unknown, field: string) {
  expect(error).toBeInstanceOf(ValidationError);
  if (!(error instanceof ValidationError)) throw new Error('Expected validation failure.');
  expect(error.message).toContain(field); expect(error.message).not.toContain('secret-'); expect(error.cause).toBeInstanceOf(Schema.SchemaError);
}

test('registered MCP tools match legacy result bytes, pagination, redaction and exact SDK requests', async () => {
  const captured = legacy.integrations, previous = process.env[captured.environment];
  process.env[captured.environment] = captured.secret;
  const requests: Record<string, unknown>[] = [];
  spyOn(Client.prototype, 'connect').mockImplementation(async (_transport, options) => { requests.push({ method: 'connect', timeout: options?.timeout, signal: !!options?.signal }); });
  spyOn(Client.prototype, 'close').mockImplementation(async () => {});
  spyOn(Client.prototype, 'listTools').mockImplementation(async (params, options) => {
    requests.push({ method: 'listTools', params, timeout: options?.timeout, signal: !!options?.signal });
    return params?.cursor ? { tools: [
      { name: '*', inputSchema: { type: 'object' } }, { name: 'Lookup', inputSchema: { type: 'object' } },
    ] } : { tools: [
      { name: 'lookup', description: `${captured.secret}:Guide 🦓`, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: true }, annotations: { readOnlyHint: true } },
      { name: 'disabled', inputSchema: { type: 'object' } },
    ], nextCursor: 'next' };
  });
  spyOn(Client.prototype, 'callTool').mockImplementation(async (params, _schema, options) => {
    requests.push({ method: 'callTool', params, timeout: options?.timeout, signal: !!options?.signal });
    if (params.arguments?.resultKind === 'structured') return { content: [], structuredContent: { info: 'Structured 🦓', secret: captured.secret } };
    if (params.arguments?.resultKind === 'error') return { content: [{ type: 'text', text: `${captured.secret}:failure` }], isError: true };
    return { content: [{ type: 'text', text: `${captured.secret}:Hello 🦓` }, { type: 'image', data: 'synthetic', mimeType: 'image/png' }] };
  });
  const { service } = integrations(captured.config), tools = await fixture({ integrations: service });
  try {
    for (const call of captured.calls) {
      const start = requests.length;
      if (call.error !== undefined) await expect(tools.execute(call.tool, call.arguments)).rejects.toThrow(call.error);
      else expect(await tools.execute(call.tool, call.arguments)).toBe(call.output);
      expect(JSON.stringify(requests.slice(start))).toBe(JSON.stringify(call.requests));
    }
  } finally {
    await tools.close?.();
    if (previous === undefined) delete process.env[captured.environment]; else process.env[captured.environment] = previous;
  }
});

test('registered workers match legacy start/list/status/stop output, raw prompts and automatic report bytes', async () => {
  setSystemTime(new Date(legacy.time));
  const reports: string[] = [], messages: string[] = [];
  const model: ModelPort = { model: 'selected-fixture-model', async stream(input, options) {
    messages.push(JSON.stringify(input)); options.onText('Finding 🦓 from facts.ts');
    return { message: { role: 'assistant', content: 'Finding 🦓 from facts.ts' }, finish_reason: 'COMPLETE' };
  } };
  const { agents } = workers({ model: () => model, tools: () => ({ definitions: [], async execute() { throw new Error('No worker tool calls'); } }),
    context: () => 'Frozen parent context', instructions: () => 'Fixture instructions', report: text => reports.push(text) });
  const tools = await fixture({ subagents: agents });
  for (const call of legacy.workers.calls) {
    if (call.drainBefore) await agents.drain();
    expect(await tools.execute(call.tool, call.arguments)).toBe(call.output);
  }
  expect(reports).toEqual(legacy.workers.reports); expect(messages).toEqual(legacy.workers.messages);
});

test('extension codecs keep raw worker bounds, exact names and all opaque MCP payload keys', () => {
  const task = ' 🦓\0' + 'x'.repeat(11_996); expect(task.length).toBe(12_000);
  const spawn = Schema.decodeUnknownSync(SpawnSubagentSchema)({ name: 'a'.repeat(40), task, extra: true });
  expect(spawn).toEqual({ name: 'a'.repeat(40), task }); expect(Schema.encodeSync(SpawnSubagentSchema)(spawn)).toEqual(spawn);
  expect(Schema.decodeUnknownSync(SpawnSubagentSchema)({ name: 'worker', task: ' task ' })).toEqual({ name: 'worker', task: ' task ' });
  expect(() => Schema.decodeUnknownSync(SpawnSubagentSchema)({ name: 'worker\n', task: 'Task' })).toThrow(Schema.SchemaError);
  expect(Schema.decodeUnknownSync(SubagentStatusSchema)({ subagent_id: '', extra: true })).toEqual({ subagent_id: '' });
  const payload = JSON.parse('{"__proto__":{"literal":true},"constructor":"kept","nested":{"list":[null,true,42,"🦓"],"extra":true}}');
  const call = Schema.decodeUnknownSync(CallIntegrationToolSchema)({ server: 'constructor', tool: '*', arguments: payload, extra: true });
  expect(JSON.stringify(call.arguments)).toBe(JSON.stringify(payload)); expect(Object.hasOwn(call.arguments, '__proto__')).toBe(true);
  expect(Schema.encodeSync(CallIntegrationToolSchema)(call)).toEqual({ server: 'constructor', tool: '*', arguments: payload });
});

test('malformed worker inputs fail before model/tool/context factories and retain useful safe Schema paths', async () => {
  const { agents, factories } = workers(), registry = new ToolRegistry(subagentTools(agents), ['read', 'subagents']);
  for (const name of [undefined, null, '', '3worker', '-worker', 'worker\n', 'a'.repeat(41), 'secret-name!']) {
    assertValidation(await registry.execute('spawn_subagent', { name, task: 'Task' }).catch(error => error), 'name');
  }
  for (const task of [undefined, null, 42, '', ' \n\t', 'x'.repeat(12_001), 'x' + ' '.repeat(12_000)]) {
    assertValidation(await registry.execute('spawn_subagent', { name: 'worker', task }).catch(error => error), 'task');
  }
  for (const name of ['subagent_status', 'stop_subagent']) for (const subagent_id of [undefined, null, 42, { secret: 'secret-id' }]) {
    assertValidation(await registry.execute(name, { subagent_id }).catch(error => error), 'subagent_id');
  }
  for (const name of workerNames) for (const value of [null, [], 'secret-record']) await expect(registry.execute(name, value)).rejects.toBeInstanceOf(ValidationError);
  expect(() => agents.spawn({ name: 'worker', task: ' ' })).toThrow(ValidationError);
  expect(() => agents.status({ subagent_id: null })).toThrow(ValidationError);
  await expect(agents.stop({ subagent_id: null })).rejects.toBeInstanceOf(ValidationError);
  expect(factories()).toBe(0); expect(agents.list()).toBe('[]');
  for (const name of ['subagent_status', 'stop_subagent']) await expect(registry.execute(name, { subagent_id: 'unknown' })).rejects.toThrow('use list_subagents');
});

test('malformed MCP payloads fail before acquisition or environment references while server/allowlist denials keep precedence', async () => {
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(async () => { throw new Error('Must not acquire'); });
  const { service, registry } = integrations({ servers: { docs: { command: 'never-spawn-this-fixture', env: { TOKEN: 'VICTRAL_UNSET_EXTENSION_FIXTURE' }, allowTools: ['lookup', '*'] } } });
  for (const server of [undefined, null, 42, { secret: 'secret-server' }]) {
    for (const name of ['list_integration_tools', 'call_integration_tool']) {
      const error = await registry.execute(name, { server, tool: 'lookup', arguments: {} }).catch(error => error);
      assertValidation(error, 'server'); expect(error.boundary).toBe(`${name} arguments`);
    }
  }
  for (const tool of [undefined, null, 42, { secret: 'secret-tool' }]) assertValidation(await registry.execute('call_integration_tool', { server: 'docs', tool, arguments: {} }).catch(error => error), 'tool');
  for (const args of [undefined, null, [], 'secret-payload', 42]) {
    const value = { server: 'docs', tool: 'lookup', arguments: args };
    assertValidation(await registry.execute('call_integration_tool', value).catch(error => error), 'arguments');
    await expect(service.execute('call_integration_tool', value)).rejects.toBeInstanceOf(ValidationError);
  }
  for (const name of integrationNames) for (const value of [null, [], 'secret-record']) await expect(registry.execute(name, value)).rejects.toBeInstanceOf(ValidationError);
  for (const tool of ['Lookup', 'disabled']) await expect(registry.execute('call_integration_tool', { server: 'docs', tool, arguments: null })).rejects.toThrow('not enabled');
  for (const server of ['unknown', 'constructor', 'toString', '__proto__']) {
    await expect(registry.execute('call_integration_tool', { server, tool: null, arguments: null })).rejects.toThrow(`Unknown integration: ${server}.`);
  }
  await expect(service.execute('unknown-operation', { server: 'docs' })).rejects.toThrow('Unknown integration operation');
  expect(connect).not.toHaveBeenCalled(); expect(service.list()).toContain('"connected": false');
});

test('extension capabilities precede decoding and disabled/worker/batch restrictions remain unchanged', async () => {
  const { agents, factories } = workers(), { service } = integrations();
  const denied = new ToolRegistry([...subagentTools(agents), ...integrationTools(service)], ['read', 'write', 'shell']);
  const names = [...workerNames, ...integrationNames];
  for (const name of names) await expect(denied.execute(name, null)).rejects.toBeInstanceOf(ToolAccessDenied);
  const enabledWithoutReads = new ToolRegistry([...subagentTools(agents), ...integrationTools(service)], ['subagents', 'integrations']);
  for (const name of ['list_subagents', 'subagent_status', 'list_integrations', 'list_integration_tools']) await expect(enabledWithoutReads.execute(name, null)).rejects.toBeInstanceOf(ToolAccessDenied);
  const disabled = await fixture(), worker = await fixture({}, true);
  for (const name of names) {
    expect(disabled.definitions.some(tool => tool.function.name === name)).toBe(false);
    expect(worker.definitions.some(tool => tool.function.name === name)).toBe(false);
    await expect(disabled.execute(name, {})).rejects.toThrow('Unknown or disabled');
    await expect(worker.execute(name, {})).rejects.toThrow('cannot use');
  }
  let requests = 0; const nested: string[] = [];
  const tools = await fixture({ subagents: agents, integrations: service, fetchImpl: (async () => { requests++; return new Response('page'); }) as unknown as typeof fetch });
  for (const name of names) await expect(tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool: name, arguments: {} },
  ] }, undefined, name => nested.push(name))).rejects.toThrow('read-only');
  expect(factories()).toBe(0); expect(requests).toBe(0); expect(nested).toEqual([]); expect(service.list()).toContain('"connected": false');
});

test('prepared worker starts recheck capacity, reuse freed slots and keep selected models and stop reports', async () => {
  let created = 0; const reports: string[] = [];
  const { agents } = workers({ model: () => { created++; return { model: 'selected-model', async stream(_messages, { signal }) {
    return new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } }; }, tools: () => ({ definitions: [], async execute() { return ''; } }), context: () => '', instructions: () => '', report: text => reports.push(text) });
  const registry = new ToolRegistry(subagentTools(agents), ['read', 'subagents']);
  const pending = registry.prepare('spawn_subagent', { name: 'fourth', task: 'Research' }); expect(created).toBe(0);
  for (const name of ['first', 'second', 'third']) await registry.execute('spawn_subagent', { name, task: 'Research' });
  await expect(pending()).rejects.toThrow('At most 3'); expect(created).toBe(3);
  const stopped = JSON.parse(await registry.execute('stop_subagent', { subagent_id: 'subagent-1' }));
  expect(stopped.status).toBe('canceled'); expect(stopped.result).toContain('Stopped by the parent agent or user.');
  expect(reports).toHaveLength(1); expect(JSON.parse(await pending()).model).toBe('selected-model'); expect(created).toBe(4);
  await agents.close(); expect(reports).toHaveLength(1);
});

test('prepared extension calls recheck allowlists/closure and pre-aborted calls do no acquisition or worker work', async () => {
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(async () => { throw new Error('Must not acquire'); });
  const { agents, factories } = workers(), { service, parsed } = integrations();
  const registry = new ToolRegistry([...subagentTools(agents), ...integrationTools(service)], ['read', 'subagents', 'integrations']);
  const spawn = registry.prepare('spawn_subagent', { name: 'worker', task: 'Research' });
  const call = registry.prepare('call_integration_tool', { server: 'docs', tool: 'lookup', arguments: {} });
  const controller = new AbortController(); controller.abort();
  for (const name of [...workerNames, ...integrationNames]) await expect(registry.execute(name, null, controller.signal)).rejects.toThrow('aborted');
  await expect(spawn(controller.signal)).rejects.toThrow('aborted'); await expect(call(controller.signal)).rejects.toThrow('aborted');
  await expect(service.execute('call_integration_tool', null, controller.signal)).rejects.toThrow('aborted');
  parsed.docs!.allowTools.splice(0, 1); await expect(call()).rejects.toThrow('not enabled');
  const literalWildcard = registry.prepare('call_integration_tool', { server: 'docs', tool: '*', arguments: {} });
  await service.close(); await expect(literalWildcard()).rejects.toThrow('closed');
  await agents.close(); await expect(spawn()).rejects.toThrow('closed'); expect(() => agents.spawn(null)).toThrow('closed');
  expect(connect).not.toHaveBeenCalled(); expect(factories()).toBe(0);
});

test('typed MCP discovery retains repeated-cursor/tool-count guards and capped/redacted call failures', async () => {
  spyOn(Client.prototype, 'connect').mockImplementation(async () => {}); spyOn(Client.prototype, 'close').mockImplementation(async () => {});
  const list = spyOn(Client.prototype, 'listTools').mockImplementation(async () => ({ tools: [], nextCursor: 'repeated' }));
  const { registry } = integrations();
  await expect(registry.execute('list_integration_tools', { server: 'docs' })).rejects.toThrow('repeated its tool-list cursor'); expect(list).toHaveBeenCalledTimes(2);
  list.mockImplementation(async () => ({ tools: Array.from({ length: 501 }, () => ({ name: 'tool', inputSchema: { type: 'object' as const } })) }));
  await expect(registry.execute('list_integration_tools', { server: 'docs' })).rejects.toThrow('exceeds 500');
  spyOn(Client.prototype, 'callTool').mockImplementation(async () => ({ content: [{ type: 'text', text: '🦓'.repeat(40_000) }], isError: true }));
  const error = await registry.execute('call_integration_tool', { server: 'docs', tool: 'lookup', arguments: {} }).catch(error => error);
  expect(error.message).toContain('Integration tool failed:'); expect(error.message).toContain('[cut:'); expect(error.message).not.toContain('�');
  expect(Array.from(error.message).length).toBeLessThanOrEqual(30_000);
});

test('registered worker completion reports once and keeps delivery failures visible in retained status', async () => {
  let delivered = 0;
  const { agents } = workers({ model: () => ({ model: 'selected-model', async stream(_messages, options) {
    options.onText('Verified finding'); return { message: { role: 'assistant', content: 'Verified finding' }, finish_reason: 'COMPLETE' };
  } }), tools: () => ({ definitions: [], async execute() { return ''; } }), context: () => '', instructions: () => '', report: () => { delivered++; throw new Error('Fixture delivery failure'); } });
  const registry = new ToolRegistry(subagentTools(agents), ['read', 'subagents']);
  await registry.execute('spawn_subagent', { name: 'worker', task: 'Research' }); await agents.drain();
  const status = JSON.parse(await registry.execute('subagent_status', { subagent_id: 'subagent-1' }));
  expect(status.status).toBe('error'); expect(status.result).toContain('Verified finding'); expect(status.result).toContain('Report delivery failed: Fixture delivery failure');
  await registry.execute('stop_subagent', { subagent_id: 'subagent-1' }); await agents.drain(); expect(delivered).toBe(1);
});
