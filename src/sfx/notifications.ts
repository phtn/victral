import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Result from 'effect/Result';
import { IOError, ValidationError } from '../core/errors.js';
import type { SoundName } from './patch.js';
import { NativeSoundPlayer, type SoundPlayer } from './player.js';
import { parseAudioSettings, type AudioSettings } from './settings.js';

export type AudioPlayback =
  | { readonly status: 'played' }
  | { readonly status: 'skipped'; readonly reason: 'silent' | 'muted' | 'zero-volume' | 'unavailable' | 'closed' }
  | { readonly status: 'failed'; readonly error: IOError };

export interface AudioNotificationService {
  readonly settings: Readonly<AudioSettings>;
  readonly play: (sound: SoundName) => Effect.Effect<AudioPlayback>;
  // Internal diagnostic only: display publicFailureMessage, never the cause.
  readonly lastFailure: Effect.Effect<IOError | undefined>;
}

export class AudioNotifications extends Context.Service<AudioNotifications, AudioNotificationService>()('victral/sfx/AudioNotifications') {
  // Selecting a live layer is a separate opt-in; unmuting cannot enable audio.
  static readonly layerSilent = Layer.succeed(AudioNotifications, {
    settings: Object.freeze(parseAudioSettings({})),
    play: () => Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'silent' }),
    lastFailure: Effect.succeed(undefined),
  });

  static layerLive(settings: unknown = {}, makePlayer: () => SoundPlayer = () => new NativeSoundPlayer()): Layer.Layer<AudioNotifications, ValidationError> {
    return Layer.effect(AudioNotifications, Effect.gen(function*() {
      // Decode before acquiring native resources, including for muted settings.
      const configured = Object.freeze(yield* Effect.try({
        try: () => parseAudioSettings(settings),
        catch: cause => cause instanceof ValidationError ? cause : new ValidationError({
          boundary: 'Audio settings', message: 'Audio settings are invalid.', cause,
        }),
      }));
      let closed = false, lastFailure: IOError | undefined;
      const active = new Map<AbortController, Promise<void>>();
      const failed = (operation: string, cause: unknown): IOError => {
        const error = new IOError({ operation, cause }); lastFailure = error; return error;
      };
      const resource = yield* Effect.acquireRelease(
        // Device discovery failure degrades audio, without failing the session.
        Effect.result(Effect.try({ try: makePlayer, catch: cause => failed('Audio player startup', cause) })),
        resource => Effect.promise(async () => {
          closed = true;
          for (const controller of active.keys()) controller.abort();
          if (Result.isSuccess(resource)) {
            try { await resource.success.close(); } catch (cause) { failed('Audio player cleanup', cause); }
          }
          // close() may only stop the device; await every playback's own cleanup.
          await Promise.allSettled(active.values());
        }),
      );
      return {
        settings: configured,
        lastFailure: Effect.sync(() => lastFailure),
        play: Effect.fn('AudioNotifications.play')((sound: SoundName) => Effect.suspend(() => {
          if (closed) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'closed' });
          if (configured.muted) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'muted' });
          if (configured.volume === 0) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'zero-volume' });
          if (Result.isFailure(resource)) return Effect.succeed<AudioPlayback>({ status: 'failed', error: resource.failure });
          const player = resource.success;
          if (!player.available) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'unavailable' });
          return Effect.callback<AudioPlayback>((resume, signal) => {
            const controller = new AbortController();
            const stop = () => controller.abort();
            signal.addEventListener('abort', stop, { once: true });
            if (signal.aborted) stop();
            // Defer the call so even synchronous throws enter the same adapter.
            const work = Promise.resolve().then(() => {
              controller.signal.throwIfAborted();
              return player.play(sound, configured.volume, controller.signal);
            }).then(
              () => resume(controller.signal.aborted ? Effect.interrupt : Effect.succeed<AudioPlayback>({ status: 'played' })),
              cause => resume(controller.signal.aborted ? Effect.interrupt : Effect.succeed<AudioPlayback>({
                status: 'failed', error: failed('Audio playback', cause),
              })),
            ).finally(() => { signal.removeEventListener('abort', stop); active.delete(controller); });
            active.set(controller, work);
            // Effect.callback aborts the signal before running this finalizer.
            // Interruption must await native cleanup, not just abandon the wait.
            return Effect.promise(() => work);
          });
        })),
      } satisfies AudioNotificationService;
    }));
  }
}
