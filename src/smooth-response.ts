import { smoothStream, type TextStreamPart } from 'ai';
import type { Message, ModelPort } from './types.js';

// Smooth the presentation only. Native messages, reasoning signatures, tool
// entries, and usage stay in the existing provider/memory pipeline.
export async function smoothResponse(model: ModelPort, messages: Message[], options: Parameters<ModelPort['stream']>[1]) {
  options.signal.throwIfAborted();
  let source!: ReadableStreamDefaultController<TextStreamPart<{}>>;
  let canceled = false;
  const stream = new ReadableStream<TextStreamPart<{}>>({
    start(controller) { source = controller; controller.enqueue({ type: 'text-start', id: 'response' }); },
    cancel() { canceled = true; },
  }).pipeThrough(smoothStream({ delayInMs: 10, chunking: 'word' })({ tools: {} }));
  const reader = stream.getReader();
  const abort = () => { canceled = true; void reader.cancel().catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  const finish = () => {
    if (canceled) return;
    source.enqueue({ type: 'text-end', id: 'response' });
    source.close();
  };
  const result = model.stream(messages, {
    ...options,
    onText(text) {
      if (!canceled && text) source.enqueue({ type: 'text-delta', id: 'response', text });
    },
    onThought(text) {
      if (!canceled) source.enqueue({ type: 'raw', rawValue: text });
    },
  }).then(value => { finish(); return { value }; }, error => { finish(); return { error }; });
  const display = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!options.signal.aborted && value.type === 'text-delta') options.onText(value.text);
      if (!options.signal.aborted && value.type === 'raw') options.onThought(String(value.rawValue));
    }
  })();
  try {
    const [outcome] = await Promise.all([result, display]);
    options.signal.throwIfAborted();
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    options.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
