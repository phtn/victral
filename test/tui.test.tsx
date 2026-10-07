import React from 'react';
import { test, expect, afterEach } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import { DemoSession } from '../src/demo.js';
import { Workspace, safeText, shortProject, wrapLines } from '../src/tui.js';
import stringWidth from 'string-width';

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
  expect(view.lastFrame()).toContain('command-a-plus-05-2026'); expect(view.lastFrame()).toContain('·');
  view.stdin.write('\x10'); await flush(); expect(view.lastFrame()).toContain('/help'); expect(view.lastFrame()).toContain('COMMANDS');
  view.stdin.write('\x1b'); await flush();
  view.stdin.write('\x0f'); await flush(); expect(view.lastFrame()).toContain('DEMO METRICS'); expect(view.lastFrame()).toContain('METRICS');
  view.stdin.write('\x0f'); await flush();
  view.stdin.write('hello'); await flush(); view.stdin.write('\r'); await flush();
  expect(session.snapshot().entries.at(-1)?.text).toBe('hello'); expect(session.snapshot().active).toBe(true);
  expect(view.lastFrame()).toContain('> hello');
  view.stdin.write('\x1b'); await flush(); expect(session.snapshot().active).toBe(false);
  await session.close();
});
test('project paths shorten with a tilde', () => {
  expect(shortProject('/elsewhere/project')).toBe('/elsewhere/project');
});
test('workspace adapts to narrow terminals and handles live resizing', async () => {
  const session = new DemoSession();
  const view = render(<Workspace session={session} />); await flush();
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 44 });
  Object.defineProperty(view.stdout, 'rows', { configurable: true, value: 18 });
  view.stdout.emit('resize'); await flush();
  expect(view.lastFrame()).toContain('Victral');
  expect(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= 44)).toBe(true);
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 30 });
  view.stdout.emit('resize'); await flush(); expect(view.lastFrame()).toContain('resize terminal');
  await session.close();
});
