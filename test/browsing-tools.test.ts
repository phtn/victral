import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Schema from 'effect/Schema';
import { ToolAccessDenied, ValidationError } from '../src/core/errors.js';
import { ToolRegistry, schemaTool } from '../src/tool-registry.js';
import { BrowseUrlSchema, ReadWebPageSchema, fetchUrlSchema, parseBrowseUrl, parseReadWebPage } from '../src/web-tool-schema.js';
import { WebBrowser } from '../src/web-browser.js';
import { projectTools, readOnlyProjectTools, type ToolOptions } from '../src/tools.js';
import type { AgentTools } from '../src/types.js';
import legacy from './fixtures/effect-migration/legacy-browsing.json';

const directories: string[] = [], toolsets: AgentTools[] = [];
afterEach(async () => {
  await Promise.all(toolsets.splice(0).map(tools => tools.close?.()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(options: ToolOptions = {}, readOnly = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-browsing-')); directories.push(directory);
  const create = readOnly ? readOnlyProjectTools : projectTools;
  const tools = create({ zoom: () => '', date: () => '' }, directory, options); toolsets.push(tools);
  return tools;
}

test('registered schemas bind decoded arguments, check capabilities, and defer execution until invoked', async () => {
  let executed = 0;
  const entry = schemaTool({ name: 'example', schema: Schema.Struct({ amount: Schema.FiniteFromString }), capabilities: ['write'],
    execute: args => { executed++; return String(args.amount + 1); } });
  const denied = new ToolRegistry([entry], ['read']);
  // Access denial precedes argument validation, including for malformed input.
  await expect(denied.execute('example', null)).rejects.toBeInstanceOf(ToolAccessDenied);
  expect(executed).toBe(0);
  const registry = new ToolRegistry([entry], ['write']);
  const input = { amount: '2' }, invoke = registry.prepare('example', input);
  input.amount = '9'; expect(executed).toBe(0);
  expect(await invoke()).toBe('3'); expect(executed).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(invoke(controller.signal)).rejects.toThrow('aborted'); expect(executed).toBe(1);
  await expect(registry.execute('example', { amount: 'secret-input' })).rejects.toBeInstanceOf(ValidationError);
  await expect(registry.execute('toString', {})).rejects.toThrow('Unknown or disabled');
  expect(() => new ToolRegistry([entry, entry], ['write'])).toThrow('Duplicate');
});

test('browsing and raw fetch output bytes match the pre-migration implementation', async () => {
  const tools = await fixture({ fetchImpl: (async (url: string) => {
    const response = legacy.fetched.find(response => response.url === url);
    return response ? new Response(response.body, { status: response.status, headers: { 'content-type': response.contentType } })
      : new Response(legacy.body, { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch });
  expect(await tools.execute('browse_url', { url: legacy.url })).toBe(legacy.open);
  for (const read of legacy.reads) expect(await tools.execute('read_web_page', read.arguments)).toBe(read.output);
  for (const find of legacy.finds) expect(await tools.execute('find_in_page', find.arguments)).toBe(find.output);
  for (const response of legacy.fetched) expect(await tools.execute('fetch_url', { url: response.url })).toBe(response.output);
});

test('browsing codecs preserve numeric defaults, nullish options, URL normalization, and ignored extras', () => {
  for (const timeout_ms of [undefined, null]) {
    const args = parseBrowseUrl({ url: ' https://EXAMPLE.test ', timeout_ms, extra: 'ignored' });
    expect(args.url).toBeInstanceOf(URL); expect(args.timeout_ms).toBe(30_000);
    expect(Schema.encodeSync(BrowseUrlSchema)(args)).toEqual({ url: 'https://example.test/', timeout_ms: 30_000 });
    const page = parseReadWebPage({ page_id: 'page-1', start_line: timeout_ms, max_lines: timeout_ms });
    expect(page).toEqual({ page_id: 'page-1', start_line: 1, max_lines: 100 });
    expect(Schema.encodeSync(ReadWebPageSchema)(page)).toEqual(page);
    const fetchSchema = fetchUrlSchema(4321);
    expect(Schema.decodeUnknownSync(fetchSchema)({ url: 'https://example.test', timeout_ms }).timeout_ms).toBe(4321);
  }
  for (const timeout_ms of [1, 120_000]) expect(parseBrowseUrl({ url: 'https://example.test', timeout_ms }).timeout_ms).toBe(timeout_ms);
  expect(parseReadWebPage({ page_id: 'page-1', start_line: Number.MAX_SAFE_INTEGER, max_lines: 300 }).max_lines).toBe(300);
});

test('invalid browsing inputs fail before fetch and expose safe field paths instead of rejected values', async () => {
  let requests = 0;
  const tools = await fixture({ fetchImpl: (async () => { requests++; return new Response('page'); }) as unknown as typeof fetch });
  const cases: [string, Record<string, unknown>, string][] = [
    ['browse_url', { url: 'https://user:secret-password@example.test' }, 'url'],
    ['browse_url', { url: 'file:///secret-path' }, 'url'],
    ['fetch_url', { url: 'secret-invalid-url' }, 'url'],
    ['fetch_url', {}, 'url'],
    ['read_web_page', { page_id: 1 }, 'page_id'],
    ['find_in_page', { page_id: 'missing', query: '   ' }, 'query'],
    ['find_in_page', { page_id: 'missing', query: { credential: 'secret-query' } }, 'query'],
  ];
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'secret-number']) {
    cases.push(['browse_url', { url: 'https://example.test', timeout_ms: value }, 'timeout_ms'],
      ['fetch_url', { url: 'https://example.test', timeout_ms: value }, 'timeout_ms'],
      ['read_web_page', { page_id: 'missing', start_line: value }, 'start_line'],
      ['read_web_page', { page_id: 'missing', max_lines: value }, 'max_lines']);
  }
  cases.push(['browse_url', { url: 'https://example.test', timeout_ms: 120_001 }, 'timeout_ms'],
    ['fetch_url', { url: 'https://example.test', timeout_ms: 120_001 }, 'timeout_ms'],
    ['read_web_page', { page_id: 'missing', max_lines: 301 }, 'max_lines']);
  for (const [name, args, field] of cases) {
    const error = await tools.execute(name, args).catch(error => error);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw new Error('Expected validation failure.');
    expect(error.message).toContain(field); expect(error.message).not.toContain('secret-');
    expect(error.cause).toBeInstanceOf(Schema.SchemaError);
  }
  expect(requests).toBe(0);
  const browser = new WebBrowser();
  for (const malformed of [null, [], 'secret-record']) {
    await expect(browser.open(malformed)).rejects.toBeInstanceOf(ValidationError);
    expect(() => browser.read(malformed)).toThrow(ValidationError);
    expect(() => browser.find(malformed)).toThrow(ValidationError);
  }
});

test('fetch retains its legacy credential URL policy and custom timeout default', async () => {
  const requested: string[] = [];
  const tools = await fixture({ timeoutMs: 4321, fetchImpl: (async (url: string, init: RequestInit) => {
    requested.push(url); expect(init.redirect).toBe('follow'); expect(init.signal?.aborted).toBe(false); return new Response('page');
  }) as typeof fetch });
  expect(await tools.execute('fetch_url', { url: ' https://user:fixture-password@EXAMPLE.test ', timeout_ms: null, metadata: true })).toContain('page');
  expect(requested).toEqual(['https://user:fixture-password@example.test/']);
  await expect(tools.execute('browse_url', { url: requested[0] })).rejects.toBeInstanceOf(ValidationError);
  expect(requested).toHaveLength(1);
  const invalidDefault = await fixture({ timeoutMs: 120_001, fetchImpl: (async () => { throw new Error('Must not fetch'); }) as unknown as typeof fetch });
  await expect(invalidDefault.execute('fetch_url', { url: 'https://example.test' })).rejects.toBeInstanceOf(ValidationError);
});

test('parallel reads validate registered arguments before any I/O and keep runtime failures independent', async () => {
  let requests = 0;
  const nested: string[] = [];
  const tools = await fixture({ fetchImpl: (async () => { requests++; return new Response('plain page'); }) as unknown as typeof fetch });
  await expect(tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.test' } },
    { tool: 'browse_url', arguments: { url: 'https://example.test', timeout_ms: 0 } },
  ] }, undefined, name => nested.push(name))).rejects.toBeInstanceOf(ValidationError);
  expect(requests).toBe(0); expect(nested).toEqual([]);
  const result = await tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.test' } },
    { tool: 'read_web_page', arguments: { page_id: 'missing' } },
  ] }, undefined, name => nested.push(name));
  expect(requests).toBe(1); expect(nested).toEqual(['fetch_url', 'read_web_page']);
  expect(result).toContain('[1/2 fetch_url; status: completed]');
  expect(result).toContain('[2/2 read_web_page; status: error]'); expect(result).toContain('Unknown page_id');
});

test('read-only project tools retain browsing access and reject disabled tools before I/O', async () => {
  let requests = 0;
  const tools = await fixture({ fetchImpl: (async () => { requests++; return new Response('page'); }) as unknown as typeof fetch }, true);
  for (const name of ['browse_url', 'read_web_page', 'find_in_page', 'fetch_url']) expect(tools.definitions.some(tool => tool.function.name === name)).toBe(true);
  const page = JSON.parse(await tools.execute('browse_url', { url: 'https://example.test' }));
  expect(await tools.execute('find_in_page', { page_id: page.page_id, query: 'PAGE' })).toContain('"total_matches": 1');
  await expect(tools.execute('write_file', { path: 'file', content: 'data' })).rejects.toThrow('cannot use');
  await expect(tools.execute('shell', {})).rejects.toThrow('cannot use'); expect(requests).toBe(1);
});

test('browsing registry propagates pre-aborted and pending request cancellation to transport', async () => {
  for (const name of ['fetch_url', 'browse_url']) {
    let started!: () => void, requests = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const tools = await fixture({ fetchImpl: (async (_url: string, init: RequestInit) => {
      requests++; started();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(init.signal!.reason);
        if (init.signal!.aborted) abort(); else init.signal!.addEventListener('abort', abort, { once: true });
      });
    }) as typeof fetch });
    const controller = new AbortController(); controller.abort();
    await expect(tools.execute(name, { url: 'https://example.test' }, controller.signal)).rejects.toThrow('aborted');
    expect(requests).toBe(0);
    const pendingController = new AbortController();
    const failure = tools.execute(name, { url: 'https://example.test' }, pendingController.signal).catch(error => error);
    await ready; pendingController.abort(); expect((await failure).name).toBe('AbortError'); expect(requests).toBe(1);
  }
});

test('page reads keep their line defaults, maximum, UTF-8 cap, and session retention limit', async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} 🦓`).join('\n');
  const browser = new WebBrowser((async () => new Response(lines, { headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch);
  const page = JSON.parse(await browser.open({ url: 'https://example.test' }));
  expect(page.text.split('\n')).toHaveLength(80);
  expect(JSON.parse(browser.read({ page_id: page.page_id })).text.split('\n')).toHaveLength(100);
  expect(JSON.parse(browser.read({ page_id: page.page_id, max_lines: 300 })).text.split('\n')).toHaveLength(300);
  for (let i = 0; i < 16; i++) await browser.open({ url: 'https://example.test' });
  expect(() => browser.read({ page_id: 'page-1' })).toThrow('Unknown page_id'); expect(browser.read({ page_id: 'page-17' })).toContain('line 1');
  const large = new WebBrowser((async () => new Response('🦓'.repeat(10_000))) as unknown as typeof fetch);
  const largePage = JSON.parse(await large.open({ url: 'https://example.test' }));
  expect(Buffer.byteLength(largePage.text)).toBeLessThanOrEqual(18_000); expect(largePage.text).not.toContain('�');
});
