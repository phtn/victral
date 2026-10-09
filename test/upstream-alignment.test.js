import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { SummaryView, pairs } from '../src/summary-view.js';
import { Runner } from '../src/runner.js';
import { bytes, MESSAGE, CAP, capResult } from '../src/constants.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const result = text => ({ finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const model = { chat: async () => result('user: ' + 'summary '.repeat(30)) };
async function fixture(options = {}, compactor = model) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-alignment-'));
  const storage = await Storage.open(directory), memory = new Memory(storage, compactor, options);
  cleanup.push(async () => { await memory.stop(); await storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, storage, memory };
}

// Independent source algorithm from the gist: keep=0 absorbs, keep=1 carries.
function rollbackPush(state, older) {
  if (!older) return { keep: 0, state, older: null };
  if (older.keep === 0) return { ...older, keep: 1 };
  return { keep: 0, state, older: rollbackPush(older.state, older.older) };
}
test('merge order matches rollback push for every step from t=0 through 20,000', () => {
  const memory = { storage: { root: [] }, start: p => p.i * 2 ** p.l, end: p => (p.i + 1) * 2 ** p.l,
    node: () => ({ text: 'summary' }), text: () => 'summary' };
  const view = new SummaryView(memory, Infinity, 0);
  let states = null;
  for (let t = 0; t <= 20_000; t++) {
    states = rollbackPush(t, states);
    const starts = [];
    for (let s = states; s; s = s.older) starts.push(s.state);
    starts.reverse();
    const expected = starts.map((start, i) => [start, (starts[i + 1] ?? t + 1) - start]);
    view.append({ l: 0, i: t });
    while (view.parts.length > expected.length) {
      view.low = view.bytes - 1; view.fit(t + 1, true);
    }
    assert.deepEqual(view.parts.map(p => [memory.start(p), 2 ** p.l]), expected, `t=${t}`);
  }
});
test('T=10 merges messages 8-9 before 0-7', () => {
  const memory = { start: p => p.i * 2 ** p.l, end: p => (p.i + 1) * 2 ** p.l, node: () => ({}), text: () => 'summary' };
  const view = new SummaryView(memory, Infinity, 0, [{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }]);
  view.low = view.bytes - 1; view.fit(10, true);
  assert.deepEqual(pairs(view.parts), [[2, 0], [2, 1], [1, 4]]);
});
test('view appends without rewriting earlier lines until it batches from high to low', async () => {
  const options = { viewBudget: 3000, viewMinimum: 1500, nodeBudget: 256 };
  const { memory, storage, directory } = await fixture(options);
  let batches = 0;
  for (let i = 0; i < 60; i++) {
    const before = pairs(memory.view), size = memory.viewBytes;
    memory.append('user', 'decision ' + i + ': ' + 'x'.repeat(230));
    assert.equal(await memory.drain(AbortSignal.timeout(3000)), true);
    assert.equal(memory.viewBytes, bytes(memory.render()));
    if (size + bytes(`${i}+1|user: decision ${i}: ${'x'.repeat(230)}\n`) <= memory.viewBudget) {
      assert.deepEqual(pairs(memory.view).slice(0, before.length), before);
    } else { batches++; assert.ok(memory.viewBytes <= 1500, JSON.stringify({ i, size, bytes: memory.viewBytes, shrinking: memory.mainView.shrinking, parts: pairs(memory.view) })); }
  }
  assert.ok(batches >= 2);
  memory.syncCompact();
  const before = memory.render(), compactBefore = memory.compactView.render();
  await memory.stop(); await storage.close();
  const reopened = await Storage.open(directory), resumed = new Memory(reopened, model, options);
  cleanup.push(async () => { await resumed.stop(); await reopened.close(); });
  assert.equal(resumed.render(), before);
  assert.equal(resumed.compactView.render(), compactBefore);
});
test('saved view survives later-built parents and recovers only an unsaved log suffix', async () => {
  const { storage, memory } = await fixture();
  memory.pump = () => {};
  for (let i = 0; i < 10; i++) memory.append('user', `choice ${i}`);
  for (let i = 0; i < 10; i++) storage.saveNode(0, i, `user: choice ${i}`);
  for (let l = 1; 2 ** l <= 10; l++) for (let i = 0; (i + 1) * 2 ** l <= 10; i++) storage.saveNode(l, i, 'user: choices');
  const saved = [[2, 0], [2, 1]];
  storage.saveView(saved);
  const resumed = new Memory(storage, model); cleanup.push(() => resumed.stop());
  assert.deepEqual(pairs(resumed.view), [...saved, [0, 8], [0, 9]]);
  assert.deepEqual(storage.loadView(), pairs(resumed.view));
  const again = new Memory(storage, model); cleanup.push(() => again.stop());
  assert.equal(again.render(), resumed.render());
});
test('a batch stalled below high resumes after restart until it reaches low', async () => {
  const { storage, memory } = await fixture({ viewBudget: 1500, viewMinimum: 750 });
  memory.pump = () => {};
  for (let i = 0; i < 10; i++) memory.append('user', `choice ${i}`);
  for (let i = 0; i < 10; i++) memory.saveNode(0, i, 'user: ' + 'x'.repeat(200));
  for (let i = 0; i < 3; i++) memory.saveNode(1, i, 'user: ' + 'x'.repeat(140));
  memory.fit();
  assert.ok(memory.viewBytes < 1500 && memory.viewBytes > 750);
  assert.equal(storage.loadView('view-batch'), true);
  const resumed = new Memory(storage, model, { viewBudget: 1500, viewMinimum: 750 }); cleanup.push(() => resumed.stop());
  assert.equal(await resumed.drain(AbortSignal.timeout(3000)), true);
  assert.ok(resumed.viewBytes <= 750);
  assert.equal(storage.loadView('view-batch'), false);
});
test('corrupt views fail visibly instead of silently rebuilding and changing the cache', async () => {
  const { storage } = await fixture();
  storage.append('user', 'one'); storage.saveView([[0, 1]]);
  assert.throws(() => new Memory(storage, model), /Invalid saved view/);
  fs.writeFileSync(path.join(storage.directory, 'view.json'), 'null');
  assert.throws(() => new Memory(storage, model), /Invalid view.json/);
});
test('restart batches a view enlarged by summaries committed before a crash', async () => {
  const { storage } = await fixture();
  for (let i = 0; i < 10; i++) { storage.append('user', `choice ${i}`); storage.saveNode(0, i, 'user: ' + 'x'.repeat(200)); }
  for (let l = 1; 2 ** l <= 10; l++) for (let i = 0; (i + 1) * 2 ** l <= 10; i++) storage.saveNode(l, i, 'user: summary');
  storage.saveView(Array.from({ length: 10 }, (_, i) => [0, i]));
  storage.saveView(false, 'view-batch');
  const resumed = new Memory(storage, model, { viewBudget: 1500, viewMinimum: 750 }); cleanup.push(() => resumed.stop());
  assert.ok(resumed.viewBytes <= 750);
  assert.equal(storage.loadView('view-batch'), false);
});
test('compactions share the exact turn prompt and tool schema with complete bounded context', async () => {
  const calls = [];
  const compactor = { chat: async (messages, options) => { calls.push({ messages: structuredClone(messages), tools: options.tools }); return result('user: ' + 'summary '.repeat(30)); } };
  const { memory } = await fixture({ compactBudget: 6000, compactMinimum: 3000 }, compactor);
  const tools = { definitions: [{ type: 'function', function: { name: 'zoom', parameters: { type: 'object' } } }], execute() {} };
  const turns = [];
  const runner = new Runner(memory, { stream: async messages => { turns.push(messages); return result('done'); } }, tools, 'User instruction: keep names exact.');
  for (let i = 0; i < 60; i++) { memory.append('user', `decision ${i}: ` + 'x'.repeat(1000)); await memory.drain(AbortSignal.timeout(3000)); }
  await runner.submit('next');
  for (const call of calls) {
    assert.equal(call.messages[0].content, turns[0][0].content);
    assert.deepEqual(call.tools, tools.definitions);
    const context = call.messages[1].content.slice(0, -1).map(b => b.text).join('');
    assert.ok(!context.includes('not summarized yet'));
    assert.ok(bytes(context) <= 6000, JSON.stringify({ bytes: bytes(context), task: call.messages[1].content.at(-1).text.slice(0, 90), context }));
    const task = call.messages[1].content.at(-1).text;
    const message = /compress message (\d+)/.exec(task), merge = /merge lines (\d+)\+(\d+) and (\d+)\+(\d+)/.exec(task);
    const end = message ? Number(message[1]) : Number(merge[3]) + Number(merge[4]);
    for (const line of context.split('\n')) {
      const range = /^(\d+)\+(\d+)\|/.exec(line);
      if (range) assert.ok(Number(range[1]) + Number(range[2]) <= end);
    }
  }
  assert.ok(calls.length >= 60);
  assert.ok(memory.compactView.parts.length < 30);
  assert.ok(memory.compactView.bytes < memory.viewBytes);
  await runner.close();
});
test('eight leaf compactions can start together and never see placeholders', async () => {
  const waiting = [], contexts = [];
  const compactor = { chat: (messages, { signal }) => new Promise((resolve, reject) => {
    contexts.push(messages[1].content.slice(0, -1).map(b => b.text).join(''));
    waiting.push(() => resolve(result('user: decision')));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const { memory } = await fixture({}, compactor);
  for (let i = 0; i < 8; i++) memory.append('user', 'x'.repeat(1000));
  assert.equal(waiting.length, 8); assert.equal(memory.busy.size, 8);
  for (const resolve of waiting.reverse()) resolve();
  assert.equal(await memory.drain(AbortSignal.timeout(3000)), true);
  for (const context of contexts) assert.equal(context, '<chat>\n</chat>');
});
test('failed compactions wait for the next message instead of retrying on a timer', async () => {
  let attempts = 0;
  const { memory } = await fixture({ report() {} }, { chat: async () => { if (++attempts === 1) throw new Error('temporary'); return result('user: decision'); } });
  memory.append('user', 'x'.repeat(1000));
  assert.equal(await memory.drain(AbortSignal.timeout(3000)), false);
  memory.pump(); memory.pump(); assert.equal(attempts, 1);
  memory.append('user', 'retry');
  assert.equal(await memory.drain(AbortSignal.timeout(3000)), true);
  assert.equal(attempts, 2);
});
test('long non-tool text is split losslessly, tool results stay capped, and legacy originals have pages', async () => {
  const { memory, storage } = await fixture();
  const text = '🦓é\n'.repeat(12_000);
  memory.append('note', text);
  assert.equal(storage.root.map(r => r.text).join(''), text);
  assert.ok(storage.root.length > 1);
  for (const record of storage.root) { assert.ok(bytes(record.text) <= MESSAGE); assert.equal(record.kind, 'note'); }
  memory.append('echo', 'HEAD' + '🦓'.repeat(CAP + 1) + 'TAIL');
  assert.equal(Array.from(storage.root.at(-1).text).length, CAP);
  const legacy = storage.append('user', 'a'.repeat(MESSAGE) + 'TAIL🦓');
  assert.ok(memory.zoom(legacy.i, 1).includes('[page 1/2'));
  assert.ok(memory.zoom(legacy.i, 1, 1).includes('TAIL🦓'));
  assert.equal(capResult(memory.zoom(legacy.i, 1)), memory.zoom(legacy.i, 1));
  const full = [];
  for (let page = 0; page < 2; page++) {
    const output = capResult(memory.zoom(legacy.i, 1, page));
    full.push(output.slice(output.indexOf('user: ') + 6).split('\n[page ')[0]);
  }
  assert.equal(full.join(''), legacy.text);
});
