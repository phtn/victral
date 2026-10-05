import test from 'node:test';
import assert from 'node:assert/strict';
import { Cohere, viewBlocks } from '../src/cohere.js';

test('view block marks preserve text exactly and split only at line ends', () => {
  const view = '<chat>\n' + ('0+1|summary\n'.repeat(10_000)) + '</chat>';
  const blocks = viewBlocks(view);
  assert.equal(blocks.length, 4);
  assert.equal(blocks.map(b => b.text).join(''), view);
  for (const block of blocks.slice(0, -1)) assert.ok(block.text.endsWith('\n'));
});
test('streaming reconstructs fragmented SSE, records text and tools, and retains thinking only in turn state', async () => {
  const events = [
    { type: 'content-start', index: 0, delta: { message: { content: { type: 'thinking', thinking: '' } } } },
    { type: 'content-delta', index: 0, delta: { message: { content: { thinking: 'private' } } } },
    { type: 'content-end', index: 0 },
    { type: 'content-start', index: 1, delta: { message: { content: { type: 'text', text: '' } } } },
    { type: 'content-delta', index: 1, delta: { message: { content: { text: 'hello 🦓' } } } },
    { type: 'content-end', index: 1 },
    { type: 'tool-plan-delta', delta: { message: { tool_plan: 'retrieve' } } },
    { type: 'tool-call-start', index: 0, delta: { message: { tool_calls: { id: 'call1', type: 'function', function: { name: 'zoom', arguments: '' } } } } },
    { type: 'tool-call-delta', index: 0, delta: { message: { tool_calls: { function: { arguments: '{"id":0,"n":1}' } } } } },
    { type: 'tool-call-end', index: 0 },
    { type: 'message-end', delta: { finish_reason: 'TOOL_CALL', usage: { cached_tokens: 0 } } },
  ];
  const data = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  const response = new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < data.length; i += 7) controller.enqueue(data.slice(i, i + 7));
    controller.close();
  } }));
  const logs = [], usages = [];
  const model = new Cohere({ apiKey: 'test-key', fetchImpl: async () => response, usage: u => usages.push(u) });
  const result = await model.stream([], { onEntry: (kind, text) => logs.push({ kind, text }) });
  assert.equal(result.message.content[0].thinking, 'private');
  assert.equal(result.message.content[1].text, 'hello 🦓');
  assert.equal(result.message.tool_plan, undefined);
  assert.equal(result.message.tool_calls[0].function.arguments, '{"id":0,"n":1}');
  assert.deepEqual(logs.map(r => r.kind), ['talk', 'tool']);
  assert.ok(!logs.some(r => r.text.includes('private')));
  assert.equal(usages.length, 1);
});
