import { sseData } from './sse.js';

const finishReason = reason => reason === 'tool_use' ? 'TOOL_CALL' : reason === 'max_tokens' ? 'MAX_TOKENS' : reason === 'end_turn' ? 'COMPLETE' : reason?.toUpperCase();

export function metaRequest(messages, tools, model, maxTokens = 16_384, purpose = 'agent') {
  const system = messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : m.content.map(b => b.text).join('\n')).join('\n\n');
  const turns = [];
  for (const message of messages.filter(m => m.role !== 'system')) {
    let role = message.role, content;
    if (role === 'tool') {
      role = 'user';
      content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
    } else if (message._metaContent) content = structuredClone(message._metaContent);
    else {
      content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : structuredClone(message.content ?? []);
      for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    }
    // Anthropic-format tool results must share one user turn when returned together.
    if (turns.at(-1)?.role === role) turns.at(-1).content.push(...content);
    else turns.push({ role, content });
  }
  return {
    model, max_tokens: maxTokens, system, messages: turns,
    thinking: { type: 'adaptive' },
    ...(purpose === 'compactor' ? { output_config: { effort: 'medium' } } : {}),
    ...(tools?.length ? { tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}),
  };
}
function normalize(content, reason, usage) {
  const message = { role: 'assistant', content: content.filter(b => b.type !== 'tool_use'), _metaContent: content };
  const calls = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  if (calls.length) message.tool_calls = calls;
  return { message, finish_reason: finishReason(reason), usage };
}
export class Meta {
  constructor({ apiKey = process.env.META_API_KEY || process.env.MODEL_API_KEY, model = 'muse-spark-1.3', usage = () => {}, fetchImpl = fetch, purpose = 'agent' } = {}) {
    if (!apiKey) throw new Error('Set META_API_KEY (or MODEL_API_KEY) in your environment before selecting Meta.');
    Object.assign(this, { apiKey, model, usage, fetchImpl, purpose });
  }
  async request(messages, { tools, signal, stream = false, maxTokens } = {}) {
    const response = await this.fetchImpl('https://api.meta.ai/v1/messages', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...metaRequest(messages, tools, this.model, maxTokens, this.purpose), stream }),
    });
    if (!response.ok) throw new Error(`Meta HTTP ${response.status}: ${(await response.text()).replaceAll(this.apiKey, '[redacted]').slice(0, 1500)}`);
    return response;
  }
  recordUsage(result) {
    this.usage({ purpose: this.purpose, model: this.model, usage: result.usage ?? {}, finish_reason: result.finish_reason });
  }
  async chat(messages, options = {}) {
    const raw = await (await this.request(messages, options)).json();
    const result = normalize(raw.content, raw.stop_reason, raw.usage);
    this.recordUsage(result);
    return result;
  }
  async stream(messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) {
    const response = await this.request(messages, { ...options, stream: true });
    const content = new Map(), argumentsByIndex = new Map();
    let ended = false, reason, usage = {};
    const event = async payload => {
      if (!payload.trim() || payload.trim() === '[DONE]') return;
      const e = JSON.parse(payload);
      if (e.type === 'message_start') usage = { ...e.message.usage };
      if (e.type === 'content_block_start') {
        content.set(e.index, structuredClone(e.content_block));
        if (e.content_block.type === 'tool_use') argumentsByIndex.set(e.index, '');
      }
      if (e.type === 'content_block_delta') {
        const block = content.get(e.index);
        if (!block) throw new Error('Meta delta arrived without a content block.');
        if (e.delta.type === 'text_delta') { block.text += e.delta.text; onText(e.delta.text); }
        if (e.delta.type === 'thinking_delta') { block.thinking += e.delta.thinking; onThought(e.delta.thinking); }
        if (e.delta.type === 'signature_delta') block.signature = (block.signature ?? '') + e.delta.signature;
        if (e.delta.type === 'input_json_delta') argumentsByIndex.set(e.index, (argumentsByIndex.get(e.index) ?? '') + e.delta.partial_json);
      }
      if (e.type === 'content_block_stop') {
        const block = content.get(e.index);
        if (block?.type === 'tool_use') {
          const argumentsText = argumentsByIndex.get(e.index);
          if (argumentsText) block.input = JSON.parse(argumentsText);
          await onEntry('tool', `${block.name} ${JSON.stringify(block.input)}`);
        }
        if (block?.type === 'text' && block.text) await onEntry('talk', block.text);
      }
      if (e.type === 'message_delta') { reason = e.delta.stop_reason; usage = { ...usage, ...e.usage }; }
      if (e.type === 'message_stop') ended = true;
      if (e.type === 'error') throw new Error(`Meta stream: ${e.error?.message ?? 'unknown error'}`);
    };
    for await (const payload of sseData(response.body)) {
      await event(payload);
      if (ended) break;
    }
    if (!ended) throw new Error('Meta stream ended before message_stop.');
    const result = normalize([...content.values()], reason, usage);
    this.recordUsage(result);
    return result;
  }
}
