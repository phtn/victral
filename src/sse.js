// Parse event-stream data across arbitrary UTF-8 and line-ending boundaries.
// Keep the scan cursor so large fragmented frames are not rescanned per chunk.
export async function* sseData(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  const newline = /\r\n|[\r\n]/g;
  let buffer = '', scanned = 0, skipLF = false, data = [];
  const line = text => {
    if (text === '') {
      const payload = data.length ? data.join('\n') : undefined;
      data = [];
      return payload;
    }
    if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      if (skipLF && buffer.length) {
        if (buffer.startsWith('\n')) buffer = buffer.slice(1);
        skipLF = false;
      }
      newline.lastIndex = scanned;
      let start = 0, match;
      while ((match = newline.exec(buffer))) {
        // Process CR immediately; swallow its optional LF in the next chunk.
        // This also lets CR-only terminal events finish on an open connection.
        skipLF = match[0] === '\r' && newline.lastIndex === buffer.length;
        const payload = line(buffer.slice(start, match.index));
        start = newline.lastIndex;
        if (payload !== undefined) yield payload;
      }
      scanned = buffer.length - start;
      buffer = buffer.slice(start);
      if (chunk.done) {
        if (buffer) line(buffer);
        // Preserve the adapters' support for a final unterminated data frame.
        if (data.length) yield data.join('\n');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
