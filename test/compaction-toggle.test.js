import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { Runner } from '../src/runner.js';
import { bytes } from '../src/constants.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const forbidden = { chat: async () => { throw new Error('Unexpected model call'); } };
const reply = text => ({ finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const LONG = 'first line\n' + 'z'.repeat(2000);
const noTools = { definitions: [], execute: async () => '' };
async function fixture(model = forbidden, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-compaction-'));
  const storage = await Storage.open(path.join(directory, 'chat'), () => {});
  const reports = [];
  const memory = new Memory(storage, model, { report: text => reports.push(text), ...options });
  cleanups.push(async () => { await memory.stop(); await storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { storage, memory, reports };
}

test('compaction off shows unsummarized messages in full, calls no model, and writes no tree nodes', async () => {
  const { storage, memory } = await fixture(forbidden, { compaction: false });
  memory.append('user', 'short decision'); memory.append('echo', LONG);
  assert.equal(await memory.settle(AbortSignal.timeout(1000)), true);
  assert.equal(storage.nodes.size, 0);
  assert.equal(memory.render(), `<chat>\n0+1|user: short decision\n1+1|echo: first line ${'z'.repeat(2000)}\n</chat>`);
  assert.equal(memory.viewBytes, bytes(memory.render()));
  // Nothing was built, so a full drain reports unfinished work without waiting.
  assert.equal(await memory.drain(AbortSignal.timeout(1000)), false);
  assert.match(memory.viewNote(), /Compaction is off/);
});

test('compaction off never merges the view, even over budget, and restarts with the same view', async () => {
  const options = { compaction: false, viewBudget: 600, viewMinimum: 300 };
  const { storage, memory } = await fixture(forbidden, options);
  for (let i = 0; i < 4; i++) memory.append('user', `decision ${i} ` + 'x'.repeat(400));
  assert.deepEqual(memory.view, [0, 1, 2, 3].map(i => ({ l: 0, i })));
  assert.ok(memory.viewBytes > 600);
  assert.notEqual(storage.loadView('view-batch'), true);
  const before = memory.render();
  await memory.stop();
  const restarted = new Memory(storage, forbidden, { report: () => {}, ...options });
  cleanups.push(() => restarted.stop());
  assert.equal(restarted.render(), before);
  assert.equal(storage.nodes.size, 0);
});

test('turning compaction back on summarizes what was skipped, at runtime and after a restart', async () => {
  let calls = 0;
  const model = { chat: async () => reply(`summary ${++calls}`) };
  const { storage, memory } = await fixture(model, { compaction: false });
  memory.append('echo', LONG); memory.append('echo', LONG);
  assert.equal(await memory.settle(AbortSignal.timeout(1000)), true);
  assert.equal(calls, 0);
  memory.setCompaction(true);
  assert.equal(memory.viewNote(), '');
  assert.equal(await memory.drain(AbortSignal.timeout(3000)), true);
  assert.ok(storage.nodes.has('0:0') && storage.nodes.has('0:1') && storage.nodes.has('1:0'));
  assert.match(memory.render(), /^<chat>\n0\+1\|summary \d\n1\+1\|summary \d\n<\/chat>$/);
  assert.equal(memory.viewBytes, bytes(memory.render()));
  memory.setCompaction(false);
  memory.append('echo', LONG);
  assert.equal(memory.viewBytes, bytes(memory.render()));
  assert.ok(memory.render().includes('z'.repeat(2000)));
  await memory.stop();
  // A later launch without the option resumes from the saved log and tree.
  const restarted = new Memory(storage, model, { report: () => {} });
  cleanups.push(() => restarted.stop());
  assert.equal(await restarted.settle(AbortSignal.timeout(3000)), true);
  assert.ok(storage.nodes.has('0:2'));
  assert.ok(!restarted.render().includes('z'.repeat(2000)));
});

test('turning compaction off releases a turn that is waiting on summaries', async () => {
  const model = { chat: async (_messages, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const { memory } = await fixture(model);
  memory.append('echo', LONG);
  const waiting = memory.settle(AbortSignal.timeout(3000));
  memory.setCompaction(false);
  assert.equal(await waiting, true);
  assert.ok(memory.render().includes('z'.repeat(2000)));
  assert.equal(memory.viewBytes, bytes(memory.render()));
});

test('the turn request says compaction is off only while it is off', async () => {
  const { memory } = await fixture({ chat: async () => reply('summary') }, { compaction: false });
  memory.append('echo', LONG);
  const requests = [];
  const agent = { model: 'agent', stream: async messages => { requests.push(structuredClone(messages)); return reply('ok'); } };
  const runner = new Runner(memory, agent, noTools, '', { onError: () => {} });
  cleanups.push(() => runner.close());
  await runner.submit('first');
  const texts = request => request[1].content.map(block => block.text);
  assert.ok(texts(requests[0]).some(text => text.includes('z'.repeat(2000))));
  assert.ok(texts(requests[0]).some(text => /Compaction is off/.test(text)));
  assert.equal(texts(requests[0]).at(-1), 'first');
  memory.setCompaction(true);
  await runner.submit('second');
  assert.ok(!texts(requests[1]).some(text => /Compaction is off/.test(text)));
  assert.ok(!texts(requests[1]).some(text => text.includes('z'.repeat(2000))));
});

test('an over-limit compactor reply is cut to the node budget on a character boundary', async () => {
  let calls = 0;
  const { memory } = await fixture({ chat: async () => { calls++; return reply('🦓'.repeat(300)); } });
  memory.append('echo', LONG);
  assert.equal(await memory.settle(AbortSignal.timeout(3000)), true);
  assert.equal(calls, 5);
  assert.equal(memory.node(0, 0).text, '🦓'.repeat(128));
  assert.equal(bytes(memory.node(0, 0).text), 512);
});

test('a failed compaction reports its reason once and the turn error names it', async () => {
  let healthy = false;
  const model = { chat: async () => { if (!healthy) throw new Error('Local server unreachable.'); return reply('summary'); } };
  const { memory, reports } = await fixture(model);
  for (let i = 0; i < 3; i++) memory.append('echo', LONG);
  const errors = [];
  const agent = { model: 'agent', stream: async () => reply('ok') };
  const runner = new Runner(memory, agent, noTools, '', { onError: text => errors.push(text) });
  cleanups.push(() => runner.close());
  await runner.submit('hello');
  assert.deepEqual(errors, ['Memory compaction failed: Local server unreachable. Send another message to retry.']);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^Compactor 0:\d: Local server unreachable\.; retrying at the next message\.$/);
  assert.equal(memory.failureReason(), 'Local server unreachable.');
  healthy = true;
  await runner.submit('again');
  assert.equal(errors.length, 1);
  assert.equal(memory.failureReason(), undefined);
});
