import * as Effect from 'effect/Effect'
import { ProviderAdapter, providerOutcome, type ProviderService } from './providers/core.js'
import type { ProviderOptions, ProviderResult, RequestOptions } from './providers/types.js'
import * as Wire from './providers/wire.js'
import type { ContentBlock, Message, ToolDefinition } from './types.js'
import { citationFooter } from './web-citations.js'

const textContent = (content: string | ContentBlock[]) =>
  typeof content === 'string' ? content : (content ?? []).map((block) => block.text ?? '').join('\n')
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value])
const toolArguments = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value ?? {}) ?? '{}'))

function citationReferences(citations: unknown[]) {
  const references: { url: string; title?: string }[] = []
  for (const citation of citations)
    for (const sourceValue of array(record(citation)?.sources)) {
      const source = record(sourceValue)
      const outputValue = source?.tool_output
      let output = record(outputValue)
      if (!output && typeof outputValue === 'string') {
        try {
          output = record(JSON.parse(outputValue))
        } catch {
          /* Plain-text tool output has no source metadata. */
        }
      }
      const nestedSource = record(output?.source)
      const url = output?.url ?? output?.source_url ?? nestedSource?.url ?? source?.url
      if (typeof url !== 'string') continue
      const title = output?.title ?? nestedSource?.title ?? source?.title
      references.push({ url, ...(typeof title === 'string' ? { title } : {}) })
    }
  return references
}

export function cohereRequest(
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  model: string,
  maxTokens = 16_384
) {
  const turns = messages.map((message) => {
    // Cohere expects its native assistant message, including tool_plan, to be
    // replayed intact when it is followed by tool results.
    if (message.role === 'assistant' && message._cohereMessage) return structuredClone(message._cohereMessage)
    const text = textContent(message.content)
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: text }
    const calls = message.tool_calls?.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments }
    }))
    return {
      role: message.role,
      ...(!(message.role === 'assistant' && calls?.length && !text) ? { content: text } : {}),
      ...(calls?.length ? { tool_calls: calls } : {})
    }
  })
  return {
    model,
    messages: turns,
    max_tokens: maxTokens,
    ...(tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool.function })) } : {})
  }
}

const normalizedFinishReason = (reason?: string | null) =>
  reason === 'COMPLETE' || reason === 'STOP_SEQUENCE'
    ? 'COMPLETE'
    : reason === 'TOOL_CALL'
      ? 'TOOL_CALL'
      : reason === 'MAX_TOKENS'
        ? 'MAX_TOKENS'
        : reason?.toUpperCase()

export class Cohere extends ProviderAdapter {
  constructor(options: ProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.COHERE_API_KEY
    if (!apiKey) throw new Error('Set COHERE_API_KEY in your environment before selecting Cohere.')
    if (options.webSearch && options.purpose !== 'compactor') {
      throw new Error(
        'Cohere Chat V2 requires a user-defined search tool; --web-search is supported with Meta and OpenAI.'
      )
    }
    super('Cohere', apiKey, options, 'north-mini-code-1-0')
  }
  private requestBody(messages: Message[], options: RequestOptions, stream: boolean) {
    return { ...cohereRequest(messages, options.tools, this.model, options.maxTokens), stream }
  }
  private normalize(input: unknown): ProviderResult {
    const raw = Wire.checkedWire(Wire.CohereResponse, input)
    if (raw.finish_reason === 'ERROR') throw this.failure('provider', 'Cohere returned an error finish reason.')
    const native = raw.message
    const text = (native.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => Wire.checkedWire(Wire.CohereText, block).text)
      .join('')
    const citations = native.citations ?? []
    const footer = citationFooter([{ annotations: citationReferences(citations) }])
    const calls = (native.tool_calls ?? []).map((block) => {
      const tool = Wire.checkedWire(Wire.CohereTool, block)
      return {
        id: tool.id,
        type: 'function',
        function: { name: tool.function.name, arguments: toolArguments(tool.function.arguments) }
      }
    })
    const content: ContentBlock[] = text ? [{ type: 'text', text }] : []
    if (footer) content.push({ type: 'text', text: footer })
    const message: Message = {
      role: 'assistant',
      content,
      _cohereMessage: structuredClone(native),
      ...(calls.length ? { tool_calls: calls } : {})
    }
    return { message, finish_reason: normalizedFinishReason(raw.finish_reason), usage: raw.usage }
  }
  protected readonly rawEffects: ProviderService = {
    model: this.model,
    chat: Effect.fn('Cohere.chat')((messages, options = {}) =>
      Effect.suspend(() =>
        this.response(
          'https://api.cohere.com/v2/chat',
          this.requestBody(messages, options, false),
          { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          (response) =>
            Effect.gen({ self: this }, function* () {
              const raw = yield* this.json(response),
                result = yield* this.parse(() => this.normalize(raw))
              return yield* providerOutcome('Cohere', result)
            })
        )
      )
    ),
    stream: Effect.fn('Cohere.stream')(
      (messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) =>
        Effect.suspend(() =>
          this.response(
            'https://api.cohere.com/v2/chat',
            this.requestBody(messages, options, true),
            { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            (response) =>
              Effect.gen({ self: this }, function* () {
                const content: string[] = [],
                  toolCalls = new Map<
                    number,
                    { id: string; type: 'function'; function: { name: string; arguments: string } }
                  >()
                const citations: unknown[] = []
                let toolPlan = '',
                  finishReason: string | null | undefined,
                  usage: Record<string, unknown> = {},
                  ended = false
                yield* consumeSse(response, (payload) =>
                  Effect.gen({ self: this }, function* () {
                    if (!payload.trim() || payload.trim() === '[DONE]') return true
                    const event = yield* this.parse(() => Wire.checkedWire(Wire.Native, JSON.parse(payload)))
                    if (event.type === 'content-delta') {
                      const delta = yield* this.parse(() => Wire.checkedWire(Wire.CohereContentDelta, event))
                      const text = delta.delta.message.content.text
                      content.push(text)
                      yield* this.textCallback(() => onText(text))
                      if (text) yield* this.callback(() => onEntry('talk', text))
                    }
                    if (event.type === 'tool-plan-delta') {
                      const delta = yield* this.parse(() => Wire.checkedWire(Wire.CohereToolPlanDelta, event))
                      toolPlan += delta.delta.message.tool_plan
                      yield* this.textCallback(() => onThought(delta.delta.message.tool_plan))
                    }
                    if (event.type === 'tool-call-start') {
                      const start = yield* this.parse(() => Wire.checkedWire(Wire.CohereToolCallStart, event))
                      const values = Array.isArray(start.delta.message.tool_calls)
                        ? start.delta.message.tool_calls
                        : [start.delta.message.tool_calls]
                      for (const value of values) {
                        const tool = yield* this.parse(() => Wire.checkedWire(Wire.CohereTool, value))
                        toolCalls.set(start.index, {
                          id: tool.id,
                          type: 'function',
                          function: {
                            name: tool.function.name,
                            arguments: toolArguments(tool.function.arguments)
                          }
                        })
                      }
                    }
                    if (event.type === 'tool-call-delta') {
                      const delta = yield* this.parse(() => Wire.checkedWire(Wire.CohereToolCallDelta, event))
                      const tool = toolCalls.get(delta.index)
                      if (!tool)
                        return yield* Effect.fail(
                          this.failure('malformed', 'Cohere tool-call delta arrived before its start event.')
                        )
                      tool.function.arguments += delta.delta.message.tool_calls.function.arguments
                    }
                    if (event.type === 'citation-start') {
                      const citation = yield* this.parse(() => Wire.checkedWire(Wire.CohereCitationStart, event))
                      citations.push(citation.delta.message.citations)
                    }
                    if (event.type === 'message-end') {
                      const end = yield* this.parse(() => Wire.checkedWire(Wire.CohereMessageEnd, event))
                      finishReason = end.delta.finish_reason
                      usage = end.delta.usage ?? {}
                      ended = true
                      return false
                    }
                    if (event.type === 'error') {
                      const error = yield* this.parse(() => Wire.checkedWire(Wire.CohereError, event))
                      return yield* Effect.fail(
                        this.failure('provider', `Cohere stream: ${error.error?.message ?? error.message ?? 'failed'}`)
                      )
                    }
                    return true
                  })
                )
                if (!ended)
                  return yield* Effect.fail(
                    this.failure('truncated', 'Cohere stream ended before a terminal message event.')
                  )
                const answer = content.join('')
                const native: Record<string, unknown> = {
                  role: 'assistant',
                  ...(answer ? { content: [{ type: 'text', text: answer }] } : {}),
                  ...(toolPlan ? { tool_plan: toolPlan } : {}),
                  ...(toolCalls.size
                    ? { tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) }
                    : {}),
                  ...(citations.length ? { citations } : {})
                }
                const result = yield* this.parse(() =>
                  this.normalize({ message: native, finish_reason: finishReason, usage })
                )
                const footer = citationFooter([{ annotations: citationReferences(citations) }])
                if (footer) {
                  yield* this.textCallback(() => onText(footer))
                  yield* this.callback(() => onEntry('talk', footer))
                }
                for (const call of result.message.tool_calls ?? []) {
                  yield* this.callback(() => onEntry('tool', `${call.function.name} ${call.function.arguments}`))
                }
                return yield* providerOutcome('Cohere', result)
              })
          )
        )
    )
  }
}
