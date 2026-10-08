import fs from 'node:fs/promises';
import path from 'node:path';

interface Hunk { before: string[]; after: string[]; atEnd: boolean }
interface Change { kind: 'add' | 'update' | 'delete'; path: string; move?: string; content?: string; hunks: Hunk[] }
interface Snapshot { filename: string; content: Buffer | null; mode?: number }
type Resolver = (relative: string) => Promise<string>;

function parsePatch(patch: string): Change[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Expected *** Begin Patch and *** End Patch.');
  const changes: Change[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]!);
    if (!header) throw new Error('Expected an Add, Update, or Delete File header.');
    const change: Change = { kind: header[1]!.toLowerCase() as Change['kind'], path: header[2]!, hunks: [] };
    if (change.kind === 'add') {
      const added: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        if (!lines[i]!.startsWith('+')) throw new Error('Added file lines must start with +.');
        added.push(lines[i++]!.slice(1));
      }
      change.content = added.length ? added.join('\n') + '\n' : '';
    } else if (change.kind === 'update') {
      if (lines[i]?.startsWith('*** Move to: ')) change.move = lines[i++]!.slice('*** Move to: '.length);
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        if (lines[i] !== '@@' && !lines[i]!.startsWith('@@ ')) throw new Error('Update hunks must begin with @@.');
        i++;
        const hunk: Hunk = { before: [], after: [], atEnd: false };
        let modified = false;
        while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('*** ')) {
          const line = lines[i++]!, prefix = line[0], body = line.slice(1);
          if (prefix !== ' ' && prefix !== '+' && prefix !== '-') throw new Error('Hunk lines must start with a space, +, or -.');
          if (prefix !== '+') hunk.before.push(body);
          if (prefix !== '-') hunk.after.push(body);
          modified ||= prefix !== ' ';
        }
        if (lines[i] === '*** End of File') { hunk.atEnd = true; i++; }
        if (!modified || !hunk.before.length) throw new Error('Each hunk needs a change and existing context; use Add File for a new file.');
        change.hunks.push(hunk);
      }
      if (!change.hunks.length) throw new Error('Update File needs at least one hunk.');
    }
    changes.push(change);
  }
  if (!changes.length) throw new Error('Patch contains no changes.');
  if (changes.length > 100) throw new Error('Patch is limited to 100 files.');
  return changes;
}

function updateContent(current: string, hunks: Hunk[], filename: string): string {
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const trailing = current.endsWith('\n');
  const lines = current === '' ? [] : current.split(/\r?\n/);
  if (trailing) lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    const found: number[] = [];
    for (let i = cursor; i <= lines.length - hunk.before.length; i++) {
      if (hunk.atEnd && i + hunk.before.length !== lines.length) continue;
      if (hunk.before.every((line, j) => lines[i + j] === line)) found.push(i);
    }
    if (!found.length) throw new Error(`Patch context not found in ${filename}; read the file again.`);
    if (found.length > 1) throw new Error(`Patch context is ambiguous in ${filename}; include more context.`);
    const start = found[0]!;
    lines.splice(start, hunk.before.length, ...hunk.after);
    cursor = start + hunk.after.length;
  }
  return lines.join(newline) + (trailing && lines.length ? newline : '');
}

export async function applyProjectPatch(patch: string, resolve: Resolver, signal?: AbortSignal): Promise<string> {
  const changes = parsePatch(patch);
  const snapshots = new Map<string, Snapshot>();
  const writes: { filename: string; content: string | null; mode?: number }[] = [];
  const canonicalPaths = new Set<string>();
  async function snapshot(relative: string): Promise<Snapshot> {
    const filename = await resolve(relative);
    // Canonicalize existing symlinks and missing paths' parents for duplicate detection.
    let ancestor = filename;
    const suffix: string[] = [];
    for (;;) {
      try { ancestor = await fs.realpath(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
    const canonical = path.join(ancestor, ...suffix);
    if (canonicalPaths.has(canonical)) throw new Error(`Patch targets the same file more than once: ${relative}.`);
    canonicalPaths.add(canonical);
    let value: Snapshot;
    try {
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw new Error(`Patch target is a symlink: ${relative}. Use its real project path.`);
      if (!stat.isFile()) throw new Error(`Patch target is not a regular file: ${relative}.`);
      const content = await fs.readFile(filename);
      if (content.includes(0)) throw new Error(`Patch target is binary: ${relative}.`);
      value = { filename, content, mode: stat.mode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      value = { filename, content: null };
    }
    snapshots.set(filename, value);
    return value;
  }
  // Validate every path and every hunk before changing any files.
  for (const change of changes) {
    signal?.throwIfAborted();
    const source = await snapshot(change.path);
    if (change.kind === 'add') {
      if (source.content !== null) throw new Error(`File already exists: ${change.path}.`);
      writes.push({ filename: source.filename, content: change.content! });
    } else {
      if (source.content === null) throw new Error(`File does not exist: ${change.path}.`);
      if (change.kind === 'delete') writes.push({ filename: source.filename, content: null });
      else {
        const content = updateContent(source.content.toString('utf8'), change.hunks, change.path);
        const destination = change.move ? await snapshot(change.move) : source;
        if (change.move && destination.content !== null) throw new Error(`Move destination already exists: ${change.move}.`);
        writes.push({ filename: destination.filename, content, mode: source.mode });
        if (change.move) writes.push({ filename: source.filename, content: null });
      }
    }
  }
  signal?.throwIfAborted();
  const project = await resolve('.');
  const applied: string[] = [];
  try {
    for (const write of writes) {
      signal?.throwIfAborted();
      // Check for a concurrent edit between preflight and this write.
      const original = snapshots.get(write.filename)!;
      let current: Buffer | null = null;
      try { current = await fs.readFile(write.filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (original.content === null ? current !== null : current === null || !original.content.equals(current)) throw new Error('Patch target changed during validation; read the files again.');
      await resolve(path.relative(project, write.filename));
      applied.push(write.filename);
      if (write.content === null) await fs.unlink(write.filename);
      else {
        await fs.mkdir(path.dirname(write.filename), { recursive: true });
        await fs.writeFile(write.filename, write.content, { encoding: 'utf8', mode: write.mode });
      }
    }
  } catch (error) {
    const failures: string[] = [];
    for (const filename of applied.reverse()) {
      const original = snapshots.get(filename)!;
      try {
        if (original.content === null) await fs.rm(filename, { force: true });
        else await fs.writeFile(filename, original.content, { mode: original.mode });
      } catch { failures.push(filename); }
    }
    if (failures.length) throw new Error(`Patch failed and rollback could not restore: ${failures.join(', ')}. Cause: ${String(error)}`);
    throw error;
  }
  return changes.map(change => `${change.kind === 'add' ? 'Added' : change.kind === 'delete' ? 'Deleted' : 'Updated'} ${change.path}${change.move ? ` -> ${change.move}` : ''}.`).join('\n');
}
