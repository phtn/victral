import { MARKS } from './constants.js'
import { sseData } from './sse.js'

export function viewBlocks(view) {
  const blocks = []
  let start = 0
  for (const mark of MARKS) {
    if (mark >= view.length) break
    const end = view.lastIndexOf('\n', mark)
    if (end > start) {
      blocks.push({ type: 'text', text: view.slice(start, end + 1) })
      start = end + 1
    }
  }
  blocks.push({ type: 'text', text: view.slice(start) })
  return blocks
}
export class Cohere {
  constructor({
    apiKey = process.env.COHERE_API_KEY,
    model = 'command-a-plus-05-2026',
    usage = () => {},
    fetchImpl = fetch,
    purpose = 'agent'
  } = {}) {
    if (!apiKey) throw new Error('Set COHERE_API_KEY in your environment before starting.')
    Object.assign(this, { apiKey, model, usage, fetchImpl, purpose })
  }
  async request(messages, { tools, signal, stream = false, maxTokens, thinking } = {}) {
    const response = await this.fetchImpl('https://api.cohere.com/v2/chat', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Client-Name': 'victral'
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream,
        ...(tools?.length ? { tools } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(thinking ? { thinking } : {})
      })
    })
    if (!response.ok) {
      // Never print an Authorization header or the supplied key.
      const body = (await response.text()).replaceAll(this.apiKey, '[redacted]').slice(0, 1500)
      throw new Error(`Cohere HTTP ${response.status}: ${body}`)
    }
    return response
  }
  recordUsage(result) {
    this.usage({
      purpose: this.purpose,
      model: this.model,
      usage: result.usage ?? {},
      finish_reason: result.finish_reason
    })
  }
  async chat(messages, options = {}) {
    const result = await (await this.request(messages, options)).json()
    this.recordUsage(result)
    return result
  }
  async stream(messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) {
    const response = await this.request(messages, { ...options, stream: true })
    let ended = false,
      finishReason,
      usage,
      toolPlan = ''
    const content = new Map(),
      calls = new Map()
    const event = async (payload) => {
      if (!payload.trim() || payload.trim() === '[DONE]') return
      const e = JSON.parse(payload)
      const delta = e.delta?.message
      if (e.type === 'content-start') content.set(e.index, { ...delta.content })
      if (e.type === 'content-delta') {
        const block = content.get(e.index) ?? { type: delta.content.thinking !== undefined ? 'thinking' : 'text' }
        if (delta.content.text !== undefined) {
          block.text = (block.text ?? '') + delta.content.text
          onText(delta.content.text)
        }
        if (delta.content.thinking !== undefined) {
          block.thinking = (block.thinking ?? '') + delta.content.thinking
          onThought(delta.content.thinking)
        }
        content.set(e.index, block)
      }
      if (e.type === 'content-end') {
        const block = content.get(e.index)
        if (block?.type === 'text' && block.text) await onEntry('talk', block.text)
      }
      if (e.type === 'tool-plan-delta') toolPlan += delta.tool_plan
      if (e.type === 'tool-call-start') calls.set(e.index, structuredClone(delta.tool_calls))
      if (e.type === 'tool-call-delta') {
        const call = calls.get(e.index)
        if (!call) throw new Error('Tool arguments arrived without a tool-call-start.')
        call.function.arguments += delta.tool_calls.function.arguments
      }
      if (e.type === 'tool-call-end') {
        const call = calls.get(e.index)
        if (!call) throw new Error('Unknown completed tool call.')
        await onEntry('tool', `${call.function.name} ${call.function.arguments}`)
      }
      if (e.type === 'message-end') {
        ended = true
        finishReason = e.delta.finish_reason
        usage = e.delta.usage
      }
      if (e.type === 'error') throw new Error(e.message ?? 'Cohere stream error.')
    }
    for await (const payload of sseData(response.body)) {
      await event(payload)
      if (ended) break
    }
    if (!ended) throw new Error('Cohere stream ended before message-end.')
    const message = { role: 'assistant', content: [...content.values()] }
    if (calls.size) {
      message.tool_calls = [...calls.values()]
      // Cohere rejects a replay containing both thinking blocks and tool_plan.
      // Keep the generated thinking intact; include tool_plan for non-reasoning turns.
      if (!message.content.some((block) => block.type === 'thinking')) message.tool_plan = toolPlan
    }
    const result = { message, finish_reason: finishReason, usage }
    this.recordUsage(result)
    return result
  }
}
