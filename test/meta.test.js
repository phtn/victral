import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Meta, metaRequest } from '../src/meta.js';
import { OpenAI } from '../src/openai.js';
import { createModel, MODELS, MODEL_INFO, formatModelsList, resolveModelId } from '../src/models.js';
import { MODEL } from '../src/constants.js';

test('Meta request groups tool results and preserves encrypted reasoning exactly', () => {
  const native = [
    { type: 'redacted_thinking', data: 'encrypted' },
    { type: 'tool_use', id: 'call1', name: 'zoom', input: { id: 0, n: 1 } },
    { type: 'tool_use', id: 'call2', name: 'date', input: { id: 0 } },
  ];
  const request = metaRequest([
    { role: 'system', content: 'stable instructions' },
    { role: 'user', content: [{ type: 'text', text: '<chat></chat>' }, { type: 'text', text: 'request' }] },
    { role: 'assistant', content: [], _metaContent: native },
    { role: 'tool', tool_call_id: 'call1', content: [{ type: 'text', text: 'decision' }] },
    { role: 'tool', tool_call_id: 'call2', content: [{ type: 'text', text: 'date' }] },
  ], [{ function: { name: 'zoom', description: 'retrieve', parameters: { type: 'object' } } }], 'muse-spark-1.3', undefined, 'compactor');
  assert.equal(request.system, 'stable instructions');
  assert.deepEqual(request.messages[1].content, native);
  assert.equal(request.messages.length, 3);
  assert.equal(request.messages[2].content.length, 2);
  assert.equal(request.messages[2].content[0].type, 'tool_result');
  assert.equal(request.output_config.effort, 'medium');
  assert.equal(request.max_tokens, 16_384);
  assert.equal(request.tools[0].name, 'zoom');
});
test('Meta streaming retains signatures and encrypted blocks without logging reasoning', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'encrypted' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'c1', name: 'zoom', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"id":0,"n":1}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10, cache_read_input_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const logs = [];
  const model = new Meta({ apiKey: 'test-key', fetchImpl: async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')) });
  const result = await model.stream([], { onEntry: (kind, text) => logs.push({ kind, text }) });
  assert.equal(result.message._metaContent[0].signature, 'sig');
  assert.equal(result.message._metaContent[1].data, 'encrypted');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"id":0,"n":1}');
  assert.equal(result.finish_reason, 'TOOL_CALL');
  assert.equal(result.usage.input_tokens, 20);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'tool');
});
test('model selection supports Meta and only the two requested OpenAI models', () => {
  assert.deepEqual(MODELS, ['muse-spark-1.3', 'muse-spark-1.3-contributor', 'gpt-6-luna', 'gpt-6.1-sol']);
  for (const model of MODELS) {
    const provider = createModel(model, { apiKey: 'test-key' });
    assert.equal(provider.model, model);
    assert.ok(provider instanceof (model.startsWith('muse-') ? Meta : OpenAI));
  }
  assert.throws(() => createModel('unknown'), /Unsupported model/);
});
test('default model is the Meta contributor tier', () => {
  assert.equal(MODEL, 'muse-spark-1.3-contributor');
  assert.ok(createModel(MODEL, { apiKey: 'test-key' }) instanceof Meta);
});
test('model input accepts numbers, case variants, and unambiguous short names', () => {
  assert.equal(MODEL_INFO.length, 4);
  assert.ok(formatModelsList().includes('1. muse-spark-1.3'));
  assert.ok(formatModelsList().includes('2. muse-spark-1.3-contributor'));
  assert.equal(resolveModelId('1'), MODELS[0]);
  assert.equal(resolveModelId('2'), MODELS[1]);
  assert.equal(resolveModelId('MUSE-SPARK-1.3'), 'muse-spark-1.3');
  assert.equal(resolveModelId('contributor'), 'muse-spark-1.3-contributor');
  for (const { id, shortName } of MODEL_INFO) {
    assert.equal(resolveModelId(shortName), id);
    assert.equal(resolveModelId(` ${shortName.toUpperCase()} `), id);
    assert.equal(createModel(shortName, { apiKey: 'test-key' }).model, id);
    assert.ok(formatModelsList().includes(`alias ${shortName}`));
  }
  assert.equal(resolveModelId('3'), 'gpt-6-luna');
  assert.equal(resolveModelId('4'), 'gpt-6.1-sol');
  assert.equal(resolveModelId('OPENAI luna6'), 'gpt-6-luna');
  assert.equal(resolveModelId('openai gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(resolveModelId('meta ms1.3'), 'muse-spark-1.3');
  assert.equal(resolveModelId('openai 3'), 'gpt-6-luna');
  assert.throws(() => resolveModelId('meta luna6'), /Unknown model/);
  assert.throws(() => resolveModelId('openai 1'), /belong to openai/);
  assert.throws(() => resolveModelId('5'), /between 1 and 4/);
  assert.throws(() => resolveModelId('muse-spark'), /several models/);
  assert.throws(() => resolveModelId('unknown'), /Unknown model/);
  assert.throws(() => resolveModelId(''), /Choose a model/);
});

test('Meta built-in search replays server blocks and streamed citations without local calls', async () => {
  const server = { type: 'server_tool_use', id: 'search_1', name: 'web_search', input: { query: 'question' } };
  const events = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: server },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.test/source', title: 'Source' } } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    { type: 'message_stop' },
  ];
  let sent; const texts = [], logs = [];
  const model = new Meta({ apiKey: 'test', webSearch: true, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  } });
  const result = await model.stream([], { onText: text => texts.push(text), onEntry: (kind, text) => logs.push({ kind, text }) });
  assert.deepEqual(sent.tools, [{ type: 'web_search' }]);
  assert.equal(result.finish_reason, 'COMPLETE'); assert.equal(result.message.tool_calls, undefined);
  assert.ok(texts.join('').includes('[Source](<https://example.test/source>)'));
  assert.equal(logs.filter(entry => entry.kind === 'tool').length, 1);
  assert.deepEqual(metaRequest([result.message], [], model.model).messages[0].content, result.message._metaContent);
});

test('web search is off by default and never enabled for compaction', async () => {
  for (const Provider of [Meta, OpenAI]) for (const options of [{}, { purpose: 'compactor', webSearch: true }]) {
    let sent;
    const model = new Provider({ apiKey: 'test', ...options, fetchImpl: async (_url, request) => { sent = JSON.parse(request.body); return Response.json({ status: 'completed', output: [], content: [], stop_reason: 'end_turn' }); } });
    await model.chat([]);
    assert.ok(!sent.tools?.some(tool => tool.type === 'web_search'));
  }
});
