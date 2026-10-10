import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import { validationDecoder } from './core/schema.js';
import { httpURL } from './http-url.js';

function urlSchema(browsing: boolean) {
  const message = browsing ? 'Expected an absolute HTTP(S) URL without embedded credentials.' : 'Expected an absolute http(s) URL.';
  return Schema.String.check(Schema.makeFilter(value => {
    try {
      const url = browsing ? httpURL(value) : new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
    } catch { return false; }
  }, { message })).annotate({ identifier: message }).annotateKey({ messageMissingKey: message }).pipe(
    Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString),
  );
}

function defaultInteger(name: string, fallback: number, maximum: number, fetching = false) {
  const message = fetching ? `${name} must be an integer between 1 and ${maximum}.` : `${name} must be between 1 and ${maximum}.`;
  const integer = Schema.Number.check(Schema.isInt({ message }),
    Schema.isBetween({ minimum: 1, maximum }, { message }),
  ).annotate({ identifier: message });
  // Legacy numeric options use ?? defaults: preserve null as well as absence
  // and undefined, without accepting numeric strings or unsafe integers.
  return Schema.NullOr(integer).pipe(
    Schema.decodeTo(integer, SchemaTransformation.transform({ decode: value => value ?? fallback, encode: value => value })),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
}

const PageId = Schema.String.annotate({ identifier: 'Expected page_id to be text.' })
  .annotateKey({ messageMissingKey: 'Expected page_id to be text.' });
const Query = Schema.String.check(Schema.makeFilter(value => !!value.trim(), { message: 'query must be nonempty text.' }))
  .annotate({ identifier: 'query must be nonempty text.' }).annotateKey({ messageMissingKey: 'query must be nonempty text.' });

export const BrowseUrlSchema = Schema.Struct({ url: urlSchema(true), timeout_ms: defaultInteger('timeout_ms', 30_000, 120_000) });
export const ReadWebPageSchema = Schema.Struct({ page_id: PageId,
  start_line: defaultInteger('start_line', 1, Number.MAX_SAFE_INTEGER), max_lines: defaultInteger('max_lines', 100, 300),
});
export const FindInPageSchema = Schema.Struct({ page_id: PageId, query: Query });
export function fetchUrlSchema(timeoutMs: number) {
  return Schema.Struct({ url: urlSchema(false), timeout_ms: defaultInteger('timeout_ms', timeoutMs, 120_000, true) });
}
export type BrowseUrlArgs = typeof BrowseUrlSchema.Type;
export type ReadWebPageArgs = typeof ReadWebPageSchema.Type;
export type FindInPageArgs = typeof FindInPageSchema.Type;

export const parseBrowseUrl = validationDecoder(BrowseUrlSchema, 'browse_url arguments');
export const parseReadWebPage = validationDecoder(ReadWebPageSchema, 'read_web_page arguments');
export const parseFindInPage = validationDecoder(FindInPageSchema, 'find_in_page arguments');
