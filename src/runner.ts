import type { MemoryPort, ModelPort, AgentTools, Message, TurnRecord, ToolActivity, MessageKind } from './types.js';
import { errorMessage } from './types.js';
import { viewBlocks } from './view.js';
import { systemPrompt } from './prompt.js';
import { capResult } from './constants.js';
import { smoothResponse } from './smooth-response.js';

interface RunnerOptions {
  maxModelSteps?: number;
  onText?: (text: string) => void; onThought?: (text: string) => void;
  onError?: (text: string) => void; onTurn?: (record: TurnRecord) => void;
  onTool?: (activity: ToolActivity) => void;
  onPhase?: (phase: string) => void;
}
export class Runner {
  system: string;
  queue: { text: string; logged: boolean; kind: MessageKind }[];
  maxModelSteps: number;
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
  onPhase: (phase: string) => void;
  constructor(public memory: MemoryPort, public model: ModelPort, public tools: AgentTools, instructions = '', { onText = () => {}, onThought = () => {}, onError = console.error, onTurn = () => {}, onTool = () => {}, onPhase = () => {}, maxModelSteps = Infinity }: RunnerOptions = {}) {
    this.maxModelSteps = maxModelSteps;
    this.onText = onText; this.onThought = onThought; this.onError = onError; this.onTurn = onTurn; this.onTool = onTool;
    this.onPhase = onPhase;
    this.system = systemPrompt(instructions);
    memory.configure?.(this.system, tools.definitions);
    this.queue = [];
    this.active = false;
    this.inCall = false;
    this.controller = null;
    this.closed = false;
  }
  submit(text: string, kind: MessageKind = 'user') {
    const entry = { text, logged: false, kind };
    if (this.inCall) { this.memory.append(kind, text); entry.logged = true; }
    this.queue.push(entry);
    if (!this.active) this.running = this.run();
    return this.running;
  }
  cancel() { this.controller?.abort(); }
  take() {
    const entries = this.queue.splice(0);
    for (const entry of entries) if (!entry.logged) { this.memory.append(entry.kind, entry.text); entry.logged = true; }
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
          // Retain input on cancellation or a compaction failure, unanswered.
          this.take();
          if (!signal.aborted) this.onError('Memory compaction failed. Send another message to retry.');
          this.onTurn({ status: signal.aborted ? 'canceled' : 'error', duration_ms: performance.now() - started, settle_ms: performance.now() - started, tool_calls: 0, retrievals: 0 });
          break;
        }
        const settled = performance.now();
        const view = this.memory.render(); // Always before new input is logged.
        const entries = this.take();
        const context = this.tools.context?.();
        const messages: Message[] = [
          { role: 'system', content: this.system },
          { role: 'user', content: [...viewBlocks(view), ...(context ? [{ type: 'text', text: context }] : []), { type: 'text', text: entries.map(e => e.text).join('\n\n') }] },
        ];
        this.inCall = true;
        try {
          let modelSteps = 0;
          for (;;) {
            if (modelSteps++ >= this.maxModelSteps) throw new Error(`Model step limit (${this.maxModelSteps}) reached; task is incomplete.`);
            this.onPhase('Waiting for response');
            const result = await smoothResponse(this.model, messages, {
              tools: this.tools.definitions, signal, onText: this.onText, onThought: this.onThought,
              onEntry: (kind, text) => this.memory.append(kind, text),
            });
            messages.push(result.message); // Keep provider content intact within the turn.
            if (result.finish_reason === 'MAX_TOKENS') throw new Error('Model output limit reached; response is incomplete.');
            if (result.finish_reason !== 'COMPLETE' && result.finish_reason !== 'TOOL_CALL') {
              throw new Error(`Model response did not complete: ${result.finish_reason ?? 'missing finish reason'}.`);
            }
            const calls = result.message.tool_calls ?? [];
            if (result.finish_reason === 'TOOL_CALL' && !calls.length) throw new Error('Model requested a tool step without tool calls.');
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
                output = await this.tools.execute(call.function.name, args as Record<string, unknown>, signal, name => {
                  toolCalls++; if (name === 'zoom') retrievals++;
                });
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
            // Inject input queued during the HTTP request at this tool boundary.
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
    try { await this.running; }
    finally { this.take(); await this.tools.close?.(); }
  }
}
