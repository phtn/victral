import * as Effect from 'effect/Effect'
import { ProviderAdapter, providerOutcome, type ProviderService } from './providers/core.js'
import type { ProviderOptions, ProviderResult, RequestOptions } from './providers/types.js'
import * as Wire from './providers/wire.js'
import { consumeSse } from './sse.js'
import type { ContentBlock, Message, ToolDefinition } from './types.js'

const DEFAULT_MODEL = 'mlx-community/Qwen3.5-4B-MLX-4bit'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'
// A local MLX server needs no credential. The placeholder keeps the adapter's
// usage and redaction plumbing intact while no Authorization header is sent.
const LOCAL_KEY = 'local-mlx'
const textContent = (content: string | ContentBlock[]) =>
  typeof content === 'string' ? content : (content ?? []).map((block) => block.text ?? '').join('\n')
const normalizedUsage = (usage: Record<string, unknown> = {}) => ({
  ...usage,
  ...(typeof (usage.prompt_tokens ?? usage.input_tokens) === 'number'
    ? { input_tokens: usage.prompt_tokens ?? usage.input_tokens }
    : {}),
  ...(typeof (usage.completion_tokens ?? usage.output_tokens) === 'number'
    ? { output_tokens: usage.completion_tokens ?? usage.output_tokens }
    : {})
})
// A local model stops with "stop" even when it emitted calls, so the presence of
// tool calls decides the turn rather than the reported reason alone.
const normalizedFinishReason = (reason: string | null | undefined, calls: number) => {
  const raw = reason?.toUpperCase() ?? 'COMPLETE'
  return raw === 'STOP'
    ? calls
      ? 'TOOL_CALL'
      : 'COMPLETE'
    : raw === 'TOOL_CALLS'
      ? 'TOOL_CALL'
      : raw === 'LENGTH'
        ? 'MAX_TOKENS'
        : raw
}
type NativeMessage = {
  role: string
  content: string | null
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export function mlxRequest(
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  model: string,
  maxTokens = 16_384
) {
  const turns = messages.map((message) => {
    // Replay the server's own assistant message when one was captured, so local
    // reasoning and native tool-call shapes survive every tool step of a turn.
    if (message.role === 'assistant' && message._mlxMessage)
      return structuredClone(message._mlxMessage as NativeMessage)
    const text = textContent(message.content)
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: text }
    const calls = message.tool_calls?.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments }
    }))
    return { role: message.role, content: text, ...(calls?.length ? { tool_calls: calls } : {}) }
  })
  return {
    model,
    messages: turns,
    max_tokens: maxTokens,
    ...(tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool.function })) } : {})
  }
}

export class MLX extends ProviderAdapter {
  private readonly endpoint: string
  constructor(options: ProviderOptions = {}) {
    if (options.webSearch && options.purpose !== 'compactor') {
      throw new Error(
        'A local MLX server does not provide provider-hosted web search; disable --web-search to use MLX.'
      )
    }
    super('MLX', options.apiKey ?? process.env.MLX_API_KEY ?? LOCAL_KEY, options, DEFAULT_MODEL)
    this.endpoint = `${(process.env.MLX_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/chat/completions`
  }
  private requestBody(messages: Message[], options: RequestOptions, stream: boolean) {
    // Summaries are short; cap the compactor so a local model cannot run on.
    const maxTokens = this.purpose === 'compactor' ? Math.min(options.maxTokens ?? 8_192, 8_192) : options.maxTokens
    return { ...mlxRequest(messages, options.tools, this.model, maxTokens), stream }
  }
  private get headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey && this.apiKey !== LOCAL_KEY ? { Authorization: `Bearer ${this.apiKey}` } : {})
    }
  }
  private normalize(input: unknown): ProviderResult {
    const raw = Wire.checkedWire(Wire.ChatResponse, input)
    if (raw.error) throw this.failure('provider', `MLX response: ${raw.error.message ?? 'failed'}`)
    const choice = raw.choices?.[0]
    const native = choice?.message
    if (!native) throw this.failure('malformed', 'MLX response did not contain a chat completion.')
    const calls = (native.tool_calls ?? []).map((call) => {
      if (!call.id || !call.function?.name) throw this.failure('malformed', 'MLX returned an incomplete tool call.')
      return {
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments ?? '' }
      }
    })
    const text = native.content ?? ''
    return {
      message: {
        role: 'assistant',
        content: text ? [{ type: 'text', text }] : [],
        _mlxMessage: structuredClone(native) as NativeMessage,
        ...(calls.length ? { tool_calls: calls } : {})
      },
      finish_reason: normalizedFinishReason(choice.finish_reason, calls.length),
      usage: normalizedUsage(raw.usage)
    }
  }
  protected readonly rawEffects: ProviderService = {
    model: this.model,
    chat: Effect.fn('MLX.chat')((messages, options = {}) =>
      Effect.suspend(() =>
        this.response(this.endpoint, this.requestBody(messages, options, false), this.headers, (response) =>
          Effect.gen({ self: this }, function* () {
            const raw = yield* this.json(response)
            const result = yield* this.parse(() => this.normalize(raw))
            return yield* providerOutcome('MLX', result)
          })
        )
      )
    ),
    stream: Effect.fn('MLX.stream')(
      (messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) =>
        Effect.suspend(() =>
          this.response(this.endpoint, this.requestBody(messages, options, true), this.headers, (response) =>
            Effect.gen({ self: this }, function* () {
              const tools = new Map<number, { id?: string; name: string; arguments: string }>()
              let finishReason: string | null | undefined,
                usage: Record<string, unknown> = {},
                chunks = 0
              let text = ''
              yield* consumeSse(response, (payload) =>
                Effect.gen({ self: this }, function* () {
                  if (!payload.trim()) return true
                  if (payload.trim() === '[DONE]') return false
                  const chunk = yield* this.parse(() => Wire.checkedWire(Wire.ChatResponse, JSON.parse(payload)))
                  if (chunk.error)
                    return yield* Effect.fail(
                      this.failure('provider', `MLX stream: ${chunk.error.message ?? 'failed'}`)
                    )
                  chunks++
                  if (chunk.usage) usage = normalizedUsage(chunk.usage)
                  for (const choice of chunk.choices ?? []) {
                    if (choice.finish_reason !== undefined && choice.finish_reason !== null)
                      finishReason = choice.finish_reason
                    const delta = choice.delta
                    if (delta?.reasoning) yield* this.textCallback(() => onThought(delta.reasoning!))
                    if (delta?.content) {
                      text += delta.content
                      yield* this.textCallback(() => onText(delta.content!))
                    }
                    for (const [offset, call] of (delta?.tool_calls ?? []).entries()) {
                      const index = call.index ?? offset
                      const current = tools.get(index) ?? { name: '', arguments: '' }
                      if (call.id) current.id = call.id
                      if (call.function?.name) current.name += call.function.name
                      if (call.function?.arguments) current.arguments += call.function.arguments
                      tools.set(index, current)
                    }
                  }
                  return true
                })
              )
              // Local servers and proxies sometimes close without [DONE]; only a
              // stream that delivered nothing at all counts as truncated.
              if (!chunks && !text && !tools.size)
                return yield* Effect.fail(this.failure('truncated', 'MLX stream ended before any chunk arrived.'))
              if (text) yield* this.callback(() => onEntry('talk', text))
              const toolCalls = yield* this.parse(() =>
                [...tools.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([, call]) => {
                    if (!call.id || !call.name)
                      throw this.failure('malformed', 'MLX stream returned an incomplete tool call.')
                    return {
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments || '{}' }
                    }
                  })
              )
              for (const call of toolCalls)
                yield* this.callback(() => onEntry('tool', `${call.function.name} ${call.function.arguments}`))
              const result: ProviderResult = {
                message: {
                  role: 'assistant',
                  content: text ? [{ type: 'text', text }] : [],
                  _mlxMessage: {
                    role: 'assistant',
                    content: text || null,
                    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
                  } as NativeMessage,
                  ...(toolCalls.length ? { tool_calls: toolCalls } : {})
                },
                finish_reason: normalizedFinishReason(finishReason, toolCalls.length),
                usage
              }
              return yield* providerOutcome('MLX', result)
            })
          )
        )
    )
  }
}
