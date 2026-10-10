import path from 'node:path';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { validationDecoder } from './core/schema.js';
import { ArgumentsObjectSchema, textArgument, integerArgument, defaultIntegerArgument, defaultBooleanArgument } from './tool-argument-schema.js';

const safeMaximum = Number.MAX_SAFE_INTEGER;
const Id = integerArgument('id', 0, safeMaximum, 'id must be a nonnegative integer.');
const Page = Schema.optional(integerArgument('page', 0, safeMaximum, 'page must be a nonnegative integer.'));
export const ZoomSchema = Schema.Struct({ id: Id, n: defaultIntegerArgument('n', 1, 2 ** 30), page: Page });
// The legacy shared memory branch also validates page on date calls.
export const DateSchema = Schema.Struct({ id: Id, page: Page });
export const GetPlanSchema = ArgumentsObjectSchema;
export const ListFilesSchema = Schema.Struct({ path: textArgument('path') });
const fileLine = (name: string) => Schema.optional(Schema.NullOr(integerArgument(name, 1, safeMaximum)));
export const ReadFileSchema = Schema.Struct({ path: textArgument('path'), start_line: fileLine('start_line'), end_line: fileLine('end_line') }).check(
  Schema.makeFilter(args => args.end_line != null && args.end_line < (args.start_line ?? 1)
    ? { path: ['end_line'], issue: 'end_line must not precede start_line.' } : undefined),
);

const globMessage = 'Expected a nonempty project-relative glob without .. segments.';
const Glob = textArgument('pattern').check(Schema.makeFilter(value => !!value && !value.includes('\0')
  && !path.isAbsolute(value) && !value.split('/').includes('..'), { message: globMessage }),
).annotate({ identifier: globMessage });
const queryMessage = 'query must be nonempty, single-line text.';
const Query = textArgument('query').check(Schema.makeFilter(value => !!value && !/[\r\n\0]/.test(value), { message: queryMessage }))
  .annotate({ identifier: queryMessage });
const discoveryFields = {
  path: textArgument('path').pipe(Schema.withDecodingDefault(Effect.succeed('.'))),
  regex: defaultBooleanArgument('regex', false), case_sensitive: defaultBooleanArgument('case_sensitive', true),
};
export const GlobFilesSchema = Schema.Struct({ pattern: Glob, ...discoveryFields, max_results: defaultIntegerArgument('max_results', 200, 1000) });
export const SearchFilesSchema = Schema.Struct({ query: Query, glob: Schema.optional(Glob), ...discoveryFields,
  max_results: defaultIntegerArgument('max_results', 100, 1000),
}).check(Schema.makeFilter(args => {
  if (args.regex) {
    try { new RegExp(args.query, args.case_sensitive ? '' : 'i'); }
    catch { return { path: ['query'], issue: 'Invalid regular expression.' }; }
  }
}));

const refMessage = 'ref must be a nonempty Git revision and cannot start with -.';
export const GitRefSchema = Schema.String.check(Schema.makeFilter(value => !!value && !value.startsWith('-') && !/[\0\r\n]/.test(value),
  { message: refMessage },
)).annotate({ identifier: refMessage });
const Ref = GitRefSchema.pipe(Schema.withDecodingDefault(Effect.succeed('HEAD')));
const gitPath = (message: string) => Schema.String.check(Schema.isMinLength(1, { message }))
  .annotate({ identifier: message }).annotateKey({ messageMissingKey: message });
const OptionalGitPath = Schema.optional(gitPath('Expected a project-relative path.'));
export const GitStatusSchema = ArgumentsObjectSchema;
export const GitDiffSchema = Schema.Struct({ path: Schema.optional(textArgument('path')),
  staged: defaultBooleanArgument('staged', false), base: Schema.optional(GitRefSchema),
});
export const GitLogSchema = Schema.Struct({ ref: Ref, path: OptionalGitPath, max_count: defaultIntegerArgument('max_count', 20, 100) });
export const GitShowSchema = Schema.Struct({ ref: Ref, path: OptionalGitPath });
export const GitBlameSchema = Schema.Struct({ ref: Ref, path: gitPath('git_blame requires a project-relative file path.'),
  start_line: Schema.optional(integerArgument('start_line', 1, safeMaximum, 'start_line must be a positive integer.')),
  end_line: Schema.optional(integerArgument('end_line', 1, safeMaximum, 'end_line must be a positive integer.')),
}).check(Schema.makeFilter(args => {
  if (args.start_line === undefined && args.end_line === undefined) return;
  if (args.start_line === undefined) return { path: ['start_line'], issue: 'start_line must be a positive integer.' };
  if (args.end_line === undefined) return { path: ['end_line'], issue: 'end_line must be a positive integer.' };
  if (args.end_line < args.start_line) return { path: ['end_line'], issue: 'end_line must not precede start_line.' };
}));

export type GitDiffArgs = typeof GitDiffSchema.Type;
export type GitLogArgs = typeof GitLogSchema.Type;
export type GitShowArgs = typeof GitShowSchema.Type;
export type GitBlameArgs = typeof GitBlameSchema.Type;
export const parseGitRef = validationDecoder(GitRefSchema, 'Git revision');
export const parseGitStatus = validationDecoder(GitStatusSchema, 'git_status arguments');
export const parseGitDiff = validationDecoder(GitDiffSchema, 'git_diff arguments');
export const parseGitLog = validationDecoder(GitLogSchema, 'git_log arguments');
export const parseGitShow = validationDecoder(GitShowSchema, 'git_show arguments');
export const parseGitBlame = validationDecoder(GitBlameSchema, 'git_blame arguments');
