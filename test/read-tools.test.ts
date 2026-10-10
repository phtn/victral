import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Schema from 'effect/Schema';
import { ToolAccessDenied, ValidationError } from '../src/core/errors.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { readTools } from '../src/read-tools.js';
import { GitTools } from '../src/git-tools.js';
import { ZoomSchema, DateSchema, ReadFileSchema, GlobFilesSchema, SearchFilesSchema, GitLogSchema, GitShowSchema, GitBlameSchema } from '../src/read-tool-schema.js';
import { projectTools, readOnlyProjectTools, type ToolOptions } from '../src/tools.js';
import type { AgentTools } from '../src/types.js';
import legacy from './fixtures/effect-migration/legacy-read-tools.json';

const directories: string[] = [], toolsets: AgentTools[] = [];
afterEach(async () => {
  await Promise.all(toolsets.splice(0).map(tools => tools.close?.()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'victral-reads-'))); directories.push(root); return root;
}
const memory = { zoom: (id: number, n: number, page?: number) => JSON.stringify({ id, n, page }), date: (id: number) => `Date of message ${id}.` };
async function fixture(options: ToolOptions = {}, readOnly = false) {
  const root = await directory();
  const tools = (readOnly ? readOnlyProjectTools : projectTools)(memory, root, options); toolsets.push(tools);
  return { root, tools };
}
const readNames = ['zoom', 'date', 'get_plan', 'list_files', 'read_file', 'glob_files', 'search_files', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame'];

test('file, discovery, memory and plan output bytes match the captured legacy handlers', async () => {
  const { root, tools } = await fixture();
  for (const [relative, content] of Object.entries(legacy.files)) {
    const filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content);
  }
  for (const [relative, target] of Object.entries(legacy.symlinks)) await fs.symlink(path.join(root, target), path.join(root, relative));
  for (const call of legacy.reads) expect(await tools.execute(call.tool, call.arguments)).toBe(call.output);
});

test('registered Git inspections preserve exact argv, literal paths, timeout and output', async () => {
  const root = await directory();
  const resolved: string[] = [];
  let command: { argv: string[]; timeoutMs: number; signal?: AbortSignal } | undefined;
  const resolveFile = async (relative: string) => { resolved.push(relative); return path.resolve(root, relative); };
  const git = new GitTools({ async run(argv, timeoutMs, signal) { command = { argv, timeoutMs, signal }; return 'Fixture Git output 🦓.'; } }, resolveFile, 4321);
  const registry = new ToolRegistry(readTools(memory, { project: root, resolveFile, plans: { get: () => '' }, git }), ['read']);
  const signal = new AbortController().signal;
  for (const call of legacy.git) {
    const before = resolved.length;
    expect(await registry.execute(call.tool, call.arguments, signal)).toBe(call.output);
    expect(command).toEqual({ argv: call.argv, timeoutMs: call.timeoutMs, signal });
    if (call.arguments.path !== undefined) expect(resolved.slice(before)).toEqual([call.arguments.path]);
    else expect(resolved).toHaveLength(before);
  }
  // The direct adapter uses the same schemas without requiring registry callers
  // to decode a second time inside the typed implementations.
  expect(await git.execute('git_log', { max_count: null })).toBe('Fixture Git output 🦓.');
  expect(command?.argv).toContain('20');
});

test('read schemas preserve null and undefined distinctions, defaults, safe bounds and codec shapes', () => {
  const decodeFile = Schema.decodeUnknownSync(ReadFileSchema);
  for (const args of [{ path: 'a' }, { path: 'a', start_line: null }, { path: 'a', end_line: null }, { path: 'a', start_line: 2, end_line: 3 }]) {
    const decoded = decodeFile({ ...args, extra: 'ignored' });
    expect(decoded).toEqual(args); expect(Schema.encodeSync(ReadFileSchema)(decoded)).toEqual(args);
  }
  for (const n of [undefined, null]) expect(Schema.decodeUnknownSync(ZoomSchema)({ id: 0, n })).toEqual({ id: 0, n: 1 });
  expect(Schema.decodeUnknownSync(ZoomSchema)({ id: Number.MAX_SAFE_INTEGER, n: 2 ** 30, page: 0 }).id).toBe(Number.MAX_SAFE_INTEGER);
  // Power-of-two/alignment and history availability stay in Memory.zoom,
  // which reports missing lines through its existing result strings.
  expect(Schema.decodeUnknownSync(ZoomSchema)({ id: 1, n: 3 })).toEqual({ id: 1, n: 3 });
  expect(Schema.decodeUnknownSync(DateSchema)({ id: 0, n: 'ignored' })).toEqual({ id: 0 });
  for (const max_results of [undefined, null]) {
    expect(Schema.decodeUnknownSync(GlobFilesSchema)({ pattern: '**/*', max_results })).toEqual({ pattern: '**/*', path: '.', regex: false, case_sensitive: true, max_results: 200 });
    const search = Schema.decodeUnknownSync(SearchFilesSchema)({ query: ' ', max_results });
    expect(search).toEqual({ query: ' ', path: '.', regex: false, case_sensitive: true, max_results: 100 });
    expect(Schema.encodeSync(SearchFilesSchema)(search)).toEqual(search);
  }
  for (const max_count of [undefined, null, 1, 100]) {
    const log = Schema.decodeUnknownSync(GitLogSchema)({ max_count });
    expect(log).toEqual({ ref: 'HEAD', max_count: max_count ?? 20 }); expect(Schema.encodeSync(GitLogSchema)(log)).toEqual(log);
  }
  expect(Schema.decodeUnknownSync(GitShowSchema)({ ref: undefined })).toEqual({ ref: 'HEAD' });
  expect(Schema.decodeUnknownSync(GitBlameSchema)({ path: 'a', start_line: 1, end_line: Number.MAX_SAFE_INTEGER }).end_line).toBe(Number.MAX_SAFE_INTEGER);
});

test('malformed registered reads fail with safe Schema errors before memory, path lookup or subprocess I/O', async () => {
  let effects = 0;
  const touch = () => { effects++; throw new Error('Unexpected I/O'); };
  const resolveFile = async () => touch();
  const git = new GitTools({ run: async () => touch() }, resolveFile, 4321);
  const registry = new ToolRegistry(readTools({ zoom: touch, date: touch }, { project: '/fixture', resolveFile, plans: { get: touch }, git }), ['read']);
  const cases: [string, unknown, string][] = [
    ['zoom', { id: -1 }, 'id'], ['zoom', { id: 0, page: null }, 'page'], ['date', { id: 0, page: -1 }, 'page'],
    ['list_files', { path: { secret: 'secret-path' } }, 'path'],
    ['read_file', { path: 'missing', start_line: 5, end_line: 4 }, 'end_line'],
    ['glob_files', { pattern: '../secret-pattern' }, 'pattern'],
    ['glob_files', { pattern: '**/*', regex: null }, 'regex'],
    ['search_files', { query: 'secret-query\n' }, 'query'], ['search_files', { query: '[', regex: true }, 'query'],
    ['search_files', { query: 'word', glob: '' }, 'glob'], ['search_files', { query: 'word', path: null }, 'path'],
    ['search_files', { query: 'word', case_sensitive: 'secret-boolean' }, 'case_sensitive'],
    ['git_diff', { base: '--secret-ref' }, 'base'], ['git_diff', { staged: null }, 'staged'],
    ['git_log', { ref: null }, 'ref'], ['git_log', { path: '' }, 'path'], ['git_show', { path: null }, 'path'],
    ['git_blame', { path: 'file', start_line: 1 }, 'end_line'], ['git_blame', { path: 'file', end_line: 1 }, 'start_line'],
    ['git_blame', { path: 'file', start_line: 3, end_line: 1 }, 'end_line'], ['git_blame', { path: '' }, 'path'],
  ];
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'secret-number']) {
    cases.push(['zoom', { id: 0, n: value }, 'n'], ['read_file', { path: 'missing', start_line: value }, 'start_line'],
      ['glob_files', { pattern: '**/*', max_results: value }, 'max_results'], ['git_log', { max_count: value }, 'max_count']);
  }
  cases.push(['zoom', { id: 0, n: 2 ** 30 + 1 }, 'n'], ['glob_files', { pattern: '**/*', max_results: 1001 }, 'max_results'],
    ['git_log', { max_count: 101 }, 'max_count']);
  for (const [name, value, field] of cases) {
    const error = await registry.execute(name, value).catch(error => error);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw new Error('Expected validation failure.');
    expect(error.message).toContain(field); expect(error.message).not.toContain('secret-'); expect(error.cause).toBeInstanceOf(Schema.SchemaError);
  }
  for (const name of readNames) for (const value of [null, [], 'secret-record']) await expect(registry.execute(name, value)).rejects.toBeInstanceOf(ValidationError);
  expect(effects).toBe(0);
});

test('read and Git argument errors reject an entire parallel batch before any nested call starts', async () => {
  let requests = 0;
  const nested: string[] = [];
  const { tools } = await fixture({ fetchImpl: (async () => { requests++; return new Response('page'); }) as unknown as typeof fetch });
  const invalid: [string, Record<string, unknown>][] = [
    ['read_file', { path: 'missing', start_line: 0 }], ['read_file', { path: 'missing', start_line: 2, end_line: 1 }],
    ['search_files', { query: '[', regex: true }], ['git_log', { ref: '--output=escape' }],
    ['git_blame', { path: 'missing', start_line: 1 }], ['zoom', { id: -1 }],
  ];
  for (const [tool, args] of invalid) await expect(tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool, arguments: args },
  ] }, undefined, name => nested.push(name))).rejects.toBeInstanceOf(ValidationError);
  expect(requests).toBe(0); expect(nested).toEqual([]);
  const result = await tools.execute('parallel_tools', { calls: [
    { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool: 'read_file', arguments: { path: 'missing' } },
    { tool: 'date', arguments: { id: 0 } },
  ] }, undefined, name => nested.push(name));
  expect(requests).toBe(1); expect(nested).toEqual(['fetch_url', 'read_file', 'date']);
  expect(result).toContain('[1/3 fetch_url; status: completed]'); expect(result).toContain('[2/3 read_file; status: error]');
  expect(result).toContain('[3/3 date; status: completed]'); expect(result).toContain('Date of message 0.');
});

test('file and Git reads retain project containment and external-symlink checks', async () => {
  const { root, tools } = await fixture();
  const outside = await directory(); await fs.writeFile(path.join(outside, 'private.txt'), 'outside fixture content');
  await fs.symlink(path.join(outside, 'private.txt'), path.join(root, 'escape'));
  await fs.writeFile(path.join(root, 'inside.txt'), 'allowed content'); await fs.symlink(path.join(root, 'inside.txt'), path.join(root, 'inside-link'));
  expect(await tools.execute('read_file', { path: 'inside-link' })).toBe('allowed content');
  const calls: [string, Record<string, unknown>][] = [
    ['list_files', {}], ['read_file', {}], ['glob_files', { pattern: '**/*' }], ['search_files', { query: 'content' }],
    ['git_diff', {}], ['git_log', {}], ['git_show', {}], ['git_blame', {}],
  ];
  for (const [name, args] of calls) {
    await expect(tools.execute(name, { ...args, path: '../outside' })).rejects.toThrow('outside');
    await expect(tools.execute(name, { ...args, path: path.join(outside, 'private.txt') })).rejects.toThrow('relative');
    await expect(tools.execute(name, { ...args, path: 'escape' })).rejects.toThrow('Symlink leaves');
  }
});

test('all read registrations require read access while worker tool permissions stay unchanged', async () => {
  const { root, tools } = await fixture({}, true);
  for (const name of readNames) expect(tools.definitions.some(tool => tool.function.name === name)).toBe(true);
  expect(await tools.execute('get_plan', {})).toContain('No task plan'); expect(await tools.execute('date', { id: 5 })).toBe('Date of message 5.');
  for (const name of ['write_file', 'update_plan', 'shell', 'start_command', 'call_integration_tool', 'spawn_subagent']) {
    await expect(tools.execute(name, {})).rejects.toThrow('cannot use');
  }
  const touch = async () => { throw new Error('Must not run'); };
  const git = new GitTools({ run: touch }, touch, 4321);
  const denied = new ToolRegistry(readTools(memory, { project: root, resolveFile: touch, plans: { get: () => { throw new Error('Must not run'); } }, git }), []);
  for (const name of readNames) await expect(denied.execute(name, null)).rejects.toBeInstanceOf(ToolAccessDenied);
});

test('pre-aborted reads do no work and cancellation during Git path resolution prevents spawning', async () => {
  let effects = 0, resolved!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { resolved = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const resolveFile = async () => { resolved(); await gate; return '/fixture/file'; };
  const git = new GitTools({ async run() { effects++; return ''; } }, resolveFile, 4321);
  const registry = new ToolRegistry(readTools({ zoom: () => { effects++; return ''; }, date: () => { effects++; return ''; } },
    { project: '/fixture', resolveFile, plans: { get: () => { effects++; return ''; } }, git }), ['read']);
  const aborted = new AbortController(); aborted.abort();
  for (const name of readNames) await expect(registry.execute(name, null, aborted.signal)).rejects.toThrow('aborted');
  expect(effects).toBe(0);
  const controller = new AbortController();
  const failure = git.execute('git_show', { path: 'file' }, controller.signal).catch(error => error);
  await ready; controller.abort(); release(); expect((await failure).name).toBe('AbortError'); expect(effects).toBe(0);
});
