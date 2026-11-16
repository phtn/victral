import { Meta } from './meta.js';
import { OpenAI } from './openai.js';
import { Cohere } from './cohere.js';
import { Anthropic } from './anthropic.js';
import { Cloudflare } from './cloudflare.js';
import { MLX } from './mlx.js';
import { MODEL } from './constants.js';
import type { ProviderOptions } from './providers/types.js';
import { findModel, formatModelsList } from './model-catalog.js';
export { MODEL_INFO, PROVIDERS, MODELS, shortModelName, formatModelsList, resolveModelId } from './model-catalog.js';

export function createModel(model = MODEL, options: ProviderOptions = {}) {
  const selected = findModel(String(model).trim().toLowerCase());
  if (!selected) throw new Error(`Unsupported model: ${model}.\n${formatModelsList()}`);
  model = selected.id;
  const Provider = selected.provider === 'OpenAI' ? OpenAI : selected.provider === 'Cohere' ? Cohere
    : selected.provider === 'Anthropic' ? Anthropic : selected.provider === 'Cloudflare' ? Cloudflare
      : selected.provider === 'MLX' ? MLX : Meta;
  return new Provider({ ...options, model, instrument: true });
}
