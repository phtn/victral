export const NODE = 512;
export const VIEW = 128_000;
export const JOBS = 8;
export const TRIES = 5;
export const RETRY = 10_000;
export const CAP = 30_000;
export const MARKS = [50_000, 80_000, 100_000];
export const MODEL = 'command-a-plus-05-2026';
export const bytes = text => Buffer.byteLength(text, 'utf8');
export const cutBytes = (text, limit) => Buffer.from(text).subarray(0, limit).toString('utf8').replace(/\uFFFD$/, '');
export function capResult(text) {
  const chars = Array.from(text);
  if (chars.length <= CAP) return text;
  const marker = `\n[cut: ${chars.length - CAP} or more characters omitted]\n`;
  const keep = CAP - Array.from(marker).length;
  return chars.slice(0, Math.ceil(keep / 2)).join('') + marker + chars.slice(-Math.floor(keep / 2)).join('');
}
