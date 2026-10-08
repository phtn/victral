import React from 'react';
import { test, expect, afterEach } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import { DemoSession } from '../src/demo.js';
import { Workspace, safeText, shortProject, wrapLines } from '../src/tui.js';
import stringWidth from 'string-width';
import { EventEmitter } from 'node:events';
import type { SessionState } from '../src/session.js';
import type { WorkspaceSession } from '../src/tui.js';

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 60));
test('terminal output removes control sequences and wraps Unicode by display width', () => {
  expect(safeText('\x1b[31mhello\x1b[0m\x1b]52;c;hidden\x07')).toBe('hello');
  expect(wrapLines('abcd🦓文e', 5).every(line => stringWidth(line) <= 5)).toBe(true);
});
test('workspace renders Codex layout, opens command menu and metrics, and submits input', async () => {
  const empty = {
    options: { project: '/tmp/victral-empty', allowShell: false },
    metrics: { detailed: () => 'empty' },
    snapshot: () => ({ entries: [], model: 'command-a-plus-05-2026', active: false, phase: 'Ready', metrics: '' }),
    submit: async () => {}, cancel: () => {}, close: async () => {},
    on: () => {}, off: () => {},
  } as unknown as DemoSession;
  const emptyView = render(<Workspace session={empty} />); await flush();
  expect(emptyView.lastFrame()).toContain('Victral'); expect(emptyView.lastFrame()).toContain('(v0.2.0)');
  expect(emptyView.lastFrame()).toContain('A half-formed idea will do.');
  emptyView.unmount();
  const session = new DemoSession();
  const view = render(<Workspace session={session} />); await flush();
  expect(view.lastFrame()).toContain('Victral'); expect(view.lastFrame()).toContain('(v0.2.0)');
  expect(view.lastFrame()).toContain('muse-spark-1.3-contributor'); expect(view.lastFrame()).toContain('·');
  view.stdin.write('\x10'); await flush(); expect(view.lastFrame()).toContain('/help'); expect(view.lastFrame()).toContain('COMMANDS');
  view.stdin.write('\x1b'); await flush();
  view.stdin.write('\x0f'); await flush(); expect(view.lastFrame()).toContain('DEMO METRICS'); expect(view.lastFrame()).toContain('METRICS');
  view.stdin.write('\x0f'); await flush();
  view.stdin.write('hello'); await flush(); view.stdin.write('\r'); await flush();
  expect(session.snapshot().entries.at(-1)?.text).toBe('hello'); expect(session.snapshot().active).toBe(true);
  expect(view.lastFrame()).toContain('⟢ hello');
  expect(view.lastFrame()).toContain('✓ Received');
  expect(view.lastFrame()).toContain('Working');
  view.stdin.write('\x1b'); await flush(); expect(session.snapshot().active).toBe(false);
  await session.close();
});
test('project paths shorten with a tilde', () => {
  expect(shortProject('/elsewhere/project')).toBe('/elsewhere/project');
});
test('workspace renders incremental Markdown and keeps work visible through panels and tool phases', async () => {
  const state: SessionState = {
    entries: [{ id: 0, role: 'you', text: 'Explain it' }, { id: 1, role: 'victral', text: '# Answer\n\n**Partial**' }],
    model: 'muse-spark-1.3-contributor', active: true, phase: 'Responding', metrics: '',
    jev: { state: 'enabled', completed: 0, pending: 1, errors: 0, skipped: 0 },
  };
  const session: WorkspaceSession & EventEmitter = Object.assign(new EventEmitter(), {
    options: { project: '/tmp/markdown', allowShell: false }, metrics: { detailed: () => 'Usage' },
    snapshot: () => ({ ...state, entries: [...state.entries] }), submit: async () => {}, cancel: () => {}, close: async () => {},
  });
  const view = render(<Workspace session={session} />); await flush();
  expect(view.lastFrame()).toContain('✓ Received');
  expect(view.lastFrame()).toContain('Working · Responding');
  expect(view.lastFrame()).toContain('Answer'); expect(view.lastFrame()).toContain('Partial');
  expect(view.lastFrame()).not.toContain('**Partial**');
  expect(view.lastFrame()!.split('\n').findLast(line => line.includes('Jev'))!.trimEnd()).toEndWith('Jev 0✓ 1…');
  state.entries[1]!.text += ' response\n\n- First\n- Second'; session.emit('update'); await flush();
  expect(view.lastFrame()).toContain('Partial response'); expect(view.lastFrame()).toContain('• Second');
  state.phase = 'Running read_file'; session.emit('update');
  view.stdin.write('\x0f'); await flush();
  expect(view.lastFrame()).toContain('Usage'); expect(view.lastFrame()).toContain('Working · Running read_file');
  state.active = false; session.emit('update'); await flush();
  expect(view.lastFrame()).not.toContain('Working');
  state.jev = { state: 'enabled', completed: 1, pending: 0, errors: 0, skipped: 0, risks: { unsupported: 0.02, omitted: 0.01, inflated: 0 } };
  session.emit('update'); await flush();
  expect(view.lastFrame()!.split('\n').findLast(line => line.includes('Jev'))!.trimEnd()).toEndWith('Jev 1✓ · U2% O1% P0%');
});
test('workspace adapts to narrow terminals and handles live resizing', async () => {
  const session = new DemoSession();
  const view = render(<Workspace session={session} />); await flush();
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 44 });
  Object.defineProperty(view.stdout, 'rows', { configurable: true, value: 18 });
  view.stdout.emit('resize'); await flush();
  expect(view.lastFrame()).toContain('Victral');
  expect(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= 44)).toBe(true);
  const footer = view.lastFrame()!.split('\n').findLast(line => line.includes('Jev'))!.trimEnd();
  expect(footer).toEndWith('Jev 12✓ 1… · U2% O1% P0%');
  expect(stringWidth(footer)).toBe(43);
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 30 });
  view.stdout.emit('resize'); await flush(); expect(view.lastFrame()).toContain('resize terminal');
  await session.close();
});
