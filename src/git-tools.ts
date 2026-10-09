import { CommandTools } from './command-tools.js';

export function gitRef(value: unknown, fallback = 'HEAD'): string {
  const ref = value === undefined ? fallback : value;
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('ref must be a nonempty Git revision and cannot start with -.');
  return ref;
}
function lineNumber(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer.`);
  return value as number;
}

export class GitTools {
  constructor(private commands: CommandTools, private resolve: (relative: string) => Promise<string>, private timeoutMs: number) {}
  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const argv = ['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false'];
    const ref = gitRef(args.ref);
    if (name === 'git_log') {
      const count = args.max_count ?? 20;
      if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 100) throw new Error('max_count must be an integer between 1 and 100.');
      argv.push('log', '--no-ext-diff', '--no-textconv', '--no-decorate', '--date=iso-strict', '--format=%h%x09%ad%x09%an%x09%s', '-n', String(count), ref);
    } else if (name === 'git_show') {
      argv.push('show', '--no-ext-diff', '--no-textconv', '--format=fuller', '--stat', '--patch', ref);
    } else if (name === 'git_blame') {
      argv.push('blame', '--no-textconv', '--date=iso-strict');
      if (args.start_line !== undefined || args.end_line !== undefined) {
        const start = lineNumber(args.start_line, 'start_line'), end = lineNumber(args.end_line, 'end_line');
        if (end < start) throw new Error('end_line must not precede start_line.');
        argv.push('-L', `${start},${end}`);
      }
      if (typeof args.path !== 'string' || !args.path) throw new Error('git_blame requires a project-relative file path.');
      argv.push(ref);
    } else throw new Error(`Unknown Git inspection tool: ${name}.`);
    argv.push('--');
    if (args.path !== undefined) {
      if (typeof args.path !== 'string' || !args.path) throw new Error('Expected a project-relative path.');
      await this.resolve(args.path);
      // Literal pathspecs prevent leading : or glob characters from changing scope.
      argv.push(name === 'git_blame' ? args.path : `:(literal)${args.path}`);
    }
    return this.commands.run(argv, this.timeoutMs, signal);
  }
}
