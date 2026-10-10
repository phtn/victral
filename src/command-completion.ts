import { COMMANDS } from './session-commands.js';
import { MODEL_INFO, PROVIDERS } from './models.js';
import stringWidth from 'string-width';

export interface CommandCompletion {
  suggestions: string[];
  start: number;
  end: number;
  key: string;
}

// Cursor positions in the composer count Unicode code points; replacement
// ranges count UTF-16 units so string slicing preserves surrounding input.
export function commandCompletion(input: string, cursor = Array.from(input).length): CommandCompletion {
  const before = Array.from(input).slice(0, cursor).join('');
  const tokens = before.split(/\s+/);
  const fragment = tokens.at(-1) ?? '';
  const start = before.length - fragment.length;
  const end = start + (input.slice(start).match(/^\S*/)?.[0].length ?? 0);
  let suggestions: string[] = [];
  const lowered = fragment.toLowerCase();
  if (before.startsWith('/') && !/[\r\n]/.test(input)) {
    if (tokens.length === 1) suggestions = COMMANDS.map(([name]) => name).filter(name => name.startsWith(lowered));
    else if (tokens[0] === '/model') {
      if (tokens.length === 2) suggestions = PROVIDERS.filter(provider => provider.startsWith(lowered));
      if (tokens.length === 3 && PROVIDERS.includes(tokens[1]!.toLowerCase())) {
        suggestions = MODEL_INFO.filter(entry => entry.provider.toLowerCase() === tokens[1]!.toLowerCase()
          && (entry.shortName.startsWith(lowered) || entry.id.startsWith(lowered)
            || String(MODEL_INFO.indexOf(entry) + 1) === fragment)).map(entry => entry.shortName);
      }
    }
  }
  return { suggestions, start, end, key: `${before}\0${end}` };
}

export function completeCommand(input: string, completion: CommandCompletion, selected = 0): { input: string; cursor: number } | undefined {
  const word = completion.suggestions[selected];
  if (!word) return;
  const prefix = input.slice(0, completion.start) + word + ' ';
  const suffix = input.slice(completion.end).replace(/^ +/, '');
  return { input: prefix + suffix, cursor: Array.from(prefix).length };
}

export function completionStatus(completion: CommandCompletion, selected: number, width: number): string {
  const labels = completion.suggestions.map((word, index) => index === selected ? `[${word}]` : word);
  const hint = ' · Tab';
  let first = selected, last = selected + 1;
  // Keep the selected option visible even when the terminal is narrow.
  while (first > 0 && stringWidth(labels.slice(first - 1, last).join(' | ') + hint) <= width) first--;
  while (last < labels.length && stringWidth(labels.slice(first, last + 1).join(' | ') + hint) <= width) last++;
  return labels.slice(first, last).join(' | ') + hint;
}
