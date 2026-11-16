import { test, expect } from 'bun:test';
import { MLX, mlxRequest } from '../src/mlx.js';
import { createModel } from '../src/models.js';
import { FallbackModel } from '../src/fallback-model.js';
import * as Effect from 'effect/Effect';

const fetcher = (run: (url: string, options: RequestInit) => Promise<Response>) => run as unknown as typeof fetch;
// A local MLX server speaks the OpenAI-compatible completions shape.
const completion = (message: Record<string, unknown>, finish = 'stop') => ({
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'mlx-community/Qwen3.5-4B-OptiQ-4bit',
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
});
const streamBody = (chunks: unknown[]) => `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;

test('mlxRequest formats turns, tool calls, and tool results', () => {
  const request = mlxRequest([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '22C and sunny' },
  ], [{ type: 'function', function: { name: 'get_weather', description: 'Get weather',
    parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }],
  'mlx-community/Qwen3.5-4B-OptiQ-4bit');
  expect(request.model).toBe('mlx-community/Qwen3.5-4B-OptiQ-4bit');
  expect(request.max_tokens).toBe(16_384);
  expect(request.messages).toEqual([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '22C and sunny' },
  ]);
  expect(request.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'Get weather',
    parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }]);
});

test('mlxRequest replays a captured server message instead of rebuilding it', () => {
  const native = { role: 'assistant', content: null, reasoning: 'local thought',
    tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_time', arguments: '{}' } }] };
  const request = mlxRequest([{ role: 'assistant', content: [], _mlxMessage: native }], undefined, 'mlx-community/Qwen3.5-4B-OptiQ-4bit');
  expect(request.messages[0]).toEqual(native);
  expect(request.messages[0]).not.toBe(native);
  expect(request.tools).toBeUndefined();
});

test('a compactor request that never answers times out as a provider failure and fails over', async () => {
  const hang = fetcher((_url, options) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })));
  const stalled = new MLX({ purpose: 'compactor', timeoutMs: 40, fetchImpl: hang });
  await expect(stalled.chat([{ role: 'user', content: 'summarize' }])).rejects.toThrow(/MLX did not respond within/);
  const summary = { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: 'summary' }] } };
  const model = new FallbackModel('llama3b', { purpose: 'compactor' }, undefined, (id, options) => id.startsWith('mlx-community/')
    ? new MLX({ ...options, model: id, timeoutMs: 40, fetchImpl: hang })
    : { model: id, effects: { model: id, chat: () => Effect.succeed(summary), stream: () => Effect.succeed(summary) } });
  expect(await model.chat([{ role: 'user', content: 'summarize' }])).toBe(summary);
  expect(model.fallbackActive).toBe(true);
  // Agent turns stream for as long as the model keeps working: no default limit.
  expect(new MLX({ fetchImpl: hang }).timeoutMs).toBeUndefined();
  expect(new MLX({ purpose: 'compactor', fetchImpl: hang }).timeoutMs).toBe(300_000);
});

test('MLX chat posts to the local server and normalizes text completions', async () => {
  let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const model = createModel('optiq', { fetchImpl: fetcher(async (url, options) => {
    sent = { url: String(url), headers: options.headers as Record<string, string>, body: JSON.parse(String(options.body)) };
    return Response.json(completion({ role: 'assistant', content: 'Hello dear friend!' }));
  }) });
  const result = await model.chat([{ role: 'user', content: 'Say hello in five words.' }]);
  expect(sent?.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
  expect(sent?.headers.Authorization).toBeUndefined();
  expect(sent?.body.model).toBe('mlx-community/Qwen3.5-4B-OptiQ-4bit');
  expect(sent?.body.stream).toBe(false);
  expect(result.finish_reason).toBe('COMPLETE');
  expect(result.message.content).toEqual([{ type: 'text', text: 'Hello dear friend!' }]);
  expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });
});

test('MLX chat keeps the native message and reports tool calls', async () => {
  const native = { role: 'assistant', content: null, reasoning: 'Checking weather',
    tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' } }] };
  const result = await new MLX({ model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    fetchImpl: fetcher(async () => Response.json(completion(native, 'tool_calls'))) }).chat([]);
  expect(result.finish_reason).toBe('TOOL_CALL');
  expect(result.message.content).toEqual([]);
  expect(result.message._mlxMessage).toEqual(native);
  expect(result.message.tool_calls?.[0]).toMatchObject({ id: 'call_abc', function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' } });
});

test('MLX chat reports a tool turn even when the model stops normally', async () => {
  const result = await new MLX({ fetchImpl: fetcher(async () => Response.json(completion({ role: 'assistant', content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2}' } }] }))) }).chat([]);
  expect(result.finish_reason).toBe('TOOL_CALL');
});

test('MLX chat rejects a completion without a message and an incomplete tool call', async () => {
  const empty = new MLX({ fetchImpl: fetcher(async () => Response.json({ id: 'chatcmpl-2', choices: [{ index: 0 }] })) });
  await expect(empty.chat([])).rejects.toThrow(/did not contain a chat completion/);
  const partial = new MLX({ fetchImpl: fetcher(async () => Response.json(completion({ role: 'assistant', content: null,
    tool_calls: [{ type: 'function', function: { name: 'add', arguments: '{}' } }] }, 'tool_calls'))) });
  await expect(partial.chat([])).rejects.toThrow(/incomplete tool call/);
});

test('MLX chat surfaces a server error payload', async () => {
  const model = new MLX({ fetchImpl: fetcher(async () => Response.json({ choices: [], error: { message: 'model not loaded' } })) });
  await expect(model.chat([])).rejects.toThrow(/model not loaded/);
});

test('MLX streaming emits reasoning, text, and one talk entry', async () => {
  const texts: string[] = [], thoughts: string[] = [], logs: { kind: string; text: string }[] = [];
  const model = new MLX({ fetchImpl: fetcher(async (_url, options) => {
    expect(JSON.parse(String(options.body)).stream).toBe(true);
    return new Response(streamBody([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Thinking deeply...' } }] },
      { choices: [{ index: 0, delta: { content: 'Hello ' } }] },
      { choices: [{ index: 0, delta: { content: 'world!' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ]));
  }) });
  const result = await model.stream([{ role: 'user', content: 'Hi' }], {
    onText: text => texts.push(text), onThought: text => thoughts.push(text), onEntry: (kind, text) => logs.push({ kind, text }) });
  expect(texts.join('')).toBe('Hello world!');
  expect(thoughts).toEqual(['Thinking deeply...']);
  expect(logs).toEqual([{ kind: 'talk', text: 'Hello world!' }]);
  expect(result.finish_reason).toBe('COMPLETE');
  expect(result.message.content).toEqual([{ type: 'text', text: 'Hello world!' }]);
  expect(result.message._mlxMessage).toEqual({ role: 'assistant', content: 'Hello world!' });
  expect(result.usage).toMatchObject({ input_tokens: 4, output_tokens: 2 });
});

test('MLX streaming joins tool call fragments across chunks', async () => {
  const logs: { kind: string; text: string }[] = [];
  const model = new MLX({ fetchImpl: fetcher(async () => new Response(streamBody([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'time', arguments: '{"zone":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]))) });
  const result = await model.stream([], { onEntry: (kind, text) => logs.push({ kind, text }) });
  expect(result.finish_reason).toBe('TOOL_CALL');
  expect(result.message.tool_calls).toHaveLength(1);
  expect(result.message.tool_calls?.[0]).toMatchObject({ id: 'call_1', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } });
  expect(result.message._mlxMessage).toMatchObject({ role: 'assistant', content: null });
  expect(logs).toEqual([{ kind: 'tool', text: 'get_time {"zone":"UTC"}' }]);
});

test('MLX streaming reports a length stop as a retained limit and an empty stream as truncated', async () => {
  const limited = new MLX({ fetchImpl: fetcher(async () => new Response(streamBody([
    { choices: [{ index: 0, delta: { content: 'partial' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ]))) });
  const result = await limited.stream([]);
  expect(result.finish_reason).toBe('MAX_TOKENS');
  expect(result.message.content).toEqual([{ type: 'text', text: 'partial' }]);
  const empty = new MLX({ fetchImpl: fetcher(async () => new Response('data: [DONE]\n\n')) });
  await expect(empty.stream([])).rejects.toThrow(/ended before any chunk arrived/);
});

test('MLX sends a bearer token only when a proxy credential is configured', async () => {
  let headers: Record<string, string> | undefined;
  const model = new MLX({ apiKey: 'proxy-key', fetchImpl: fetcher(async (_url, options) => {
    headers = options.headers as Record<string, string>;
    return Response.json(completion({ role: 'assistant', content: 'ok' }));
  }) });
  await model.chat([]);
  expect(headers?.Authorization).toBe('Bearer proxy-key');
});

test('MLX caps compactor output and leaves the agent default in place', async () => {
  const bodies: Record<string, unknown>[] = [];
  const send = (purpose: 'agent' | 'compactor') => new MLX({ purpose, fetchImpl: fetcher(async (_url, options) => {
    bodies.push(JSON.parse(String(options.body)));
    return Response.json(completion({ role: 'assistant', content: 'summary' }));
  }) }).chat([], { maxTokens: 32_000 });
  await send('compactor');
  await send('agent');
  expect(bodies[0]?.max_tokens).toBe(8_192);
  expect(bodies[1]?.max_tokens).toBe(32_000);
});

test('MLX refuses provider-hosted web search', () => {
  expect(() => new MLX({ webSearch: true })).toThrow(/does not provide provider-hosted web search/);
  expect(() => new MLX({ webSearch: true, purpose: 'compactor' })).not.toThrow();
});

test('MLX honors MLX_BASE_URL and trims a trailing slash', async () => {
  const previous = process.env.MLX_BASE_URL;
  process.env.MLX_BASE_URL = 'http://192.168.1.50:9000/';
  try {
    let url: string | undefined;
    await new MLX({ fetchImpl: fetcher(async (target) => {
      url = String(target);
      return Response.json(completion({ role: 'assistant', content: 'ok' }));
    }) }).chat([]);
    expect(url).toBe('http://192.168.1.50:9000/v1/chat/completions');
  }
  finally {
    if (previous === undefined) delete process.env.MLX_BASE_URL; else process.env.MLX_BASE_URL = previous;
  }
});
