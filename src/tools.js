import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { capResult } from './constants.js';

const tool = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
});
const string = { type: 'string' }, integer = { type: 'integer' };
export function projectTools(memory, project, { allowShell = false } = {}) {
  project = realpathSync(project);
  const definitions = [
    tool('zoom', 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.', { id: integer, n: integer }),
    tool('date', 'The date and time of message id.', { id: integer }),
    tool('list_files', 'List entries in a directory of the current project. Paths are relative to the project root.', { path: string }),
    tool('read_file', 'Read a UTF-8 project file. Paths are relative to the project root.', { path: string }),
    tool('write_file', 'Write a UTF-8 project file. Paths are relative to the project root.', { path: string, content: string }),
  ];
  if (allowShell) definitions.push(tool('shell', 'Run a shell command in the current project and return stdout, stderr, and exit status.', { command: string }));
  const contained = filename => filename === project || filename.startsWith(project + path.sep);
  async function resolveFile(relative) {
    if (typeof relative !== 'string') throw new Error('Expected a relative path.');
    const filename = path.resolve(project, relative);
    if (!contained(filename)) throw new Error('Path is outside the project.');
    // Resolve the nearest existing ancestor to prevent escaping via symlinks.
    let ancestor = filename;
    for (;;) {
      try {
        const real = await fs.realpath(ancestor);
        if (!contained(real)) throw new Error('Symlink leaves the project.');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    return filename;
  }
  async function execute(name, args, signal) {
    if (name === 'zoom') return memory.zoom(args.id, args.n);
    if (name === 'date') return memory.date(args.id);
    if (name === 'list_files') {
      const entries = await fs.readdir(await resolveFile(args.path), { withFileTypes: true });
      return entries.map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }
    if (name === 'read_file') return fs.readFile(await resolveFile(args.path), 'utf8');
    if (name === 'write_file') {
      if (typeof args.content !== 'string') throw new Error('Expected text content.');
      const filename = await resolveFile(args.path);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, args.content, 'utf8');
      return `Wrote ${args.path}.`;
    }
    if (name === 'shell' && allowShell) {
      if (typeof args.command !== 'string') throw new Error('Expected a command.');
      return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.COHERE_API_KEY;
        delete env.TYPESAFE_API_KEY;
        delete env.META_API_KEY;
        delete env.MODEL_API_KEY;
        const child = spawn(process.env.SHELL ?? '/bin/sh', ['-c', args.command], { cwd: project, env, signal, detached: true });
        let output = '', truncated = false;
        const capture = data => {
          const next = output + data.toString();
          const capped = capResult(next);
          truncated ||= capped !== next;
          output = capped;
        };
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
        signal?.addEventListener('abort', stop, { once: true });
        child.once('error', error => { signal?.removeEventListener('abort', stop); reject(error); });
        child.once('close', (code, killed) => {
          signal?.removeEventListener('abort', stop);
          resolve(`${output}\n[exit: ${code}; signal: ${killed ?? 'none'}${truncated ? '; output capped' : ''}]`);
        });
      });
    }
    throw new Error(`Unknown tool: ${name}`);
  }
  return { definitions, execute };
}
