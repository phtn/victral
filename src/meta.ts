import * as Effect from 'effect/Effect';
import { consumeSse } from './sse.js';
import { META_MODEL } from './constants.js';
import { citationFooter } from './web-citations.js';
import { ProviderAdapter, providerOutcome, type ProviderService } from './providers/core.js';
import type { NativeBlock, ProviderOptions, ProviderResult, RequestOptions } from './providers/types.js';
import type { Message, ToolDefinition } from './types.js';
import * as Wire from './providers/wire.js';

const finishReason = (reason?: string | null) => reason === 'tool_use' ? 'TOOL_CALL' : reason === 'max_tokens' ? 'MAX_TOKENS' : reason === 'end_turn' ? 'COMPLETE' : reason?.toUpperCase();

export function metaRequest(messages: Message[], tools: ToolDefinition[] | undefined, model: string, maxTokens = 16_384, purpose = 'agent') {
  const system = messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : m.content.map(b => b.text).join('\n')).join('\n\n');
  const turns: { role: string; content: NativeBlock[] }[] = [];
  for (const message of messages.filter(m => m.role !== 'system')) {
    let role = message.role, content: NativeBlock[];
    if (role === 'tool') {
      role = 'user';
      content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
    } else if (message._metaContent) content = structuredClone(message._metaContent);
    else {
      content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : structuredClone(message.content ?? []);
      for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    }
    // Tool results returned together must share one user turn.
    if (turns.at(-1)?.role === role) turns.at(-1)!.content.push(...content);
    else turns.push({ role, content });
  }
  return { model, max_tokens: maxTokens, system, messages: turns, thinking: { type: 'adaptive' },
    ...(purpose === 'compactor' ? { output_config: { effort: 'medium' } } : {}),
    ...(tools?.length ? { tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}),
  };
}
function normalize(content: NativeBlock[], reason?: string | null, usage?: Record<string, unknown>): ProviderResult {
  for (const block of content) Wire.metaBlock(block);
  const visible = content.filter(b => b.type !== 'tool_use');
  const message: Message = { role: 'assistant', content: visible, _metaContent: content };
  const citations = citationFooter(content);
  if (citations) message.content = [...visible, { type: 'text', text: citations }];
  const calls = content.filter(b => b.type === 'tool_use').map(block => {
    const tool = Wire.checkedWire(Wire.MetaTool, block);
    return { id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } };
  });
  if (calls.length) message.tool_calls = calls;
  return { message, finish_reason: finishReason(reason), usage };
}
export class Meta extends ProviderAdapter {
  constructor(options: ProviderOptions = {}) {
    const apiKey = options.apiKey ?? (process.env.META_API_KEY || process.env.MODEL_API_KEY);
    if (!apiKey) throw new Error('Set META_API_KEY (or MODEL_API_KEY) in your environment before selecting Meta.');
    super('Meta', apiKey, options, META_MODEL);
  }
  private requestBody(messages: Message[], options: RequestOptions, stream: boolean) {
    const body = metaRequest(messages, options.tools, this.model, options.maxTokens, this.purpose);
    const tools = this.webSearch && this.purpose !== 'compactor' ? [...(body.tools ?? []), { type: 'web_search' }] : body.tools;
    // Preserve absent tools vs explicitly present arrays and JSON property order.
    return { ...body, ...(tools ? { tools } : {}), stream };
  }
  protected readonly rawEffects: ProviderService = {
    model: this.model,
    chat: Effect.fn('Meta.chat')((messages, options = {}) => Effect.suspend(() => this.response('https://api.meta.ai/v1/messages',
      this.requestBody(messages, options, false), { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      response => Effect.gen({ self: this }, function*() {
        const raw = yield* this.json(response);
        const result = yield* this.parse(() => {
          const parsed = Wire.checkedWire(Wire.MetaResponse, raw);
          return normalize([...parsed.content], parsed.stop_reason, parsed.usage);
        });
        return yield* providerOutcome('Meta', result);
      })))),
    stream: Effect.fn('Meta.stream')((messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) =>
      Effect.suspend(() => this.response('https://api.meta.ai/v1/messages', this.requestBody(messages, options, true),
        { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        response => Effect.gen({ self: this }, function*() {
          const content = new Map<number, NativeBlock>(), argumentsByIndex = new Map<number, string>();
          let ended = false, reason: string | null | undefined, usage: Record<string, unknown> = {};
          yield* consumeSse(response, payload => Effect.gen({ self: this }, function*() {
            if (!payload.trim() || payload.trim() === '[DONE]') return true;
            const e = yield* this.parse(() => Wire.checkedWire(Wire.Native, JSON.parse(payload)));
            if (e.type === 'message_start') {
              const start = yield* this.parse(() => Wire.checkedWire(Wire.MetaStart, e)); usage = { ...start.message.usage };
            }
            if (e.type === 'content_block_start') {
              const start = yield* this.parse(() => Wire.checkedWire(Wire.MetaBlockStart, e));
              const block = yield* this.parse(() => Wire.metaBlock(start.content_block));
              content.set(start.index, structuredClone(block));
              if (['tool_use', 'server_tool_use'].includes(block.type)) argumentsByIndex.set(start.index, '');
            }
            if (e.type === 'content_block_delta') {
              const delta = yield* this.parse(() => Wire.checkedWire(Wire.MetaBlockDelta, e));
              const block = content.get(delta.index);
              if (!block) return yield* Effect.fail(this.failure('malformed', 'Meta delta arrived without a content block.'));
              yield* this.parse(() => {
                if (delta.delta.type === 'text_delta') {
                  block.text = Wire.checkedWire(Wire.MetaText, block).text + Wire.checkedWire(Wire.TextDelta, delta.delta).text;
                }
                if (delta.delta.type === 'thinking_delta') {
                  block.thinking = Wire.checkedWire(Wire.MetaThinking, block).thinking + Wire.checkedWire(Wire.ThinkingDelta, delta.delta).thinking;
                }
                if (delta.delta.type === 'citations_delta') {
                  const { citation } = Wire.checkedWire(Wire.CitationDelta, delta.delta);
                  if (citation) {
                    const existing = Wire.checkedWire(Wire.CitationState, block).citations ?? [];
                    block.citations = [...existing, citation];
                  }
                }
                if (delta.delta.type === 'signature_delta') {
                  const current = Wire.checkedWire(Wire.SignatureState, block).signature ?? '';
                  block.signature = current + Wire.checkedWire(Wire.SignatureDelta, delta.delta).signature;
                }
                if (delta.delta.type === 'input_json_delta') argumentsByIndex.set(delta.index,
                  (argumentsByIndex.get(delta.index) ?? '') + Wire.checkedWire(Wire.InputDelta, delta.delta).partial_json);
              });
              if (delta.delta.type === 'text_delta') yield* this.textCallback(() => onText(Wire.checkedWire(Wire.TextDelta, delta.delta).text));
              if (delta.delta.type === 'thinking_delta') yield* this.textCallback(() => onThought(Wire.checkedWire(Wire.ThinkingDelta, delta.delta).thinking));
            }
            if (e.type === 'content_block_stop') {
              const { index } = yield* this.parse(() => Wire.checkedWire(Wire.BlockIndex, e)), block = content.get(index);
              if (block && ['tool_use', 'server_tool_use'].includes(block.type)) {
                const args = argumentsByIndex.get(index);
                if (args) block.input = yield* this.parse(() => Wire.checkedWire(Wire.JsonObject, JSON.parse(args)));
                const tool = yield* this.parse(() => Wire.checkedWire(Wire.MetaTool, block));
                yield* this.callback(() => onEntry('tool', `${tool.name} ${JSON.stringify(tool.input)}`));
              }
              if (block?.type === 'text') {
                const text = yield* this.parse(() => Wire.checkedWire(Wire.MetaText, block).text);
                if (text) yield* this.callback(() => onEntry('talk', text));
              }
            }
            if (e.type === 'message_delta') {
              const delta = yield* this.parse(() => Wire.checkedWire(Wire.MetaMessageDelta, e)); reason = delta.delta.stop_reason; usage = { ...usage, ...delta.usage };
            }
            if (e.type === 'error') {
              const error = yield* this.parse(() => Wire.checkedWire(Wire.MetaError, e));
              return yield* Effect.fail(this.failure('provider', `Meta stream: ${error.error?.message ?? 'unknown error'}`));
            }
            if (e.type === 'message_stop') ended = true;
            return !ended;
          }));
          if (!ended) return yield* Effect.fail(this.failure('truncated', 'Meta stream ended before message_stop.'));
          const result = yield* this.parse(() => normalize([...content.values()], reason, usage));
          const citations = citationFooter([...content.values()]);
          if (citations) { yield* this.textCallback(() => onText(citations)); yield* this.callback(() => onEntry('talk', citations)); }
          return yield* providerOutcome('Meta', result);
        })))),
  };
}
