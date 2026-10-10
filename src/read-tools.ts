import fs from 'node:fs/promises';
import { capResult } from './constants.js';
import { discoverFiles } from './file-discovery.js';
import { schemaTool } from './tool-registry.js';
import { ZoomSchema, DateSchema, GetPlanSchema, ListFilesSchema, ReadFileSchema, GlobFilesSchema, SearchFilesSchema,
  GitStatusSchema, GitDiffSchema, GitLogSchema, GitShowSchema, GitBlameSchema } from './read-tool-schema.js';
import type { MemoryPort } from './types.js';
import type { TaskPlans } from './task-plans.js';
import type { GitTools } from './git-tools.js';

export function readTools(memory: Pick<MemoryPort, 'zoom' | 'date'>, options: {
  project: string; resolveFile: (relative: string) => Promise<string>; plans: Pick<TaskPlans, 'get'>; git: GitTools;
}) {
  const { project, resolveFile, plans, git } = options;
  return [
    schemaTool({ name: 'zoom', schema: ZoomSchema, capabilities: ['read'], execute: args => memory.zoom(args.id, args.n, args.page) }),
    schemaTool({ name: 'date', schema: DateSchema, capabilities: ['read'], execute: args => memory.date(args.id) }),
    schemaTool({ name: 'get_plan', schema: GetPlanSchema, capabilities: ['read'], execute: () => plans.get() }),
    schemaTool({ name: 'list_files', schema: ListFilesSchema, capabilities: ['read'], async execute(args) {
      const entries = await fs.readdir(await resolveFile(args.path), { withFileTypes: true });
      return capResult(entries.sort((a, b) => a.name.localeCompare(b.name)).map(entry => entry.name + (entry.isDirectory() ? '/' : '')).join('\n'));
    } }),
    schemaTool({ name: 'read_file', schema: ReadFileSchema, capabilities: ['read'], async execute(args) {
      const contents = await fs.readFile(await resolveFile(args.path), 'utf8');
      // Explicit null requests a numbered read; absent/undefined options do not.
      if (args.start_line === undefined && args.end_line === undefined) return capResult(contents);
      const lines = contents.split('\n'), start = args.start_line ?? 1, end = args.end_line ?? Math.max(start, lines.length);
      return capResult(lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n'));
    } }),
    schemaTool({ name: 'glob_files', schema: GlobFilesSchema, capabilities: ['read'], async execute(args, signal) {
      return discoverFiles({ root: await resolveFile(args.path), project, signal, pattern: args.pattern,
        regex: args.regex, caseSensitive: args.case_sensitive, maxResults: args.max_results });
    } }),
    schemaTool({ name: 'search_files', schema: SearchFilesSchema, capabilities: ['read'], async execute(args, signal) {
      return discoverFiles({ root: await resolveFile(args.path), project, signal, query: args.query, pattern: args.glob,
        regex: args.regex, caseSensitive: args.case_sensitive, maxResults: args.max_results });
    } }),
    schemaTool({ name: 'git_status', schema: GitStatusSchema, capabilities: ['read'], execute: (_args, signal) => git.status(signal) }),
    schemaTool({ name: 'git_diff', schema: GitDiffSchema, capabilities: ['read'], execute: (args, signal) => git.diff(args, signal) }),
    schemaTool({ name: 'git_log', schema: GitLogSchema, capabilities: ['read'], execute: (args, signal) => git.log(args, signal) }),
    schemaTool({ name: 'git_show', schema: GitShowSchema, capabilities: ['read'], execute: (args, signal) => git.show(args, signal) }),
    schemaTool({ name: 'git_blame', schema: GitBlameSchema, capabilities: ['read'], execute: (args, signal) => git.blame(args, signal) }),
  ];
}
