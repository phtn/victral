import { afterEach, expect, setSystemTime, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Schema from 'effect/Schema';
import { ToolAccessDenied, ValidationError } from '../src/core/errors.js';
import { WriteFileSchema, EditFileSchema, ApplyPatchSchema } from '../src/mutation-tool-schema.js';
import { mutationTools } from '../src/mutation-tools.js';
import { TaskPlans, type TaskPlan } from '../src/task-plans.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { projectTools, readOnlyProjectTools, type ToolOptions } from '../src/tools.js';
import type { AgentTools } from '../src/types.js';
import legacy from './fixtures/effect-migration/legacy-mutations.json';

const directories: string[] = [], toolsets: AgentTools[] = [];
afterEach(async () => {
  setSystemTime();
  await Promise.all(toolsets.splice(0).map(tools => tools.close?.()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'victral-mutations-'))); directories.push(root); return root;
}
async function fixture(options: ToolOptions = {}, readOnly = false) {
  const root = await directory();
  const memory = { zoom: () => '', date: () => '' };
  const tools = (readOnly ? readOnlyProjectTools : projectTools)(memory, root, options); toolsets.push(tools);
  return { root, tools };
}
const mutationNames = ['write_file', 'edit_file', 'apply_patch', 'update_plan'];
const planInput = { expected_revision: 0, title: ' Work ', steps: [{ step: ' Inspect ', status: 'pending' }] };

test('mutation results, file bytes/modes and saved plan records match the captured legacy handlers', async () => {
  setSystemTime(new Date(legacy.time));
  const records: TaskPlan[] = [];
  const { root, tools } = await fixture({ planStore: { load: () => [], save: plan => { records.push(plan); } } });
  for (const [relative, content] of Object.entries(legacy.initial)) await fs.writeFile(path.join(root, relative), content);
  for (const [relative, mode] of Object.entries(legacy.modes)) await fs.chmod(path.join(root, relative), mode);
  for (const call of legacy.calls) {
    const output = await tools.execute(call.tool, call.arguments);
    // Only the canonical temporary root varies; retain every other output byte.
    expect(call.tool === 'update_plan' ? output.replace(JSON.stringify(root), JSON.stringify(legacy.project)) : output).toBe(call.output);
  }
  for (const [relative, content] of Object.entries(legacy.final)) expect(await fs.readFile(path.join(root, relative))).toEqual(Buffer.from(content, 'utf8'));
  for (const relative of legacy.absent) expect(await fs.exists(path.join(root, relative))).toBe(false);
  for (const [relative, mode] of Object.entries(legacy.finalModes)) expect((await fs.stat(path.join(root, relative))).mode & 0o777).toBe(mode);
  expect(legacy.plans).toEqual(records.map(record => ({ ...record, project: legacy.project })));
  expect(tools.context?.().replace(JSON.stringify(root), JSON.stringify(legacy.project))).toBe(`Current task plan (agent-authored state; use get_plan and update_plan):\n${legacy.calls.at(-1)!.output}`);
});

test('mutation codecs keep literal empty, whitespace, Unicode and NUL text while discarding tool extras', () => {
  const content = ' \r\n🦓\0 ';
  const write = Schema.decodeUnknownSync(WriteFileSchema)({ path: 'literal [1].txt', content, extra: true });
  expect(write).toEqual({ path: 'literal [1].txt', content }); expect(Schema.encodeSync(WriteFileSchema)(write)).toEqual(write);
  expect(Schema.decodeUnknownSync(WriteFileSchema)({ path: '', content: '' })).toEqual({ path: '', content: '' });
  for (const old_text of [' ', '\0', '🦓']) {
    const edit = Schema.decodeUnknownSync(EditFileSchema)({ path: 'file', old_text, new_text: '', extra: true });
    expect(edit).toEqual({ path: 'file', old_text, new_text: '' }); expect(Schema.encodeSync(EditFileSchema)(edit)).toEqual(edit);
  }
  const patch = Schema.decodeUnknownSync(ApplyPatchSchema)({ patch: content, extra: true });
  expect(Schema.encodeSync(ApplyPatchSchema)(patch)).toEqual({ patch: content });
});

test('malformed mutation arguments fail with safe Schema paths before filesystem lookup or persistence', async () => {
  let lookups = 0, writes = 0;
  const plans = new TaskPlans('/fixture', { load: () => [], save() { writes++; } });
  const registry = new ToolRegistry(mutationTools({ plans, resolveFile: async () => { lookups++; throw new Error('Must not resolve'); } }), ['write']);
  const cases: [string, unknown, string][] = [
    ['write_file', { path: null, content: 'secret-content' }, 'path'],
    ['write_file', { path: 'file', content: { secret: 'secret-content' } }, 'content'],
    ['write_file', { path: 'file' }, 'content'],
    ['edit_file', { path: 42, old_text: 'secret-old', new_text: '' }, 'path'],
    ['edit_file', { path: 'file', old_text: '', new_text: '' }, 'old_text'],
    ['edit_file', { path: 'file', old_text: null, new_text: '' }, 'old_text'],
    ['edit_file', { path: 'file', old_text: 'secret-old', new_text: [] }, 'new_text'],
    ['edit_file', { path: 'file', old_text: 'secret-old' }, 'new_text'],
    ['apply_patch', { patch: { secret: 'secret-patch' } }, 'patch'],
    ['apply_patch', {}, 'patch'],
    ['update_plan', { ...planInput, expected_revision: 'secret-revision' }, 'expected_revision'],
    ['update_plan', { ...planInput, title: { secret: 'secret-title' } }, 'title'],
    ['update_plan', { ...planInput, steps: [] }, 'steps'],
    ['update_plan', { ...planInput, steps: [{ step: 'secret-step', status: 'secret-status' }] }, 'status'],
  ];
  for (const [name, value, field] of cases) {
    const error = await registry.execute(name, value).catch(error => error);
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw new Error('Expected validation failure.');
    expect(error.message).toContain(field); expect(error.message).not.toContain('secret-'); expect(error.cause).toBeInstanceOf(Schema.SchemaError);
  }
  for (const name of mutationNames) for (const value of [null, [], 'secret-record']) await expect(registry.execute(name, value)).rejects.toBeInstanceOf(ValidationError);
  // A string passes Schema, but malformed patch grammar still fails in the pure
  // parser before any path lookup, independently of filesystem preflight.
  await expect(registry.execute('apply_patch', { patch: 'invalid patch' })).rejects.toThrow('Begin Patch');
  expect(lookups).toBe(0); expect(writes).toBe(0); expect(plans.context()).toBe('');
});

test('mutation capability denial precedes validation and workers/batches cannot perform writes', async () => {
  let writes = 0, lookups = 0, requests = 0;
  const planStore = { load: () => [], save() { writes++; } };
  const denied = new ToolRegistry(mutationTools({ plans: new TaskPlans('/fixture', planStore),
    resolveFile: async () => { lookups++; throw new Error('Must not resolve'); } }), ['read']);
  for (const name of mutationNames) await expect(denied.execute(name, null)).rejects.toBeInstanceOf(ToolAccessDenied);
  const { root, tools } = await fixture({ planStore, fetchImpl: (async () => { requests++; return new Response('page'); }) as unknown as typeof fetch }, true);
  const nested: string[] = [];
  for (const name of mutationNames) {
    expect(tools.definitions.some(tool => tool.function.name === name)).toBe(false);
    await expect(tools.execute(name, {})).rejects.toThrow('cannot use');
    await expect(tools.execute('parallel_tools', { calls: [
      { tool: 'fetch_url', arguments: { url: 'https://example.test' } }, { tool: name, arguments: {} },
    ] }, undefined, name => nested.push(name))).rejects.toThrow('read-only');
  }
  expect(writes).toBe(0); expect(lookups).toBe(0); expect(requests).toBe(0); expect(nested).toEqual([]);
  expect(await fs.readdir(root)).toEqual([]);
});

test('registered plans preserve conflict precedence and recheck prepared updates before saving', async () => {
  const records: TaskPlan[] = [];
  const plans = new TaskPlans('/fixture', { load: () => [], save: plan => { records.push(plan); } });
  const registry = new ToolRegistry(mutationTools({ plans, resolveFile: async () => { throw new Error('Must not resolve'); } }), ['write']);
  const stale = registry.prepare('update_plan', planInput);
  expect(records).toEqual([]); expect(plans.context()).toBe('');
  const first = await registry.execute('update_plan', { ...planInput, title: 'First' });
  await expect(stale()).rejects.toThrow('expected 0, current 1');
  await expect(registry.execute('update_plan', { expected_revision: 0, title: null, steps: null })).rejects.toThrow('expected 0, current 1');
  await expect(registry.execute('update_plan', { expected_revision: 1, title: null, steps: null })).rejects.toBeInstanceOf(ValidationError);
  expect(plans.get()).toBe(first); expect(records).toHaveLength(1);
  const update = registry.prepare('update_plan', { ...planInput, expected_revision: 1, title: 'Second' });
  const controller = new AbortController(); controller.abort();
  await expect(update(controller.signal)).rejects.toThrow('aborted');
  expect(plans.get()).toBe(first); expect(records).toHaveLength(1);
  expect(JSON.parse(await update()).revision).toBe(2);
  await expect(update()).rejects.toThrow('expected 1, current 2'); expect(records).toHaveLength(2);
});

test('registered plan updates save before publishing and retain the prior state when persistence fails', async () => {
  const records: TaskPlan[] = [], visibleDuringSave: string[] = [];
  let fail = false;
  const plans = new TaskPlans('/fixture', { load: () => [], save: plan => {
    visibleDuringSave.push(plans.get());
    if (fail) throw new Error('Fixture save failed');
    records.push(plan);
  } });
  const registry = new ToolRegistry(mutationTools({ plans, resolveFile: async () => { throw new Error('Must not resolve'); } }), ['write']);
  const empty = plans.get(), first = await registry.execute('update_plan', planInput);
  fail = true;
  await expect(registry.execute('update_plan', { ...planInput, expected_revision: 1, title: 'Second' })).rejects.toThrow('Fixture save failed');
  expect(visibleDuringSave).toEqual([empty, first]); expect(records).toHaveLength(1); expect(plans.get()).toBe(first);
  expect(plans.context()).toBe(`Current task plan (agent-authored state; use get_plan and update_plan):\n${first}`);
});

test('registered file mutations keep containment checks before writes and allow internal symlinks', async () => {
  const { root, tools } = await fixture();
  const outside = await directory(), outsideFile = path.join(outside, 'private.txt');
  await fs.writeFile(outsideFile, 'outside content');
  await fs.symlink(outside, path.join(root, 'escape'));
  const calls: [string, Record<string, unknown>][] = [
    ['write_file', { content: 'changed' }], ['edit_file', { old_text: 'content', new_text: 'changed' }],
  ];
  for (const [name, args] of calls) {
    await expect(tools.execute(name, { ...args, path: `${path.relative(root, outside)}/private.txt` })).rejects.toThrow('outside');
    await expect(tools.execute(name, { ...args, path: outsideFile })).rejects.toThrow('relative');
    await expect(tools.execute(name, { ...args, path: 'escape/private.txt' })).rejects.toThrow('Symlink leaves');
  }
  await expect(tools.execute('write_file', { path: 'escape/new/child.txt', content: 'changed' })).rejects.toThrow('Symlink leaves');
  expect(await fs.exists(path.join(outside, 'new'))).toBe(false); expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside content');
  await fs.writeFile(path.join(root, 'inside.txt'), 'before'); await fs.symlink(path.join(root, 'inside.txt'), path.join(root, 'inside-link'));
  expect(await tools.execute('write_file', { path: 'inside-link', content: 'after' })).toBe('Wrote inside-link.');
  expect(await tools.execute('edit_file', { path: 'inside-link', old_text: 'after', new_text: 'done' })).toBe('Edited inside-link.');
  expect(await fs.readFile(path.join(root, 'inside.txt'), 'utf8')).toBe('done');
});

test('pre-aborted mutations and cancellation during path resolution leave files, directories and plans untouched', async () => {
  const root = await directory();
  let lookups = 0, writes = 0;
  const plans = new TaskPlans(root, { load: () => [], save() { writes++; } });
  const preAborted = new AbortController(); preAborted.abort();
  const registry = new ToolRegistry(mutationTools({ plans, resolveFile: async () => { lookups++; return root; } }), ['write']);
  for (const name of mutationNames) await expect(registry.execute(name, null, preAborted.signal)).rejects.toThrow('aborted');
  expect(lookups).toBe(0); expect(writes).toBe(0);
  await fs.writeFile(path.join(root, 'existing.txt'), 'before');
  for (const name of ['write_file', 'edit_file']) {
    let resolved!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { resolved = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const target = name === 'write_file' ? path.join(root, 'new/child.txt') : path.join(root, 'existing.txt');
    const delayed = new ToolRegistry(mutationTools({ plans, resolveFile: async () => { resolved(); await gate; return target; } }), ['write']);
    const controller = new AbortController();
    const failure = delayed.execute(name, { path: 'file', content: 'after', old_text: 'before', new_text: 'after' }, controller.signal).catch(error => error);
    await ready; controller.abort(); release(); expect((await failure).name).toBe('AbortError');
  }
  expect(await fs.exists(path.join(root, 'new'))).toBe(false); expect(await fs.readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('before');
  expect(writes).toBe(0); expect(plans.context()).toBe('');
});
