import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage, day } from '../src/storage.js';
import { Memory, SCALE } from '../src/memory.js';
import { bytes, cutBytes, capResult, CAP } from '../src/constants.js';
import { Runner } from '../src/runner.js';
import { projectTools } from '../src/tools.js';

const noModel = { chat: async () => { throw new Error('Unexpected model call'); } };
async function fixture(t, model = noModel, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-test-'));
  const storage = await Storage.open(path.join(directory, 'chat'), () => {});
  const memory = new Memory(storage, model, options);
  t.after(async () => { await memory.stop(); await storage.close(); });
  return { directory, storage, memory };
}
test('UTF-8 lengths, safe truncation, and head/tail tool cap', () => {
  assert.equal(bytes(SCALE), 512);
  assert.equal(bytes('🦓'), 4);
  assert.equal(cutBytes('a🦓z', 3), 'a');
  const capped = capResult('HEAD' + 'x'.repeat(40_000) + 'TAIL');
  assert.equal(Array.from(capped).length, CAP);
  assert.ok(capped.startsWith('HEAD') && capped.endsWith('TAIL') && capped.includes('omitted'));
});
test('single writer excludes a second opener and permits restart', async t => {
  const { storage } = await fixture(t);
  await assert.rejects(Storage.open(storage.directory), /already open/);
});
test('free nodes, binary ranges, Unicode retrieval, and replay survive restart', async t => {
  const { storage, memory } = await fixture(t);
  for (let i = 0; i < 4; i++) memory.append('user', `decision ${i} 🦓`);
  assert.equal(await memory.drain(AbortSignal.timeout(3000)), true);
  assert.match(memory.zoom(0, 4), /^0\+2\|.*\n2\+2\|/s);
  assert.equal(memory.zoom(2, 1), '2+0|user: decision 2 🦓');
  assert.match(memory.zoom(1, 2), /No line/);
  const before = memory.render();
  await memory.stop(); await storage.close();
  const reloaded = await Storage.open(storage.directory);
  t.after(() => reloaded.close());
  const next = new Memory(reloaded, noModel);
  assert.equal(next.render(), before);
  assert.equal(next.zoom(2, 1), '2+0|user: decision 2 🦓');
});
test('torn final JSON is reported, skipped, and cannot swallow the next append', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-torn-'));
  fs.mkdirSync(path.join(directory, 'main'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'main', day() + '.jsonl'), '{"incomplete":');
  const reports = [];
  const store = await Storage.open(directory, text => reports.push(text));
  store.append('user', 'recovered');
  await store.close();
  const next = await Storage.open(directory, () => {});
  t.after(() => next.close());
  assert.equal(next.root.length, 1);
  assert.equal(next.root[0].text, 'recovered');
  assert.equal(reports.length, 1);
});
test('view merges the most due adjacent binary siblings, covers every message, and never splits', async t => {
  const model = { chat: async () => ({ finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'user: decisions' }] } }) };
  const { storage, memory } = await fixture(t, model, { viewBudget: 50, nodeBudget: 45 });
  for (let i = 0; i < 16; i++) memory.append('user', `decision-${i}`);
  await memory.drain(AbortSignal.timeout(3000));
  let cursor = 0;
  for (const part of memory.view) { assert.equal(memory.start(part), cursor); cursor = memory.end(part); }
  assert.equal(cursor, 16);
  const ranges = memory.view.map(p => [memory.start(p), memory.end(p)]);
  memory.append('user', 'one more');
  await memory.drain(AbortSignal.timeout(3000));
  for (const [start, end] of ranges) assert.ok(memory.view.some(p => memory.start(p) <= start && memory.end(p) >= end));
  const reconstructed = new Memory(storage, model, { viewBudget: 50, nodeBudget: 45 });
  assert.equal(reconstructed.render(), memory.render());
});
test('compactor retries with byte feedback in the same conversation, keeps the shortest, and omits IDs from context', async t => {
  const requests = [];
  const attempts = ['x'.repeat(530), 'x'.repeat(520), 'x'.repeat(519), 'x'.repeat(521), 'x'.repeat(518)];
  const model = { chat: async messages => {
    requests.push(structuredClone(messages));
    return { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: attempts[requests.length - 1] }] } };
  } };
  const { memory } = await fixture(t, model);
  memory.append('user', 'z'.repeat(900));
  await memory.settle(AbortSignal.timeout(3000));
  assert.equal(requests.length, 5);
  assert.equal(bytes(memory.node(0, 0).text), 518);
  assert.equal(requests[1].length, 4);
  assert.match(requests[1][3].content, /530 bytes/);
  assert.ok(!requests[0][1].content[0].text.includes('0+1|'));
});
test('settle waits for summaries and cancellation resolves false', async t => {
  const model = { chat: async (_messages, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const { memory } = await fixture(t, model);
  memory.append('user', 'x'.repeat(1000));
  const controller = new AbortController();
  const result = memory.settle(controller.signal);
  controller.abort();
  assert.equal(await result, false);
  assert.match(memory.render(), /not summarized/);
});
test('fresh turns use prior view, inject mid-turn input at boundary, and log it once', async t => {
  const { memory, storage } = await fixture(t);
  const requests = [];
  let runner;
  const model = { stream: async (messages, options) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) runner.submit('new instruction');
    await options.onEntry('talk', 'received');
    return { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'received' }] } };
  } };
  runner = new Runner(memory, model, { definitions: [], execute() {} });
  await runner.submit('first instruction');
  assert.ok(!requests[0][1].content[0].text.includes('first instruction'));
  assert.equal(requests[1].at(-1).content, 'new instruction');
  assert.equal(storage.root.filter(r => r.text === 'new instruction').length, 1);
  await runner.submit('second turn');
  assert.equal(requests[2].length, 2);
  assert.match(requests[2][1].content[0].text, /first instruction/);
  await runner.close();
});
test('project file tools reject parent paths and symlinks escaping the project', async t => {
  const { memory, directory } = await fixture(t);
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  const outside = path.join(directory, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, 'link'));
  const tools = projectTools(memory, project);
  await assert.rejects(tools.execute('write_file', { path: '../outside/file', content: 'no' }), /outside/);
  await assert.rejects(tools.execute('write_file', { path: 'link/file', content: 'no' }), /Symlink/);
  await tools.execute('write_file', { path: 'src/hello.txt', content: 'hello' });
  assert.equal(await tools.execute('read_file', { path: 'src/hello.txt' }), 'hello');
});
