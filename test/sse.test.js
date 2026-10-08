import { test, expect } from 'bun:test';
import { sseData } from '../src/sse.js';
import { Meta } from '../src/meta.js';

const encoder = new TextEncoder();
function fragmented(text, size) {
  const bytes = encoder.encode(text);
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } });
}

test('SSE preserves multiline data and Unicode across LF, CRLF, and CR chunk boundaries', async () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const source = [': keepalive', 'event: message', 'data: hello 🦓', 'data:  indented', '', 'data: last', '', ''].join(ending);
    for (let size = 1; size <= 17; size++) {
      const payloads = [];
      for await (const payload of sseData(fragmented(source, size))) payloads.push(payload);
      expect(payloads).toEqual(['hello 🦓\n indented', 'last']);
    }
  }
});

test('SSE flushes a final unterminated frame and releases the reader after errors', async () => {
  const body = fragmented('data: final 🦓', 1);
  const payloads = [];
  for await (const payload of sseData(body)) payloads.push(payload);
  expect(payloads).toEqual(['final 🦓']);
  expect(body.locked).toBe(false);
  let canceled = false;
  const open = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: invalid\n\n')); }, cancel() { canceled = true; } });
  await expect((async () => {
    for await (const payload of sseData(open)) JSON.parse(payload);
  })()).rejects.toThrow();
  expect(canceled).toBe(true);
  expect(open.locked).toBe(false);
});

const fixtures = [
  { Provider: Meta, terminal: 'message_stop', events: [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello 🦓' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10 } },
    { type: 'message_stop' },
  ] },
];
for (const { Provider, terminal, events } of fixtures) {
  test(`${Provider.name} accepts byte-fragmented CRLF events without changing text or usage`, async () => {
    const logs = [], usage = [], visible = [];
    const model = new Provider({ apiKey: 'test-key', usage: record => usage.push(record), fetchImpl: async () => new Response(fragmented(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''), 1)) });
    const result = await model.stream([], { onEntry: (kind, text) => logs.push({ kind, text }), onText: text => visible.push(text) });
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello 🦓' }]);
    expect(result.finish_reason).toBe('COMPLETE');
    expect(logs).toEqual([{ kind: 'talk', text: 'hello 🦓' }]);
    expect(visible.join('')).toBe('hello 🦓');
    expect(usage).toHaveLength(1);
    expect(result.usage.input_tokens).toBe(10);
  });
  test(`${Provider.name} finishes at ${terminal} without waiting for HTTP EOF`, async () => {
    let canceled = false;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
      // The server leaves the connection open after its terminal event.
    }, cancel() { canceled = true; } });
    const model = new Provider({ apiKey: 'test-key', fetchImpl: async () => new Response(body) });
    const result = await model.stream([]);
    expect(result.finish_reason).toBe('COMPLETE');
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });
  test(`${Provider.name} finishes on CR-only terminal events with an open connection`, async () => {
    let canceled = false;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(events.map(e => `data: ${JSON.stringify(e)}\r\r`).join('')));
    }, cancel() { canceled = true; } });
    const model = new Provider({ apiKey: 'test-key', fetchImpl: async () => new Response(body) });
    expect((await model.stream([])).finish_reason).toBe('COMPLETE');
    expect(canceled).toBe(true);
  });
  test(`${Provider.name} rejects truncated streams and records no successful usage`, async () => {
    const usage = [];
    const model = new Provider({ apiKey: 'test-key', usage: record => usage.push(record), fetchImpl: async () => new Response(fragmented(events.slice(0, -1).map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), 3)) });
    await expect(model.stream([])).rejects.toThrow(`before ${terminal}`);
    expect(usage).toHaveLength(0);
  });
}
