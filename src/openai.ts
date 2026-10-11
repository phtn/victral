import * as Effect from 'effect/Effect';
import { consumeSse } from './sse.js';
import { citationFooter } from './web-citations.js';
import { ProviderAdapter, providerOutcome, type ProviderService } from './providers/core.js';
import type { NativeBlock, ProviderOptions, ProviderResult, RequestOptions } from './providers/types.js';
import type { ContentBlock, Message, ToolDefinition } from './types.js';
import * as Wire from './providers/wire.js';

const textContent = (content: string | ContentBlock[]) => typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n');
export function openaiRequest(messages: Message[], tools: ToolDefinition[] | undefined, model: string, maxTokens = 16_384) {
  const input: (NativeBlock | { role: string; content: string })[] = [];
  for (const message of messages) {
    // Native items, encrypted reasoning and phase replay only within this turn.
    if (message._openaiOutput) input.push(...structuredClone(message._openaiOutput));
    else if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textContent(message.content) });
    else {
      const text = textContent(message.content);
      if (text) input.push({ role: message.role, content: text });
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return { model, input, store: false, max_output_tokens: maxTokens, reasoning: { effort: 'medium' },
    ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })) } : {}),
  };
}
export class OpenAI extends ProviderAdapter {
  constructor(options: ProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Set OPENAI_API_KEY in your environment before selecting OpenAI.');
    super('OpenAI', apiKey, options, 'gpt-6-luna');
  }
  private requestBody(messages: Message[], options: RequestOptions, stream: boolean) {
    const body = openaiRequest(messages, options.tools, this.model, options.maxTokens);
    const tools = this.webSearch && this.purpose !== 'compactor' ? [...(body.tools ?? []), { type: 'web_search' }] : body.tools;
    return { ...body, ...(tools ? { tools } : {}), stream };
  }
  private normalize(input: unknown): ProviderResult {
    // Handle an explicit provider failure before requiring successful output.
    const state = Wire.checkedWire(Wire.OpenaiState, input);
    if (state.status === 'failed' || state.error) throw this.failure('provider', `OpenAI response: ${state.error?.message ?? 'failed'}`);
    const raw = Wire.checkedWire(Wire.OpenaiResponse, input);
    const output = raw.output.map(Wire.openaiItem);
    const blocks = output.filter(item => item.type === 'message').flatMap(item => Wire.checkedWire(Wire.OpenaiMessage, item).content ?? []);
    const content: ContentBlock[] = blocks.filter(block => block.type === 'output_text' || block.type === 'refusal').map(block => ({ type: 'text',
      text: block.type === 'output_text' ? Wire.checkedWire(Wire.OpenaiText, block).text ?? '' : Wire.checkedWire(Wire.OpenaiRefusal, block).refusal ?? '',
    }));
    const citations = citationFooter(blocks);
    if (citations) content.push({ type: 'text', text: citations });
    const calls = output.filter(item => item.type === 'function_call').map(item => {
      const tool = Wire.checkedWire(Wire.OpenaiTool, item);
      return { id: tool.call_id, type: 'function', function: { name: tool.name, arguments: tool.arguments } };
    });
    const finish_reason = raw.status === 'completed' ? (calls.length ? 'TOOL_CALL' : 'COMPLETE')
      : raw.status === 'incomplete' && raw.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : raw.status?.toUpperCase();
    return { message: { role: 'assistant', content, _openaiOutput: structuredClone(output), ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason, usage: raw.usage };
  }
  protected readonly rawEffects: ProviderService = {
    model: this.model,
    chat: Effect.fn('OpenAI.chat')((messages, options = {}) => Effect.suspend(() => this.response('https://api.openai.com/v1/responses',
      this.requestBody(messages, options, false), { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      response => Effect.gen({ self: this }, function*() {
        const raw = yield* this.json(response), result = yield* this.parse(() => this.normalize(raw));
        return yield* providerOutcome('OpenAI', result);
      })))),
    stream: Effect.fn('OpenAI.stream')((messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) =>
      Effect.suspend(() => this.response('https://api.openai.com/v1/responses', this.requestBody(messages, options, true),
        { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, response => Effect.gen({ self: this }, function*() {
          const logged = new Set<number>();
          let result: ProviderResult | undefined;
          const logItem = (input: unknown, index: number) => Effect.gen({ self: this }, function*() {
            const item = yield* this.parse(() => Wire.openaiItem(input));
            if (logged.has(index)) return;
            logged.add(index);
            if (item.type === 'function_call') {
              const tool = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiTool, item));
              yield* this.callback(() => onEntry('tool', `${tool.name} ${tool.arguments}`));
            }
            if (item.type === 'web_search_call') {
              const search = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiSearch, item));
              yield* this.callback(() => onEntry('tool', `web_search ${JSON.stringify(search.action ?? {})}`));
            }
            if (item.type === 'message') {
              const message = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiMessage, item));
              for (const block of message.content ?? []) {
                const text = yield* this.parse(() => block.type === 'output_text' ? Wire.checkedWire(Wire.OpenaiText, block).text
                  : block.type === 'refusal' ? Wire.checkedWire(Wire.OpenaiRefusal, block).refusal : '');
                if (text) yield* this.callback(() => onEntry('talk', text));
              }
            }
          });
          yield* consumeSse(response, payload => Effect.gen({ self: this }, function*() {
            if (!payload.trim() || payload.trim() === '[DONE]') return true;
            const e = yield* this.parse(() => Wire.checkedWire(Wire.Native, JSON.parse(payload)));
            if (e.type === 'response.output_text.delta' || e.type === 'response.refusal.delta') {
              const delta = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiDelta, e));
              yield* this.textCallback(() => onText(delta.delta));
            }
            if (e.type === 'response.reasoning_summary_text.delta') {
              const delta = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiDelta, e));
              yield* this.textCallback(() => onThought(delta.delta));
            }
            if (e.type === 'response.output_item.added') {
              const added = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiItemAdded, e));
              if (added.item.type === 'reasoning') yield* this.textCallback(() => onThought(''));
            }
            if (e.type === 'response.output_item.done') {
              const done = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiItemDone, e));
              yield* logItem(done.item, done.output_index);
            }
            if (e.type === 'error' || e.type === 'response.failed') {
              const error = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiError, e));
              return yield* Effect.fail(this.failure('provider', `OpenAI stream: ${error.response?.error?.message ?? error.message ?? 'failed'}`));
            }
            if (e.type === 'response.completed' || e.type === 'response.incomplete') {
              const terminal = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiTerminal, e));
              result = yield* this.parse(() => this.normalize(terminal.response));
              const native = yield* this.parse(() => Wire.checkedWire(Wire.OpenaiResponse, terminal.response));
              for (const [index, item] of native.output.entries()) yield* logItem(item, index);
              const blocks = native.output.filter(item => item.type === 'message').flatMap(item => Wire.checkedWire(Wire.OpenaiMessage, item).content ?? []);
              const citations = citationFooter(blocks);
              if (citations) { yield* this.textCallback(() => onText(citations)); yield* this.callback(() => onEntry('talk', citations)); }
              return false;
            }
            return true;
          }));
          if (!result) return yield* Effect.fail(this.failure('truncated', 'OpenAI stream ended before a terminal response event.'));
          return yield* providerOutcome('OpenAI', result);
        })))),
  };
}
