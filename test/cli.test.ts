import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const cli = path.resolve(import.meta.dir, '../src/cli.ts');
test('CLI help and terminal validation run without provider requests', async () => {
  const help = Bun.spawn([process.execPath, cli, '--help'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(help.stdout).text()).toContain('--allow-shell'); expect(await help.exited).toBe(0);
  const tui = Bun.spawn([process.execPath, cli, '--tui'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(tui.stderr).text()).toContain('requires an interactive terminal'); expect(await tui.exited).toBe(1);
});
test('model listing names providers, credentials, and selection format', async () => {
  const models = Bun.spawn([process.execPath, cli, '--models'], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(models.stdout).text();
  expect(await models.exited).toBe(0);
  expect(output).toContain('1. muse-spark-1.3 (Meta; alias ms1.3; needs META_API_KEY or MODEL_API_KEY)');
  expect(output).toContain('2. muse-spark-1.3-contributor (Meta; alias ms1.3c; needs META_API_KEY or MODEL_API_KEY)');
  expect(output.match(/^  \d+\./gm)).toHaveLength(2);
  expect(output).toContain('--model <number, short name, or ID>');
});
test('plain piped commands close cleanly and release chat storage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-cli-'));
  try {
    for (let i = 0; i < 2; i++) {
      const child = Bun.spawn([process.execPath, cli, '--plain', ...(i === 0 ? ['--model', 'ms1.3', '--compactor-model', 'ms1.3c'] : []), '--project', directory, '--chat-dir', path.join(directory, 'chat'), '--no-jev'], {
        cwd: directory, env: { ...process.env, META_API_KEY: 'offline-test', TYPESAFE_API_KEY: '', VICTRAL_MODEL: 'ms1.3', VICTRAL_COMPACTOR_MODEL: 'ms1.3c' },
        stdin: new TextEncoder().encode('/tools\n/model ms1.3c\n/exit\n'), stdout: 'pipe', stderr: 'pipe',
      });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(error).toBe(''); expect(await child.exited).toBe(0); expect(output).toContain('search_files'); expect(output).toContain('Command execution: disabled');
      expect(output).toContain('Victral · muse-spark-1.3');
      expect(output).toContain('Switched agent to muse-spark-1.3-contributor');
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
