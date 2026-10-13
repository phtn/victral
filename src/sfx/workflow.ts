import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import type { AudioNotificationService } from './notifications.js';
import type { SoundName } from './patch.js';
import type { WorkflowEvent, WorkflowObserver } from '../workflow-events.js';

const sounds: Record<WorkflowEvent['status'], SoundName> = {
  processing: 'processing', completed: 'success', failed: 'error', canceled: 'close', retry: 'retry',
};
// Audio observes typed turn outcomes; it never parses presentation or saved text.
// Model/tool events remain available to other observers without producing a cue
// on every request or nested read. The installed Session layer remains silent.
export function workflowAudioObserver(audio: AudioNotificationService, scope: Scope.Scope, now = () => performance.now()): WorkflowObserver {
  const seen = new Set<string>();
  let lastOnset = -Infinity;
  return (event, signal) => {
    if (event.kind !== 'turn' && event.kind !== 'worker' && event.kind !== 'evaluation') return;
    const key = `${event.operationId}:${event.status}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1024) seen.delete(seen.values().next().value!);
    if (event.status === 'processing' || event.status === 'retry') {
      if (now() - lastOnset < 250) return;
      lastOnset = now();
    }
    try {
      const playback = Effect.suspend(() => audio.play(sounds[event.status]));
      const interrupted = signal && event.status === 'processing' ? Effect.callback<never>(resume => {
        const abort = () => resume(Effect.interrupt);
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        return Effect.sync(() => signal.removeEventListener('abort', abort));
      }) : undefined;
      // Session/job scope drains playback on shutdown; processing follows its
      // turn cancellation. A terminal cancellation cue has its own short lifetime.
      const effect = (interrupted ? Effect.raceFirst(playback, interrupted) : playback).pipe(Effect.catchCause(() => Effect.void));
      Effect.runSync(Effect.forkIn(effect, scope, { startImmediately: true }));
    } catch { /* Observer failure cannot fail or retry an agent task. */ }
  };
}
