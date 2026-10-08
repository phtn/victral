import { test, expect } from 'bun:test';
import { smoothResponse } from '../src/smooth-response.js';
import { Runner } from '../src/runner.js';
import type { ModelPort, MemoryPort } from '../src/types.js';

const response = { message: { role: 'assistant', content: 'Hello world 🦓' }, finish_reason: 'COMPLETE' };
const options = (signal = new AbortController().signal) => ({ signal, tools: [], onText: (_text: string) => {}, onThought: (_text: string) => {}, onEntry: () => {} });
test('smoothing displays words before the provider finishes and preserves native output and entries', async () => {
  let release!: () => void;
  let firstText!: () => void;
  const visible: string[] = [], entries: string[] = [];
  const pending = new Promise<void>(resolve => { release = resolve; });
  const displayed = new Promise<void>(resolve => { firstText = resolve; });
  const model: ModelPort = { model: 'test', async stream(_messages, opts) {
    opts.onText('Hel'); opts.onText('lo world ');
    await pending;
    opts.onText('🦓'); opts.onEntry('talk', 'Hello world 🦓');
    return response;
  } };
  const work = smoothResponse(model, [], { ...options(), onText: text => { visible.push(text); firstText(); }, onEntry: (_kind, text) => { entries.push(text); } });
  await displayed;
  expect(visible[0]).toBe('Hello ');
  expect(entries).toEqual([]);
  release();
  expect(await work).toBe(response);
  expect(visible.join('')).toBe('Hello world 🦓');
  expect(entries).toEqual(['Hello world 🦓']);
});
test('provider failure flushes partial text and reports the error', async () => {
  const visible: string[] = [];
  const model: ModelPort = { model: 'test', async stream(_messages, opts) { opts.onText('Partial response'); throw new Error('connection lost'); } };
  await expect(smoothResponse(model, [], { ...options(), onText: text => visible.push(text) })).rejects.toThrow('connection lost');
  expect(visible.join('')).toBe('Partial response');
});
test('canceling discards queued display chunks and does not leak text into the next response', async () => {
  const controller = new AbortController();
  const visible: string[] = [];
  const model: ModelPort = { model: 'test', async stream(_messages, opts) {
    opts.onText('one two three four five six ');
    return response;
  } };
  await expect(smoothResponse(model, [], { ...options(controller.signal), onText: text => { visible.push(text); controller.abort(); } })).rejects.toThrow();
  expect(visible).toEqual(['one ']);
  const next: string[] = [];
  await smoothResponse({ model: 'test', async stream(_messages, opts) { opts.onText('New response'); return response; } }, [], { ...options(), onText: text => next.push(text) });
  expect(next.join('')).toBe('New response');
});
test('Runner drains smooth output before tools, preserves reasoning callbacks, and resets the waiting phase', async () => {
  const events: string[] = [];
  let calls = 0;
  const model: ModelPort = { model: 'test', async stream(_messages, opts) {
    if (++calls === 1) {
      opts.onThought('consider'); opts.onText('Checking files');
      return { message: { role: 'assistant', content: 'Checking files', tool_calls: [{ id: 'call', function: { name: 'files', arguments: '{}' } }] }, finish_reason: 'TOOL_CALL' };
    }
    opts.onText('All done'); return { message: { role: 'assistant', content: 'All done' }, finish_reason: 'COMPLETE' };
  } };
  const memory: MemoryPort = { append() {}, async settle() { return true; }, render: () => '', zoom: () => '', date: () => '' };
  const runner = new Runner(memory, model, { definitions: [], async execute() { events.push('tool'); return 'files'; } }, '', {
    onText: text => events.push(text), onThought: () => events.push('thinking'), onPhase: phase => events.push(phase),
  });
  await runner.submit('Check files'); await runner.close();
  expect(events).toEqual(['Waiting for response', 'thinking', 'Checking ', 'files', 'tool', 'Waiting for response', 'All ', 'done']);
});

test.each(['MAX_TOKENS', 'ERROR', 'UNKNOWN_STOP', undefined])('Runner reports unsuccessful termination %s before executing tools', async finish_reason => {
  let executed = 0;
  const errors: string[] = [], statuses: string[] = [];
  const model: ModelPort = { model: 'test', async stream() {
    return { message: { role: 'assistant', content: 'partial', tool_calls: [{ id: 'call', function: { name: 'write_file', arguments: '{}' } }] }, finish_reason };
  } };
  const memory: MemoryPort = { append() {}, async settle() { return true; }, render: () => '', zoom: () => '', date: () => '' };
  const runner = new Runner(memory, model, { definitions: [], async execute() { executed++; return 'written'; } }, '', {
    onError: text => errors.push(text), onTurn: turn => statuses.push(turn.status),
  });
  await runner.submit('Make a change'); await runner.close();
  expect(executed).toBe(0);
  expect(statuses).toEqual(['error']);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(finish_reason === 'MAX_TOKENS' ? 'output limit' : finish_reason ?? 'missing finish reason');
});
test('Runner rejects a tool termination with no calls instead of reporting completion', async () => {
  const errors: string[] = [], statuses: string[] = [];
  const model: ModelPort = { model: 'test', async stream() { return { message: { role: 'assistant', content: [] }, finish_reason: 'TOOL_CALL' }; } };
  const memory: MemoryPort = { append() {}, async settle() { return true; }, render: () => '', zoom: () => '', date: () => '' };
  const runner = new Runner(memory, model, { definitions: [], async execute() { throw new Error('unexpected tool'); } }, '', {
    onError: text => errors.push(text), onTurn: turn => statuses.push(turn.status),
  });
  await runner.submit('Check files'); await runner.close();
  expect(statuses).toEqual(['error']);
  expect(errors).toEqual(['Model requested a tool step without tool calls.']);
});
