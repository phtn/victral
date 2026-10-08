import fs from 'node:fs/promises';
import path from 'node:path';
import { capResult } from './constants.js';
import { RegexSearch } from './regex-search.js';

const SKIP = new Set(['.git', 'node_modules', '.victral', 'dist', 'coverage', '.env']);
const excluded = (name: string) => SKIP.has(name) || name.startsWith('.env.');
export interface DiscoveryOptions {
  root: string; project: string; signal?: AbortSignal; maxResults: number;
  pattern?: string; query?: string; regex?: boolean; caseSensitive?: boolean;
}

// Walk explicitly rather than following glob symlinks or traversing dependencies.
export async function discoverFiles({ root, project, signal, maxResults, pattern, query, regex = false, caseSensitive = true }: DiscoveryOptions): Promise<string> {
  if (path.relative(project, root).split(path.sep).some(excluded)) throw new Error('Search excludes this path.');
  const glob = pattern === undefined ? undefined : new Bun.Glob(pattern);
  const expression = regex && query !== undefined ? new RegexSearch(query, caseSensitive) : undefined;
  const needle = caseSensitive ? query : query?.toLowerCase();
  const matches: string[] = [];
  let scanned = 0, limited = false;
  async function visit(filename: string): Promise<void> {
    signal?.throwIfAborted();
    if (matches.length >= maxResults || scanned >= 5000) { limited = true; return; }
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(filename)).sort()) {
        if (excluded(entry)) continue;
        await visit(path.join(filename, entry));
        if (limited) break;
      }
    } else if (stat.isFile()) {
      scanned++;
      const relative = path.relative(project, filename).split(path.sep).join('/');
      if (glob && !glob.match(relative)) return;
      if (query === undefined) { matches.push(relative); return; }
      if (stat.size > 1_000_000) return;
      const data = await fs.readFile(filename);
      if (data.includes(0)) return;
      const lines = data.toString('utf8').split('\n');
      const indices = expression ? await expression.match(lines, maxResults - matches.length, signal) : lines.keys();
      for (const i of indices) {
        signal?.throwIfAborted();
        const line = lines[i]!;
        if (expression || (caseSensitive ? line : line.toLowerCase()).includes(needle!)) {
          matches.push(`${relative}:${i + 1}: ${line.slice(0, 500)}`);
          if (matches.length >= maxResults) { limited = true; break; }
        }
      }
    }
  }
  try { await visit(root); }
  finally { await expression?.close(); }
  return capResult(`${matches.join('\n') || 'No matches.'}\n[${scanned} files scanned${limited ? '; search limit reached' : ''}]`);
}
