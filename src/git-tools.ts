import type { CommandTools } from './command-tools.js';
import { parseGitRef, parseGitStatus, parseGitDiff, parseGitLog, parseGitShow, parseGitBlame,
  type GitDiffArgs, type GitLogArgs, type GitShowArgs, type GitBlameArgs } from './read-tool-schema.js';

export function gitRef(value: unknown, fallback = 'HEAD'): string {
  return parseGitRef(value === undefined ? fallback : value);
}

export class GitTools {
  constructor(private commands: Pick<CommandTools, 'run'>, private resolve: (relative: string) => Promise<string>, private timeoutMs: number) {}
  async execute(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (name === 'git_status') { parseGitStatus(args); return this.status(signal); }
    if (name === 'git_diff') return this.diff(parseGitDiff(args), signal);
    if (name === 'git_log') return this.log(parseGitLog(args), signal);
    if (name === 'git_show') return this.show(parseGitShow(args), signal);
    if (name === 'git_blame') return this.blame(parseGitBlame(args), signal);
    throw new Error(`Unknown Git inspection tool: ${name}.`);
  }
  status(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return this.commands.run(['git', '--no-pager', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'], this.timeoutMs, signal);
  }
  diff(args: GitDiffArgs, signal?: AbortSignal): Promise<string> {
    const argv = ['git', '--no-pager', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : [])];
    if (args.base !== undefined) argv.push(args.base);
    return this.run(argv, args.path, true, signal);
  }
  log(args: GitLogArgs, signal?: AbortSignal): Promise<string> {
    const argv = this.historyArgs();
    argv.push('log', '--no-ext-diff', '--no-textconv', '--no-decorate', '--date=iso-strict', '--format=%h%x09%ad%x09%an%x09%s', '-n', String(args.max_count), args.ref);
    return this.run(argv, args.path, true, signal);
  }
  show(args: GitShowArgs, signal?: AbortSignal): Promise<string> {
    const argv = this.historyArgs();
    argv.push('show', '--no-ext-diff', '--no-textconv', '--format=fuller', '--stat', '--patch', args.ref);
    return this.run(argv, args.path, true, signal);
  }
  blame(args: GitBlameArgs, signal?: AbortSignal): Promise<string> {
    const argv = this.historyArgs();
    argv.push('blame', '--no-textconv', '--date=iso-strict');
    if (args.start_line !== undefined && args.end_line !== undefined) argv.push('-L', `${args.start_line},${args.end_line}`);
    argv.push(args.ref);
    return this.run(argv, args.path, false, signal);
  }
  private historyArgs(): string[] {
    return ['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false'];
  }
  private async run(argv: string[], relative: string | undefined, literal: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    argv.push('--');
    if (relative !== undefined) {
      await this.resolve(relative);
      // Literal pathspecs prevent leading : or glob characters from changing scope.
      argv.push(literal ? `:(literal)${relative}` : relative);
    }
    signal?.throwIfAborted();
    return this.commands.run(argv, this.timeoutMs, signal);
  }
}
