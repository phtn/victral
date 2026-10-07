import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Storage } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { createModel } from '../src/models.js';
import { parseArgs } from 'node:util';
import { Runner } from '../src/runner.js';
import { projectTools } from '../src/tools.js';
import { MODEL } from '../src/constants.js';

const { values } = parseArgs({ options: { model: { type: 'string', default: MODEL } } });
const modelId = values.model;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'victral-smoke-'));
let storage, memory;
try {
  storage = await Storage.open(path.join(directory, 'chat'));
  const usage = record => storage.usage(record);
  const model = createModel(modelId, { usage });
  memory = new Memory(storage, createModel(modelId, { purpose: 'compactor', usage }));
  const longDecision = 'user: The synthetic project launch code is ZEBRA-7319. Keep this exact code available for future turns. ' +
    'The fictional project has a green interface and a planned release next month. '.repeat(8);
  memory.append('note', longDecision);
  const signal = AbortSignal.timeout(90_000);
  assert.equal(await memory.drain(signal), true);
  assert.ok(memory.node(0, 0));
  await memory.stop(); await storage.close();
  storage = await Storage.open(path.join(directory, 'chat'));
  memory = new Memory(storage, createModel(modelId, { purpose: 'compactor', usage }));
  let reply = '';
  const tools = projectTools(memory, directory);
  let zoomed = false;
  const execute = tools.execute;
  tools.execute = async (name, args, signal) => { zoomed ||= name === 'zoom'; return execute(name, args, signal); };
  const errors = [];
  const runner = new Runner(memory, model, tools, '', { onText: text => { reply += text; }, onError: text => errors.push(text) });
  await runner.submit('Use zoom(0, 1) to retrieve the original stored note, then reply with only its launch code.');
  assert.deepEqual(errors, []);
  assert.ok(zoomed, 'The model must invoke the retrieval tool.');
  assert.ok(reply.includes('ZEBRA-7319'), 'The stored decision must survive restart.');
  assert.equal(await memory.settle(signal), true);
  const usageRecords = storage.load('usage');
  console.log(JSON.stringify({ model: modelId, compaction: 'passed', restart: 'passed', tool_retrieval: 'passed', reply, usage: usageRecords.map(r => ({ purpose: r.purpose, ...r.usage })), artifacts: directory }, null, 2));
  await runner.close();
} finally {
  await memory?.stop(); await storage?.close();
}
