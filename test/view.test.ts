import { test, expect } from 'bun:test';
import { viewBlocks } from '../src/view.js';

test('view block marks preserve text exactly and split only at line ends', () => {
  const view = '<chat>\n' + '0+1|summary\n'.repeat(10_000) + '</chat>';
  const blocks = viewBlocks(view);
  expect(blocks).toHaveLength(4);
  expect(blocks.map(block => block.text).join('')).toBe(view);
  for (const block of blocks.slice(0, -1)) expect(block.text.endsWith('\n')).toBe(true);
});
