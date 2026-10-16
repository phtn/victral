import { schemaTool } from './tool-registry.js';
import { TikrSearchSchema, TikrOpenSchema } from './tikr-schema.js';
import { ReadWebPageSchema, FindInPageSchema } from './web-tool-schema.js';
import type { TikrResearch } from './tikr.js';

export function tikrTools(tikr: TikrResearch) {
  return [
    schemaTool({ name: 'tikr_search', schema: TikrSearchSchema, capabilities: ['read'],
      execute: (args, signal) => tikr.search(args, signal), executeEffect: (args, signal) => tikr.searchEffect(args, signal) }),
    schemaTool({ name: 'tikr_open', schema: TikrOpenSchema, capabilities: ['read'],
      execute: (args, signal) => tikr.open(args, signal), executeEffect: (args, signal) => tikr.openEffect(args, signal) }),
    schemaTool({ name: 'tikr_read_page', schema: ReadWebPageSchema, capabilities: ['read'], execute: args => tikr.readPage(args) }),
    schemaTool({ name: 'tikr_find_in_page', schema: FindInPageSchema, capabilities: ['read'], execute: args => tikr.findText(args) }),
  ];
}
