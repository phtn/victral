import { Meta } from './meta.js';
import { OpenAI } from './openai.js';
import { MODEL } from './constants.js';
import { randomUUID } from 'node:crypto';

export const MODEL_INFO = [
  { id: 'muse-spark-1.3', shortName: 'ms1.3', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'muse-spark-1.3-contributor', shortName: 'ms1.3c', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'gpt-6-luna', shortName: 'luna6', provider: 'OpenAI', credential: 'OPENAI_API_KEY' },
  { id: 'gpt-6.1-sol', shortName: 'sol6.1', provider: 'OpenAI', credential: 'OPENAI_API_KEY' },
];
export const PROVIDERS = [...new Set(MODEL_INFO.map(entry => entry.provider.toLowerCase()))];
export const MODELS = MODEL_INFO.map(entry => entry.id);
const exactModel = lowered => MODEL_INFO.find(entry => entry.id.toLowerCase() === lowered || entry.shortName === lowered);
export function shortModelName(model) {
  return exactModel(String(model).trim().toLowerCase())?.shortName ?? model;
}
export function formatModelsList(provider) {
  return MODEL_INFO.flatMap((entry, index) => !provider || entry.provider.toLowerCase() === provider.toLowerCase()
    ? [`  ${index + 1}. ${entry.id} (${entry.provider}; alias ${entry.shortName}; needs ${entry.credential})`] : []).join('\n');
}
// Resolve exact aliases before partial IDs, so ms1.3 selects Standard even
// though the Contributor alias starts with the same characters.
export function resolveModelId(input) {
  let text = String(input ?? '').trim();
  const parts = text.split(/\s+/);
  const provider = PROVIDERS.includes(parts[0]?.toLowerCase()) ? parts.shift().toLowerCase() : undefined;
  if (provider) text = parts.join(' ');
  const choices = MODEL_INFO.filter(entry => !provider || entry.provider.toLowerCase() === provider);
  const list = formatModelsList(provider);
  const hint = 'Use /model <provider> <short name or ID>, e.g. /model openai luna6. Numbers and model-only shortcuts also work.';
  if (!text) throw new Error(`Choose a model:\n${list}\n${hint}`);
  const index = Number(text);
  if (/^\d+$/.test(text)) {
    if (Number.isSafeInteger(index) && index >= 1 && index <= MODEL_INFO.length && choices.includes(MODEL_INFO[index - 1])) return MODEL_INFO[index - 1].id;
    throw new Error(`Model number must be between 1 and ${MODEL_INFO.length}${provider ? ` and belong to ${provider}` : ''}.\n${list}`);
  }
  const lowered = text.toLowerCase();
  const exact = exactModel(lowered);
  if (exact && choices.includes(exact)) return exact.id;
  const matches = choices.filter(entry => entry.id.toLowerCase().includes(lowered) || entry.shortName.startsWith(lowered));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`"${text}" matches several models:\n${list}\n${hint}`);
  throw new Error(`Unknown model "${text}"${provider ? ` for ${provider}` : ''}. Available models:\n${list}\n${hint}`);
}
export function createModel(model = MODEL, options = {}) {
  const selected = exactModel(String(model).trim().toLowerCase());
  if (!selected) throw new Error(`Unsupported model: ${model}.\n${formatModelsList()}`);
  model = selected.id;
  const report = options.usage ?? (() => {});
  const Provider = selected.provider === 'OpenAI' ? OpenAI : Meta;
  const provider = new Provider({ ...options, model, usage: () => {} });
  for (const method of ['chat', 'stream']) {
    const original = provider[method].bind(provider);
    provider[method] = async (messages, request = {}) => {
      const start = performance.now(), requestId = randomUUID();
      let ttft;
      try {
        const result = await original(messages, method === 'stream' ? { ...request, onText: text => {
          if (text && ttft === undefined) ttft = performance.now() - start;
          request.onText?.(text);
        } } : request);
        report({ request_id: requestId, purpose: provider.purpose, model, status: 'completed', usage: result.usage ?? {}, finish_reason: result.finish_reason, latency_ms: performance.now() - start, ...(ttft !== undefined ? { ttft_ms: ttft } : {}) });
        return result;
      } catch (error) {
        report({ request_id: requestId, purpose: provider.purpose, model, status: request.signal?.aborted ? 'canceled' : 'error', latency_ms: performance.now() - start, error_type: error.name });
        throw error;
      }
    };
  }
  return provider;
}
