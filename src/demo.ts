import { EventEmitter } from 'node:events';
import { startTui, type WorkspaceSession } from './tui.js';
import type { SessionState } from './session.js';
import { COMMANDS } from './session.js';

export class DemoSession extends EventEmitter implements WorkspaceSession {
  options = { project: `${process.cwd()} · DEMO / no API calls`, allowShell: true };
  private counter = 4;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private state: SessionState = {
    model: 'command-a-plus-05-2026', active: false, phase: 'Ready · demo',
    metrics: '[metrics] session tokens 2,408 in / 516 out · cached 1,024 · zoom 2',
    entries: [
      { id: 0, role: 'you', text: 'Inspect the project and outline the next improvement.' },
      { id: 1, role: 'tool', text: 'list_files · completed · 0.01s' },
      { id: 2, role: 'tool', text: 'git_status · completed · 0.03s' },
      { id: 3, role: 'victral', text: 'The project has durable conversation memory and a provider-neutral agent loop.\n\nA useful next step is to add focused CLI tools for search, precise edits, and test execution, then surface their progress in the terminal workspace.\n\nThis is a local interface preview. No models or tools have been called.' },
    ],
  };
  metrics = { detailed: () => 'DEMO METRICS · illustrative values\n\nSession     2,408 input / 516 output tokens\nCache       1,024 tokens\nMemory      28 messages / 41 nodes\nRetrieval   2 zoom calls\n\nThe real workspace shows measured provider and memory counters.' };
  snapshot(): SessionState { return { ...this.state, entries: [...this.state.entries] }; }
  cancel(): void { clearTimeout(this.timer); this.state = { ...this.state, active: false, phase: 'Canceled · demo' }; this.emit('update'); }
  async submit(input: string): Promise<void> {
    if (input.trim() === '/exit') { await this.close(); return; }
    if (input.trim() === '/cancel') { this.cancel(); return; }
    if (input.startsWith('/')) {
      const text = input.trim() === '/metrics' ? this.metrics.detailed() : COMMANDS.map(([command, description]) => `${command}  ${description}`).join('\n');
      this.state.entries = [...this.state.entries, { id: this.counter++, role: 'system', text }]; this.emit('update'); return;
    }
    if (this.closed) return;
    clearTimeout(this.timer);
    this.state = { ...this.state, active: true, phase: 'Thinking · demo', entries: [...this.state.entries, { id: this.counter++, role: 'you', text: input }] };
    this.emit('update');
    this.timer = setTimeout(() => {
      this.state = { ...this.state, active: false, phase: 'Ready · demo', entries: [...this.state.entries, { id: this.counter++, role: 'victral', text: 'This preview demonstrates the terminal interface. Launch without --demo to work with the real agent and persistent memory.' }] };
      this.emit('update');
    }, 900);
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; clearTimeout(this.timer); this.emit('closed'); }
}
export async function startDemo(): Promise<void> { await startTui(new DemoSession()); }
