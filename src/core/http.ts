import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import { TimeoutError } from './errors.js';

export class HttpFailure extends Schema.TaggedError<HttpFailure>()('HttpFailure', {
  reason: Schema.Literals(['request', 'body', 'limit', 'response']),
  message: Schema.String, cause: Schema.Defect(),
}) {}

const ResponseCancellation = Context.Reference<() => void>('victral/core/Http/ResponseCancellation', { defaultValue: () => () => {} });

export interface HttpService {
  readonly withResponse: <A, E, R>(url: string, timeoutMs: number,
    consume: (response: Response) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | HttpFailure | TimeoutError, Exclude<R, Scope.Scope>>;
}

// Consume body bytes inside the response scope; only inert metadata may escape.
export class Http extends Context.Service<Http, HttpService>()('victral/core/Http') {
  static service(fetchImpl: typeof fetch = fetch): HttpService {
    return {
      withResponse: (url, timeoutMs, consume) => Effect.scoped(Effect.gen(function*() {
        const controller = new AbortController();
        let request: Promise<Response> | undefined, response: Response | undefined;
        yield* Effect.addFinalizer(() => Effect.tryPromise({
          try: async () => {
            controller.abort();
            // A fetch can resolve concurrently with interruption. Drain acquisition
            // and dispose even a late body before completing the canceled operation.
            if (request) { try { response = await request; } catch { /* Request failure is already in the effect. */ } }
            if (response?.body && !response.body.locked && !response.bodyUsed) await response.body.cancel();
          },
          catch: cause => new HttpFailure({ reason: 'body', message: 'Web response cleanup failed.', cause }),
        }).pipe(Effect.orDie));
        response = yield* Effect.tryPromise({
          try: signal => {
            request = Promise.resolve().then(() => {
              const requestSignal = AbortSignal.any([signal, controller.signal]);
              requestSignal.throwIfAborted();
              return fetchImpl(url, { signal: requestSignal, redirect: 'follow' });
            });
            return request;
          },
          catch: cause => new HttpFailure({ reason: 'request', message: 'Web request failed.', cause }),
        });
        return yield* consume(response).pipe(Effect.provideService(ResponseCancellation, () => controller.abort()));
      })).pipe(Effect.timeoutOrElse({ duration: timeoutMs,
        orElse: () => Effect.fail(new TimeoutError({ operation: 'Web request', cause: undefined })),
      })),
    };
  }
  static layer(fetchImpl: typeof fetch = fetch): Layer.Layer<Http> { return Layer.succeed(Http, Http.service(fetchImpl)); }
}

// Reader cancellation unblocks a pending read, and is awaited before releaseLock.
// Register the finalizer atomically with getReader, including on parsing failures.
export const readResponseBytes = Effect.fn('Http.readResponseBytes')(function*(response: Response, maxBytes?: number) {
  if (!response.body && maxBytes === undefined) return new Uint8Array(0);
  const abort = yield* ResponseCancellation;
  const reader = yield* Effect.acquireRelease(
    Effect.try({ try: () => {
      if (!response.body) throw new Error('Web response has no body.');
      return response.body.getReader();
    }, catch: cause => new HttpFailure({ reason: 'body', message: 'Web response has no body.', cause }) }),
    reader => Effect.tryPromise({ try: async () => {
      abort();
      await cancelResponseReader(reader);
    }, catch: cause => new HttpFailure({ reason: 'body', message: 'Web response cleanup failed.', cause }) }).pipe(Effect.orDie),
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = yield* Effect.tryPromise({ try: () => reader.read(),
      catch: cause => new HttpFailure({ reason: 'body', message: 'Web response read failed.', cause }) });
    if (chunk.done) break;
    size += chunk.value.length;
    if (maxBytes !== undefined && size > maxBytes) return yield* Effect.fail(new HttpFailure({
      reason: 'limit', message: 'Page exceeds the 2 MB browsing limit.', cause: undefined,
    }));
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
});

// Canceling an errored stream repeats its stored error; preserve the original
// typed read failure/interruption rather than fabricating a cleanup defect.
export async function cancelResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel(); }
  catch (cause) {
    let stored: unknown;
    try { await reader.closed; } catch (error) { stored = error; }
    if (stored !== cause) throw cause;
  } finally { reader.releaseLock(); }
}
