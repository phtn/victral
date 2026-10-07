import { Cohere } from './cohere.js';
import { Meta } from './meta.js';
import { MODEL } from './constants.js';
import { randomUUID } from 'node:crypto';

export const MODELS = [MODEL, 'muse-spark-1.3', 'muse-spark-1.3-contributor'];
export function createModel(model = MODEL, options = {}) {
  if (!MODELS.includes(model)) throw new Error(`Unsupported model: ${model}. Choose ${MODELS.join(', ')}.`);
  const report = options.usage ?? (() => {});
  const provider = model === MODEL ? new Cohere({ ...options, model, usage: () => {} }) : new Meta({ ...options, model, usage: () => {} });
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
