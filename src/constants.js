export const NODE = 512
export const VIEW = 128_000
export const JOBS = 8
export const TRIES = 5
export const RETRY = 10_000
export const CAP = 30_000
export const MARKS = [50_000, 80_000, 100_000]
export const MODEL = 'muse-spark-1.3-contributor'
export const bytes = (text) => Buffer.byteLength(text, 'utf8')
export function cutBytes(text, limit) {
  const data = Buffer.from(text)
  let end = Math.min(data.length, Math.max(0, Math.floor(limit)))
  // Back up only when the cut lands inside an encoded character. Removing a
  // decoded replacement character also removed genuine U+FFFD from the input.
  if (end < data.length) while (end > 0 && (data[end] & 0xc0) === 0x80) end--
  return data.subarray(0, end).toString('utf8')
}
export function capResult(text) {
  const chars = Array.from(text)
  if (chars.length <= CAP) return text
  const marker = `\n[cut: ${chars.length - CAP} or more characters omitted]\n`
  const keep = CAP - Array.from(marker).length
  return chars.slice(0, Math.ceil(keep / 2)).join('') + marker + chars.slice(-Math.floor(keep / 2)).join('')
}
