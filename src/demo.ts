import { EventEmitter } from 'node:events';
import { startTui, type WorkspaceSession } from './tui.js';
import type { SessionState } from './session.js';
import { COMMANDS } from './session.js';
import { MODEL } from './constants.js';
import { setTimeout as delay } from 'node:timers/promises';
import { smoothResponse } from './smooth-response.js';

export class DemoSession extends EventEmitter implements WorkspaceSession {
  options = { project: `${process.cwd()} · DEMO / no API calls`, allowShell: true };
  private counter = 4;
  private controller?: AbortController;
  private closed = false;
  private state: SessionState = {
    model: MODEL, active: false, phase: 'Ready · demo',
    metrics: '[metrics] session tokens 2,408 in / 516 out · cached 1,024 · zoom 2',
    jev: { state: 'enabled', completed: 12, pending: 1, errors: 0, skipped: 0, risks: { unsupported: 0.02, omitted: 0.01, inflated: 0 } },
    entries: [
      { id: 0, role: 'you', text: 'Inspect the project and outline the next improvement.' },
      { id: 1, role: 'tool', text: 'list_files · completed · 0.01s' },
      { id: 2, role: 'tool', text: 'git_status · completed · 0.03s' },
      { id: 3, role: 'victral', text: 'The project has durable conversation memory and a provider-neutral agent loop.\n\nA useful next step is to add focused CLI tools for search, precise edits, and test execution, then surface their progress in the terminal workspace.\n\nThis is a local interface preview. No models or tools have been called.' },
    ],
  };
  metrics = { detailed: () => 'DEMO METRICS · illustrative values\n\nSession     2,408 input / 516 output tokens\nCache       1,024 tokens\nMemory      28 messages / 41 nodes\nRetrieval   2 zoom calls\n\nThe real workspace shows measured provider and memory counters.' };
  snapshot(): SessionState { return { ...this.state, entries: [...this.state.entries] }; }
  cancel(): void { this.controller?.abort(); this.state = { ...this.state, active: false, phase: 'Canceled · demo' }; this.emit('update'); }
  async submit(input: string): Promise<void> {
    if (input.trim() === '/exit') { await this.close(); return; }
    if (input.trim() === '/cancel') { this.cancel(); return; }
    if (input.startsWith('/')) {
      const text = input.trim() === '/metrics' ? this.metrics.detailed() : COMMANDS.map(([command, description]) => `${command}  ${description}`).join('\n');
      this.state.entries = [...this.state.entries, { id: this.counter++, role: 'system', text }]; this.emit('update'); return;
    }
    if (this.closed) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    this.state = { ...this.state, active: true, phase: 'Message received · thinking · demo', entries: [...this.state.entries, { id: this.counter++, role: 'you', text: input }] };
    this.emit('update');
    const response = '## Streaming preview\n\nResponses arrive **word by word**, with readable Markdown.\n\n- A receipt confirms your message arrived.\n- The spinner shows the agent is working.\n- Press `Esc` to cancel.\n\n```sh\nbun run start\n```\n\nLaunch without `--demo` to work with the real agent and persistent memory.';
    let entry: SessionState['entries'][number] | undefined;
    try {
      await smoothResponse({ model: this.state.model, async stream(_messages, options) {
        await delay(400, undefined, { signal: options.signal });
        options.onText(response);
        return { message: { role: 'assistant', content: response }, finish_reason: 'COMPLETE' };
      } }, [], {
        tools: [], signal: controller.signal, onThought: () => {}, onEntry: () => {},
        onText: text => {
          if (!entry) { entry = { id: this.counter++, role: 'victral', text: '' }; this.state.entries = [...this.state.entries, entry]; }
          entry.text += text; this.state = { ...this.state, phase: 'Responding · demo', entries: [...this.state.entries] }; this.emit('update');
        },
      });
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally {
      if (this.controller === controller && !this.closed && !controller.signal.aborted) {
        this.state = { ...this.state, active: false, phase: 'Ready · demo' }; this.emit('update');
      }
    }
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.controller?.abort(); this.emit('closed'); }
}
export async function startDemo(): Promise<void> { await startTui(new DemoSession()); }
