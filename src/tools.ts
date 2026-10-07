import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { capResult } from './constants.js';
import type { AgentTools, MemoryPort, ToolDefinition } from './types.js';

const string = { type: 'string' }, integer = { type: 'integer' };
const tool = (name: string, description: string, properties: ToolDefinition['function']['parameters']['properties'], required = Object.keys(properties)): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
});
export interface ToolOptions { allowShell?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch }
const SKIP = new Set(['.git', 'node_modules', '.victral', 'dist', 'coverage', '.env']);
function text(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`Expected ${key} to be text.`);
  return args[key];
}
function integerArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${key} must be an integer between 1 and ${max}.`);
  return value as number;
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
    tool('search_files', 'Search literal text recursively in project files; returns file:line matches. Skips dependencies, build output, .env files, binary files and symlinks. Bounded to 5000 files and 100 matches.', { query: string, path: string }, ['query']),
    tool('git_status', 'Read Git working-tree status.', {}),
    tool('git_diff', 'Read unstaged or staged Git differences, optionally for a project path.', { path: string, staged: { type: 'boolean' } }, []),
    tool('fetch_url', 'Fetch a page over HTTP(S) with GET and return its text. Non-text responses are summarized, not dumped.', { url: string, timeout_ms: integer }, ['url']),
  ];
  if (allowShell) definitions.push(
    tool('run_command', 'Execute a CLI program directly with an argument array in the project. Use for builds, tests and developer tools. Returns output, exit status and timeout. Default timeout 30s; maximum 120s.', { program: string, args: { type: 'array', items: string }, timeout_ms: integer }, ['program', 'args']),
    tool('shell', 'Execute a shell command in the project. Use run_command when shell syntax is unnecessary. Timeout 30s, maximum 120s.', { command: string, timeout_ms: integer }, ['command']),
  );
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
  async function command(argv: string[], ms: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)$/i.test(key)) delete env[key];
    // A process group lets cancellation terminate grandchildren as well as the CLI.
    const child = Bun.spawn(argv, { cwd: project, env, detached: process.platform !== 'win32', stdout: 'pipe', stderr: 'pipe' });
    let output = '', truncated = false, timedOut = false;
    const kill = () => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, ms);
    signal?.addEventListener('abort', kill, { once: true });
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const capture = (chunk: string) => { const next = output + chunk; output = capResult(next); truncated ||= output !== next; };
      for await (const chunk of stream) capture(decoder.decode(chunk, { stream: true }));
      capture(decoder.decode());
    };
    try {
      const [code] = await Promise.all([child.exited, consume(child.stdout), consume(child.stderr)]);
      signal?.throwIfAborted();
      return `${output}\n[exit: ${code}; signal: ${child.signalCode ?? 'none'}; timeout: ${timedOut}${truncated ? '; output capped' : ''}]`;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', kill); kill(); }
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
    if (name === 'search_files') {
      const query = text(args, 'query');
      if (!query || query.includes('\n')) throw new Error('query must be nonempty, single-line text.');
      const matches: string[] = []; let scanned = 0, limited = false;
      async function visit(filename: string): Promise<void> {
        signal?.throwIfAborted();
        if (matches.length >= 100 || scanned >= 5000) { limited = true; return; }
        const stat = await fs.lstat(filename);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          for (const entry of (await fs.readdir(filename)).sort()) {
            if (SKIP.has(entry) || entry.startsWith('.env.')) continue;
            await visit(path.join(filename, entry));
            if (limited) break;
          }
        } else if (stat.isFile()) {
          scanned++;
          if (stat.size > 1_000_000) return;
          const data = await fs.readFile(filename);
          if (data.includes(0)) return;
          const lines = data.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(query)) {
            matches.push(`${path.relative(project, filename)}:${i + 1}: ${lines[i]!.slice(0, 500)}`);
            if (matches.length >= 100) { limited = true; break; }
          }
        }
      }
      const filename = await resolveFile(args.path === undefined ? '.' : text(args, 'path'));
      if (SKIP.has(path.basename(filename)) || path.basename(filename).startsWith('.env.')) throw new Error('Search excludes this path.');
      await visit(filename);
      return capResult(`${matches.join('\n') || 'No matches.'}\n[${scanned} files scanned${limited ? '; search limit reached' : ''}]`);
    }
    if (name === 'git_status') return command(['git', '--no-pager', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'], timeoutMs, signal);
    if (name === 'git_diff') {
      if (args.staged !== undefined && typeof args.staged !== 'boolean') throw new Error('staged must be boolean.');
      const argv = ['git', '--no-pager', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : [])];
      if (args.path !== undefined) { await resolveFile(text(args, 'path')); argv.push('--', text(args, 'path')); }
      return command(argv, timeoutMs, signal);
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
      if (name === 'shell') return command([process.env.SHELL ?? '/bin/sh', '-c', text(args, 'command')], ms, signal);
      const program = text(args, 'program');
      if (!program || program.startsWith('-') || program.includes('\0')) throw new Error('Expected a CLI program name.');
      if (!Array.isArray(args.args) || !args.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('args must be an array of strings.');
      return command([program, ...args.args], ms, signal);
    }
    throw new Error(`Unknown or disabled tool: ${name}`);
  }
  return { definitions, execute };
}
