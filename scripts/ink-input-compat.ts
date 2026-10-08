/** Keep Ink 8's control-reply filtering while using the Ink 7.1.1 binding.
 * Apply only during compilation; never modify the installed package.
 * Remove when the binding adopts these upstream input fixes.
 */
export function preserveInk8Input(source: string): string {
  const anchor = 'const keypress = parseKeypress(data);';
  if (source.split(anchor).length !== 2) throw new Error('Ink input compatibility anchor changed; review the binding before building.');
  return source.replace(anchor, `const keypress = parseKeypress(data === '\\u001bOM' ? '\\r' : data);
    // Unrecognized CSI/SS3 sequences are terminal replies, not typed text.
    if (/^\\u001b+[\\[O]/.test(data) && !keypress.name) return;`);
}
