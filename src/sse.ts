import * as Effect from 'effect/Effect';
import { acquireResponseReader, cancelResponseReader, HttpFailure } from './core/http.js';

// The original scan cursor, CR/LF handling and final-frame support are unchanged.
class SseFramer {
  private readonly decoder = new TextDecoder();
  private readonly newline = /\r\n|[\r\n]/g;
  private buffer = '';
  private scanned = 0;
  private skipLF = false;
  private data: string[] = [];
  private line(text: string): string | undefined {
    if (text === '') {
      const payload = this.data.length ? this.data.join('\n') : undefined;
      this.data = [];
      return payload;
    }
    if (text.startsWith('data:')) this.data.push(text.slice(5).replace(/^ /, ''));
  }
  *write(chunk: { done: boolean; value?: Uint8Array }): Generator<string> {
    let { buffer, scanned, skipLF } = this;
    const { decoder, newline } = this;
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
      const payload = this.line(buffer.slice(start, match.index));
      start = newline.lastIndex;
      if (payload !== undefined) yield payload;
    }
    scanned = buffer.length - start;
    buffer = buffer.slice(start);
    if (chunk.done) {
      if (buffer) this.line(buffer);
      // Preserve the adapters' support for a final unterminated data frame.
      if (this.data.length) yield this.data.join('\n');
    }
    this.buffer = buffer; this.scanned = scanned; this.skipLF = skipLF;
  }
}

// Compatibility iterator for framing tests and non-Effect consumers.
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), framer = new SseFramer();
  try {
    for (;;) {
      const chunk = await reader.read();
      yield* framer.write(chunk);
      if (chunk.done) break;
    }
  } finally { await cancelResponseReader(reader); }
}

// false stops at a terminal event, without awaiting EOF or reading another frame.
export const consumeSse = Effect.fn('Sse.consume')(function*<E, R>(response: Response,
  event: (payload: string) => Effect.Effect<boolean, E, R>) {
  const reader = yield* acquireResponseReader(response), framer = new SseFramer();
  for (;;) {
    const chunk = yield* Effect.tryPromise({ try: () => reader.read(),
      catch: cause => new HttpFailure({ reason: 'body', message: 'Response stream read failed.', cause }) });
    for (const payload of framer.write(chunk)) if (!(yield* event(payload))) return;
    if (chunk.done) return;
  }
});
