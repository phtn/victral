export const httpURL = (value: unknown): URL => {
  if (typeof value !== 'string') throw new Error('Expected an absolute HTTP(S) URL.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) URL without embedded credentials.');
  return url;
};
