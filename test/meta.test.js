import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Meta, metaRequest } from '../src/meta.js';
import { OpenAI } from '../src/openai.js';
import { Cohere } from '../src/cohere.js';
import { Anthropic } from '../src/anthropic.js';
import { Cloudflare } from '../src/cloudflare.js';
import { MLX } from '../src/mlx.js';
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
  ], [{ function: { name: 'zoom', description: 'retrieve', parameters: { type: 'object' } } }], 'muse-wonder-1.0', undefined, 'compactor');
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
test('model selection supports Cohere, Meta, OpenAI, Anthropic and Cloudflare models', () => {
  assert.deepEqual(MODELS, ['north-mini-code-1-0', 'command-a-03-2025', 'command-a-plus-05-2026', 'muse-wonder-1.0', 'muse-wonder-full', 'gpt-6-luna', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-opus-5-5', '@cf/meta/llama-3.2-1b-instruct', '@cf/zai-org/glm-4.7-flash', 'mlx-community/Qwen3.5-4B-OptiQ-4bit', 'mlx-community/Llama-3.2-3B-Instruct-4bit']);
  for (const model of MODELS) {
    const provider = createModel(model, { apiKey: 'test-key', accountId: 'test-account' });
    assert.equal(provider.model, model);
    assert.ok(provider instanceof (model.startsWith('muse-') ? Meta : model.startsWith('gpt-') ? OpenAI : model.startsWith('claude-') ? Anthropic : model.startsWith('@cf/') ? Cloudflare : model.startsWith('mlx-community/') ? MLX : Cohere));
  }
  assert.throws(() => createModel('unknown'), /Unsupported model/);
});
test('default model is Cohere North Mini Code', () => {
  assert.equal(MODEL, 'north-mini-code-1-0');
  assert.ok(createModel(MODEL, { apiKey: 'test-key' }) instanceof Cohere);
});
test('model input accepts numbers, case variants, and unambiguous short names', () => {
  assert.equal(MODEL_INFO.length, 13);
  assert.ok(formatModelsList().includes('1. north-mini-code-1-0'));
  assert.ok(formatModelsList().includes('4. muse-wonder-1.0'));
  assert.equal(resolveModelId('1'), MODELS[0]);
  assert.equal(resolveModelId('2'), MODELS[1]);
  assert.equal(resolveModelId('MUSE-WONDER-1.0'), 'muse-wonder-1.0');
  assert.equal(resolveModelId('full'), 'muse-wonder-full');
  for (const { id, shortName } of MODEL_INFO) {
    assert.equal(resolveModelId(shortName), id);
    assert.equal(resolveModelId(` ${shortName.toUpperCase()} `), id);
    assert.equal(createModel(shortName, { apiKey: 'test-key', accountId: 'test-account' }).model, id);
    assert.ok(formatModelsList().includes(`alias ${shortName}`));
  }
  assert.equal(resolveModelId('3'), 'command-a-plus-05-2026');
  assert.equal(resolveModelId('6'), 'gpt-6-luna');
  assert.equal(resolveModelId('7'), 'gpt-6.1-sol');
  assert.equal(resolveModelId('OPENAI luna6'), 'gpt-6-luna');
  assert.equal(resolveModelId('openai gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(resolveModelId('meta mw1.0'), 'muse-wonder-1.0');
  assert.equal(resolveModelId('openai 6'), 'gpt-6-luna');
  assert.throws(() => resolveModelId('meta luna6'), /Unknown model/);
  assert.throws(() => resolveModelId('openai 1'), /belong to openai/);
  assert.equal(resolveModelId('9'), 'claude-opus-5-5');
  assert.equal(resolveModelId('anthropic sonnet5.5'), 'claude-sonnet-5-5');
  assert.equal(resolveModelId('10'), '@cf/meta/llama-3.2-1b-instruct');
  assert.equal(resolveModelId('cloudflare cf-llama1b'), '@cf/meta/llama-3.2-1b-instruct');
  assert.equal(resolveModelId('11'), '@cf/zai-org/glm-4.7-flash');
  assert.equal(resolveModelId('cloudflare cf-glm47'), '@cf/zai-org/glm-4.7-flash');
  assert.equal(resolveModelId('12'), 'mlx-community/Qwen3.5-4B-OptiQ-4bit');
  assert.equal(resolveModelId('mlx optiq'), 'mlx-community/Qwen3.5-4B-OptiQ-4bit');
  assert.equal(resolveModelId('13'), 'mlx-community/Llama-3.2-3B-Instruct-4bit');
  assert.equal(resolveModelId('local llama3b'), 'mlx-community/Llama-3.2-3B-Instruct-4bit');
  assert.equal(resolveModelId('MLX-COMMUNITY/QWEN3.5-4B-OPTIQ-4BIT'), 'mlx-community/Qwen3.5-4B-OptiQ-4bit');
  assert.throws(() => resolveModelId('mlx 1'), /belong to mlx/);
  assert.throws(() => resolveModelId('llama'), /several models/);
  assert.throws(() => resolveModelId('14'), /between 1 and 13/);
  assert.throws(() => resolveModelId('muse-wonder'), /several models/);
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

test('Anthropic requests use x-api-key, adaptive effort, default fallbacks and dated web search', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ content: [{ type: 'thinking', thinking: 'brief', signature: 'sig' }, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 3 } });
  };
  const model = new Anthropic({ apiKey: 'test-key', model: 'claude-sonnet-5-5', webSearch: true, fetchImpl });
  const result = await model.chat([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }]);
  const [{ url, headers, body }] = requests;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'test-key');
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.tools, [{ type: 'web_search_20260209', name: 'web_search' }]);
  assert.equal(result.finish_reason, 'COMPLETE');
  assert.equal(result.message._metaContent[0].signature, 'sig');
  const compactor = new Anthropic({ apiKey: 'test-key', purpose: 'compactor', webSearch: true, fetchImpl });
  await compactor.chat([{ role: 'user', content: 'summarize' }]);
  assert.equal(requests[1].body.model, 'claude-opus-5-5');
  assert.deepEqual(requests[1].body.output_config, { effort: 'medium' });
  assert.equal(requests[1].body.tools, undefined);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try { assert.throws(() => new Anthropic({}), /ANTHROPIC_API_KEY/); }
  finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});
