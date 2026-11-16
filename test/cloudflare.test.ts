import { test, expect } from 'bun:test';
import { Cloudflare, cloudflareRequest } from '../src/cloudflare.js';
import { createModel } from '../src/models.js';

const credentials = { apiKey: 'test-token', accountId: 'test-account' };
const usage = { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22, prompt_tokens_details: { cached_tokens: 0 }, neurons: 0.133 };
// Workers AI sends OpenAI-compatible completions, so absent fields arrive as null.
const completion = (message: Record<string, unknown>, finish = 'stop') => ({
  id: 'id-1', object: 'chat.completion', created: 1, model: '@cf/meta/llama-3.2-1b-instruct',
  choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], usage,
});
const streamBody = (chunks: unknown[]) => `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;

test('Cloudflare chat normalizes a Llama completion that reports a null refusal', async () => {
  let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const model = createModel('cf-llama1b', { ...credentials, fetchImpl: (async (url: string, options: RequestInit) => {
    sent = { url: String(url), headers: options.headers as Record<string, string>, body: JSON.parse(String(options.body)) };
    return Response.json(completion({ role: 'assistant', content: 'Hello dear friend!', refusal: null }));
  }) as unknown as typeof fetch });
  const result = await model.chat([{ role: 'user', content: 'Say hello in five words.' }]);
  expect(sent?.url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions');
  expect(sent?.headers.Authorization).toBe('Bearer test-token');
  expect(sent?.body.model).toBe('@cf/meta/llama-3.2-1b-instruct');
  expect(sent?.body.stream).toBe(false);
  expect(result.finish_reason).toBe('COMPLETE');
  expect(result.message.content).toEqual([{ type: 'text', text: 'Hello dear friend!' }]);
  expect(result.usage).toMatchObject({ input_tokens: 17, output_tokens: 5 });
});

test('Cloudflare chat keeps a null content with tool calls and a null refusal', async () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2}' } };
  const result = await new Cloudflare({ ...credentials, model: '@cf/meta/llama-3.2-1b-instruct',
    fetchImpl: (async () => Response.json(completion({ role: 'assistant', content: null, tool_calls: [call], refusal: null }, 'tool_calls'))) as unknown as typeof fetch,
  }).chat([]);
  expect(result.finish_reason).toBe('TOOL_CALL');
  expect(result.message.content).toEqual([]);
  expect(result.message.tool_calls?.[0]).toMatchObject({ id: 'call_1', function: { name: 'add', arguments: '{"a":2}' } });
});

test('Cloudflare chat reports a refusal as assistant text', async () => {
  const result = await new Cloudflare({ ...credentials, model: '@cf/meta/llama-3.2-1b-instruct',
    fetchImpl: (async () => Response.json(completion({ role: 'assistant', content: null, refusal: 'I cannot help with that.' }))) as unknown as typeof fetch,
  }).chat([]);
  expect(result.message.content).toEqual([{ type: 'text', text: 'I cannot help with that.' }]);
});

test('Cloudflare streaming accepts null content and refusal deltas', async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, refusal: null } }] },
    { choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { choices: [{ index: 0, delta: { content: ' there' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ];
  const text: string[] = [];
  const result = await new Cloudflare({ ...credentials, model: '@cf/meta/llama-3.2-1b-instruct',
    fetchImpl: (async () => new Response(streamBody(chunks), { headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch,
  }).stream([], { onText: chunk => text.push(chunk) });
  expect(text.join('')).toBe('Hello there');
  expect(result.finish_reason).toBe('COMPLETE');
  expect(result.message.content).toEqual([{ type: 'text', text: 'Hello there' }]);
  expect(result.usage).toMatchObject({ input_tokens: 17, output_tokens: 5 });
});

test('Cloudflare requests omit assistant content only when a tool call carries the turn', () => {
  const request = cloudflareRequest([
    { role: 'user', content: 'add two numbers' },
    { role: 'assistant', content: [], tool_calls: [{ id: 'call_1', function: { name: 'add', arguments: { a: 2 } } }] },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '4' }] },
  ] as never, undefined, '@cf/meta/llama-3.2-1b-instruct');
  expect(request.messages[1]).toEqual({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2}' } }] });
  expect(request.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '4' });
});

const search = [{ type: 'function', function: { name: 'tikr_search', description: 'Search TIKR',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }];
const searchCall = { id: 'call_1', type: 'function', function: { name: 'tikr_search', arguments: '{"query":"NVDA"}' } };

test('Cloudflare refuses a Llama tool turn on both paths and points at cf-glm47', async () => {
  let requests = 0;
  const llama = () => new Cloudflare({ ...credentials, model: '@cf/meta/llama-3.2-1b-instruct',
    fetchImpl: (async () => { requests++; return Response.json(completion({ role: 'assistant', content: 'unused', refusal: null })); }) as unknown as typeof fetch });
  const turns = [() => llama().chat([] as never, { tools: search as never }), () => llama().stream([] as never, { tools: search as never })];
  for (const turn of turns) await expect(turn()).rejects.toThrow(/cannot choose tools on Workers AI.*cf-glm47/s);
  // Refused before any Neurons are spent.
  expect(requests).toBe(0);
});

test('Cloudflare still serves Llama turns that request no tools', async () => {
  const result = await new Cloudflare({ ...credentials, model: '@cf/meta/llama-3.2-1b-instruct',
    fetchImpl: (async () => Response.json(completion({ role: 'assistant', content: 'Hello there!', refusal: null }))) as unknown as typeof fetch,
  }).chat([] as never);
  expect(result.message.content).toEqual([{ type: 'text', text: 'Hello there!' }]);
});

test('Cloudflare still streams Llama turns that request no tools', async () => {
  const bodies: Record<string, unknown>[] = [];
  const chunks = [
    { choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { choices: [{ index: 0, delta: { content: ' there' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ];
  const text: string[] = [];
  await new Cloudflare({ ...credentials, model: '@cf/meta/llama-3.2-1b-instruct',
    fetchImpl: (async (_url: string, options: RequestInit) => {
      bodies.push(JSON.parse(String(options.body)));
      return new Response(streamBody(chunks), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  }).stream([] as never, { onText: chunk => text.push(chunk) });
  expect(bodies[0].stream).toBe(true);
  expect(text).toEqual(['Hello', ' there']);
});

test('Cloudflare streams GLM tool turns natively instead of buffering them', async () => {
  const bodies: Record<string, unknown>[] = [];
  const chunks = [
    { choices: [{ index: 0, delta: { content: 'Searching' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tikr_search', arguments: '{"query":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"NVDA"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
  ];
  const result = await new Cloudflare({ ...credentials, model: '@cf/zai-org/glm-4.7-flash',
    fetchImpl: (async (_url: string, options: RequestInit) => {
      bodies.push(JSON.parse(String(options.body)));
      return new Response(streamBody(chunks), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  }).stream([] as never, { tools: search as never });
  expect(bodies[0].stream).toBe(true);
  expect(result.finish_reason).toBe('TOOL_CALL');
  expect(result.message.tool_calls?.[0]).toMatchObject({ id: 'call_1', function: { name: 'tikr_search', arguments: '{"query":"NVDA"}' } });
});
