import { smoothStream, type TextStreamPart } from 'ai';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { ProviderOutputLimit } from './providers/core.js';
import { toolExitValue, toolPromise } from './tool-effects.js';
import type { Message, ModelPort } from './types.js';

type DisplayOptions = Omit<Parameters<ModelPort['stream']>[1], 'signal'>;

// Smooth presentation only; native messages and saved provider entries keep
// their existing ordering. Both the provider and the display belong to this scope.
export function smoothResponseEffect(model: ModelPort, messages: Message[], options: DisplayOptions) {
  return Effect.scoped(Effect.gen(function*() {
    const resource = yield* Effect.acquireRelease(Effect.sync(() => {
      let source!: ReadableStreamDefaultController<TextStreamPart<{}>>, canceled = false;
      const stream = new ReadableStream<TextStreamPart<{}>>({
        start(controller) { source = controller; controller.enqueue({ type: 'text-start', id: 'response' }); },
        cancel() { canceled = true; },
      }).pipeThrough(smoothStream({ delayInMs: 10, chunking: 'word' })({ tools: {} }));
      const reader = stream.getReader();
      const display = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!canceled && value.type === 'text-delta') options.onText(value.text);
          if (!canceled && value.type === 'raw') options.onThought(String(value.rawValue));
        }
      })();
      // Observe immediately even if a callback throws before Effect awaits it.
      void display.catch(() => {});
      const cancel = async () => { canceled = true; await reader.cancel(); };
      return { reader, display, cancel,
        finish() { if (!canceled) { source.enqueue({ type: 'text-end', id: 'response' }); source.close(); } },
        onText(text: string) { if (!canceled && text) source.enqueue({ type: 'text-delta', id: 'response', text }); },
        onThought(text: string) { if (!canceled) source.enqueue({ type: 'raw', rawValue: text }); },
      };
    }), resource => Effect.promise(async () => {
      try { await resource.cancel(); }
      finally { await resource.display.catch(() => {}); resource.reader.releaseLock(); }
    }));
    const callbacks = { ...options, onText: resource.onText, onThought: resource.onThought };
    const provider = model.effects ? model.effects.stream(messages, callbacks)
      : toolPromise(signal => model.stream(messages, { ...callbacks, signal }));
    const [outcome] = yield* Effect.all([
      Effect.exit(provider.pipe(Effect.onExit(() => Effect.sync(resource.finish)))),
      // Stop the display immediately when interrupted, even if provider cleanup
      // must wait for an already-started persistence callback to finish.
      Effect.tryPromise({ try: () => resource.display, catch: error => error }).pipe(
        Effect.onInterrupt(() => Effect.promise(resource.cancel))),
    ], { concurrency: 2 });
    if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
    return outcome.value;
  }));
}

export async function smoothResponse(model: ModelPort, messages: Message[], options: Parameters<ModelPort['stream']>[1]) {
  const { signal, ...display } = options;
  signal.throwIfAborted();
  // Native providers keep output limits typed. The compatible Promise API
  // recovers only a lone limit, after smoothing and provider cleanup complete.
  const exit = await Effect.runPromiseExit(smoothResponseEffect(model, messages, display), { signal });
  if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
    const reason = exit.cause.reasons[0]!;
    if (Cause.isFailReason(reason) && reason.error instanceof ProviderOutputLimit) return reason.error.result;
  }
  return toolExitValue(exit, signal);
}
