import { marked, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import stringWidth from 'string-width';
import { safeText } from './terminal-text.js';

export interface MarkdownSpan {
  text: string;
  bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean;
  color?: string;
}
export interface MarkdownLine { spans: MarkdownSpan[] }
type Style = Omit<MarkdownSpan, 'text'>;
const accent = '#5aa9ff', codeColor = '#e5c07b', muted = '#8b949e';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const textSpan = (text: string, style: Style = {}): MarkdownSpan => ({ ...style, text: safeText(text) });

function inline(tokens: Token[], style: Style = {}): MarkdownSpan[] {
  return tokens.flatMap((token): MarkdownSpan[] => {
    switch (token.type) {
      case 'strong': return inline(token.tokens!, { ...style, bold: true });
      case 'em': return inline(token.tokens!, { ...style, italic: true });
      case 'del': return inline(token.tokens!, { ...style, strikethrough: true });
      case 'codespan': return [textSpan(decodeHTML(token.text), { ...style, color: codeColor })];
      case 'br': return [textSpan('\n', style)];
      case 'link': {
        const label = inline(token.tokens!, { ...style, color: accent, underline: true });
        const href = safeText(decodeHTML(token.href));
        return label.map(s => s.text).join('') === href ? label : [...label, textSpan(` (${href})`, { ...style, color: muted })];
      }
      case 'image': return [textSpan(`${decodeHTML(token.text) || 'Image'} (${decodeHTML(token.href)})`, style)];
      case 'text':
        return token.tokens ? inline(token.tokens, style) : [textSpan(decodeHTML(token.text).replace(/\n/g, ' '), style)];
      case 'escape': return [textSpan(decodeHTML(token.text), style)];
      // HTML is shown literally; it never becomes markup or terminal escapes.
      default: return [textSpan('text' in token ? token.text : token.raw, style)];
    }
  });
}

// Keep formatting while wrapping to terminal columns, with intact graphemes
// and word boundaries. Code uses literal line breaks and indentation.
function wrap(spans: MarkdownSpan[], width: number, literal = false): MarkdownLine[] {
  width = Math.max(1, width);
  const lines: MarkdownLine[] = [];
  let current: MarkdownSpan[] = [], columns = 0;
  const flush = () => { lines.push({ spans: current }); current = []; columns = 0; };
  for (const span of spans) {
    for (const part of span.text.split(/(\n|[^\S\n]+|[^\s]+)/).filter(Boolean)) {
      if (part === '\n') { flush(); continue; }
      const isSpace = /^\s+$/.test(part);
      if (!literal && !isSpace && columns && columns + stringWidth(part) > width) flush();
      if (!literal && isSpace && (!columns || columns + stringWidth(part) > width)) continue;
      for (const { segment } of graphemes.segment(part)) {
        const size = stringWidth(segment);
        if (columns + size > width && columns) flush();
        if (size > width) continue;
        const last = current.at(-1);
        if (last && last.bold === span.bold && last.italic === span.italic && last.underline === span.underline && last.strikethrough === span.strikethrough && last.color === span.color) last.text += segment;
        else current.push({ ...span, text: segment });
        columns += size;
      }
    }
  }
  flush();
  return lines;
}
const blank = (): MarkdownLine => ({ spans: [] });
const lineText = (line: MarkdownLine) => line.spans.map(s => s.text).join('');
const isBlank = (line: MarkdownLine) => !lineText(line).trim();
function prefix(lines: MarkdownLine[], first: string, rest = first): MarkdownLine[] {
  return lines.map((line, index) => ({ spans: [textSpan(index === 0 ? first : rest, { color: muted }), ...line.spans] }));
}

function table(token: Tokens.Table, width: number): MarkdownLine[] {
  const cells = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens)));
  const count = token.header.length;
  // Wide tables become labeled records in a narrow terminal.
  if (width < count * 7 + 1) {
    return cells.slice(1).flatMap(row => [
      ...row.flatMap((cell, index) => wrap([
        ...cells[0]![index]!.map(span => ({ ...span, bold: true })), textSpan(': '), ...cell,
      ], width)), blank(),
    ]);
  }
  const available = width - count * 3 - 1;
  const sizes = token.header.map((_, index) => Math.max(3, ...cells.map(row => stringWidth(row[index]!.map(s => s.text).join('')))));
  while (sizes.reduce((a, b) => a + b, 0) > available) {
    const largest = sizes.indexOf(Math.max(...sizes));
    sizes[largest]!--;
  }
  const border = (): MarkdownLine => ({ spans: [textSpan(`├${sizes.map(size => '─'.repeat(size + 2)).join('┼')}┤`, { color: muted })] });
  const lines: MarkdownLine[] = [];
  cells.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, index) => wrap(cell.map(span => ({ ...span, bold: rowIndex === 0 || span.bold })), sizes[index]!));
    const height = Math.max(...wrapped.map(cell => cell.length));
    for (let i = 0; i < height; i++) {
      const spans: MarkdownSpan[] = [textSpan('│', { color: muted })];
      wrapped.forEach((cell, index) => {
        const content = cell[i]?.spans ?? [];
        const padding = sizes[index]! - stringWidth(content.map(s => s.text).join(''));
        const align = token.align[index];
        const left = align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0;
        spans.push(textSpan(' '.repeat(left + 1)), ...content, textSpan(' '.repeat(padding - left + 1) + '│', { color: muted }));
      });
      lines.push({ spans });
    }
    if (rowIndex === 0) lines.push(border());
  });
  return lines;
}

function blocks(tokens: Token[], width: number, tight = false): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  for (const token of tokens) {
    let content: MarkdownLine[];
    switch (token.type) {
      case 'space': if (lines.length && !isBlank(lines.at(-1)!)) lines.push(blank()); continue;
      case 'def': case 'checkbox': continue;
      case 'heading': content = wrap(inline(token.tokens!, { bold: true, color: accent }), width); break;
      case 'paragraph': case 'text':
        content = wrap(token.tokens ? inline(token.tokens) : [textSpan(decodeHTML(token.text))], width); break;
      case 'code': {
        const inset = width >= 4 ? 2 : 0;
        content = [
          ...wrap([textSpan(token.lang?.split(/\s/)[0] || 'code', { color: muted })], width),
          ...prefix(wrap([textSpan(token.text, { color: codeColor })], width - inset, true), ' '.repeat(inset)),
        ]; break;
      }
      case 'blockquote': content = prefix(blocks(token.tokens!, Math.max(1, width - 2)), '│ '); break;
      case 'list': {
        const list = token as Tokens.List;
        content = list.items.flatMap((item, index) => {
          const bullet = item.task ? (item.checked ? '☑ ' : '☐ ') : list.ordered ? `${Number(list.start) + index}. ` : '• ';
          const inset = stringWidth(bullet);
          const itemLines = blocks(item.tokens, Math.max(1, width - inset), !item.loose);
          while (itemLines.length && isBlank(itemLines.at(-1)!)) itemLines.pop();
          return prefix(itemLines, bullet, ' '.repeat(inset));
        }); break;
      }
      case 'table': content = table(token as Tokens.Table, width); break;
      case 'hr': content = [{ spans: [textSpan('─'.repeat(width), { color: muted })] }]; break;
      default: content = wrap([textSpan('text' in token ? token.text : token.raw)], width);
    }
    if (!tight && lines.length && !isBlank(lines.at(-1)!)) lines.push(blank());
    lines.push(...content);
  }
  return lines;
}

export function markdownLines(markdown: string, width: number): MarkdownLine[] {
  // Sanitize both before lexing and after entity decoding.
  const lines = blocks(marked.lexer(safeText(markdown), { gfm: true }), Math.max(1, width));
  while (lines.length && isBlank(lines.at(-1)!)) lines.pop();
  return lines;
}
