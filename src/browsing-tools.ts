import * as Effect from 'effect/Effect';
import { Http, readResponseBytes } from './core/http.js';
import { toExternalPromise } from './core/external-io.js';
import { capResult } from './constants.js';
import { schemaTool } from './tool-registry.js';
import { BrowseUrlSchema, ReadWebPageSchema, FindInPageSchema, fetchUrlSchema } from './web-tool-schema.js';
import type { WebBrowser } from './web-browser.js';

export function browsingTools(browser: WebBrowser, fetchImpl: typeof fetch, timeoutMs: number) {
  const http = Http.service(fetchImpl);
  return [
    schemaTool({ name: 'browse_url', schema: BrowseUrlSchema, capabilities: ['read'], execute: (args, signal) => browser.openPage(args, signal) }),
    schemaTool({ name: 'read_web_page', schema: ReadWebPageSchema, capabilities: ['read'], execute: args => browser.readPage(args) }),
    schemaTool({ name: 'find_in_page', schema: FindInPageSchema, capabilities: ['read'], execute: args => browser.findText(args) }),
    schemaTool({ name: 'fetch_url', schema: fetchUrlSchema(timeoutMs), capabilities: ['read'], async execute(args, signal) {
      const { response, data } = await toExternalPromise(http.withResponse(args.url.toString(), args.timeout_ms,
        response => Effect.map(readResponseBytes(response), data => ({ response, data }))), signal);
      signal?.throwIfAborted();
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      const head = `[status: ${response.status}${contentType ? `; content-type: ${contentType}` : ''}; size: ${data.length} bytes]`;
      const textual = !contentType || contentType.startsWith('text/') || /^application\/(json|javascript|x-www-form-urlencoded|.*\+xml|.*xml)$/.test(contentType);
      if (!textual) return `${head}\nNon-text response omitted.`;
      return `${head}\n${capResult(new TextDecoder().decode(data))}`;
    } }),
  ];
}
