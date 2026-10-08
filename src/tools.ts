import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { capResult } from './constants.js';
import { discoverFiles } from './file-discovery.js';
import { applyProjectPatch } from './apply-patch.js';
import { CommandTools } from './command-tools.js';
import type { AgentTools, MemoryPort, ToolDefinition } from './types.js';

const string = { type: 'string' }, integer = { type: 'integer' };
const tool = (name: string, description: string, properties: ToolDefinition['function']['parameters']['properties'], required = Object.keys(properties)): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
});
export interface ToolOptions { allowShell?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch }
function text(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`Expected ${key} to be text.`);
  return args[key];
}
function integerArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${key} must be an integer between 1 and ${max}.`);
  return value as number;
}
function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (args[key] === undefined) return fallback;
  if (typeof args[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  return args[key];
}
function programArgs(args: Record<string, unknown>): string[] {
  const program = text(args, 'program');
  if (!program || program.startsWith('-') || program.includes('\0')) throw new Error('Expected a CLI program name.');
  if (!Array.isArray(args.args) || !args.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('args must be an array of strings.');
  return [program, ...args.args];
}

export function projectTools(memory: Pick<MemoryPort, 'zoom' | 'date'>, project: string, { allowShell = false, timeoutMs = 30_000, fetchImpl = fetch }: ToolOptions = {}): AgentTools {
  project = realpathSync(project);
  const definitions = [
    tool('zoom', 'Expand a saved memory range. n must be a power of two.', { id: integer, n: integer }),
    tool('date', 'Get the local date and time of a saved message.', { id: integer }),
    tool('list_files', 'List a project directory. Paths are relative to the project root.', { path: string }),
    tool('read_file', 'Read a UTF-8 project file with optional 1-based line range.', { path: string, start_line: integer, end_line: integer }, ['path']),
    tool('write_file', 'Write a complete UTF-8 project file, creating parent directories.', { path: string, content: string }),
    tool('edit_file', 'Replace exactly one occurrence of old_text. Fails if it is absent or ambiguous.', { path: string, old_text: string, new_text: string }),
    tool('apply_patch', 'Apply a multi-file text patch. Format: *** Begin Patch, then *** Add File: path (lines prefixed +), *** Update File: path (optional *** Move to: path; @@ hunks with space context, - removals, + additions), or *** Delete File: path, then *** End Patch. Optional *** End of File anchors a hunk. Context must match exactly and uniquely. All paths and hunks are validated before writing; failed writes are rolled back. Paths are project-relative.', { patch: string }),
    tool('glob_files', 'Find project files by glob (e.g. **/*.{ts,js}). Patterns match project-relative paths, even when path scopes a subdirectory. Skips dependencies, build output, .env files and symlinks. Bounded to 5000 files; default 200 results, maximum 1000.', { pattern: string, path: string, max_results: integer }, ['pattern']),
    tool('search_files', 'Search project text; returns file:line matches. query is literal by default; regex enables JavaScript regular expressions and case_sensitive defaults true. Optional glob filters project-relative paths. Skips dependencies, build output, .env files, binary files and symlinks. Bounded to 5000 files; default 100 matches, maximum 1000.', { query: string, path: string, regex: { type: 'boolean' }, case_sensitive: { type: 'boolean' }, glob: string, max_results: integer }, ['query']),
    tool('git_status', 'Read Git working-tree status.', {}),
    tool('git_diff', 'Read unstaged or staged Git differences, optionally for a project path.', { path: string, staged: { type: 'boolean' } }, []),
    tool('fetch_url', 'Fetch a page over HTTP(S) with GET and return its text. Non-text responses are summarized, not dumped.', { url: string, timeout_ms: integer }, ['url']),
  ];
  if (allowShell) definitions.push(
    tool('run_command', 'Execute a CLI program directly with an argument array in the project. Use for builds, tests and developer tools. Returns output, exit status and timeout. Default timeout 30s; maximum 120s.', { program: string, args: { type: 'array', items: string }, timeout_ms: integer }, ['program', 'args']),
    tool('shell', 'Execute a shell command in the project. Use run_command when shell syntax is unnecessary. Timeout 30s, maximum 120s.', { command: string, timeout_ms: integer }, ['command']),
    tool('start_command', 'Start a CLI program in the background with literal arguments. Returns command_id immediately; use command_status to read output and stop_command to terminate it. Default timeout 120s, maximum 600s. At most 8 running commands. Jobs survive completed turns and stop on originating-turn cancellation or session close. No interactive stdin.', { program: string, args: { type: 'array', items: string }, timeout_ms: integer }, ['program', 'args']),
    tool('command_status', 'Read a background command by command_id. Optional wait_ms waits up to 10s for completion (default 0). Output is a cumulative capped snapshot. IDs are local to this session; the most recent 32 results are retained.', { command_id: string, wait_ms: integer }, ['command_id']),
    tool('stop_command', 'Terminate a background command and its process group; return its final output and exit status.', { command_id: string }),
  );
  const commands = new CommandTools(project);
  const contained = (filename: string) => filename === project || filename.startsWith(project + path.sep);
  async function resolveFile(relative: string): Promise<string> {
    if (path.isAbsolute(relative)) throw new Error('Expected a relative project path.');
    const filename = path.resolve(project, relative);
    if (!contained(filename)) throw new Error('Path is outside the project.');
    let ancestor = filename;
    for (;;) {
      try {
        if (!contained(await fs.realpath(ancestor))) throw new Error('Symlink leaves the project.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    return filename;
  }
  async function execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (name === 'zoom' || name === 'date') {
      if (!Number.isSafeInteger(args.id) || (args.id as number) < 0) throw new Error('id must be a nonnegative integer.');
      return name === 'date' ? memory.date(args.id as number) : memory.zoom(args.id as number, integerArg(args, 'n', 1, 2 ** 30));
    }
    if (name === 'list_files') {
      const entries = await fs.readdir(await resolveFile(text(args, 'path')), { withFileTypes: true });
      return capResult(entries.sort((a, b) => a.name.localeCompare(b.name)).map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n'));
    }
    if (name === 'read_file') {
      const contents = await fs.readFile(await resolveFile(text(args, 'path')), 'utf8');
      if (args.start_line === undefined && args.end_line === undefined) return capResult(contents);
      const lines = contents.split('\n');
      const start = integerArg(args, 'start_line', 1, Number.MAX_SAFE_INTEGER);
      const end = integerArg(args, 'end_line', Math.max(start, lines.length), Number.MAX_SAFE_INTEGER);
      if (end < start) throw new Error('end_line must not precede start_line.');
      return capResult(lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n'));
    }
    if (name === 'write_file' || name === 'edit_file') {
      const filename = await resolveFile(text(args, 'path'));
      let content: string;
      if (name === 'write_file') content = text(args, 'content');
      else {
        const old = text(args, 'old_text'), replacement = text(args, 'new_text');
        if (!old) throw new Error('old_text must not be empty.');
        const current = await fs.readFile(filename, 'utf8');
        const first = current.indexOf(old);
        if (first < 0) throw new Error('old_text was not found; read the file again.');
        if (current.indexOf(old, first + 1) >= 0) throw new Error('old_text is ambiguous; include more context.');
        content = current.slice(0, first) + replacement + current.slice(first + old.length);
      }
      signal?.throwIfAborted();
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content, 'utf8');
      return `${name === 'edit_file' ? 'Edited' : 'Wrote'} ${args.path}.`;
    }
    if (name === 'apply_patch') return applyProjectPatch(text(args, 'patch'), resolveFile, signal);
    if (name === 'search_files' || name === 'glob_files') {
      const query = name === 'search_files' ? text(args, 'query') : undefined;
      if (query !== undefined && (!query || /[\r\n\0]/.test(query))) throw new Error('query must be nonempty, single-line text.');
      const pattern = name === 'glob_files' ? text(args, 'pattern') : args.glob === undefined ? undefined : text(args, 'glob');
      if (pattern !== undefined && (!pattern || pattern.includes('\0') || path.isAbsolute(pattern) || pattern.split('/').includes('..'))) throw new Error('Expected a nonempty project-relative glob without .. segments.');
      return discoverFiles({ root: await resolveFile(args.path === undefined ? '.' : text(args, 'path')), project, signal, query, pattern,
        regex: booleanArg(args, 'regex', false), caseSensitive: booleanArg(args, 'case_sensitive', true),
        maxResults: integerArg(args, 'max_results', name === 'glob_files' ? 200 : 100, 1000) });
    }
    if (name === 'git_status') return commands.run(['git', '--no-pager', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'], timeoutMs, signal);
    if (name === 'git_diff') {
      if (args.staged !== undefined && typeof args.staged !== 'boolean') throw new Error('staged must be boolean.');
      const argv = ['git', '--no-pager', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : [])];
      if (args.path !== undefined) { await resolveFile(text(args, 'path')); argv.push('--', text(args, 'path')); }
      return commands.run(argv, timeoutMs, signal);
    }
    if (name === 'fetch_url') {
      let target: URL;
      try { target = new URL(text(args, 'url')); } catch { throw new Error('Expected an absolute http(s) URL.'); }
      if ((target.protocol !== 'http:' && target.protocol !== 'https:') || !target.hostname) throw new Error('Expected an absolute http(s) URL.');
      const ms = integerArg(args, 'timeout_ms', timeoutMs, 120_000);
      const timeout = AbortSignal.timeout(ms);
      const response = await fetchImpl(target.toString(), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' });
      signal?.throwIfAborted();
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      const data = new Uint8Array(await response.arrayBuffer());
      const head = `[status: ${response.status}${contentType ? `; content-type: ${contentType}` : ''}; size: ${data.length} bytes]`;
      const textual = !contentType || contentType.startsWith('text/') || /^application\/(json|javascript|x-www-form-urlencoded|.*\+xml|.*xml)$/.test(contentType);
      if (!textual) return `${head}\nNon-text response omitted.`;
      return `${head}\n${capResult(new TextDecoder().decode(data))}`;
    }
    if (allowShell && (name === 'shell' || name === 'run_command')) {
      const ms = integerArg(args, 'timeout_ms', timeoutMs, 120_000);
      if (name === 'shell') return commands.run([process.env.SHELL ?? '/bin/sh', '-c', text(args, 'command')], ms, signal);
      return commands.run(programArgs(args), ms, signal);
    }
    if (allowShell && name === 'start_command') return commands.start(programArgs(args), integerArg(args, 'timeout_ms', 120_000, 600_000), signal);
    if (allowShell && name === 'command_status') {
      const wait = args.wait_ms ?? 0;
      if (!Number.isSafeInteger(wait) || (wait as number) < 0 || (wait as number) > 10_000) throw new Error('wait_ms must be an integer between 0 and 10000.');
      return commands.status(text(args, 'command_id'), wait as number, signal);
    }
    if (allowShell && name === 'stop_command') return commands.stop(text(args, 'command_id'));
    throw new Error(`Unknown or disabled tool: ${name}`);
  }
  return { definitions, execute, close: () => commands.close() };
}
