import * as Effect from 'effect/Effect';
import { IOError } from './errors.js';
import { cancelResponseReader } from './http.js';
import type { McpFactoryContext } from './mcp.js';

// The SDK owns parsing/protocol behavior. This wrapper owns only the underlying
// fetch and byte reader, since SDK close() aborts but does not drain detached SSE.
export const acquireMcpFetch = Effect.fn('Mcp.acquireFetch')(function*(context: McpFactoryContext, fetchImpl: typeof fetch = fetch) {
  const controller = new AbortController();
  const outstanding = new Set<() => Promise<void>>();
  const cleanupFailures: unknown[] = [];
  yield* Effect.addFinalizer(() => Effect.tryPromise({ try: async () => {
    controller.abort();
    const exits = await Promise.allSettled([...outstanding].map(close => close()));
    const errors = [...cleanupFailures, ...exits.flatMap(exit => exit.status === 'rejected' ? [exit.reason] : [])];
    if (errors.length) throw new AggregateError([...new Set(errors)], 'MCP HTTP cleanup failed.');
  }, catch: cause => new IOError({ operation: 'MCP HTTP cleanup', cause }) }).pipe(Effect.orDie));

  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestSignal = context.requests.getStore();
    const signals = [controller.signal, context.signal, init?.signal, requestSignal].filter((signal): signal is AbortSignal => !!signal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    let stopBody: (() => Promise<void>) | undefined;
    const work = Promise.resolve().then(() => fetchImpl(url, { ...init, signal }));
    // Register acquisition immediately, including fetches that resolve after abort.
    const close = async () => {
      try { await work; } catch { return; }
      if (stopBody) await stopBody();
    };
    outstanding.add(close);
    if (requestSignal) {
      let hooks = context.nativeCleanup.get(requestSignal);
      if (!hooks) context.nativeCleanup.set(requestSignal, hooks = new Set());
      hooks.add(close);
    }
    const forget = () => {
      outstanding.delete(close);
      if (requestSignal) context.nativeCleanup.get(requestSignal)?.delete(close);
    };
    try {
      const response = await work;
      if (!response.body) { forget(); return response; }
      const reader = response.body.getReader();
      let streamController!: ReadableStreamDefaultController<Uint8Array>, stopped: Promise<void> | undefined, done = false;
      const release = () => { signal.removeEventListener('abort', abort); forget(); };
      stopBody = () => stopped ??= (async () => {
        if (done) return;
        done = true;
        try {
          await cancelResponseReader(reader);
          try { streamController.close(); } catch { /* Consumer cancellation already closed the wrapper. */ }
        }
        catch (cause) { cleanupFailures.push(cause); try { streamController.error(cause); } catch { /* Already closed by the consumer. */ } throw cause; }
        finally { release(); }
      })();
      const abort = () => { void stopBody!().catch(() => {}); };
      const body = new ReadableStream<Uint8Array>({
        start(value) { streamController = value; },
        async pull(value) {
          try {
            const chunk = await reader.read();
            if (done) return;
            if (chunk.done) { done = true; reader.releaseLock(); release(); value.close(); }
            else value.enqueue(chunk.value);
          } catch (cause) {
            if (done) return;
            done = true; reader.releaseLock(); release(); value.error(cause);
          }
        },
        cancel: () => stopBody!(),
      }, { highWaterMark: 0 });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) await stopBody();
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      // Response constructors do not preserve redirect metadata used by the SDK.
      for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(wrapped, key, { value: response[key] });
      return wrapped;
    } catch (cause) { forget(); throw cause; }
  };
});
