import { Cohere } from './cohere.js';
import { Meta } from './meta.js';
import { MODEL } from './constants.js';

export const MODELS = [MODEL, 'muse-spark-1.3', 'muse-spark-1.3-contributor'];
export function createModel(model = MODEL, options = {}) {
  if (!MODELS.includes(model)) throw new Error(`Unsupported model: ${model}. Choose ${MODELS.join(', ')}.`);
  return model === MODEL ? new Cohere({ ...options, model }) : new Meta({ ...options, model });
}
