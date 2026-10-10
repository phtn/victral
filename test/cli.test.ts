import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { projectTools } from '../src/tools.js';
const cli = path.resolve(import.meta.dir, '../src/cli.ts');
test('CLI help and terminal validation run without provider requests', async () => {
  const help = Bun.spawn([process.execPath, cli, '--help'], { stdout: 'pipe', stderr: 'pipe' });
  const helpText = await new Response(help.stdout).text();
  expect(helpText).toContain('--allow-shell'); expect(helpText).toContain('--web-search'); expect(helpText).toContain('--mcp-config'); expect(await help.exited).toBe(0);
  const tui = Bun.spawn([process.execPath, cli, '--tui'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(tui.stderr).text()).toContain('requires an interactive terminal'); expect(await tui.exited).toBe(1);
});
test('model listing names providers, credentials, and selection format', async () => {
  const models = Bun.spawn([process.execPath, cli, '--models'], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(models.stdout).text();
  expect(await models.exited).toBe(0);
  expect(output).toContain('1. muse-spark-1.3 (Meta; alias ms1.3; needs META_API_KEY or MODEL_API_KEY)');
  expect(output).toContain('2. muse-spark-1.3-contributor (Meta; alias ms1.3c; needs META_API_KEY or MODEL_API_KEY)');
  expect(output).toContain('3. gpt-6-luna (OpenAI; alias luna6; needs OPENAI_API_KEY)');
  expect(output).toContain('4. gpt-6.1-sol (OpenAI; alias sol6.1; needs OPENAI_API_KEY)');
  expect(output.match(/^  \d+\./gm)).toHaveLength(4);
  expect(output).toContain('--model <number, short name, or ID>');
});

test('provider-qualified commands switch OpenAI models and preserve the startup compactor', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-openai-cli-'));
  try {
    const child = Bun.spawn([process.execPath, cli, '--plain', '--model', 'luna6', '--project', directory, '--chat-dir', path.join(directory, 'chat'), '--no-jev'], {
      cwd: directory, env: { ...process.env, OPENAI_API_KEY: 'offline-test', VICTRAL_COMPACTOR_MODEL: 'luna6', TYPESAFE_API_KEY: '' },
      stdin: new TextEncoder().encode('/model openai\n/model openai sol6.1\n/model\n/model meta luna6\n/model\n/exit\n'), stdout: 'pipe', stderr: 'pipe',
    });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1); // The intentionally invalid provider/model pair sets the piped CLI's exit status.
    expect(output).toContain('Switched agent to gpt-6.1-sol');
    expect(output).toContain('Agent: gpt-6.1-sol\nCompactor: gpt-6-luna (fixed at startup)');
    const providerList = output.split('Available models:\n')[1]!.split('\n\n')[0]!;
    expect(providerList).toContain('gpt-6-luna'); expect(providerList).not.toContain('muse-spark');
    expect(error).toContain('Unknown model "luna6" for meta');
    expect(output.match(/Agent: gpt-6.1-sol/g)).toHaveLength(2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('plain piped commands close cleanly and release chat storage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-cli-'));
  try {
    for (let i = 0; i < 2; i++) {
      const child = Bun.spawn([process.execPath, cli, '--plain', ...(i === 0 ? ['--model', 'ms1.3', '--compactor-model', 'ms1.3c'] : []), '--project', directory, '--chat-dir', path.join(directory, 'chat'), '--no-jev'], {
        cwd: directory, env: { ...process.env, META_API_KEY: 'offline-test', TYPESAFE_API_KEY: '', VICTRAL_MODEL: 'ms1.3', VICTRAL_COMPACTOR_MODEL: 'ms1.3c' },
        stdin: new TextEncoder().encode('/tools\n/plan\n/jobs\n/model ms1.3c\n/exit\n'), stdout: 'pipe', stderr: 'pipe',
      });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(error).toBe(''); expect(await child.exited).toBe(0); expect(output).toContain('search_files'); expect(output).toContain('glob_files'); expect(output).toContain('apply_patch'); expect(output).toContain('Command execution: disabled');
      expect(output).not.toContain('start_command');
      expect(output).toContain('parallel_tools'); expect(output).toContain('git_blame'); expect(output).toContain('No task plan');
      expect(output).toContain('Victral · muse-spark-1.3');
      expect(output).toContain('Switched agent to muse-spark-1.3-contributor');
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('saved plans are visible through /plan and included in chat backups', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-plan-cli-'));
  const chat = path.join(directory, 'chat'), backup = path.join(directory, 'backup');
  let storage: Storage | undefined;
  try {
    storage = await Storage.open(chat);
    const tools = projectTools({ zoom: () => '', date: () => '' }, directory, { planStore: { load: () => storage!.load('plans'), save: plan => storage!.savePlan(plan) } });
    await tools.execute('update_plan', { title: 'Resume saved work', expected_revision: 0, steps: [{ step: 'Verify changes', status: 'pending' }] });
    storage.saveView({ parts: [], shrinking: false }, 'compaction-view');
    await tools.close?.(); await storage.close(); storage = undefined;
    const child = Bun.spawn([process.execPath, cli, '--plain', '--allow-shell', '--project', directory, '--chat-dir', chat, '--no-jev'], {
      cwd: directory, env: { ...process.env, META_API_KEY: 'offline-test', TYPESAFE_API_KEY: '', VICTRAL_MODEL: 'ms1.3c', VICTRAL_COMPACTOR_MODEL: 'ms1.3c' },
      stdin: new TextEncoder().encode(`/plan\n/jobs\n/tools\n/backup ${backup}\n/exit\n`), stdout: 'pipe', stderr: 'pipe',
    });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe(''); expect(code).toBe(0); expect(output).toContain('Resume saved work'); expect(output).toContain('write_command_input');
    const files = await fs.readdir(path.join(backup, 'plans'));
    expect(files).toHaveLength(1);
    expect(await fs.readFile(path.join(backup, 'plans', files[0]!), 'utf8')).toContain('Resume saved work');
    expect(JSON.parse(await fs.readFile(path.join(backup, 'view.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(backup, 'view-batch.json'), 'utf8'))).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(backup, 'compaction-view.json'), 'utf8'))).toEqual({ parts: [], shrinking: false });
  } finally { await storage?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
