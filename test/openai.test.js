import { test, expect } from 'bun:test';
import { OpenAI, openaiRequest } from '../src/openai.js';
import { createModel } from '../src/models.js';

const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'encrypted-only-in-turn' };
const tool = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'zoom', arguments: '{"id":0,"n":1}', status: 'completed' };
const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Decision 🦓', annotations: [] }] };
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } };
const response = output => ({ id: 'resp_1', status: 'completed', output, usage });
const streamBody = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');

test('Responses request converts memory and tools while replaying native reasoning and phase', () => {
  const native = [reasoning, message, tool];
  const request = openaiRequest([
    { role: 'system', content: 'instructions' },
    { role: 'user', content: [{ type: 'text', text: '<chat>history</chat>', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'question' }] },
    { role: 'assistant', content: [], tool_calls: [{ id: 'call_1', function: { name: 'zoom', arguments: tool.arguments } }], _openaiOutput: native },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'saved result' }] },
    { role: 'user', content: 'steering' },
  ], [{ type: 'function', function: { name: 'zoom', description: 'retrieve', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: [] } } }], 'gpt-6.1-sol');
  expect(request.model).toBe('gpt-6.1-sol'); expect(request.store).toBe(false);
  expect(request.max_output_tokens).toBe(16_384); expect(request.reasoning.effort).toBe('medium');
  expect(request.input.slice(2, 5)).toEqual(native);
  expect(request.input[2]).not.toBe(reasoning);
  expect(request.input[1].content).toBe('<chat>history</chat>\nquestion');
  expect(request.input[5]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'saved result' });
  expect(request.input[6]).toEqual({ role: 'user', content: 'steering' });
  expect(request.tools[0]).toMatchObject({ type: 'function', name: 'zoom', strict: false });
  expect(request.tools[0].parameters.required).toEqual([]);
});

test('OpenAI chat uses Responses auth, preserves requested IDs and normalizes text and calls', async () => {
  let sent;
  const records = [];
  const model = createModel('sol6.1', { apiKey: 'test-key', purpose: 'compactor', usage: record => records.push(record), fetchImpl: async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return Response.json(response([reasoning, message]));
  } });
  const result = await model.chat([{ role: 'user', content: 'Summarize' }]);
  expect(sent.url).toBe('https://api.openai.com/v1/responses');
  expect(sent.headers.Authorization).toBe('Bearer test-key');
  expect(sent.body.model).toBe('gpt-6.1-sol'); expect(sent.body.stream).toBe(false);
  expect(result.finish_reason).toBe('COMPLETE');
  expect(result.message.content).toEqual([{ type: 'text', text: 'Decision 🦓' }]);
  expect(result.message._openaiOutput).toEqual([reasoning, message]);
  expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ model: 'gpt-6.1-sol', purpose: 'compactor', status: 'completed', usage });
  const toolResult = await new OpenAI({ apiKey: 'test', fetchImpl: async () => Response.json(response([reasoning, tool])) }).chat([]);
  expect(toolResult.finish_reason).toBe('TOOL_CALL');
  expect(toolResult.message.tool_calls[0]).toMatchObject({ id: 'call_1', function: { name: 'zoom', arguments: tool.arguments } });
});

test('OpenAI streaming emits text and logs visible entries once while retaining reasoning privately', async () => {
  const events = [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: reasoning },
    { type: 'response.reasoning_summary_text.delta', delta: 'considering' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Decision ' },
    { type: 'response.output_text.delta', output_index: 1, delta: '🦓' },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"id":0,' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"n":1}' },
    { type: 'response.output_item.done', output_index: 2, item: tool },
    { type: 'response.completed', response: response([reasoning, message, tool]) },
  ];
  const text = [], thoughts = [], logs = [], records = [];
  const model = createModel('luna6', { apiKey: 'test', usage: record => records.push(record), fetchImpl: async () => new Response(streamBody(events)) });
  const result = await model.stream([], { onText: value => text.push(value), onThought: value => thoughts.push(value), onEntry: (kind, text) => logs.push({ kind, text }) });
  expect(text.join('')).toBe('Decision 🦓'); expect(thoughts).toContain('considering');
  expect(logs).toEqual([{ kind: 'talk', text: 'Decision 🦓' }, { kind: 'tool', text: 'zoom {"id":0,"n":1}' }]);
  expect(result.message._openaiOutput[0]).toEqual(reasoning);
  expect(result.finish_reason).toBe('TOOL_CALL'); expect(result.usage).toEqual(usage);
  expect(records).toHaveLength(1); expect(records[0].ttft_ms).toBeGreaterThanOrEqual(0);
  const next = openaiRequest([result.message, { role: 'tool', tool_call_id: 'call_1', content: 'result' }], [], model.model);
  expect(next.input.slice(0, 3)).toEqual([reasoning, message, tool]);
  expect(next.input[3].call_id).toBe('call_1');
});

test('Responses streaming returns at the terminal event on a still-open connection', async () => {
  let canceled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(streamBody([{ type: 'response.completed', response: response([message]) }])));
  }, cancel() { canceled = true; } });
  const model = new OpenAI({ apiKey: 'test', fetchImpl: async () => new Response(body) });
  const result = await model.stream([]);
  expect(result.finish_reason).toBe('COMPLETE'); expect(canceled).toBe(true);
});

test('OpenAI rejects failed and truncated streams, marks output limits, and redacts credentials', async () => {
  const truncated = new OpenAI({ apiKey: 'test', fetchImpl: async () => new Response(streamBody([{ type: 'response.output_text.delta', delta: 'partial' }])) });
  await expect(truncated.stream([])).rejects.toThrow('before a terminal response event');
  for (const type of ['error', 'response.failed']) {
    const failed = new OpenAI({ apiKey: 'secret-key', fetchImpl: async () => new Response(streamBody([{ type, message: 'bad secret-key', response: { error: { message: 'bad secret-key' } } }])) });
    await expect(failed.stream([])).rejects.toThrow('bad [redacted]');
  }
  const incomplete = { ...response([message]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  const limited = new OpenAI({ apiKey: 'test', fetchImpl: async (_url, options) => JSON.parse(options.body).stream
    ? new Response(streamBody([{ type: 'response.incomplete', response: incomplete }])) : Response.json(incomplete) });
  expect((await limited.chat([])).finish_reason).toBe('MAX_TOKENS');
  expect((await limited.stream([])).finish_reason).toBe('MAX_TOKENS');
  const rejected = new OpenAI({ apiKey: 'secret-key', fetchImpl: async () => new Response('bad secret-key', { status: 401 }) });
  await expect(rejected.chat([])).rejects.toThrow('OpenAI HTTP 401: bad [redacted]');
  const missing = new OpenAI({ apiKey: 'test', fetchImpl: async () => Response.json({ output: [] }) });
  expect((await missing.chat([])).finish_reason).toBeUndefined();
  expect(() => new OpenAI({ apiKey: '' })).toThrow('OPENAI_API_KEY');
});

test('OpenAI passes cancellation through to transport and reports a canceled request', async () => {
  const controller = new AbortController(), records = [];
  const model = createModel('luna6', { apiKey: 'test', usage: record => records.push(record), fetchImpl: async (_url, options) => {
    expect(options.signal).toBe(controller.signal);
    controller.abort(); throw new DOMException('Aborted', 'AbortError');
  } });
  await expect(model.stream([], { signal: controller.signal })).rejects.toThrow('Aborted');
  expect(records).toHaveLength(1); expect(records[0].status).toBe('canceled');
});

test('OpenAI web search stays native, preserves citations and logs search once', async () => {
  const search = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'question' } };
  const cited = { ...message, content: [{ type: 'output_text', text: 'Sourced answer', annotations: [{ type: 'url_citation', title: 'Official guide', url: 'https://example.test/guide' }] }] };
  let sent; const logs = [], texts = [];
  const model = new OpenAI({ apiKey: 'test', webSearch: true, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(streamBody([{ type: 'response.output_text.delta', delta: 'Sourced answer' }, { type: 'response.output_item.done', output_index: 0, item: search }, { type: 'response.completed', response: response([search, cited]) }]));
  } });
  const result = await model.stream([], { onText: text => texts.push(text), onEntry: (kind, text) => logs.push({ kind, text }) });
  expect(sent.tools).toEqual([{ type: 'web_search' }]);
  expect(texts.join('')).toContain('[Official guide](<https://example.test/guide>)');
  expect(logs.filter(entry => entry.kind === 'tool')).toHaveLength(1);
  expect(result.message.tool_calls).toBeUndefined(); expect(result.message._openaiOutput).toEqual([search, cited]);
  const replay = openaiRequest([result.message], [], model.model);
  expect(replay.input).toEqual([search, cited]);
});
