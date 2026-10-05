import fs from 'node:fs';
import { viewBlocks } from './cohere.js';
import { capResult } from './constants.js';

const MASTER = fs.readFileSync(new URL('./MASTER.txt', import.meta.url), 'utf8').trimEnd();
const VIEW_DOC = fs.readFileSync(new URL('./VIEW_DOC.txt', import.meta.url), 'utf8').trimEnd();
export class Runner {
  constructor(memory, model, tools, instructions = '', { onText = () => {}, onThought = () => {}, onError = console.error } = {}) {
    Object.assign(this, { memory, model, tools, onText, onThought, onError });
    this.system = [MASTER, VIEW_DOC, instructions].filter(Boolean).join('\n\n');
    this.queue = [];
    this.active = false;
    this.inCall = false;
    this.controller = null;
    this.closed = false;
  }
  submit(text) {
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
        this.controller = new AbortController();
        const signal = this.controller.signal;
        if (!await this.memory.settle(signal)) {
          // Cancellation while waiting: retain the user's message in the log, unanswered.
          this.take(); break;
        }
        const view = this.memory.render(); // Always before new input is logged.
        const entries = this.take();
        const messages = [
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
              if (signal.aborted) throw signal.reason;
              let output;
              try { output = await this.tools.execute(call.function.name, JSON.parse(call.function.arguments), signal); }
              catch (error) { if (signal.aborted) throw error; output = `Error: ${error.message}`; }
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
          if (signal.aborted) this.onError('Turn canceled. Completed entries remain saved.');
          else this.onError(error.message);
        } finally { this.inCall = false; }
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
