import * as Schema from 'effect/Schema';
import { validationDecoder } from './core/schema.js';

export const TIKR_ORIGIN = 'https://app.tikr.com';
export const TIKR_SECTIONS = { overview: '/stock/about', financials: '/stock/financials', transcripts: '/stock/transcripts' } as const;
export const TikrSectionSchema = Schema.Literals(['overview', 'financials', 'transcripts']);
export type TikrSection = typeof TikrSectionSchema.Type;

// Never accept arbitrary destinations, credentials, account routes, or tokens.
export function tikrCompanyUrl(input: string, section?: TikrSection): string {
  const url = new URL(input);
  if (url.origin !== TIKR_ORIGIN || url.username || url.password ||
    !Object.values(TIKR_SECTIONS).some(path => path === url.pathname) ||
    !/^\d{1,32}$/.test(url.searchParams.get('cid') ?? '') ||
    !/^\d{1,32}$/.test(url.searchParams.get('tid') ?? '')) throw new Error('Expected a TIKR company research URL with cid and tid.');
  const clean = new URL(section ? TIKR_SECTIONS[section] : url.pathname, TIKR_ORIGIN);
  clean.searchParams.set('cid', url.searchParams.get('cid')!);
  clean.searchParams.set('tid', url.searchParams.get('tid')!);
  return clean.href;
}

export const TikrSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200), Schema.makeFilter(value => !!value.trim(), { message: 'query must not be blank.' })),
});
const CompanyUrl = Schema.String.check(Schema.makeFilter(value => {
  try { tikrCompanyUrl(value); return true; } catch { return false; }
}, { message: 'Expected a TIKR company research URL with cid and tid.' }));
export const TikrOpenSchema = Schema.Struct({
  result_id: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^tikr-result-\d+-\d+$/))),
  url: Schema.optionalKey(CompanyUrl),
  section: Schema.optionalKey(TikrSectionSchema),
}).check(Schema.makeFilter(args => (args.result_id !== undefined) !== (args.url !== undefined), {
  message: 'Provide exactly one of result_id or url.',
}));
export type TikrSearchArgs = typeof TikrSearchSchema.Type;
export type TikrOpenArgs = typeof TikrOpenSchema.Type;
export const parseTikrSearch = validationDecoder(TikrSearchSchema, 'tikr_search arguments');
export const parseTikrOpen = validationDecoder(TikrOpenSchema, 'tikr_open arguments');
