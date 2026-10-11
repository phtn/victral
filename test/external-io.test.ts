import { expect, test } from 'bun:test';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { Http, HttpFailure, readResponseBytes } from '../src/core/http.js';
import { Mcp, McpFailure, acquireMcpResource, type McpClient, type McpFactory } from '../src/core/mcp.js';
import { IOError, TimeoutError } from '../src/core/errors.js';
import { WebBrowser } from '../src/web-browser.js';
import { Integrations, parseIntegrations } from '../src/integrations.js';
import { projectTools } from '../src/tools.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const fetcher = (run: (url: string, init: RequestInit) => Promise<Response>) => run as unknown as typeof fetch;
const failures = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error) : [];
const mcpFailure = (operation: string, cause: unknown) => new McpFailure({ operation, message: 'Safe MCP failure.', cause });

function fakeMcp(options: { connect?: McpClient['connect']; call?: McpClient['callTool']; closeFailure?: boolean; transportFailure?: boolean } = {}) {
  const counts = { constructed: 0, connected: 0, clientsClosed: 0, transportsClosed: 0, calls: 0 };
  const factory: McpFactory = () => acquireMcpResource(() => {
    counts.constructed++;
    return {
      connect: async (...args) => { counts.connected++; await options.connect?.(...args); },
      close: async () => { counts.clientsClosed++; if (options.closeFailure) throw new Error('private-client-close'); },
      listTools: async () => ({ tools: [] }),
      callTool: async (...args) => { counts.calls++; return options.call ? options.call(...args) : { content: [{ type: 'text', text: 'fixture' }] }; },
    };
  }, () => {
    if (options.transportFailure) throw new Error('private-transport-constructor');
    return { start: async () => {}, send: async () => {}, close: async () => { counts.transportsClosed++; } } satisfies Transport;
  }, cause => mcpFailure('MCP connection', cause));
  return { factory, counts };
}

for (const operation of ['browse_url', 'fetch_url']) {
  test(`${operation} cancels a stalled body and awaits reader cleanup before rejecting`, async () => {
    const ready = gate(), cleanup = gate(), canceled = gate();
    let signal!: AbortSignal, count = 0, body!: ReadableStream<Uint8Array>;
    const tools = projectTools({ zoom: () => '', date: () => '' }, import.meta.dir, { fetchImpl: fetcher(async (_url, init) => {
      signal = init.signal!;
      body = new ReadableStream({ pull() { ready.resolve(); }, async cancel() { count++; canceled.resolve(); await cleanup.promise; } }, { highWaterMark: 0 });
      return new Response(body);
    }) });
    const controller = new AbortController();
    let finished = false;
    const work = tools.execute(operation, { url: 'https://fixture.test' }, controller.signal).catch(error => error).finally(() => { finished = true; });
    try {
      await ready.promise; controller.abort(); await canceled.promise;
      expect(signal.aborted).toBe(true); expect(finished).toBe(false); expect(body.locked).toBe(true);
      cleanup.resolve();
      expect((await work).name).toBe('AbortError'); expect(body.locked).toBe(false); expect(count).toBe(1);
    } finally { cleanup.resolve(); await work; await tools.close?.(); }
  });
}

test('fake HTTP layer retains typed request/body failures and closes on success, limit, timeout and invalid redirects', async () => {
  for (const outcome of ['success', 'limit', 'body-failure', 'timeout']) {
    let canceled = 0, body!: ReadableStream<Uint8Array>, signal!: AbortSignal;
    const runtime = ManagedRuntime.make(Http.layer(fetcher(async (_url, init) => {
      signal = init.signal!;
      body = new ReadableStream({ start(controller) {
        if (outcome === 'body-failure') controller.error(new Error('private body failure'));
        else if (outcome !== 'timeout') controller.enqueue(new Uint8Array([1, 2]));
        // Success ends on the second pull; other paths retain a cancelable body.
      }, pull(controller) { if (outcome === 'success') controller.close(); }, cancel() { canceled++; } });
      return new Response(body);
    })));
    try {
      const exit = await runtime.runPromiseExit(Effect.flatMap(Http, http => http.withResponse('https://fixture.test', 20,
        response => readResponseBytes(response, 1 + Number(outcome !== 'limit')))));
      expect(body.locked).toBe(false);
      if (outcome === 'success') { expect(Exit.isSuccess(exit)).toBe(true); expect(canceled).toBe(0); }
      else if (outcome === 'timeout') { expect(failures(exit)[0]).toBeInstanceOf(TimeoutError); expect(signal.aborted).toBe(true); expect(canceled).toBe(1); }
      else { expect(failures(exit)[0]).toBeInstanceOf(HttpFailure); if (outcome === 'limit') expect(canceled).toBe(1); }
    } finally { await runtime.dispose(); }
  }
  let body!: ReadableStream<Uint8Array>;
  const browser = new WebBrowser(fetcher(async () => {
    body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([65])); controller.close(); } });
    const response = new Response(body); Object.defineProperty(response, 'url', { value: 'https://user:secret@fixture.test' }); return response;
  }));
  await expect(browser.open({ url: 'https://fixture.test' })).rejects.toThrow('without embedded credentials'); expect(body.locked).toBe(false);
  const runtime = ManagedRuntime.make(Http.layer(fetcher(async () => { throw new Error('secret request failure'); })));
  try {
    const exit = await runtime.runPromiseExit(Effect.flatMap(Http, http => http.withResponse('https://fixture.test', 100, () => Effect.void)));
    expect(failures(exit)[0]).toBeInstanceOf(HttpFailure); expect((failures(exit)[0] as HttpFailure).message).toBe('Web request failed.');
  } finally { await runtime.dispose(); }
});

test('interruption drains late fetch acquisition and cancels its unconsumed response', async () => {
  const ready = gate(), aborted = gate(), complete = gate();
  let canceled = 0, finished = false;
  const runtime = ManagedRuntime.make(Http.layer(fetcher(async (_url, init) => {
    ready.resolve(); init.signal!.addEventListener('abort', aborted.resolve, { once: true });
    await complete.promise;
    return new Response(new ReadableStream({ cancel() { canceled++; } }));
  })));
  const controller = new AbortController();
  const work = runtime.runPromiseExit(Effect.flatMap(Http, http => http.withResponse('https://fixture.test', 500,
    response => readResponseBytes(response))), { signal: controller.signal }).finally(() => { finished = true; });
  try {
    await ready.promise; controller.abort(); await aborted.promise; expect(finished).toBe(false);
    complete.resolve(); const exit = await work;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true); expect(canceled).toBe(1);
  } finally { complete.resolve(); await work; await runtime.dispose(); }
});

test('reader cleanup failure remains a defect alongside the original typed limit failure', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { throw new Error('private cleanup failure'); } });
  const runtime = ManagedRuntime.make(Http.layer(fetcher(async () => new Response(body))));
  try {
    const exit = await runtime.runPromiseExit(Effect.flatMap(Http, http => http.withResponse('https://fixture.test', 100,
      response => readResponseBytes(response, 1))));
    expect(body.locked).toBe(false); expect(failures(exit)[0]).toBeInstanceOf(HttpFailure);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  } finally { await runtime.dispose(); }
});

test('fake MCP layer is lazy, shares pending acquisition and lets a joining waiter cancel independently', async () => {
  const started = gate(), release = gate();
  const { factory, counts } = fakeMcp({ connect: async () => { started.resolve(); await release.promise; } });
  const runtime = ManagedRuntime.make(Mcp.layer(factory, mcpFailure));
  const request = Effect.flatMap(Mcp, mcp => mcp.request('docs', 'MCP tool discovery', (client, options) => client.listTools({}, options)));
  const controller = new AbortController();
  try {
    await runtime.runPromise(Mcp); expect(counts.constructed).toBe(0);
    const first = runtime.runPromise(request); await started.promise;
    const second = runtime.runPromiseExit(request, { signal: controller.signal });
    // Yield through service lookup before canceling the joining waiter.
    await new Promise(resolve => setTimeout(resolve, 1)); controller.abort();
    const exit = await second; expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(counts.clientsClosed).toBe(0); release.resolve(); await first;
    expect(counts.constructed).toBe(1); await runtime.runPromise(request); expect(counts.connected).toBe(1);
    await runtime.dispose(); expect(counts.clientsClosed).toBe(1); expect(counts.transportsClosed).toBe(1);
  } finally { release.resolve(); await runtime.dispose(); }
});

test('MCP canceled initiator drains shared rollback, clears pending state and permits a new handshake', async () => {
  const started = gate(); let attempt = 0, signal!: AbortSignal;
  const { factory, counts } = fakeMcp({ connect: async (_transport, options) => {
    if (attempt++ > 0) return;
    signal = options!.signal!; started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const integrations = new Integrations(parseIntegrations({ servers: { docs: { command: 'fake', allowTools: ['lookup'] } } }), import.meta.dir, { factory });
  const controller = new AbortController();
  try {
    const first = integrations.execute('list_integration_tools', { server: 'docs' }, controller.signal).catch(error => error);
    await started.promise;
    const joined = integrations.execute('list_integration_tools', { server: 'docs' }).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 1)); controller.abort();
    expect((await first).name).toBe('AbortError'); expect((await joined).name).toBe('AbortError');
    expect(signal.aborted).toBe(true); expect(counts.clientsClosed).toBe(1); expect(counts.transportsClosed).toBe(1);
    expect(integrations.list()).toContain('"connected": false');
    expect(JSON.parse(await integrations.execute('list_integration_tools', { server: 'docs' })).tools).toEqual([]);
    expect(counts.constructed).toBe(2);
  } finally { await integrations.close(); }
});

test('MCP failed construction, handshake and separate deadlines release owners and retain typed failures', async () => {
  for (const kind of ['constructor', 'handshake', 'connect-timeout', 'call-timeout']) {
    const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const { factory, counts } = fakeMcp({ transportFailure: kind === 'constructor',
      connect: async (_transport, options) => {
        expect(options!.timeout).toBe(15);
        if (kind === 'handshake') throw new Error('private handshake failure');
        if (kind === 'connect-timeout') await waitForAbort(options!.signal!);
      }, call: async (_params, _schema, options) => {
        expect(options!.timeout).toBe(25); return waitForAbort(options!.signal!);
      } });
    const runtime = ManagedRuntime.make(Mcp.layer(factory, mcpFailure, { connectTimeoutMs: 15, callTimeoutMs: 25 }));
    try {
      const exit = await runtime.runPromiseExit(Effect.flatMap(Mcp, mcp => mcp.request('docs', 'MCP tool call',
        (client, options) => client.callTool({ name: 'lookup' }, undefined, options))));
      expect(failures(exit)[0]).toBeInstanceOf(kind.endsWith('timeout') ? TimeoutError : McpFailure);
      if (kind !== 'call-timeout') expect(counts.clientsClosed).toBe(1);
      await runtime.dispose(); expect(counts.clientsClosed).toBe(1); expect(counts.transportsClosed).toBe(Number(kind !== 'constructor'));
    } finally { await runtime.dispose(); }
  }
});

test('MCP session close drains a handshake and active call, is cached, and attempts every cleanup after failure', async () => {
  for (const pending of ['handshake', 'call']) {
    const ready = gate(), cleaned = gate(); let signal!: AbortSignal;
    const block = async (requestSignal: AbortSignal) => {
      signal = requestSignal; ready.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { cleaned.resolve(); reject(signal.reason); }, { once: true }));
    };
    const { factory, counts } = fakeMcp({ connect: async (_transport, options) => { if (pending === 'handshake') await block(options!.signal!); },
      call: async (_params, _schema, options) => { await block(options!.signal!); return { content: [] }; } });
    const integrations = new Integrations(parseIntegrations({ servers: { docs: { command: 'fake', allowTools: ['lookup'] } } }), import.meta.dir, { factory });
    const work = integrations.execute('call_integration_tool', { server: 'docs', tool: 'lookup', arguments: {} }).catch(error => error);
    await ready.promise; const close = integrations.close(); expect(integrations.close()).toBe(close);
    await cleaned.promise; await close; await work; expect(signal.aborted).toBe(true);
    expect(counts.clientsClosed).toBe(1); expect(counts.transportsClosed).toBe(1);
    await expect(integrations.execute('list_integration_tools', { server: 'docs' })).rejects.toThrow('closed');
  }
  const { factory, counts } = fakeMcp({ closeFailure: true });
  const runtime = ManagedRuntime.make(Mcp.layer(factory, mcpFailure));
  await runtime.runPromise(Effect.flatMap(Mcp, mcp => mcp.request('one', 'MCP call', (client, options) => client.listTools({}, options))));
  await runtime.runPromise(Effect.flatMap(Mcp, mcp => mcp.request('two', 'MCP call', (client, options) => client.listTools({}, options))));
  const exit = await Effect.runPromiseExit(runtime.disposeEffect);
  expect(counts.clientsClosed).toBe(2); expect(counts.transportsClosed).toBe(2);
  if (!Exit.isFailure(exit)) throw new Error('Expected cleanup failure');
  expect(exit.cause.reasons.filter(Cause.isDieReason).every(reason => reason.defect instanceof IOError)).toBe(true);
});

test('MCP HTTP request cancellation reaches fetch rather than only the SDK protocol wait', async () => {
  const ready = gate(); let callSignal!: AbortSignal, closed = false;
  const integrations = new Integrations(parseIntegrations({ servers: { docs: { url: 'https://fixture.test/mcp', allowTools: ['lookup'] } } }), import.meta.dir,
    { fetchImpl: fetcher(async (_url, init) => {
      if (init.method !== 'POST') return new Response(null, { status: 405 });
      const message = JSON.parse(init.body as string);
      if (message.method === 'tools/call') {
        callSignal = init.signal!; ready.resolve();
        return new Promise<Response>((_resolve, reject) => callSignal.addEventListener('abort', () => { closed = true; reject(callSignal.reason); }, { once: true }));
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
      } });
    }) });
  const controller = new AbortController();
  try {
    const work = integrations.execute('call_integration_tool', { server: 'docs', tool: 'lookup', arguments: {} }, controller.signal).catch(error => error);
    await ready.promise; controller.abort(); expect((await work).name).toBe('AbortError'); expect(callSignal.aborted).toBe(true); expect(closed).toBe(true);
  } finally { await integrations.close(); }
});

test('raw fetch keeps empty-response output while browsing still requires a body', async () => {
  const tools = projectTools({ zoom: () => '', date: () => '' }, import.meta.dir, {
    fetchImpl: fetcher(async () => new Response(null, { status: 204 })),
  });
  try {
    expect(await tools.execute('fetch_url', { url: 'https://fixture.test' })).toBe('[status: 204; size: 0 bytes]\n');
    await expect(tools.execute('browse_url', { url: 'https://fixture.test' })).rejects.toThrow('Web response has no body.');
  } finally { await tools.close?.(); }
});

test('native HTTP body interruption retains AbortError and disconnects the request', async () => {
  const ready = gate(), disconnected = gate();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
      cancel() { disconnected.resolve(); } }), { headers: { 'content-type': 'text/plain' } });
  } });
  const browser = new WebBrowser(fetcher(async (url, init) => {
    const response = await fetch(url, init); ready.resolve(); return response;
  }));
  const controller = new AbortController();
  try {
    const work = browser.open({ url: server.url.href }, controller.signal).catch(error => error);
    await ready.promise; await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
    expect((await work).name).toBe('AbortError');
    await disconnected.promise;
  } finally { server.stop(true); }
});

test('canceling native MCP stdio initialization exits its process before the handshake rejects', async () => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-effect-mcp-'));
  const filename = path.join(directory, 'server.js'), marker = path.join(directory, 'pid');
  await fs.writeFile(filename, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`);
  const integrations = new Integrations(parseIntegrations({ servers: { docs: { command: process.execPath, args: [filename] } } }), directory);
  const controller = new AbortController();
  try {
    const work = integrations.execute('list_integration_tools', { server: 'docs' }, controller.signal).catch(error => error);
    let pid = 0;
    for (let i = 0; i < 200 && !pid; i++) {
      try { pid = Number(await fs.readFile(marker, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    expect(pid).toBeGreaterThan(0); controller.abort(); expect((await work).name).toBe('AbortError');
    expect(() => process.kill(pid, 0)).toThrow(); expect(integrations.list()).toContain('"connected": false');
  } finally { controller.abort(); await integrations.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('MCP drains detached SSE byte readers at call completion and session shutdown', async () => {
  const callCanceled = gate(), releaseCall = gate(), sessionCanceled = gate(), releaseSession = gate();
  const bodies: ReadableStream<Uint8Array>[] = [];
  const counts = { call: 0, session: 0 };
  const integrations = new Integrations(parseIntegrations({ servers: { docs: { url: 'https://fixture.test/mcp', allowTools: ['lookup'] } } }), import.meta.dir,
    { fetchImpl: fetcher(async (_url, init) => {
      if (init.method !== 'POST') return new Response(null, { status: 405 });
      const message = JSON.parse(init.body as string);
      if (message.id === undefined) return new Response(null, { status: 202 });
      const initialize = message.method === 'initialize';
      const result = initialize ? {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
      } : { content: [{ type: 'text', text: 'SSE fixture' }] };
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`));
      }, async cancel() {
        if (initialize) { counts.session++; sessionCanceled.resolve(); await releaseSession.promise; }
        else { counts.call++; callCanceled.resolve(); await releaseCall.promise; }
      } });
      bodies.push(body); return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) });
  let completed = false, closed = false;
  const work = integrations.execute('call_integration_tool', { server: 'docs', tool: 'lookup', arguments: {} }).finally(() => { completed = true; });
  try {
    await callCanceled.promise; expect(completed).toBe(false); expect(bodies[1]!.locked).toBe(true);
    releaseCall.resolve(); expect(await work).toBe('SSE fixture'); expect(bodies[1]!.locked).toBe(false); expect(counts.call).toBe(1);
    const close = integrations.close().finally(() => { closed = true; });
    await sessionCanceled.promise; expect(closed).toBe(false); releaseSession.resolve(); await close;
    expect(bodies[0]!.locked).toBe(false); expect(counts.session).toBe(1);
  } finally { releaseCall.resolve(); releaseSession.resolve(); await work; await integrations.close(); }
});

test('MCP discovery gives each page a separate call deadline', async () => {
  let pages = 0;
  const factory: McpFactory = () => acquireMcpResource(() => ({
    connect: async () => {}, close: async () => {}, callTool: async () => ({ content: [] }),
    listTools: async (_params, options) => {
      expect(options!.timeout).toBe(40);
      await new Promise(resolve => setTimeout(resolve, 25));
      return pages++ ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
        : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'second' };
    },
  }), () => ({ start: async () => {}, close: async () => {}, send: async () => {} }), cause => mcpFailure('MCP connection', cause));
  const integrations = new Integrations(parseIntegrations({ servers: { docs: { command: 'fake' } } }), import.meta.dir,
    { factory, callTimeoutMs: 40 });
  try {
    const result = JSON.parse(await integrations.execute('list_integration_tools', { server: 'docs' }));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['first', 'second']); expect(pages).toBe(2);
  } finally { await integrations.close(); }
});
