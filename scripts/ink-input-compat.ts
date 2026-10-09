/** Keep Ink 8's control-reply filtering, route wheel events, and expose left clicks.
 * Apply only during compilation; never modify the installed package.
 * Revisit when the binding adopts upstream input fixes or native mouse support.
 */
export function preserveInk8Input(source: string): string {
  const anchor = 'const keypress = parseKeypress(data);';
  if (source.split(anchor).length !== 2) throw new Error('Ink input compatibility anchor changed; review the binding before building.');
  const handler = 'inputHandler(input, key);';
  if (source.split(handler).length !== 2) throw new Error('Ink input handler changed; review mouse handling before building.');
  return source.replace(anchor, `// Translate SGR wheel presses to the workspace's line-scroll shortcuts.
    const wheel = /^\\u001b\\[<(\\d+);\\d+;\\d+M$/.exec(data);
    if (wheel && (Number(wheel[1]) & 0xc3) === 64) data = '\\u001b[1;2A';
    else if (wheel && (Number(wheel[1]) & 0xc3) === 65) data = '\\u001b[1;2B';
    const mousePress = /^\\u001b\\[<0;\\d+;\\d+M$/.test(data);
    const keypress = parseKeypress(data === '\\u001bOM' ? '\\r' : data);
    // Unrecognized CSI/SS3 sequences are terminal replies, not typed text.
    if (/^\\u001b+[\\[O]/.test(data) && !keypress.name && !mousePress) return;`)
    .replace(handler, 'inputHandler(mousePress ? data : input, key);');
}
