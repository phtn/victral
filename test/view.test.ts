import { test, expect } from 'bun:test';
import { viewBlocks } from '../src/view.js';

test('view block marks preserve text exactly and split only at line ends', () => {
  const view = '<chat>\n' + '0+1|summary\n'.repeat(10_000) + '</chat>';
  const blocks = viewBlocks(view);
  expect(blocks).toHaveLength(2501);
  expect(blocks.map(block => block.text).join('')).toBe(view);
  for (const block of blocks.slice(0, -1)) expect(block.text.endsWith('\n')).toBe(true);
});


test('completed four-line blocks remain unchanged as the view grows', () => {
  for (let count = 0; count < 20; count++) {
    const render = (n: number) => '<chat>\n' + Array.from({ length: n }, (_, i) => `${i}+1|choice 🦓`).join('\n') + (n ? '\n' : '') + '</chat>';
    const before = viewBlocks(render(count)), after = viewBlocks(render(count + 1));
    expect(before.map(b => b.text).join('')).toBe(render(count));
    for (let i = 0; i < Math.floor(count / 4); i++) expect(after[i]).toEqual(before[i]);
  }
});
