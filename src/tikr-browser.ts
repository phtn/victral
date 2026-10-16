import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { TIKR_ORIGIN, tikrCompanyUrl } from './tikr-schema.js';

export class TikrFailure extends Schema.TaggedError<TikrFailure>()('TikrFailure', {
  reason: Schema.Literals(['configuration', 'browser', 'authentication', 'research', 'cleanup']),
  message: Schema.String, cause: Schema.Defect(),
}) {}
export interface TikrCredentials { username: Redacted.Redacted<string>; password: Redacted.Redacted<string> }
export interface TikrSnapshot { url: string; title: string; text: string }
export interface TikrBrowser {
  search(query: string): Promise<readonly string[]>;
  select(index: number, expectedLabel: string): Promise<string>;
  open(url: string): Promise<TikrSnapshot>;
  close(): Promise<void>;
}
export type TikrBrowserFactory = (credentials: TikrCredentials, signal: AbortSignal) => Promise<TikrBrowser>;

// Chrome receives only OS launch settings, never the agent's credential environment.
export function tikrBrowserEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'DISPLAY', 'XDG_RUNTIME_DIR']
    .flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
}

// These selectors come from TIKR's public login UI and shipped search components
// (AlgoliaInput, CompanyRow, EtfRow and the legacy tickers--search component).
const INPUT = '.global-search-input input:visible, .tickers--search input:visible';
const ROW_SELECTOR = '.result-section .company-row__main, .result-section .etf-row, .tickers--search-item';
const ROWS = ROW_SELECTOR.split(', ').map(selector => `${selector}:visible`).join(', ');
const EMPTY = '.gs-no-results:visible';

// Observe the search request made by the UI; do not call private APIs or accept
// an unrelated analytics response as evidence that this query has completed.
export function isTikrSearchResponse(url: string, body: string | null, query: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(?:^|\.)(?:algolia\.net|algolianet\.com)$/.test(parsed.hostname)) return false;
    const containsQuery = (value: unknown, depth = 0): boolean => {
      if (depth > 6) return false;
      if (typeof value === 'string') return new URLSearchParams(value).get('query') === query;
      if (typeof value !== 'object' || value === null) return false;
      return Object.entries(value).some(([key, item]) => key === 'query' && item === query || containsQuery(item, depth + 1));
    };
    return parsed.searchParams.get('query') === query || containsQuery(body ? JSON.parse(body) : null);
  } catch { return false; }
}

class PlaywrightTikrBrowser implements TikrBrowser {
  private labels: readonly string[] = [];
  private readonly searches = new Map<string, readonly string[]>();
  private selected?: { label: string; identity: string };
  constructor(private browser: Browser, private context: BrowserContext, private page: Page) {}
  async search(inputQuery: string): Promise<readonly string[]> {
    const query = inputQuery.trim();
    const input = this.page.locator(INPUT).first();
    await input.fill('');
    await this.page.locator(ROWS).first().waitFor({ state: 'hidden' });
    const cached = this.searches.get(query);
    const response = cached ? undefined : this.page.waitForResponse(response =>
      isTikrSearchResponse(response.url(), response.request().postData(), query));
    void response?.catch(() => {});
    await input.fill(query);
    if (response) {
      const completed = await response;
      if (!completed.ok() || await completed.finished()) throw new Error('TIKR search request failed.');
    } else {
      // The website may reuse a cached query without making another request.
      // Only accept the matching labels, rather than a previous query's rows.
      await this.page.waitForFunction(({ selector, labels, query }) => {
        const rows = [...document.querySelectorAll<HTMLElement>(selector)].filter(row => row.getClientRects().length);
        if (!labels.length) return !!document.querySelector(`.gs-no-results__title`) &&
          document.querySelector('.gs-no-results__title')?.getAttribute('title') === query;
        return labels.every((label, index) => rows[index]?.innerText === label);
      }, { selector: ROW_SELECTOR, labels: cached!, query });
    }
    await this.page.locator(`${ROWS}, ${EMPTY}`).first().waitFor({ state: 'visible' });
    // Vue renders the response on its next tick. Wait through the next paint;
    // a previously reached page load state cannot validate a new SPA query.
    await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    this.labels = (await this.page.locator(ROWS).allInnerTexts()).slice(0, 20);
    if (this.searches.size >= 32) this.searches.delete(this.searches.keys().next().value!);
    this.searches.set(query, this.labels);
    return this.labels;
  }
  private identity(url: string): string {
    try { const parsed = new URL(tikrCompanyUrl(url)); return `${parsed.searchParams.get('cid')}:${parsed.searchParams.get('tid')}`; }
    catch { return ''; }
  }
  async select(index: number, expectedLabel: string): Promise<string> {
    if (this.labels[index] !== expectedLabel) throw new Error('Stale TIKR search result.');
    const row = this.page.locator(ROWS).nth(index);
    if (await row.innerText() !== expectedLabel) throw new Error('TIKR search results changed. Search again.');
    const previous = this.identity(this.page.url());
    const same = this.selected?.label === expectedLabel && this.selected.identity === previous;
    await row.click();
    await this.page.waitForURL(url => {
      const identity = this.identity(url.href);
      return !!identity && (identity !== previous || same);
    });
    this.labels = [];
    this.selected = { label: expectedLabel, identity: this.identity(this.page.url()) };
    return tikrCompanyUrl(this.page.url());
  }
  async open(url: string): Promise<TikrSnapshot> {
    const target = tikrCompanyUrl(url);
    await this.page.goto(target, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    const actual = tikrCompanyUrl(this.page.url());
    if (actual !== target) throw new Error('TIKR did not open the requested company page.');
    if (this.selected?.identity !== this.identity(actual)) this.selected = undefined;
    const main = this.page.locator('main').first();
    await main.waitFor({ state: 'visible' });
    const text = await main.innerText();
    if (!text.trim()) throw new Error('TIKR returned an empty research page.');
    return { url: actual, title: await this.page.title(), text };
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.context.close(); } catch (cause) { failures.push(cause); }
    try { await this.browser.close(); } catch (cause) { failures.push(cause); }
    if (failures.length) throw new AggregateError(failures, 'TIKR browser cleanup failed.');
  }
}

export const launchTikrBrowser: TikrBrowserFactory = async (credentials, signal) => {
  signal.throwIfAborted();
  const { chromium } = await import('playwright-core');
  let browser: Browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30_000, env: tikrBrowserEnvironment() }); }
  catch (cause) { throw new TikrFailure({ reason: 'browser', message: 'TIKR needs Google Chrome installed locally. Browser startup failed.', cause }); }
  let context: BrowserContext | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= browser.close();
  const onAbort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    context = await browser.newContext({ locale: 'en-US', acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    // Keep navigation on TIKR and exclude account-management destinations.
    await page.route('**/*', route => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return route.continue();
      const url = new URL(request.url());
      // Allow TIKR's normal post-login landing route, but never account changes,
      // registration, billing or password-reset navigation.
      return url.origin === TIKR_ORIGIN && !/^\/(?:account|register|forgot|reset|billing|checkout|portfolio)(?:\/|$)/.test(url.pathname)
        ? route.continue() : route.abort();
    });
    await page.goto(TIKR_ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.locator(`${INPUT}, input[type="password"]`).first().waitFor({ state: 'visible' });
    if (new URL(page.url()).origin !== TIKR_ORIGIN) throw new Error('Unexpected TIKR login destination.');
    if (await page.locator('input[type="password"]').isVisible()) {
      await page.getByLabel('Email', { exact: true }).fill(Redacted.value(credentials.username));
      await page.getByLabel('Password', { exact: true }).fill(Redacted.value(credentials.password));
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    }
    // A failed login, challenge, subscription gate or changed interface stops
    // here. Never retry passwords, solve challenges or modify account settings.
    await page.locator(INPUT).first().waitFor({ state: 'visible' });
    signal.throwIfAborted();
    return new PlaywrightTikrBrowser(browser, context, page);
  } catch (cause) {
    try { await close(); }
    catch (cleanup) { throw new TikrFailure({ reason: 'cleanup', message: 'TIKR browser cleanup failed.', cause: new AggregateError([cause, cleanup]) }); }
    signal.throwIfAborted();
    throw new TikrFailure({ reason: 'authentication', message: 'TIKR sign-in did not complete. Check the account in TIKR; challenges and subscription gates require your attention.', cause });
  } finally { signal.removeEventListener('abort', onAbort); }
};
