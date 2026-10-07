import type { MemoryPort, ModelPort, AgentTools, Message, TurnRecord, ToolActivity } from './types.js';
import { errorMessage } from './types.js';
import fs from 'node:fs';
import { viewBlocks } from './cohere.js';
import { capResult } from './constants.js';

const MASTER = fs.readFileSync(new URL('./MASTER.txt', import.meta.url), 'utf8').trimEnd();
const VIEW_DOC = fs.readFileSync(new URL('./VIEW_DOC.txt', import.meta.url), 'utf8').trimEnd();
interface RunnerOptions {
  onText?: (text: string) => void; onThought?: (text: string) => void;
  onError?: (text: string) => void; onTurn?: (record: TurnRecord) => void;
  onTool?: (activity: ToolActivity) => void;
}
export class Runner {
  system: string;
  queue: { text: string; logged: boolean }[];
  active: boolean;
  inCall: boolean;
  controller: AbortController | null;
  closed: boolean;
  running?: Promise<void>;
  onText: (text: string) => void;
  onThought: (text: string) => void;
  onError: (text: string) => void;
  onTurn: (record: TurnRecord) => void;
  onTool: (activity: ToolActivity) => void;
  constructor(public memory: MemoryPort, public model: ModelPort, public tools: AgentTools, instructions = '', { onText = () => {}, onThought = () => {}, onError = console.error, onTurn = () => {}, onTool = () => {} }: RunnerOptions = {}) {
    this.onText = onText; this.onThought = onThought; this.onError = onError; this.onTurn = onTurn; this.onTool = onTool;
    this.system = [MASTER, VIEW_DOC, instructions].filter(Boolean).join('\n\n');
    this.queue = [];
    this.active = false;
    this.inCall = false;
    this.controller = null;
    this.closed = false;
  }
  submit(text: string) {
    const entry = { text, logged: false };
    if (this.inCall) { this.memory.append('user', text); entry.logged = true; }
    this.queue.push(entry);
    if (!this.active) this.running = this.run();
    return this.running;
  }
  cancel() { this.controller?.abort(); }
  take() {
    const entries = this.queue.splice(0);
    for (const entry of entries) if (!entry.logged) { this.memory.append('user', entry.text); entry.logged = true; }
    return entries;
  }
  async run() {
    this.active = true;
    try {
      while (this.queue.length && !this.closed) {
        const started = performance.now();
        let status: TurnRecord['status'] = 'completed'; let toolCalls = 0, retrievals = 0;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        if (!await this.memory.settle(signal)) {
          // Cancellation while waiting: retain the user's message in the log, unanswered.
          this.take();
          this.onTurn({ status: 'canceled', duration_ms: performance.now() - started, settle_ms: performance.now() - started, tool_calls: 0, retrievals: 0 });
          break;
        }
        const settled = performance.now();
        const view = this.memory.render(); // Always before new input is logged.
        const entries = this.take();
        const messages: Message[] = [
          { role: 'system', content: this.system },
          { role: 'user', content: [...viewBlocks(view), { type: 'text', text: entries.map(e => e.text).join('\n\n') }] },
        ];
        this.inCall = true;
        try {
          for (;;) {
            const result = await this.model.stream(messages, {
              tools: this.tools.definitions, signal, onText: this.onText, onThought: this.onThought,
              onEntry: (kind, text) => this.memory.append(kind, text),
            });
            messages.push(result.message); // Keep provider content intact within the turn.
            if (result.finish_reason === 'MAX_TOKENS') throw new Error('Model output limit reached; response is incomplete.');
            const calls = result.message.tool_calls ?? [];
            for (const call of calls) {
              toolCalls++;
              if (call.function.name === 'zoom') retrievals++;
              if (signal.aborted) throw signal.reason;
              let output;
              const toolStart = performance.now();
              let toolStatus: ToolActivity['status'] = 'completed';
              this.onTool({ name: call.function.name, status: 'running' });
              try {
                const args: unknown = JSON.parse(call.function.arguments);
                if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
                output = await this.tools.execute(call.function.name, args as Record<string, unknown>, signal);
              } catch (error) {
                toolStatus = 'error';
                if (signal.aborted) throw error;
                output = `Error: ${errorMessage(error)}`;
              } finally {
                this.onTool({ name: call.function.name, status: toolStatus, duration_ms: performance.now() - toolStart });
              }
              output = capResult(String(output));
              this.memory.append('echo', output);
              messages.push({ role: 'tool', tool_call_id: call.id, content: [{ type: 'text', text: output }] });
            }
            // Cohere has no send() for an in-flight HTTP request; inject queued input at this tool boundary.
            if (this.queue.length) {
              const additions = this.take();
              messages.push({ role: 'user', content: additions.map(e => e.text).join('\n\n') });
              continue;
            }
            if (!calls.length) break;
          }
        } catch (error) {
          status = signal.aborted ? 'canceled' : 'error';
          if (signal.aborted) this.onError('Turn canceled. Completed entries remain saved.');
          else this.onError(errorMessage(error));
        } finally {
          this.inCall = false;
          this.onTurn({ status, model: this.model.model, duration_ms: performance.now() - started, settle_ms: settled - started, tool_calls: toolCalls, retrievals });
        }
        if (signal.aborted) { this.take(); break; }
      }
    } finally { this.active = false; this.controller = null; }
  }
  async close() {
    this.closed = true; this.cancel();
    await this.running;
    this.take();
  }
}
