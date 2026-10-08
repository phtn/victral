import { MARKS } from './constants.js';

export function viewBlocks(view: string): { type: 'text'; text: string }[] {
  const blocks: { type: 'text'; text: string }[] = [];
  let start = 0;
  for (const mark of MARKS) {
    if (mark >= view.length) break;
    const end = view.lastIndexOf('\n', mark);
    if (end > start) {
      blocks.push({ type: 'text', text: view.slice(start, end + 1) });
      start = end + 1;
    }
  }
  blocks.push({ type: 'text', text: view.slice(start) });
  return blocks;
}
