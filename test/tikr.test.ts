import { afterEach, expect, test } from 'bun:test';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Redacted from 'effect/Redacted';
import { TikrResearch } from '../src/tikr.js';
import { TikrFailure, isTikrSearchResponse, tikrBrowserEnvironment, type TikrBrowser, type TikrBrowserFactory } from '../src/tikr-browser.js';
import { parseTikrOpen, parseTikrSearch, tikrCompanyUrl } from '../src/tikr-schema.js';
import { projectTools, readOnlyProjectTools } from '../src/tools.js';
import { ValidationError } from '../src/core/errors.js';

const COMPANY = 'https://app.tikr.com/stock/about?cid=123&tid=456';
const credentials = { username: Redacted.make('private-user@example.test'), password: Redacted.make('private-fixture-password') };
const owners: Array<{ close?: () => Promise<void> }> = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close?.())); });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Partial<TikrBrowser> = {}) {
  const calls: string[] = [];
  let launched = 0, closed = 0;
  const browser: TikrBrowser = {
    async search(query) { calls.push(`search:${query}`); return ['TEST\nTest Corporation\nNYSE', 'TEST\nOther Listing\nLSE']; },
    async select(index, label) { calls.push(`select:${index}:${label}`); return COMPANY; },
    async open(url) { calls.push(`open:${url}`); return { url, title: 'Test Corporation', text: 'TEST NYSE\nCurrency: USD; units: millions\nFiscal year 2025\nRevenue\t42\n' + Array.from({ length: 150 }, (_, index) => `Row ${index}`).join('\n') }; },
    async close() { closed++; },
    ...overrides,
  };
  const factory: TikrBrowserFactory = async (received, signal) => {
    signal.throwIfAborted(); expect(received).toBe(credentials); launched++; return browser;
  };
  const research = new TikrResearch(credentials, factory);
  const tools = projectTools({ zoom: () => '', date: () => '' }, import.meta.dir, { tikr: research });
  owners.push(tools);
  return { research, tools, calls, get launched() { return launched; }, get closed() { return closed; } };
}

test('TIKR configuration stays lazy and runtime preference appears only with the optional tools', async () => {
  expect(TikrResearch.fromEnv({})).toBeUndefined();
  const missing = TikrResearch.fromEnv({ TIKR_UN: 'offline-user' })!;
  owners.push(missing);
  await expect(missing.search({ query: 'TEST' })).rejects.toMatchObject({ reason: 'configuration' });
  const f = fixture();
  expect(f.launched).toBe(0);
  expect(f.tools.definitions.filter(tool => tool.function.name.startsWith('tikr_')).map(tool => tool.function.name))
    .toEqual(['tikr_search', 'tikr_open', 'tikr_read_page', 'tikr_find_in_page']);
  expect(f.tools.context?.()).toContain('use tikr_search and tikr_open first');
  expect(JSON.stringify(f.tools.definitions) + f.tools.context?.()).not.toContain('private-');
  for (const create of [projectTools, readOnlyProjectTools]) {
    const tools = create({ zoom: () => '', date: () => '' }, import.meta.dir); owners.push(tools);
    expect(tools.definitions.some(tool => tool.function.name.startsWith('tikr_'))).toBe(false);
    await expect(tools.execute('tikr_search', { query: 'TEST' })).rejects.toThrow();
  }
});

test('TIKR schemas reject malformed requests and arbitrary URLs before browser startup', async () => {
  const f = fixture();
  for (const query of ['', '  ', 'x'.repeat(201), null, 1, undefined])
    await expect(f.tools.execute('tikr_search', { query })).rejects.toBeInstanceOf(ValidationError);
  for (const args of [null, {}, { result_id: 'anything' }, { result_id: 'tikr-result-1-1', url: COMPANY },
    ...['https://evil.test/stock/about?cid=1&tid=2', 'https://app.tikr.com.evil.test/stock/about?cid=1&tid=2',
      'https://u:private-password@app.tikr.com/stock/about?cid=1&tid=2',
      'https://app.tikr.com/account?cid=1&tid=2', 'https://app.tikr.com/stock/about?cid=1',
      'https://app.tikr.com/stock/about?cid=bad&tid=2', 'http://app.tikr.com/stock/about?cid=1&tid=2']
      .map(url => ({ url })), { url: COMPANY, section: 'billing' }, { url: COMPANY, result_id: null }]) {
    const error = await f.tools.execute('tikr_open', args).catch(error => error);
    expect(error).toBeInstanceOf(ValidationError); expect(error.message).not.toContain('private-password');
  }
  expect(f.launched).toBe(0);
  expect(parseTikrSearch({ query: ' TEST ', extra: true })).toEqual({ query: ' TEST ' });
  expect(parseTikrOpen({ url: COMPANY, section: 'financials' }).section).toBe('financials');
  expect(tikrCompanyUrl(COMPANY + '&ref=untrusted-token#fragment', 'financials'))
    .toBe('https://app.tikr.com/stock/financials?cid=123&tid=456');
});

test('TIKR search selection, section URLs, pagination and find preserve company identity and source metadata', async () => {
  const f = fixture();
  const search = JSON.parse(await f.tools.execute('tikr_search', { query: 'TEST' }));
  expect(search.source).toBe('TIKR'); expect(search.results).toHaveLength(2);
  const page = JSON.parse(await f.tools.execute('tikr_open', { result_id: search.results[1].result_id, section: 'financials' }));
  expect(f.launched).toBe(1);
  expect(f.calls[1]).toBe('select:1:TEST\nOther Listing\nLSE');
  expect(page.url).toBe('https://app.tikr.com/stock/financials?cid=123&tid=456');
  expect(page.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(page.text).toContain('Revenue\t42'); expect(page.total_lines).toBe(154);
  const requests = f.calls.length;
  const remainder = JSON.parse(await f.tools.execute('tikr_read_page', { page_id: page.page_id, start_line: 81, max_lines: 100 }));
  expect(remainder.text).toContain('154: Row 149'); expect(remainder.retrieved_at).toBe(page.retrieved_at);
  const found = JSON.parse(await f.tools.execute('tikr_find_in_page', { page_id: page.page_id, query: 'revenue' }));
  expect(found.matches).toEqual([{ line: 4, text: 'Revenue\t42' }]); expect(f.calls.length).toBe(requests);
  await f.tools.execute('tikr_open', { url: page.url });
  expect(f.calls.at(-1)).toBe(`open:${page.url}`);
  await expect(f.tools.execute('tikr_open', { result_id: search.results[0].result_id })).rejects.toThrow('stale');
  await f.tools.close?.(); expect(f.closed).toBe(1);
});

test('unknown or stale result IDs never trigger authentication or select the wrong listing', async () => {
  const f = fixture();
  await expect(f.tools.execute('tikr_open', { result_id: 'tikr-result-1-1' })).rejects.toThrow('stale');
  expect(f.launched).toBe(0);
  const first = JSON.parse(await f.tools.execute('tikr_search', { query: 'TEST' }));
  await f.tools.execute('tikr_search', { query: 'OTHER' });
  const count = f.calls.length;
  await expect(f.tools.execute('tikr_open', { result_id: first.results[0].result_id })).rejects.toThrow('stale');
  expect(f.calls.length).toBe(count);
});

test('TIKR snapshots redact credentials, retain bounded pages, and reject mismatched destinations', async () => {
  const privateText = `${Redacted.value(credentials.username)} ${Redacted.value(credentials.password)}`;
  const f = fixture({ async search() { return [privateText]; }, async open(url) { return { url, title: privateText, text: privateText }; } });
  const search = await f.tools.execute('tikr_search', { query: 'TEST' });
  expect(search).not.toContain('private-'); expect(search).toContain('[redacted]');
  for (let i = 0; i < 17; i++) {
    const page = await f.tools.execute('tikr_open', { url: COMPANY });
    expect(page).not.toContain('private-'); expect(page).toContain('[redacted]');
  }
  await expect(f.tools.execute('tikr_read_page', { page_id: 'tikr-page-1' })).rejects.toThrow('Unknown TIKR page_id');
  const mismatch = fixture({ async open() { return { url: 'https://app.tikr.com/stock/about?cid=999&tid=456', title: 'Wrong', text: 'Wrong company' }; } });
  await expect(mismatch.tools.execute('tikr_open', { url: COMPANY })).rejects.toBeInstanceOf(TikrFailure);
  expect(mismatch.closed).toBe(1);
});

test('TIKR errors expose safe messages and reset the failed browser for a later call', async () => {
  const f = fixture({ async search() { throw new Error('private-fixture-password'); } });
  for (let i = 0; i < 2; i++) {
    const error = await f.tools.execute('tikr_search', { query: 'TEST' }).catch(error => error);
    expect(error).toBeInstanceOf(TikrFailure); expect(error.message).not.toContain('private-');
    expect(f.closed).toBe(i + 1); expect(f.launched).toBe(i + 1);
  }
});

test('native interruption closes TIKR and awaits cleanup before releasing the operation', async () => {
  const started = gate(), closing = gate(), cleanup = gate();
  let reject!: (cause: unknown) => void;
  const f = fixture({
    async search() { started.resolve(); return new Promise((_, fail) => { reject = fail; }); },
    async close() { closing.resolve(); await cleanup.promise; reject(new DOMException('aborted', 'AbortError')); },
  });
  const fiber = Effect.runFork(f.tools.executeEffect!('tikr_search', { query: 'TEST' }));
  await started.promise;
  let finished = false;
  const interrupt = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { finished = true; });
  await closing.promise;
  expect(finished).toBe(false);
  cleanup.resolve();
  await interrupt;
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  await f.tools.close?.();
});

test('TIKR cancellation releases a browser whose acquisition completes late', async () => {
  const started = gate(), ready = gate(); let closed = 0;
  const browser: TikrBrowser = { async search() { throw new Error('must not search'); }, async select() { return COMPANY; },
    async open(url) { return { url, title: '', text: '' }; }, async close() { closed++; } };
  const client = new TikrResearch(credentials, async () => { started.resolve(); await ready.promise; return browser; });
  owners.push(client);
  const controller = new AbortController();
  const pending = client.search({ query: 'TEST' }, controller.signal);
  await started.promise; controller.abort(); ready.resolve();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(closed).toBe(1);
});

test('TIKR browser work is serialized, queued cancellations do not start work, and close is idempotent', async () => {
  const started = gate(), finish = gate();
  const f = fixture({ async search(query) { if (query === 'FIRST') { started.resolve(); await finish.promise; } return [query]; } });
  const first = f.research.search({ query: 'FIRST' });
  await started.promise;
  const controller = new AbortController();
  const second = f.research.search({ query: 'SECOND' }, controller.signal);
  controller.abort(); await expect(second).rejects.toThrow();
  finish.resolve(); await first;
  expect(f.launched).toBe(1);
  const close = f.research.close(); expect(f.research.close()).toBe(close); await close;
  expect(f.closed).toBe(1);
  await expect(f.research.search({ query: 'THIRD' })).rejects.toThrow();
});

test('TIKR account tools cannot enter parallel batches and Chrome receives no credential environment', async () => {
  const f = fixture();
  await expect(f.tools.execute('parallel_tools', { calls: [{ tool: 'tikr_search', arguments: { query: 'TEST' } }] })).rejects.toBeInstanceOf(ValidationError);
  expect(f.launched).toBe(0);
  expect(tikrBrowserEnvironment({ PATH: '/offline', HOME: '/offline/home', TIKR_UN: 'private-user', TIKR_PW: 'private-password',
    META_API_KEY: 'private-api-key', NODE_OPTIONS: '--inspect' })).toEqual({ PATH: '/offline', HOME: '/offline/home' });
});

test('TIKR search completion matches the exact query on the UI search provider', () => {
  const url = 'https://offline-dsn.algolia.net/1/indexes/*/queries';
  const body = JSON.stringify({ requests: [{ indexName: 'tickers', params: 'query=A%26B+Corp&hitsPerPage=20' }] });
  expect(isTikrSearchResponse(url, body, 'A&B Corp')).toBe(true);
  expect(isTikrSearchResponse(url, body, 'A&B')).toBe(false);
  expect(isTikrSearchResponse('https://analytics.example.test/queries', body, 'A&B Corp')).toBe(false);
  expect(isTikrSearchResponse('https://algolia.net.evil.test/queries', body, 'A&B Corp')).toBe(false);
  expect(isTikrSearchResponse(url, '{bad json', 'TEST')).toBe(false);
  expect(isTikrSearchResponse(url, JSON.stringify({ query: 'TEST' }), 'TEST')).toBe(true);
});
