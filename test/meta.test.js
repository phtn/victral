import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Meta, metaRequest } from '../src/meta.js';
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
test('model selection supports only the two Meta models and preserves requested IDs', () => {
  assert.deepEqual(MODELS, ['muse-spark-1.3', 'muse-spark-1.3-contributor']);
  for (const model of MODELS) {
    const provider = createModel(model, { apiKey: 'test-key' });
    assert.equal(provider.model, model);
    assert.ok(provider instanceof Meta);
  }
  assert.throws(() => createModel('unknown'), /Unsupported model/);
});
test('default model is the Meta contributor tier', () => {
  assert.equal(MODEL, 'muse-spark-1.3-contributor');
  assert.ok(createModel(MODEL, { apiKey: 'test-key' }) instanceof Meta);
});
test('model input accepts numbers, case variants, and unambiguous short names', () => {
  assert.equal(MODEL_INFO.length, 2);
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
  assert.throws(() => resolveModelId('3'), /between 1 and 2/);
  assert.throws(() => resolveModelId('muse-spark'), /several models/);
  assert.throws(() => resolveModelId('unknown'), /Unknown model/);
  assert.throws(() => resolveModelId(''), /Choose a model/);
});
