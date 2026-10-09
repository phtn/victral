import { BLOCK_LINES } from './constants.js';

export function viewBlocks(view: string): { type: 'text'; text: string }[] {
  const blocks: { type: 'text'; text: string }[] = [];
  const lines = view.split('\n');
  let start = 0;
  // Keep opening/closing tags out of the line count; completed blocks stay
  // identical when more summaries are appended.
  for (let line = BLOCK_LINES; line < lines.length - 1; line += BLOCK_LINES) {
    const text = lines.slice(start, line + 1).join('\n') + '\n';
    blocks.push({ type: 'text', text }); start = line + 1;
  }
  blocks.push({ type: 'text', text: lines.slice(start).join('\n') });
  return blocks;
}
