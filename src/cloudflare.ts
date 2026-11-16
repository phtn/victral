import * as Effect from 'effect/Effect';
import { ProviderAdapter, providerOutcome, type ProviderService } from './providers/core.js';
import type { ProviderOptions, ProviderResult, RequestOptions } from './providers/types.js';
import * as Wire from './providers/wire.js';
import { consumeSse } from './sse.js';
import type { ContentBlock, Message, ToolDefinition } from './types.js';

const DEFAULT_MODEL = '@cf/zai-org/glm-4.7-flash';
const textContent = (content: string | ContentBlock[]) =>
  typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n');
const toolArguments = (value: unknown) => typeof value === 'string' ? value : (JSON.stringify(value ?? {}) ?? '{}');
const normalizedUsage = (usage: Record<string, unknown> = {}) => ({
  ...usage,
  ...(typeof (usage.prompt_tokens ?? usage.input_tokens) === 'number' ? { input_tokens: usage.prompt_tokens ?? usage.input_tokens } : {}),
  ...(typeof (usage.completion_tokens ?? usage.output_tokens) === 'number' ? { output_tokens: usage.completion_tokens ?? usage.output_tokens } : {}),
});
const requestToolArguments = (value: unknown) => {
  const encoded = toolArguments(value);
  try {
    const parsed = JSON.parse(encoded);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? encoded : '{}';
  }
  catch { return '{}'; }
};

export function cloudflareRequest(messages: Message[], tools: ToolDefinition[] | undefined, model: string, maxTokens = 2_048) {
  const turns = messages.map(message => {
    const text = textContent(message.content);
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: text };
    const calls = message.tool_calls?.map(call => ({ id: call.id, type: 'function',
      function: { name: call.function.name, arguments: requestToolArguments(call.function.arguments) } }));
    return { role: message.role, ...(!(message.role === 'assistant' && calls?.length && !text) ? { content: text } : {}),
      ...(calls?.length ? { tool_calls: calls } : {}) };
  });
  return { model, messages: turns, max_tokens: maxTokens,
    ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: tool.function })), tool_choice: 'auto' } : {}) };
}

// Workers AI cannot serve a tool turn with the Llama family. It ignores
// tool_choice (even "none" returns a call), parses tool calls on the
// non-streaming endpoint only, and the model answers with a call on every turn,
// inventing names outside the supplied list. Refuse instead of guessing.
const choosesTools = (model: string) => !/^@cf\/meta\/llama/i.test(model);
const TOOL_REFUSAL = 'cannot choose tools on Workers AI: tool_choice is ignored and tool calls are not streamed. '
  + 'Use cf-glm47 (@cf/zai-org/glm-4.7-flash) for tool-enabled turns.';

const normalizedFinishReason = (reason?: string | null) =>
  reason === 'stop' ? 'COMPLETE' : reason === 'tool_calls' ? 'TOOL_CALL' : reason === 'length' ? 'MAX_TOKENS' : reason?.toUpperCase();

export class Cloudflare extends ProviderAdapter {
  private readonly endpoint: string;
  constructor(options: ProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.CLOUDFLARE_API_TOKEN;
    const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!apiKey) throw new Error('Set CLOUDFLARE_API_TOKEN in your environment before selecting Cloudflare.');
    if (!accountId) throw new Error('Set CLOUDFLARE_ACCOUNT_ID in your environment before selecting Cloudflare.');
    if (options.webSearch && options.purpose !== 'compactor') {
      throw new Error('Cloudflare Workers AI does not provide provider-hosted web search; disable --web-search to use Cloudflare.');
    }
    super('Cloudflare', apiKey, options, DEFAULT_MODEL);
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
  }
  private requestBody(messages: Message[], options: RequestOptions, stream: boolean) {
    const maxTokens = this.purpose === 'compactor' ? Math.min(options.maxTokens ?? 2_048, 8_192) : options.maxTokens ?? 2_048;
    return { ...cloudflareRequest(messages, options.tools, this.model, maxTokens), stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}) };
  }
  private normalize(input: unknown): ProviderResult {
    const raw = Wire.checkedWire(Wire.ChatResponse, input);
    if (raw.error) throw this.failure('provider', `Cloudflare response: ${raw.error.message ?? 'failed'}`);
    const choice = raw.choices?.[0];
    const native = choice?.message;
    if (!native) throw this.failure('malformed', 'Cloudflare response did not contain a chat completion.');
    const calls = (native.tool_calls ?? []).map(call => {
      if (!call.id || !call.function?.name) throw this.failure('malformed', 'Cloudflare returned an incomplete tool call.');
      return { id: call.id, type: 'function', function: { name: call.function.name, arguments: toolArguments(call.function.arguments) } };
    });
    const text = native.content ?? native.refusal ?? '';
    return { message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [], ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: normalizedFinishReason(choice.finish_reason), usage: normalizedUsage(raw.usage) };
  }
  private get headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'cf-aig-gateway-id': 'default', 'Content-Type': 'application/json' };
  }
  private chatResult(messages: Message[], options: RequestOptions) {
    return this.response(this.endpoint, this.requestBody(messages, options, false), this.headers,
      response => Effect.gen({ self: this }, function*() {
        const raw = yield* this.json(response);
        return yield* this.parse(() => this.normalize(raw));
      }));
  }
  private toolRefusal(options: RequestOptions) {
    return options.tools?.length && !choosesTools(this.model)
      ? Effect.fail(this.failure('provider', `${this.model} ${TOOL_REFUSAL}`)) : undefined;
  }
  protected readonly rawEffects: ProviderService = {
    model: this.model,
    chat: Effect.fn('Cloudflare.chat')((messages, options = {}) => Effect.suspend(() => this.toolRefusal(options)
      ?? Effect.flatMap(this.chatResult(messages, options), result => providerOutcome('Cloudflare', result)))),
    stream: Effect.fn('Cloudflare.stream')((messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) =>
      Effect.suspend(() => this.toolRefusal(options)
        ?? this.response(this.endpoint, this.requestBody(messages, options, true),
        this.headers, response => Effect.gen({ self: this }, function*() {
          const tools = new Map<number, { id?: string; name: string; arguments: string }>();
          let finishReason: string | null | undefined, usage: Record<string, unknown> = {}, ended = false;
          let text = '';
          yield* consumeSse(response, payload => Effect.gen({ self: this }, function*() {
            if (!payload.trim()) return true;
            if (payload.trim() === '[DONE]') { ended = true; return false; }
            const chunk = yield* this.parse(() => Wire.checkedWire(Wire.ChatResponse, JSON.parse(payload)));
            if (chunk.error) return yield* Effect.fail(this.failure('provider', `Cloudflare stream: ${chunk.error.message ?? 'failed'}`));
            if (chunk.usage) usage = normalizedUsage(chunk.usage);
            for (const choice of chunk.choices ?? []) {
              if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
              const delta = choice.delta;
              if (delta?.content) {
                text += delta.content;
                yield* this.textCallback(() => onText(delta.content!));
                yield* this.callback(() => onEntry('talk', delta.content!));
              }
              if (delta?.refusal) {
                text += delta.refusal;
                yield* this.textCallback(() => onText(delta.refusal!));
                yield* this.callback(() => onEntry('talk', delta.refusal!));
              }
              for (const [offset, call] of (delta?.tool_calls ?? []).entries()) {
                const index = call.index ?? offset;
                const current = tools.get(index) ?? { name: '', arguments: '' };
                if (call.id) current.id = call.id;
                if (call.function?.name) current.name += call.function.name;
                if (call.function?.arguments) current.arguments += call.function.arguments;
                tools.set(index, current);
              }
            }
            return true;
          }));
          if (!ended) return yield* Effect.fail(this.failure('truncated', 'Cloudflare stream ended before [DONE].'));
          const toolCalls = yield* this.parse(() => [...tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
            if (!call.id || !call.name) throw this.failure('malformed', 'Cloudflare stream returned an incomplete tool call.');
            return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } };
          }));
          for (const call of toolCalls) yield* this.callback(() => onEntry('tool', `${call.function.name} ${call.function.arguments}`));
          const result: ProviderResult = { message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [],
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: normalizedFinishReason(finishReason) ?? (toolCalls.length ? 'TOOL_CALL' : 'COMPLETE'), usage };
          return yield* providerOutcome('Cloudflare', result);
        })))),
  };
}
