import { test, expect } from 'bun:test';
import stringWidth from 'string-width';
import { markdownLines } from '../src/markdown.js';

const text = (markdown: string, width = 80) => markdownLines(markdown, width).map(line => line.spans.map(span => span.text).join('')).join('\n');
test('Markdown renders nested inline styles, headings, links, and decoded entities', () => {
  const lines = markdownLines('# Result\n\n**Bold and *italic*** with `code` &amp; [docs](https://example.com).', 80);
  const spans = lines.flatMap(line => line.spans);
  expect(spans.some(span => span.text === 'Result' && span.bold)).toBe(true);
  expect(spans.some(span => span.text === 'italic' && span.bold && span.italic)).toBe(true);
  expect(spans.some(span => span.text === 'docs' && span.underline)).toBe(true);
  const rendered = lines.map(line => line.spans.map(span => span.text).join('')).join('\n');
  expect(rendered).toContain('with code & docs (https://example.com).');
  expect(rendered).not.toContain('**');
});
test('Markdown renders task lists, nested bullets, quotes, and unfinished fences', () => {
  const output = text('- [x] Done\n- [ ] Pending\n  - Child\n\n> Decision\n\n```ts\n  const x = "&amp;";');
  expect(output).toContain('☑ Done\n☐ Pending\n  • Child');
  expect(output).toContain('│ Decision');
  expect(output).toContain('    const x = "&amp;";');
  expect(output).not.toContain('```');
  // Partial inline syntax must still be readable until its closing token arrives.
  expect(text('Hello **part')).toContain('Hello **part');
  expect(text('Hello **part**')).toBe('Hello part');
});
test('Markdown tables and Unicode wrap within the viewport, including narrow layouts', () => {
  const md = '| Name | State |\n| --- | --- |\n| 👩‍💻 muse | Streaming |\n\n- **Long Unicode 👩‍💻 文 words**\n\n```\n  ab👩‍💻文cd\n```';
  for (const width of [78, 42, 16, 10]) {
    const lines = markdownLines(md, width);
    expect(lines.every(line => stringWidth(line.spans.map(span => span.text).join('')) <= width)).toBe(true);
    expect(lines.map(line => line.spans.map(span => span.text).join('')).join('\n')).toContain('👩‍💻');
  }
  expect(text(md, 10)).toContain('State:');
});
test('Markdown cannot introduce terminal escapes through raw content, HTML, or entities', () => {
  const output = text('**\x1b[31mRed\x1b[0m** &#27;[31m [docs](https://example.com/&#27;)\n\n<script>literal</script>');
  expect(output).not.toContain('\x1b');
  expect(output).toContain('Red');
  expect(output).toContain('<script>literal</script>');
});
