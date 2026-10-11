import { expect, test } from 'bun:test';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { Meta, metaRequest } from '../src/meta.js';
import { OpenAI, openaiRequest } from '../src/openai.js';
import { createModel } from '../src/models.js';
import { ProviderFailure, ProviderModel, ProviderOutputLimit } from '../src/providers/core.js';
import type { ProviderOptions, UsageRecord } from '../src/providers/types.js';

const fetcher = (run: (url: string, init: RequestInit) => Promise<Response>) => run as unknown as typeof fetch;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const bytes = (events: unknown[], ending = '\n') => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}${ending}${ending}`).join(''));
const failure = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;
const fixture = (provider: 'Meta' | 'OpenAI') => provider === 'Meta'
  ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial 🦓' } }]
  : [{ type: 'response.output_text.delta', delta: 'partial 🦓' }];
const complete = (provider: 'Meta' | 'OpenAI') => provider === 'Meta'
  ? [...fixture(provider), { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]
  : [...fixture(provider), { type: 'response.completed', response: { status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'partial 🦓' }] },
  ], usage: {} } }];

for (const Provider of [Meta, OpenAI]) {
  const name = Provider.name as 'Meta' | 'OpenAI';
  const modelName = name === 'Meta' ? 'ms1.3' : 'luna6';
  test(`${name} scoped service interruption drains a stalled reader, keeps partial text and reports once`, async () => {
    const visible = gate(), canceled = gate(), released = gate(), records: UsageRecord[] = [], texts: string[] = [];
    let requests = 0, signal!: AbortSignal, body!: ReadableStream<Uint8Array>, finished = false;
    const model = createModel(modelName, { apiKey: 'test-secret', usage: record => records.push(record), fetchImpl: fetcher(async (_url, init) => {
      requests++; signal = init.signal!;
      body = new ReadableStream({ start(controller) { controller.enqueue(bytes(fixture(name))); },
        async cancel() { canceled.resolve(); await released.promise; } });
      return new Response(body);
    }) });
    const runtime = ManagedRuntime.make(ProviderModel.layer(model.effects)), controller = new AbortController();
    const work = runtime.runPromiseExit(Effect.flatMap(ProviderModel, service => service.stream([], { onText(text) { texts.push(text); visible.resolve(); } })),
      { signal: controller.signal }).finally(() => { finished = true; });
    try {
      await visible.promise; controller.abort(); await canceled.promise;
      expect(signal.aborted).toBe(true); expect(finished).toBe(false); expect(records).toHaveLength(0);
      released.resolve(); const exit = await work;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true); expect(body.locked).toBe(false);
      expect(texts).toEqual(['partial 🦓']); expect(requests).toBe(1); expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ purpose: 'agent', status: 'canceled', model: model.model }); expect(records[0]?.usage).toBeUndefined();
    } finally { released.resolve(); await work; await runtime.dispose(); }
  });

  test(`${name} JSON acquisition and body cancellation abort native I/O and release readers`, async () => {
    for (const phase of ['acquisition', 'body']) {
      const ready = gate(), records: UsageRecord[] = []; let signal!: AbortSignal, body: ReadableStream<Uint8Array> | undefined;
      const model = createModel(modelName, { apiKey: 'test-secret', usage: record => records.push(record), fetchImpl: fetcher(async (_url, init) => {
        signal = init.signal!;
        if (phase === 'acquisition') {
          ready.resolve();
          return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        body = new ReadableStream({ pull() { ready.resolve(); } }, { highWaterMark: 0 }); return new Response(body);
      }) });
      const controller = new AbortController();
      const work = model.chat([], { signal: controller.signal }).catch(error => error);
      await ready.promise; controller.abort(); expect((await work).name).toBe('AbortError'); expect(signal.aborted).toBe(true);
      if (body) expect(body.locked).toBe(false);
      expect(records).toHaveLength(1); expect(records[0]?.status).toBe('canceled');
    }
  });

  test(`${name} rejects malformed consumed fields before callbacks and retains typed internal causes`, async () => {
    const invalid = name === 'Meta'
      ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 42 } }, { type: 'content_block_start', index: 'bad', content_block: { type: 'text', text: '' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'id', name: 42, input: {} } }]
      : [{ type: 'response.output_text.delta', delta: 42 }, { type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', call_id: 'id', name: 'read', arguments: {} } }, { type: 'response.completed', response: { status: 'completed', output: 'private-secret' } }];
    for (const event of invalid) {
      let callbacks = 0;
      const model = new Provider({ apiKey: 'private-secret', fetchImpl: fetcher(async () => new Response(bytes([event]))) });
      const exit = await Effect.runPromiseExit(model.effects.stream([], { onText() { callbacks++; }, onEntry() { callbacks++; } }));
      const error = failure(exit); expect(error).toBeInstanceOf(ProviderFailure);
      expect((error as ProviderFailure).reason).toBe('malformed'); expect((error as ProviderFailure).message).not.toContain('private-secret');
      expect(callbacks).toBe(0);
    }
    for (const input of ['{"content":"private-secret","output":{}}', '{"private-secret"', 'null']) {
      const model = new Provider({ apiKey: 'private-secret', fetchImpl: fetcher(async () => new Response(input)) });
      const exit = await Effect.runPromiseExit(model.effects.chat([]));
      expect(failure(exit)).toBeInstanceOf(ProviderFailure); expect((failure(exit) as ProviderFailure).reason).toBe('malformed');
    }
  });

  test(`${name} classifies HTTP, native rejection, provider and truncated stream failures without retry`, async () => {
    const cases: { reason: ProviderFailure['reason']; fetch: typeof fetch }[] = [
      { reason: 'http', fetch: fetcher(async () => new Response('private-secret denied', { status: 403 })) },
      { reason: 'transport', fetch: (() => { throw new Error('private-secret network'); }) as unknown as typeof fetch },
      { reason: 'truncated', fetch: fetcher(async () => new Response(bytes(fixture(name)))) },
      { reason: 'provider', fetch: fetcher(async () => new Response(bytes([name === 'Meta'
        ? { type: 'error', error: { message: 'private-secret provider' } } : { type: 'response.failed', response: { error: { message: 'private-secret provider' } } }]))) },
    ];
    for (const entry of cases) {
      let requests = 0; const records: UsageRecord[] = [];
      const model = createModel(modelName, { apiKey: 'private-secret', usage: record => records.push(record), fetchImpl: fetcher((url, init) => { requests++; return entry.fetch(url, init); }) });
      const exit = await Effect.runPromiseExit(model.effects.stream([]));
      const error = failure(exit) as ProviderFailure;
      expect(error).toBeInstanceOf(ProviderFailure); expect(error.reason).toBe(entry.reason); expect(error.message).not.toContain('private-secret');
      if (entry.reason === 'http') expect(error.status).toBe(403);
      expect(requests).toBe(1); expect(records).toHaveLength(1); expect(records[0]?.status).toBe('error');
    }
  });

  test(`${name} terminal event cancels its reader before usage/report completion and ignores later frames`, async () => {
    const canceled = gate(), release = gate(); let body!: ReadableStream<Uint8Array>, count = 0, finished = false;
    const records: UsageRecord[] = [], entries: string[] = [];
    const model = createModel(modelName, { apiKey: 'test', usage: record => records.push(record), fetchImpl: fetcher(async () => {
      body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([...bytes(complete(name), '\r'), ...new TextEncoder().encode('data: invalid-json\r\r')])); },
        async cancel() { count++; canceled.resolve(); await release.promise; } }); return new Response(body);
    }) });
    const work = model.stream([], { onEntry: (_kind, text) => entries.push(text) }).finally(() => { finished = true; });
    try {
      await canceled.promise; expect(finished).toBe(false); expect(records).toHaveLength(0);
      release.resolve(); const result = await work; expect(result.finish_reason).toBe('COMPLETE'); expect(body.locked).toBe(false);
      expect(entries).toEqual(['partial 🦓']); expect(records).toHaveLength(1); expect(count).toBe(1);
    } finally { release.resolve(); await work; }
  });

  test(`${name} typed output limits retain partial replay, preserve MAX_TOKENS and never retry`, async () => {
    const payload = name === 'Meta' ? { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens', usage: { output_tokens: 10 } }
      : { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }], usage: { output_tokens: 10 } };
    let requests = 0; const records: UsageRecord[] = [];
    const model = createModel(modelName, { apiKey: 'test', usage: record => records.push(record), fetchImpl: fetcher(async () => { requests++; return Response.json(payload); }) });
    const exit = await Effect.runPromiseExit(model.effects.chat([]));
    const limit = failure(exit); expect(limit).toBeInstanceOf(ProviderOutputLimit);
    expect((limit as ProviderOutputLimit).result.finish_reason).toBe('MAX_TOKENS'); expect(records).toHaveLength(1); expect(records[0]?.status).toBe('completed');
    expect((await model.chat([])).finish_reason).toBe('MAX_TOKENS'); expect(requests).toBe(2); expect(records).toHaveLength(2);
  });

  test(`${name} reporting callback failures never produce a second usage record`, async () => {
    let calls = 0;
    const options: ProviderOptions = { apiKey: 'test', usage: () => { calls++; throw new Error('private-sink-failure'); }, fetchImpl: fetcher(async () => new Response(bytes(complete(name)))) };
    const model = createModel(modelName, options);
    await expect(model.stream([])).rejects.toThrow('unexpected error'); expect(calls).toBe(1);
  });
}

test('Schema validation retains exact Meta native extension fields and key order on stream replay', async () => {
  const opaque = JSON.parse('{"vendor_private":{"value":"encrypted"},"type":"redacted_thinking","data":"cipher","future":[1,null]}');
  const text = JSON.parse('{"metadata":{"nested":true},"type":"text","text":"","citations":[]}');
  const events = [{ type: 'content_block_start', index: 0, content_block: opaque }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: text }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { future_tokens: { value: 3 } } }, { type: 'message_stop' }];
  const model = new Meta({ apiKey: 'test', fetchImpl: fetcher(async () => new Response(bytes(events))) });
  const result = await model.stream([]);
  expect(JSON.stringify(result.message._metaContent?.[0])).toBe(JSON.stringify(opaque));
  expect(JSON.stringify(result.message._metaContent?.[1])).toBe(JSON.stringify({ ...text, text: 'answer' }));
  expect(JSON.stringify(metaRequest([result.message], [], model.model).messages[0]?.content)).toBe(JSON.stringify(result.message._metaContent));
  expect(result.usage).toEqual({ future_tokens: { value: 3 } });
});

test('Schema validation retains exact OpenAI encrypted/unknown native blocks and message phase on replay', async () => {
  const output = [JSON.parse('{"id":"r","encrypted_content":"cipher","type":"reasoning","future":[1,null]}'),
    JSON.parse('{"extra":{"version":2},"type":"future_native","payload":{"private":true}}'),
    JSON.parse('{"id":"msg","phase":"final_answer","type":"message","content":[{"future":{"native":true},"type":"output_text","text":"answer","annotations":[]}]}')];
  const model = new OpenAI({ apiKey: 'test', fetchImpl: fetcher(async () => new Response(bytes([{ type: 'response.completed',
    response: { status: 'completed', output, usage: { input_tokens: 1, future_tokens: [2] } } }]))) });
  const result = await model.stream([]);
  expect(JSON.stringify(result.message._openaiOutput)).toBe(JSON.stringify(output));
  expect(JSON.stringify(openaiRequest([result.message], [], model.model).input)).toBe(JSON.stringify(output));
  expect(result.usage).toEqual({ input_tokens: 1, future_tokens: [2] });
});

test('request attribution, ids and TTFT belong to the selected model and first nonempty visible text', async () => {
  const records: UsageRecord[] = [];
  for (const purpose of ['agent', 'compactor', 'subagent'] as const) {
    let body: Record<string, unknown> | undefined;
    const model = createModel('sol6.1', { apiKey: 'test', purpose, usage: record => records.push(record), fetchImpl: fetcher(async (_url, init) => {
      body = JSON.parse(init.body as string);
      return new Response(bytes([{ type: 'response.reasoning_summary_text.delta', delta: 'private-thought' },
        { type: 'response.output_text.delta', delta: '' }, ...complete('OpenAI')]));
    }) });
    await model.stream([]); expect(body?.model).toBe('gpt-6.1-sol'); expect(body?.reasoning).toEqual({ effort: 'medium' });
    expect(records.at(-1)).toMatchObject({ purpose, model: 'gpt-6.1-sol', status: 'completed' });
    expect(records.at(-1)?.ttft_ms).toBeGreaterThanOrEqual(0);
  }
  expect(records).toHaveLength(3); expect(new Set(records.map(record => record.request_id)).size).toBe(3);
  const silent = createModel('luna6', { apiKey: 'test', usage: record => records.push(record), fetchImpl: fetcher(async () => new Response(bytes([
    { type: 'response.reasoning_summary_text.delta', delta: 'private-thought' }, { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]))) });
  await silent.stream([]); expect(records.at(-1)?.ttft_ms).toBeUndefined();
});

for (const name of ['Meta', 'OpenAI'] as const) {
  const modelName = name === 'Meta' ? 'ms1.3' : 'luna6';
  test(`${name} cancellation drains an asynchronous entry callback before releasing the response`, async () => {
    const entered = gate(), release = gate(), aborted = gate(); let signal!: AbortSignal, finished = false;
    const records: UsageRecord[] = [];
    const model = createModel(modelName, { apiKey: 'test', usage: record => records.push(record), fetchImpl: fetcher(async (_url, init) => {
      signal = init.signal!; signal.addEventListener('abort', aborted.resolve, { once: true });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes(complete(name))); } }));
    }) });
    const controller = new AbortController();
    const work = model.stream([], { signal: controller.signal, onEntry: async () => { entered.resolve(); await release.promise; } })
      .catch(error => error).finally(() => { finished = true; });
    try {
      await entered.promise; controller.abort(); await aborted.promise;
      expect(finished).toBe(false); expect(records).toHaveLength(0); expect(signal.aborted).toBe(true);
      release.resolve(); expect((await work).name).toBe('AbortError'); expect(records).toHaveLength(1); expect(records[0]?.status).toBe('canceled');
    } finally { release.resolve(); await work; }
  });
  test(`${name} callback failure releases the body and reports one safe failure`, async () => {
    let body!: ReadableStream<Uint8Array>, canceled = 0; const records: UsageRecord[] = [];
    const model = createModel(modelName, { apiKey: 'private-secret', usage: record => records.push(record), fetchImpl: fetcher(async () => {
      body = new ReadableStream({ start(controller) { controller.enqueue(bytes(complete(name))); }, cancel() { canceled++; } }); return new Response(body);
    }) });
    const error = await model.stream([], { onEntry() { throw new Error('private-secret persistence'); } }).catch(error => error);
    expect(error.message).not.toContain('private-secret'); expect(error.message).toContain('callback failed');
    expect(body.locked).toBe(false); expect(canceled).toBe(1); expect(records).toHaveLength(1); expect(records[0]?.status).toBe('error');
  });
  test(`${name} native HTTP interruption disconnects the body before request completion`, async () => {
    const visible = gate(), disconnected = gate(), records: UsageRecord[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes(fixture(name))); }, cancel() { disconnected.resolve(); } }),
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    let body: ReadableStream<Uint8Array> | null = null;
    const model = createModel(modelName, { apiKey: 'local-fixture-key', usage: record => records.push(record), fetchImpl: fetcher(async (_url, init) => {
      const response = await fetch(server.url, init); body = response.body; return response;
    }) });
    const controller = new AbortController();
    try {
      const work = model.stream([], { signal: controller.signal, onText: visible.resolve }).catch(error => error);
      await visible.promise; controller.abort(); expect((await work).name).toBe('AbortError'); await disconnected.promise;
      expect((body as ReadableStream<Uint8Array> | null)?.locked).toBe(false); expect(records).toHaveLength(1); expect(records[0]?.status).toBe('canceled');
    } finally { controller.abort(); server.stop(true); }
  });
}

test('OpenAI validates byte-fragmented CRLF streams without losing signatures, text, usage or final frames', async () => {
  const output = [{ type: 'reasoning', encrypted_content: 'cipher', summary: [], id: 'reason' },
    { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'partial 🦓' }] }];
  for (const ending of ['\n', '\r\n', '\r']) {
    const source = bytes([...fixture('OpenAI'), { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 4 } } }], ending);
    const records: UsageRecord[] = [], texts: string[] = [];
    const model = createModel('luna6', { apiKey: 'test', usage: record => records.push(record), fetchImpl: fetcher(async () => new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < source.length; i++) controller.enqueue(source.slice(i, i + 1)); controller.close(); },
    }))) });
    const result = await model.stream([], { onText: text => texts.push(text) });
    expect(texts.join('')).toBe('partial 🦓'); expect(result.message._openaiOutput).toEqual(output);
    expect(records).toHaveLength(1); expect(records[0]?.usage).toEqual({ input_tokens: 4 });
  }
  const model = new OpenAI({ apiKey: 'test', fetchImpl: fetcher(async () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } }))) });
  expect((await model.stream([])).message._openaiOutput).toEqual(output);
});

test('OpenAI classifies an explicit failed response before requiring success output', async () => {
  for (const streaming of [false, true]) {
    const raw = { status: 'failed', error: { message: 'private-secret rejected' } };
    const model = new OpenAI({ apiKey: 'private-secret', fetchImpl: fetcher(async () => streaming
      ? new Response(bytes([{ type: 'response.completed', response: raw }])) : Response.json(raw)) });
    const exit = await Effect.runPromiseExit(streaming ? model.effects.stream([]) : model.effects.chat([]));
    expect(failure(exit)).toBeInstanceOf(ProviderFailure); expect((failure(exit) as ProviderFailure).reason).toBe('provider');
    expect((failure(exit) as ProviderFailure).message).toBe('OpenAI response: [redacted] rejected');
  }
});

test('cleanup defects cannot turn an output limit into a successful compatibility result', async () => {
  const records: UsageRecord[] = []; let body!: ReadableStream<Uint8Array>;
  const model = createModel('luna6', { apiKey: 'private-secret', usage: record => records.push(record), fetchImpl: fetcher(async () => {
    body = new ReadableStream({ start(controller) { controller.enqueue(bytes([{ type: 'response.incomplete', response: {
      status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' },
    } }])); }, cancel() { throw new Error('private-secret cleanup'); } }); return new Response(body);
  }) });
  const error = await model.stream([]).catch(error => error);
  expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('private-secret'); expect(error.kind).toBe('defect');
  expect(Cause.hasDies(error.cause)).toBe(true); expect(body.locked).toBe(false); expect(records).toHaveLength(1); expect(records[0]?.status).toBe('error');
});
