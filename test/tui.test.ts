import { test, expect, afterEach } from 'bun:test';
import { render, cleanup } from './terminal-harness.js';
import { DemoSession } from '../src/demo.js';
import { safeText, shortProject, wrapLines } from '../src/tui.js';
import stringWidth from 'string-width';
import { EventEmitter } from 'node:events';
import type { SessionState } from '../src/session.js';
import type { WorkspaceSession } from '../src/tui.js';
import { copyMarkdown } from '../src/clipboard.js';

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 60));
test('status bar filters commands and Tab completes command, provider, and model in stages', async () => {
  const submitted: string[] = [];
  const session: WorkspaceSession & EventEmitter = Object.assign(new EventEmitter(), {
    options: { project: '/tmp/completion', allowShell: false }, metrics: { detailed: () => 'Usage' },
    snapshot: () => ({ entries: [], model: 'muse-spark-1.3', active: false, phase: 'Ready', metrics: '', jev: { state: 'disabled', completed: 0, pending: 0, errors: 0, skipped: 0 } }),
    submit: async (input: string) => { submitted.push(input); }, cancel: () => {}, close: async () => {},
  });
  const view = render(session); await flush();
  const footer = () => view.lastFrame()!.split('\n').at(-1)!;
  view.stdin.write('/m'); await flush();
  expect(footer()).toContain('/metrics'); expect(footer()).toContain('/model');
  expect(footer()).not.toContain('Jev');
  view.stdin.write('o'); await flush();
  expect(footer()).toContain('[/model]'); expect(footer()).not.toContain('/metrics');
  view.stdin.write('\t'); await flush();
  expect(footer()).toContain('[meta] | openai');
  view.stdin.write('o'); await flush();
  expect(footer()).toContain('[openai]'); expect(footer()).not.toContain('meta');
  view.stdin.write('\t'); await flush();
  expect(footer()).toContain('[luna6] | sol6.1');
  view.stdin.write('s'); await flush();
  expect(footer()).toContain('[sol6.1]'); expect(footer()).not.toContain('luna6');
  view.stdin.write('\t'); await flush();
  expect(footer()).toContain('ms1.3'); expect(footer()).toContain('Jev');
  expect(submitted).toEqual([]);
  view.stdin.write('\r'); await flush();
  expect(submitted).toEqual(['/model openai sol6.1 ']);
  view.stdin.write('/m'); await flush(); view.stdin.write('\x1b[B'); await flush();
  expect(footer()).toContain('/metrics | [/model]');
  view.stdin.write('\t'); await flush();
  expect(footer()).toContain('[meta] | openai');
  view.stdin.write('\x1b[Z'); await flush();
  expect(footer()).toContain('meta | [openai]');
  view.stdin.write('\t'); await flush();
  expect(footer()).toContain('[luna6] | sol6.1');
  view.stdin.write('\x1b[B'); await flush(); view.stdin.write('\t'); await flush();
  view.stdin.write('\r'); await flush();
  expect(submitted).toEqual(['/model openai sol6.1 ', '/model openai sol6.1 ']);
});

test('terminal output removes control sequences and wraps Unicode by display width', () => {
  expect(safeText('\x1b[31mhello\x1b[0m\x1b]52;c;hidden\x07')).toBe('hello');
  expect(wrapLines('abcd🦓文e', 5).every(line => stringWidth(line) <= 5)).toBe(true);
});
test('workspace renders Codex layout, opens command menu and metrics, and submits input', async () => {
  const empty = {
    options: { project: '/tmp/victral-empty', allowShell: false },
    metrics: { detailed: () => 'empty' },
    snapshot: () => ({ entries: [], model: 'muse-spark-1.3', active: false, phase: 'Ready', metrics: '' }),
    submit: async () => {}, cancel: () => {}, close: async () => {},
    on: () => {}, off: () => {},
  } as unknown as DemoSession;
  const emptyView = render(empty); await flush();
  expect(emptyView.lastFrame()).toContain('Victral'); expect(emptyView.lastFrame()).toContain('(v0.2.0)');
  expect(emptyView.lastFrame()).toContain('A half-formed idea will do.');
  expect(emptyView.lastFrame()).toContain('ms1.3 · /tmp/victral-empty');
  emptyView.unmount();
  const session = new DemoSession();
  const view = render(session); await flush();
  expect(view.lastFrame()).toContain('Victral'); expect(view.lastFrame()).toContain('(v0.2.0)');
  expect(view.lastFrame()).toContain('ms1.3c ·');
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
test('clicking response controls copies the original Markdown and respects scrolling and hit boundaries', async () => {
  const markdown = '# Hello 🦓\n\n**bold** and [link](https://example.com)\n\n```ts\nconst value = 1;\n```';
  const state: SessionState = {
    entries: [{ id: 1, role: 'victral', text: markdown }, { id: 2, role: 'victral', text: Array.from({ length: 50 }, (_, i) => `Later line ${i}`).join('  \n') }],
    model: 'muse-spark-1.3', active: false, phase: 'Ready', metrics: '',
  };
  const session: WorkspaceSession & EventEmitter = Object.assign(new EventEmitter(), {
    options: { project: '/tmp/copy', allowShell: false }, metrics: { detailed: () => 'Usage' },
    snapshot: () => ({ ...state, entries: [...state.entries] }), submit: async () => {}, cancel: () => {}, close: async () => {},
  });
  const view = render(session); await flush();
  const copyRow = () => view.lastFrame()!.split('\n').findIndex(line => line.includes('[Copy Markdown]')) + 1;
  view.stdin.write('draft'); await flush();
  let y = copyRow();
  expect(y).toBeGreaterThan(2);
  for (const click of [`\x1b[<0;1;${y}M`, `\x1b[<0;25;${y}M`, `\x1b[<0;2;${y}m`, `\x1b[<2;2;${y}M`]) {
    view.stdin.write(click); await flush();
  }
  expect(view.copied).toEqual([]);
  view.stdin.write(`\x1b[<0;2;${y}M`); await flush();
  expect(view.copied).toEqual([state.entries[1]!.text]);
  expect(view.lastFrame()).toContain('[Copied]');
  expect(view.lastFrame()).toContain('draft');
  state.entries[1]!.text += '  \nMore streamed text'; session.emit('update'); await flush();
  expect(view.lastFrame()).toContain('[Copy Markdown]');
  view.stdin.write('\x1b[H'); await flush();
  expect(view.lastFrame()).toContain('Hello 🦓');
  y = copyRow();
  view.stdin.write(`\x1b[<0;3;${y}M`); await flush();
  expect(view.copied).toEqual([expect.any(String), markdown]);
  expect(view.lastFrame()).toContain('[Copied]');
  view.stdin.write('\x0f'); await flush();
  view.stdin.write(`\x1b[<0;3;${y}M`); await flush();
  expect(view.copied).toHaveLength(2);
});
test('terminal clipboard fallback encodes original Unicode Markdown in OSC 52', async () => {
  const writes: string[] = [];
  const text = '**🦓**\n```ts\nconst x = 1;\n```';
  const result = await copyMarkdown(text, { write: (value: string | Uint8Array) => { writes.push(String(value)); return true; } }, 'linux');
  expect(result).toBe('sent');
  expect(writes).toEqual([`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`]);
});
test('clipboard errors remain in the response control and allow retry', async () => {
  const session = new DemoSession();
  let attempts = 0;
  const view = render(session, async () => {
    if (++attempts === 1) throw new Error('clipboard unavailable');
    return 'sent';
  });
  await flush();
  const y = view.lastFrame()!.split('\n').findIndex(line => line.includes('[Copy Markdown]')) + 1;
  view.stdin.write(`\x1b[<0;2;${y}M`); await flush();
  expect(view.lastFrame()).toContain('[Copy failed · retry]');
  view.stdin.write(`\x1b[<0;2;${y}M`); await flush();
  expect(view.lastFrame()).toContain('[Copy sent]');
  expect(attempts).toBe(2);
  await session.close();
});
test('thread scrolls by wheel and keyboard, holds its place during streaming, and follows again at the bottom', async () => {
  const state: SessionState = {
    entries: [{ id: 0, role: 'victral', text: Array.from({ length: 60 }, (_, i) => `Thread line ${i.toString().padStart(2, '0')}`).join('  \n') }],
    model: 'muse-spark-1.3', active: false, phase: 'Ready', metrics: '',
  };
  const session: WorkspaceSession & EventEmitter = Object.assign(new EventEmitter(), {
    options: { project: '/tmp/scroll', allowShell: false }, metrics: { detailed: () => 'Usage' },
    snapshot: () => ({ ...state, entries: [...state.entries] }), submit: async () => {}, cancel: () => {}, close: async () => {},
  });
  const view = render(session); await flush();
  const firstLine = () => /Thread line \d+/.exec(view.lastFrame()!)?.[0];
  expect(view.frames.join('')).toContain('\x1b[?1000h\x1b[?1006h');
  expect(view.lastFrame()).toContain('Thread line 59');
  expect(view.lastFrame()).not.toContain('Thread line 00');
  expect(view.lastFrame()!.split('\n')).toHaveLength(view.stdout.rows);
  view.stdin.write('draft'); await flush();
  view.stdin.write('\x1b[<64;12;8M\x1b[<64;12;8M'); await flush();
  expect(view.lastFrame()).toContain('↑ 6 lines');
  expect(view.lastFrame()).toContain('draft');
  const anchor = firstLine();
  state.entries[0]!.text += '  \nThread line 60  \nThread line 61';
  state.active = true; session.emit('update'); await flush();
  expect(firstLine()).toBe(anchor);
  expect(view.lastFrame()).toContain('Working');
  expect(view.lastFrame()).not.toContain('Thread line 61');
  view.stdin.write('\x1b[5~'); await flush();
  expect(firstLine()).not.toBe(anchor);
  view.stdin.write('\x1b[6~'); await flush();
  expect(firstLine()).toBe(anchor);
  view.stdin.write('\x1b[H'); await flush();
  expect(firstLine()).toBe('Thread line 00');
  view.stdin.write('\x1b[1;2B'); await flush();
  expect(firstLine()).toBe('Thread line 03');
  view.stdin.write('\x1b[<65;12;8M'); await flush();
  expect(firstLine()).toBe('Thread line 06');
  view.stdin.write('\x1b[F'); await flush();
  expect(view.lastFrame()).toContain('Thread line 61');
  state.entries[0]!.text += '  \nThread line 62'; session.emit('update'); await flush();
  expect(view.lastFrame()).toContain('Thread line 62');
  view.stdin.write('\x1b[H'); await flush();
  Object.defineProperty(view.stdout, 'rows', { configurable: true, value: 18 });
  view.stdout.emit('resize'); await flush();
  expect(firstLine()).toBe('Thread line 00');
  expect(view.lastFrame()).toContain('draft');
  view.unmount(); await view.waitUntilExit();
  expect(view.frames.join('')).toContain('\x1b[?1006l\x1b[?1000l');
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
  const view = render(session); await flush();
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
  state.model = 'muse-spark-1.3'; session.emit('update'); await flush();
  expect(view.lastFrame()).toContain('ms1.3 · /tmp/markdown');
  state.jev = { state: 'enabled', completed: 1, pending: 0, errors: 0, skipped: 0, risks: { unsupported: 0.02, omitted: 0.01, inflated: 0 } };
  session.emit('update'); await flush();
  expect(view.lastFrame()!.split('\n').findLast(line => line.includes('Jev'))!.trimEnd()).toEndWith('Jev 1✓ · U2% O1% P0%');
});
test('workspace adapts to narrow terminals and handles live resizing', async () => {
  const session = new DemoSession();
  const view = render(session); await flush();
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 44 });
  Object.defineProperty(view.stdout, 'rows', { configurable: true, value: 18 });
  view.stdout.emit('resize'); await flush();
  expect(view.lastFrame()).toContain('Victral');
  expect(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= 44)).toBe(true);
  const footer = view.lastFrame()!.split('\n').findLast(line => line.includes('Jev'))!.trimEnd();
  expect(footer).toEndWith('Jev 12✓ 1… · U2% O1% P0%');
  expect(footer).toContain('ms1.3c');
  expect(stringWidth(footer)).toBe(43);
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 30 });
  view.stdout.emit('resize'); await flush(); expect(view.lastFrame()).toContain('resize terminal');
  await session.close();
});

test('terminal replies stay out of the composer while editing, pasting, and keypad Enter work', async () => {
  const session = new DemoSession();
  const view = render(session); await flush();
  view.stdin.write('hello'); await flush();
  for (const reply of ['\x1b[<0;12;8M', '\x1b[I', '\x1b[O', '\x1b[12;30R', '\x1b[?1;2c']) {
    view.stdin.write(reply); await flush();
  }
  view.stdin.write('\x1b[D'); await flush();
  view.stdin.write('!'); await flush();
  view.stdin.write('\x1b[200~ 文🦓\nnext\x1b[201~'); await flush();
  view.stdin.write('\x1bOM'); await flush();
  expect(session.snapshot().entries.at(-1)?.text).toBe('hell! 文🦓\nnexto');
  await session.close();
});

test('unmount releases subscriptions and raw input, and remount owns fresh state', async () => {
  const session = new DemoSession();
  const view = render(session); await flush();
  expect(session.listenerCount('update')).toBe(1);
  expect(session.listenerCount('closed')).toBe(1);
  expect(view.stdin.rawMode).toBe(true);
  view.stdin.write('draft'); await flush();
  view.unmount();
  await view.waitUntilExit();
  expect(session.listenerCount('update')).toBe(0);
  expect(session.listenerCount('closed')).toBe(0);
  expect(view.stdin.rawMode).toBe(false);
  const remount = render(session); await flush();
  expect(remount.lastFrame()).not.toContain('draft');
  expect(session.listenerCount('update')).toBe(1);
  await session.close(); await flush();
  expect(session.listenerCount('update')).toBe(0);
  expect(session.listenerCount('closed')).toBe(0);
});
