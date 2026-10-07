import { Cohere } from './cohere.js';
import { Meta } from './meta.js';
import { MODEL } from './constants.js';
import { randomUUID } from 'node:crypto';

export const MODEL_INFO = [
  { id: 'command-a-plus-05-2026', provider: 'Cohere', credential: 'COHERE_API_KEY' },
  { id: 'muse-spark-1.3', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
  { id: 'muse-spark-1.3-contributor', provider: 'Meta', credential: 'META_API_KEY or MODEL_API_KEY' },
];
export const MODELS = MODEL_INFO.map(entry => entry.id);
export function formatModelsList() {
  return MODEL_INFO.map((entry, index) => `  ${index + 1}. ${entry.id} (${entry.provider}; needs ${entry.credential})`).join('\n');
}
// Accept a list number, an exact ID (any case), or an unambiguous short
// name/prefix, so `/model 2` and `/model contributor` work like the full ID.
export function resolveModelId(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error(`Choose a model:\n${formatModelsList()}\nUse /model <number or ID>, e.g. /model 2.`);
  const index = Number(text);
  if (Number.isSafeInteger(index) && index >= 1 && index <= MODEL_INFO.length) return MODEL_INFO[index - 1].id;
  const lowered = text.toLowerCase();
  const exact = MODEL_INFO.find(entry => entry.id.toLowerCase() === lowered);
  if (exact) return exact.id;
  const matches = MODEL_INFO.filter(entry => entry.id.toLowerCase().includes(lowered));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`"${text}" matches several models:\n${formatModelsList()}\nUse /model <number or ID>, e.g. /model 2.`);
  throw new Error(`Unknown model "${text}". Available models:\n${formatModelsList()}\nUse /model <number or ID>, e.g. /model 2.`);
}
export function createModel(model = MODEL, options = {}) {
  if (!MODELS.includes(model)) throw new Error(`Unsupported model: ${model}.\n${formatModelsList()}`);
  const report = options.usage ?? (() => {});
  const provider = MODEL_INFO.find(entry => entry.id === model)?.provider === 'Cohere'
    ? new Cohere({ ...options, model, usage: () => {} })
    : new Meta({ ...options, model, usage: () => {} });
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
