import { sseData } from './sse.js';
import { citationFooter } from './web-citations.js';

const textContent = content => typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n');

export function openaiRequest(messages, tools, model, maxTokens = 16_384) {
  const input = [];
  for (const message of messages) {
    if (message._openaiOutput) {
      // Replay native items, including encrypted reasoning and assistant phase,
      // only within this turn. The runner logs visible text and tool calls.
      input.push(...structuredClone(message._openaiOutput));
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textContent(message.content) });
    } else {
      const text = textContent(message.content);
      if (text) input.push({ role: message.role, content: text });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return {
    model, input, store: false, max_output_tokens: maxTokens,
    reasoning: { effort: 'medium' },
    ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })) } : {}),
  };
}

function normalize(raw) {
  if (raw.status === 'failed' || raw.error) throw new Error(`OpenAI response: ${raw.error?.message ?? 'failed'}`);
  if (!Array.isArray(raw.output)) throw new Error('OpenAI response is missing output items.');
  const content = raw.output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
    .filter(block => block.type === 'output_text' || block.type === 'refusal')
    .map(block => ({ type: 'text', text: block.text ?? block.refusal ?? '' }));
  const citations = citationFooter(raw.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []));
  if (citations) content.push({ type: 'text', text: citations });
  const calls = raw.output.filter(item => item.type === 'function_call').map(item => ({
    id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments },
  }));
  const finish_reason = raw.status === 'completed' ? (calls.length ? 'TOOL_CALL' : 'COMPLETE')
    : raw.status === 'incomplete' && raw.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS'
      : raw.status?.toUpperCase();
  return {
    message: { role: 'assistant', content, _openaiOutput: structuredClone(raw.output), ...(calls.length ? { tool_calls: calls } : {}) },
    finish_reason, usage: raw.usage,
  };
}

export class OpenAI {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = 'gpt-6-luna', usage = () => {}, fetchImpl = fetch, purpose = 'agent', webSearch = false } = {}) {
    if (!apiKey) throw new Error('Set OPENAI_API_KEY in your environment before selecting OpenAI.');
    Object.assign(this, { apiKey, model, usage, fetchImpl, purpose, webSearch });
  }
  redact(text) { return String(text).replaceAll(this.apiKey, '[redacted]'); }
  async request(messages, { tools, signal, stream = false, maxTokens } = {}) {
    const body = openaiRequest(messages, tools, this.model, maxTokens);
    if (this.webSearch && this.purpose !== 'compactor') body.tools = [...(body.tools ?? []), { type: 'web_search' }];
    const response = await this.fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream }),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${this.redact(await response.text()).slice(0, 1500)}`);
    return response;
  }
  recordUsage(result) {
    this.usage({ purpose: this.purpose, model: this.model, usage: result.usage ?? {}, finish_reason: result.finish_reason });
  }
  async chat(messages, options = {}) {
    const raw = await (await this.request(messages, options)).json();
    let result;
    try { result = normalize(raw); }
    catch (error) { throw new Error(this.redact(error.message)); }
    this.recordUsage(result);
    return result;
  }
  async stream(messages, { onText = () => {}, onThought = () => {}, onEntry = () => {}, ...options } = {}) {
    const response = await this.request(messages, { ...options, stream: true });
    const logged = new Set();
    const logItem = async (item, index) => {
      if (logged.has(index)) return;
      logged.add(index);
      if (item.type === 'function_call') await onEntry('tool', `${item.name} ${item.arguments}`);
      if (item.type === 'web_search_call') await onEntry('tool', `web_search ${JSON.stringify(item.action ?? {})}`);
      if (item.type === 'message') {
        for (const block of item.content ?? []) {
          const text = block.type === 'output_text' ? block.text : block.type === 'refusal' ? block.refusal : '';
          if (text) await onEntry('talk', text);
        }
      }
    };
    for await (const payload of sseData(response.body)) {
      if (!payload.trim() || payload.trim() === '[DONE]') continue;
      const event = JSON.parse(payload);
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') onText(event.delta);
      if (event.type === 'response.reasoning_summary_text.delta') onThought(event.delta);
      if (event.type === 'response.output_item.added' && event.item.type === 'reasoning') onThought('');
      if (event.type === 'response.output_item.done') await logItem(event.item, event.output_index);
      if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error(`OpenAI stream: ${this.redact(event.response?.error?.message ?? event.message ?? 'failed')}`);
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        let result;
        try { result = normalize(event.response); }
        catch (error) { throw new Error(this.redact(error.message)); }
        for (const [index, item] of event.response.output.entries()) await logItem(item, index);
        const citations = citationFooter(event.response.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []));
        if (citations) { onText(citations); await onEntry('talk', citations); }
        this.recordUsage(result);
        return result;
      }
    }
    throw new Error('OpenAI stream ended before a terminal response event.');
  }
}
