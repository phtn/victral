import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebBrowser } from '../src/web-browser.js';
import { Integrations, parseIntegrations } from '../src/integrations.js';
import { Subagents } from '../src/subagents.js';
import { readOnlyProjectTools } from '../src/tools.js';
import { Runner } from '../src/runner.js';
import type { ModelPort, MemoryPort } from '../src/types.js';

const fetchPage = (body: string, type = 'text/html') => (async () => new Response(body, { headers: { 'content-type': type } })) as unknown as typeof fetch;
test('web snapshots extract readable lines and relative links, support follow-up reads, and omit scripts', async () => {
  const browser = new WebBrowser(fetchPage('<html><head><title>Guide</title></head><body><nav>Noise</nav><main><h1>Welcome</h1><p>Unicode 🦓 &amp; text</p><script>secret script</script><p><a href="../details">Details</a></p><a href="javascript:bad">Bad link</a></main></body></html>'));
  const page = JSON.parse(await browser.open({ url: 'https://example.test/docs/guide' }));
  expect(page.title).toBe('Guide'); expect(page.text).toContain('Unicode 🦓 & text');
  expect(page.text).not.toContain('secret script'); expect(page.text).not.toContain('Noise');
  expect(page.links).toEqual([{ id: 1, text: 'Details', url: 'https://example.test/details' }]);
  const matches = JSON.parse(browser.find({ page_id: page.page_id, query: 'unicode' }));
  expect(matches.total_matches).toBe(1);
  const slice = JSON.parse(browser.read({ page_id: page.page_id, start_line: matches.matches[0].line, max_lines: 1 }));
  expect(slice.text).toContain('Unicode'); expect(slice.text).not.toContain('Details');
  expect(() => browser.read({ page_id: page.page_id, max_lines: 0 })).toThrow();
});
test('browsing bounds responses, validates URLs and honors cancellation', async () => {
  await expect(new WebBrowser(fetchPage('a'.repeat(2_000_001), 'text/plain')).open({ url: 'https://example.test' })).rejects.toThrow('2 MB');
  await expect(new WebBrowser(fetchPage('pdf', 'application/pdf')).open({ url: 'https://example.test' })).rejects.toThrow('Cannot browse');
  for (const url of ['file:///etc/passwd', 'https://user:password@example.test']) await expect(new WebBrowser().open({ url })).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(new WebBrowser(fetchPage('test')).open({ url: 'https://example.test' }, controller.signal)).rejects.toThrow();
});
test('MCP config defaults to discovery only and rejects ambiguous transports or literal secrets', () => {
  expect(parseIntegrations({ servers: { docs: { command: 'node', args: ['server.js'] } } }).docs?.allowTools).toEqual([]);
  for (const server of [{ command: 'node', url: 'https://example.test' }, { url: 'file:///tmp/server' }, { url: 'https://example.test', headers: { Authorization: 'Bearer literal-secret' } }, { command: 'node', allowTools: '*' }]) {
    expect(() => parseIntegrations({ servers: { bad: server } })).toThrow();
  }
});
test('MCP stdio discovers paginated schemas, enforces exact tool access, redacts credentials and closes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-mcp-'));
  const filename = path.join(directory, 'server.js');
  await fs.writeFile(filename, `import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
 const message = JSON.parse(line); if (message.id === undefined) return;
 const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
 : message.method === 'tools/list' ? { tools: [{ name: message.params.cursor ? 'disabled' : 'lookup', description: 'test', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }], ...(message.params.cursor ? {} : { nextCursor: 'next' }) }
 : { content: [{ type: 'text', text: process.env.TEST_TOKEN + ':' + message.params.arguments.query }], isError: message.params.arguments.query === 'error' };
 console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});`);
  process.env.VICTRAL_MCP_TEST_TOKEN = 'fixture-sensitive-value';
  const integrations = new Integrations(parseIntegrations({ servers: { fixture: { command: process.execPath, args: [filename], env: { TEST_TOKEN: 'VICTRAL_MCP_TEST_TOKEN' }, allowTools: ['lookup'] } } }), directory);
  try {
    await expect(integrations.execute('call_integration_tool', { server: 'fixture', tool: 'disabled', arguments: {} })).rejects.toThrow('not enabled');
    expect(integrations.list()).toContain('"connected": false');
    const discovery = JSON.parse(await integrations.execute('list_integration_tools', { server: 'fixture' }));
    expect(discovery.tools.map((tool: { enabled: boolean }) => tool.enabled)).toEqual([true, false]);
    expect(discovery.tools[0].inputSchema.properties.query.type).toBe('string');
    expect(await integrations.execute('call_integration_tool', { server: 'fixture', tool: 'lookup', arguments: { query: 'hello' } })).toBe('[redacted]:hello');
    await expect(integrations.execute('call_integration_tool', { server: 'fixture', tool: 'lookup', arguments: { query: 'error' } })).rejects.toThrow('Integration tool failed: [redacted]:error');
    await expect(integrations.execute('list_integration_tools', { server: 'toString' })).rejects.toThrow('Unknown integration');
  } finally { await integrations.close(); delete process.env.VICTRAL_MCP_TEST_TOKEN; await fs.rm(directory, { recursive: true, force: true }); }
  await expect(integrations.execute('list_integration_tools', { server: 'fixture' })).rejects.toThrow('closed');
});
test('research subagents keep selected models, execute read-only tools and automatically report once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-subagent-'));
  await fs.writeFile(path.join(directory, 'facts.txt'), 'verified finding');
  const reports: string[] = []; let calls = 0;
  const model: ModelPort = { model: 'gpt-6.1-sol', async stream(messages, options) {
    expect(JSON.stringify(messages)).toContain('frozen parent context');
    expect(options.tools.some(tool => tool.function.name === 'write_file')).toBe(false);
    if (calls++ === 0) return { message: { role: 'assistant', content: [], tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"facts.txt"}' } }] }, finish_reason: 'TOOL_CALL' };
    expect(JSON.stringify(messages)).toContain('verified finding');
    options.onText('Found facts.txt'); return { message: { role: 'assistant', content: 'Found facts.txt' }, finish_reason: 'COMPLETE' };
  } };
  const agents = new Subagents({ model: () => model, tools: () => readOnlyProjectTools({ zoom: () => '', date: () => '' }, directory), context: () => 'frozen parent context', instructions: () => '', report: text => reports.push(text) });
  try {
    const started = JSON.parse(agents.spawn({ name: 'research', task: 'Inspect facts' }));
    expect(started.model).toBe('gpt-6.1-sol');
    await agents.drain(); expect(reports).toHaveLength(1); expect(reports[0]).toContain('Found facts.txt');
    expect(JSON.parse(agents.status({ subagent_id: started.subagent_id })).status).toBe('completed');
    const tools = readOnlyProjectTools({ zoom: () => '', date: () => '' }, directory);
    try {
      for (const name of ['write_file', 'shell', 'spawn_subagent', 'call_integration_tool', 'update_plan']) await expect(tools.execute(name, {})).rejects.toThrow('cannot use');
      await expect(tools.execute('parallel_tools', { calls: [{ tool: 'write_file', arguments: {} }] })).rejects.toThrow('read-only');
    } finally { await tools.close?.(); }
  } finally { await agents.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
test('subagents bound concurrency and propagate stop and originating-turn cancellation', async () => {
  const reports: string[] = [];
  const agents = new Subagents({ model: () => ({ model: 'same-model', async stream(_messages, { signal }) {
    return new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } }), tools: () => ({ definitions: [], async execute() { return ''; } }), context: () => '', instructions: () => '', report: text => reports.push(text) });
  try {
    const controller = new AbortController();
    const first = JSON.parse(agents.spawn({ name: 'first', task: 'Research' }, controller.signal));
    agents.spawn({ name: 'second', task: 'Research' }); agents.spawn({ name: 'third', task: 'Research' });
    expect(() => agents.spawn({ name: 'fourth', task: 'Research' })).toThrow('At most 3');
    controller.abort();
    await agents.stop({ subagent_id: first.subagent_id });
    expect(JSON.parse(agents.status({ subagent_id: first.subagent_id })).status).toBe('canceled');
    expect(reports).toHaveLength(1);
  } finally { await agents.close(); }
  expect(reports).toHaveLength(1);
});
test('runner caps model steps and stores agent reports as work rather than user input', async () => {
  const logged: string[] = [], errors: string[] = [];
  const memory: MemoryPort = { render: () => '', settle: async () => true, append: kind => { logged.push(kind); }, zoom: () => '', date: () => '' };
  const runner = new Runner(memory, { model: 'test', async stream() { return { message: { role: 'assistant', content: [], tool_calls: [{ id: '1', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'TOOL_CALL' }; } }, { definitions: [], async execute() { return 'data'; } }, '', { maxModelSteps: 2, onError: text => errors.push(text) });
  await runner.submit('[Subagent findings]', 'work');
  expect(errors[0]).toContain('step limit'); expect(logged[0]).toBe('work'); expect(logged.filter(kind => kind === 'echo')).toHaveLength(2);
  await runner.close();
});

test('session receives late research reports, saves them as work and drains the parent response', async () => {
  const { Session } = await import('../src/session.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-reports-'));
  const originalFetch = globalThis.fetch, originalKey = process.env.META_API_KEY;
  process.env.META_API_KEY = 'offline-test';
  let release!: () => void, parentCalls = 0;
  const childGate = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    const child = body.system.includes('You are a research subagent.');
    if (child) await childGate;
    const content = child ? [{ type: 'text', text: 'Research finding from worker' }]
      : parentCalls++ === 0 ? [{ type: 'tool_use', id: 'spawn-1', name: 'spawn_subagent', input: { name: 'inspect', task: 'Research files' } }]
      : [{ type: 'text', text: parentCalls === 2 ? 'Research is running' : 'Parent reviewed the research finding' }];
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 20 } } },
      ...content.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: { ...block, ...(block.type === 'text' ? { text: '' } : {}) } },
        ...(block.type === 'text' ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'text' in block ? block.text : '' } }] : []),
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  }) as unknown as typeof fetch;
  let session: Awaited<ReturnType<typeof Session.open>> | undefined;
  try {
    session = await Session.open({ project: directory, chatDir: path.join(directory, 'chat'), model: 'muse-spark-1.3', compactorModel: 'muse-spark-1.3', allowShell: false, jev: false, metrics: true, webSearch: true });
    await session.submit('Use a subagent to research files');
    expect(parentCalls).toBe(2); expect(session.snapshot().active).toBe(false);
    release(); await session.settle(new AbortController().signal);
    expect(parentCalls).toBe(3);
    expect(JSON.stringify(requests.at(-1))).toContain('Research finding from worker');
    expect(session.storage.root.some((entry: { kind: string; text: string }) => entry.kind === 'work' && entry.text.includes('[Subagent inspect; completed; muse-spark-1.3]'))).toBe(true);
    expect(session.storage.load('usage').filter((record: { purpose?: string }) => record.purpose === 'subagent')).toHaveLength(1);
    expect(session.snapshot().entries.at(-1)?.text).toContain('Parent reviewed');
  } finally {
    release(); await session?.close(); globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = originalKey;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
