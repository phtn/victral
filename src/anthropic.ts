import { ANTHROPIC_MODEL } from './constants.js';
import { MessagesAdapter, type metaRequest } from './meta.js';
import type { ProviderOptions } from './providers/types.js';

// Claude 5.5 models always think adaptively; effort is the only depth control
// (Opus 5.5 defaults to medium, so set it explicitly). Summarized thinking feeds
// onThought; refused requests are rerouted server-side by the default fallbacks.
export class Anthropic extends MessagesAdapter {
  protected readonly endpoint = 'https://api.anthropic.com/v1/messages';
  protected readonly webSearchTool = { type: 'web_search_20260209', name: 'web_search' };
  constructor(options: ProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY in your environment before selecting Anthropic.');
    super('Anthropic', apiKey, options, ANTHROPIC_MODEL);
  }
  protected headers() {
    return { 'x-api-key': this.apiKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01' };
  }
  protected adjustBody(body: ReturnType<typeof metaRequest>) {
    return { ...body, thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: this.purpose === 'compactor' ? 'medium' : 'high' }, fallbacks: 'default' };
  }
}
