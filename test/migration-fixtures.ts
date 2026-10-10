import { projectTools } from '../src/tools.js';
import { Integrations } from '../src/integrations.js';
import { Subagents } from '../src/subagents.js';
import { systemPrompt } from '../src/prompt.js';
import type { Message } from '../src/types.js';

// All tools exposed by a fully enabled session, with no running work or I/O.
export const baselineTools = () => projectTools({ zoom: () => '', date: () => '' }, import.meta.dir, {
  allowShell: true, integrations: new Integrations({}, import.meta.dir),
  subagents: new Subagents({ model: () => { throw new Error('No fixture model calls.'); },
    tools: () => { throw new Error('No fixture workers.'); }, context: () => '', instructions: () => '', report: () => {} }),
});

export const baselineMessages = (): Message[] => [
  { role: 'system', content: systemPrompt('Offline migration fixture.') },
  { role: 'user', content: [{ type: 'text', text: '<chat>0 user: Saved decision 🦓</chat>', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Inspect the decision.' }] },
  { role: 'assistant', content: [], tool_calls: [{ id: 'call_1', function: { name: 'zoom', arguments: '{"id":0,"n":1}' } }],
    _metaContent: [{ type: 'redacted_thinking', data: 'fixture-encrypted-meta' }, { type: 'tool_use', id: 'call_1', name: 'zoom', input: { id: 0, n: 1 } }],
    _openaiOutput: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'fixture-encrypted-openai' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'zoom', arguments: '{"id":0,"n":1}', status: 'completed' }] },
  { role: 'tool', tool_call_id: 'call_1', content: 'Saved decision 🦓' },
  { role: 'user', content: 'Keep the original model.' },
];
