import { Meta } from './meta.js';
import { OpenAI } from './openai.js';
import { MODEL } from './constants.js';
import type { ProviderOptions } from './providers/types.js';
import { findModel, formatModelsList } from './model-catalog.js';
export { MODEL_INFO, PROVIDERS, MODELS, shortModelName, formatModelsList, resolveModelId } from './model-catalog.js';

export function createModel(model = MODEL, options: ProviderOptions = {}) {
  const selected = findModel(String(model).trim().toLowerCase());
  if (!selected) throw new Error(`Unsupported model: ${model}.\n${formatModelsList()}`);
  model = selected.id;
  const Provider = selected.provider === 'OpenAI' ? OpenAI : Meta;
  return new Provider({ ...options, model, instrument: true });
}
