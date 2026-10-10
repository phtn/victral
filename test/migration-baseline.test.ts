import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { Session, type SessionOptions } from '../src/session.js';
import { Integrations, parseIntegrations } from '../src/integrations.js';
import { Meta } from '../src/meta.js';
import { OpenAI } from '../src/openai.js';
import { systemPrompt } from '../src/prompt.js';
import { baselineTools, baselineMessages } from './migration-fixtures.js';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/effect-migration/${name}`, import.meta.url));
const options = (directory: string): SessionOptions => ({ project: directory, chatDir: path.join(directory, 'chat'),
  model: 'muse-spark-1.3', compactorModel: 'muse-spark-1.3', allowShell: false, jev: false, metrics: false });

test('migration baseline preserves prompt, tool-schema and native provider request bytes', async () => {
  const tools = baselineTools();
  try {
    expect(systemPrompt('Offline migration fixture.')).toBe(await fixture('prompt.txt').text());
    expect(JSON.stringify(tools.definitions)).toBe((await fixture('tools.json').text()).trimEnd());
    for (const [name, Model, model] of [['meta', Meta, 'muse-spark-1.3'], ['openai', OpenAI, 'gpt-6.1-sol']] as const) {
      let body: unknown;
      const provider = new Model({ apiKey: 'offline-fixture-key', model, fetchImpl: (async (_url: unknown, init: RequestInit) => {
        body = init.body; return Response.json({});
      }) as unknown as typeof fetch });
      const requestOptions = { tools: tools.definitions, stream: true };
      await provider.request(baselineMessages(), requestOptions);
      expect(body).toBe((await fixture(`${name}-request.json`).text()).trimEnd());
    }
  } finally { await tools.close?.(); }
});

test('migration baseline restores a legacy chat and keeps its view across a second restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-legacy-'));
  const legacy = await fixture('legacy-chat.json').json();
  let storage: Storage | undefined, memory: Memory | undefined;
  try {
    for (const stream of ['main', 'tree']) {
      await fs.mkdir(path.join(directory, stream));
      await fs.writeFile(path.join(directory, stream, '2026-01-01.jsonl'), legacy[stream].map((record: unknown) => JSON.stringify(record)).join('\n') + '\n');
    }
    await fs.writeFile(path.join(directory, 'view.json'), JSON.stringify(legacy.view));
    for (let restart = 0; restart < 2; restart++) {
      storage = await Storage.open(directory);
      memory = new Memory(storage, { chat() { throw new Error('Legacy fixture must not call a provider.'); } });
      expect(storage.root).toEqual(legacy.main);
      expect(memory.render()).toBe(legacy.render);
      expect(storage.loadView()).toEqual(legacy.view);
      await memory.stop(); memory = undefined;
      await storage.close(); storage = undefined;
    }
  } finally { await memory?.stop(); await storage?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('partial session startup failure releases the chat lock and permits repair/restart', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'victral-startup-')));
  const key = process.env.META_API_KEY;
  process.env.META_API_KEY = 'offline-fixture-key';
  let storage: Storage | undefined, session: Session | undefined;
  try {
    storage = await Storage.open(options(directory).chatDir);
    storage.savePlan({ project: directory, title: '', revision: 1, updated_at: 'invalid', steps: [] });
    await storage.close(); storage = undefined;
    await expect(Session.open(options(directory)).then(opened => { session = opened; })).rejects.toThrow('Invalid saved task plan');
    storage = await Storage.open(options(directory).chatDir);
    await fs.rm(path.join(storage.directory, 'plans'), { recursive: true });
    await storage.close(); storage = undefined;
    session = await Session.open(options(directory));
    let closed = 0; session.on('closed', () => { closed++; });
    const closing = session.close();
    expect(session.close()).toBe(closing);
    await closing; await session.close();
    expect(closed).toBe(1);
    storage = await Storage.open(options(directory).chatDir);
  } finally {
    await session?.close(); await storage?.close();
    if (key === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = key;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('canceling MCP acquisition clears the pending handshake so a later connection succeeds', async () => {
  let acquired!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const message = await request.json();
    if (message.method === 'initialize' && calls++ === 0) { acquired(); await gate; }
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [] };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  } });
  const integrations = new Integrations(parseIntegrations({ servers: { fixture: { url: server.url.href } } }), os.tmpdir());
  try {
    const controller = new AbortController();
    const pending = integrations.execute('list_integration_tools', { server: 'fixture' }, controller.signal);
    await started; controller.abort(); await expect(pending).rejects.toThrow();
    expect(integrations.list()).toContain('"connected": false');
    release();
    expect(JSON.parse(await integrations.execute('list_integration_tools', { server: 'fixture' })).tools).toEqual([]);
    await integrations.close(); await integrations.close();
    await expect(integrations.execute('list_integration_tools', { server: 'fixture' })).rejects.toThrow('closed');
  } finally { release(); await integrations.close(); server.stop(true); }
});
