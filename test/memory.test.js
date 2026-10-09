import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage, day } from '../src/storage.js';
import { Memory, SCALE } from '../src/memory.js';
import { bytes, cutBytes, capResult, CAP } from '../src/constants.js';
import { Runner } from '../src/runner.js';
import { projectTools } from '../src/tools.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const noModel = { chat: async () => { throw new Error('Unexpected model call'); } };
async function fixture(model = noModel, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-test-'));
  const storage = await Storage.open(path.join(directory, 'chat'), () => {});
  const memory = new Memory(storage, model, options);
  cleanups.push(async () => { await memory.stop(); await storage.close(); });
  return { directory, storage, memory };
}
test('UTF-8 lengths, safe truncation, and head/tail tool cap', () => {
  assert.equal(bytes(SCALE), 512);
  assert.equal(bytes('🦓'), 4);
  assert.equal(cutBytes('a🦓z', 3), 'a');
  assert.equal(cutBytes('a\uFFFDz', 4), 'a\uFFFD');
  for (const original of ['a🦓z', 'é文\uFFFDz', 'plain']) {
    for (let limit = 0; limit <= bytes(original) + 1; limit++) {
      let prefix = '';
      for (const char of original) { if (bytes(prefix + char) > limit) break; prefix += char; }
      assert.equal(cutBytes(original, limit), prefix);
    }
  }
  const capped = capResult('HEAD' + 'x'.repeat(40_000) + 'TAIL');
  assert.equal(Array.from(capped).length, CAP);
  assert.ok(capped.startsWith('HEAD') && capped.endsWith('TAIL') && capped.includes('omitted'));
});
test('single writer excludes a second opener and permits restart', async () => {
  const { storage } = await fixture();
  await assert.rejects(Storage.open(storage.directory), /already open/);
});
test('free nodes, binary ranges, Unicode retrieval, and replay survive restart', async () => {
  const { storage, memory } = await fixture();
  for (let i = 0; i < 4; i++) memory.append('user', `decision ${i} 🦓`);
  assert.equal(await memory.drain(AbortSignal.timeout(3000)), true);
  assert.match(memory.zoom(0, 4), /^0\+2\|.*\n2\+2\|/s);
  assert.equal(memory.zoom(2, 1), '2+0|user: decision 2 🦓');
  assert.match(memory.zoom(1, 2), /No line/);
  const before = memory.render();
  await memory.stop(); await storage.close();
  const reloaded = await Storage.open(storage.directory);
  cleanups.push(() => reloaded.close());
  const next = new Memory(reloaded, noModel);
  assert.equal(next.render(), before);
  assert.equal(next.zoom(2, 1), '2+0|user: decision 2 🦓');
});
test('torn final JSON is reported, skipped, and cannot swallow the next append', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-torn-'));
  fs.mkdirSync(path.join(directory, 'main'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'main', day() + '.jsonl'), '{"incomplete":');
  const reports = [];
  const store = await Storage.open(directory, text => reports.push(text));
  store.append('user', 'recovered');
  await store.close();
  const next = await Storage.open(directory, () => {});
  cleanups.push(() => next.close());
  assert.equal(next.root.length, 1);
  assert.equal(next.root[0].text, 'recovered');
  assert.equal(reports.length, 1);
});
test('view merges the most due adjacent binary siblings, covers every message, and never splits', async () => {
  const model = { chat: async () => ({ finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'user: decisions' }] } }) };
  const { storage, memory } = await fixture(model, { viewBudget: 50, nodeBudget: 45 });
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

// Deliberately recompute sizes and scan all siblings: a small, independent
// reference for the specification's incremental, most-due folding rule.
function referenceFit(view, memory, T, state) {
  const render = () => '<chat>\n' + view.map(p => `${memory.start(p)}+${2 ** p.l}|${memory.text(p).replace(/\r\n|\r|\n/g, ' ')}`).join('\n') + (view.length ? '\n' : '') + '</chat>';
  let size = bytes(render());
  if (size > memory.viewBudget) state.shrinking = true;
  while (state.shrinking && size > memory.viewMinimum) {
    let best = -1, weight = -Infinity;
    for (let j = 0; j + 1 < view.length; j++) {
      const a = view[j], b = view[j + 1];
      if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1 || !memory.node(a.l + 1, a.i / 2)) continue;
      const due = (T - ((b.i + 1) * 2 ** b.l - 1)) / 2 ** a.l;
      if (due > weight) { best = j; weight = due; }
    }
    if (best < 0) break;
    const a = view[best], b = view[best + 1], parent = { l: a.l + 1, i: a.i / 2 };
    view.splice(best, 2, parent);
    size = bytes(render());
  }
  if (size <= memory.viewMinimum) state.shrinking = false;
}
test('indexed scheduling preserves source/context readiness, scan priority, retries, and view folding', async () => {
  let calls = 0;
  const model = { chat: async messages => {
    assert.ok(!messages[1].content[0].text.includes('not summarized yet'));
    await Bun.sleep(++calls % 3);
    return { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'user: retain the decisions and original sources 🦓' }] } };
  } };
  const { storage, memory } = await fixture(model, { nodeBudget: 64, viewBudget: 200, jobs: 3, retry: 2, report: () => {} });
  const reference = [], state = { shrinking: false };
  let seen = 0;
  memory.on('change', () => {
    while (seen < storage.root.length) reference.push({ l: 0, i: seen++ });
    referenceFit(reference, memory, storage.root.length, state);
    assert.deepEqual(memory.view, reference);
    assert.equal(memory.viewBytes, bytes(memory.render()));
  });
  const build = memory.build.bind(memory), attempts = new Map();
  memory.build = async (l, i, signal) => {
    const key = `${l}:${i}`, first = memory.first(), T = storage.root.length;
    let expected;
    for (let level = 0; 2 ** level <= T && !expected; level++) {
      for (let index = 0; (index + 1) * 2 ** level <= T; index++) {
        if (memory.node(level, index) || memory.failures.has(`${level}:${index}`) || (memory.busy.has(`${level}:${index}`) && `${level}:${index}` !== key)) continue;
        if (level === 0 && index - first - [...memory.builtAhead].filter(id => id < index).length >= memory.jobs) continue;
        if (level && (!memory.node(level - 1, 2 * index) || !memory.node(level - 1, 2 * index + 1))) continue;
        expected = `${level}:${index}`; break;
      }
    }
    assert.equal(key, expected);
    const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
    if (['0:3', '1:0', '1:2'].includes(key) && attempt === 1) throw new Error('temporary compactor failure');
    return build(l, i, signal);
  };
  for (let i = 0; i < 32; i++) memory.append('user', i % 3 ? `decision ${i} 🦓 `.repeat(20) : `keep ${i}`);
  for (let retry = 0; !await memory.drain(AbortSignal.timeout(3000)); retry++) {
    assert.ok(retry < 3); memory.append('user', 'retry failed compactions');
  }
  let expectedNodes = 0;
  for (let n = storage.root.length; n >= 1; n = Math.floor(n / 2)) expectedNodes += n;
  assert.equal(storage.nodes.size, expectedNodes);
  assert.equal(memory.remaining, 0);
  for (const key of ['0:3', '1:0', '1:2']) assert.equal(attempts.get(key), 2);
  const next = new Memory(storage, model, { nodeBudget: 64, viewBudget: 200 });
  assert.deepEqual(next.view, memory.view);
  assert.equal(next.viewBytes, bytes(next.render()));
  await next.stop();
});
test('restart indexes unfinished merges and idle pumps do not scan saved history', async () => {
  const { storage, memory } = await fixture();
  for (let i = 0; i < 32; i++) storage.append('user', `choice ${i}`);
  for (let i = 0; i < 32; i++) storage.saveNode(0, i, `user: choice ${i}`);
  // A completed later sibling must be retained while earlier gaps catch up.
  storage.saveNode(1, 7, 'user: choice 14\nuser: choice 15');
  const resumed = new Memory(storage, noModel);
  cleanups.push(() => resumed.stop());
  assert.equal(await resumed.drain(AbortSignal.timeout(3000)), true);
  assert.equal(storage.nodes.size, 63);
  const get = storage.nodes.get.bind(storage.nodes);
  let reads = 0;
  storage.nodes.get = key => { reads++; return get(key); };
  for (let i = 0; i < 100; i++) resumed.pump();
  assert.equal(reads, 0);
  const alreadyCanceled = new AbortController(); alreadyCanceled.abort();
  assert.equal(await resumed.drain(alreadyCanceled.signal), false);
});
test('compactor retries with byte feedback in the same conversation, keeps the shortest, and uses the dash ruler', async () => {
  const requests = [];
  const attempts = ['x'.repeat(530), 'x'.repeat(520), 'x'.repeat(519), 'x'.repeat(521), 'x'.repeat(518)];
  const model = { chat: async messages => {
    requests.push(structuredClone(messages));
    return { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: attempts[requests.length - 1] }] } };
  } };
  const { memory } = await fixture(model);
  memory.append('user', 'z'.repeat(900));
  await memory.settle(AbortSignal.timeout(3000));
  assert.equal(requests.length, 5);
  assert.equal(bytes(memory.node(0, 0).text), 518);
  assert.equal(requests[1].length, 4);
  assert.match(requests[1][3].content, /530 bytes/);
  assert.match(requests[0][1].content.at(-1).text, /Compaction: compress message 0/);
  assert.ok(requests[0][1].content.at(-1).text.includes('-'.repeat(512)));
  assert.ok(requests[0][1].content.at(-1).text.includes('<input>\nuser: '));
});
test('settle waits for summaries and cancellation resolves false', async () => {
  const model = { chat: async (_messages, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const { memory } = await fixture(model);
  memory.append('user', 'x'.repeat(1000));
  const controller = new AbortController();
  const result = memory.settle(controller.signal);
  controller.abort();
  assert.equal(await result, false);
  assert.match(memory.render(), /not summarized/);
});
test('fresh turns use prior view, inject mid-turn input at boundary, and log it once', async () => {
  const { memory, storage } = await fixture();
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
test('project file tools reject parent paths and symlinks escaping the project', async () => {
  const { memory, directory } = await fixture();
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  const outside = path.join(directory, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, 'link'));
  const tools = projectTools(memory, project);
  await assert.rejects(tools.execute('write_file', { path: '../outside/file', content: 'no' }), /outside/);
  await assert.rejects(tools.execute('write_file', { path: 'link/file', content: 'no' }), /Symlink/);
  await tools.execute('write_file', { path: 'src/hello.txt', content: 'hello' });
  assert.equal(await tools.execute('read_file', { path: 'src/hello.txt' }), 'hello');
});
test('Bun shell tool captures Unicode output, stderr, and nonzero exit status', async () => {
  const { memory, directory } = await fixture();
  const tools = projectTools(memory, directory, { allowShell: true });
  const output = await tools.execute('shell', { command: 'printf "🦓"; printf "shell-warning" >&2; exit 7' });
  assert.ok(output.includes('🦓') && output.includes('shell-warning') && output.includes('exit: 7'));
});
