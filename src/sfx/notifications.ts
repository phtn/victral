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

export class AudioNotificationControls extends Context.Service<AudioNotificationControls, {
  readonly enabled: Effect.Effect<boolean>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
}>()('victral/sfx/AudioNotificationControls') {}

export class AudioNotifications extends Context.Service<AudioNotifications, AudioNotificationService>()('victral/sfx/AudioNotifications') {
  // Selecting a live layer is a separate opt-in; unmuting cannot enable audio.
  static readonly layerSilent = Layer.succeed(AudioNotifications, {
    settings: Object.freeze(parseAudioSettings({})),
    play: () => Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'silent' }),
    lastFailure: Effect.succeed(undefined),
  });

  static layerLive(settings: unknown = {}, makePlayer: () => SoundPlayer = () => new NativeSoundPlayer()): Layer.Layer<AudioNotifications, ValidationError> {
    return Layer.effect(AudioNotifications, AudioNotifications.make(settings, makePlayer, true));
  }

  static layerControlled(settings: unknown = {}, makePlayer: () => SoundPlayer = () => new NativeSoundPlayer()): Layer.Layer<AudioNotifications | AudioNotificationControls, ValidationError> {
    return Layer.effectContext(Effect.map(AudioNotifications.make(settings, makePlayer, false), audio =>
      Context.make(AudioNotifications, audio).pipe(Context.add(AudioNotificationControls, audio))));
  }

  private static make(settings: unknown, makePlayer: () => SoundPlayer, initiallyEnabled: boolean) {
    return Effect.gen(function*() {
      // Decode before acquiring native resources, including for muted settings.
      const configured = Object.freeze(yield* Effect.try({
        try: () => parseAudioSettings(settings),
        catch: cause => cause instanceof ValidationError ? cause : new ValidationError({
          boundary: 'Audio settings', message: 'Audio settings are invalid.', cause,
        }),
      }));
      let enabled = initiallyEnabled, closed = false, lastFailure: IOError | undefined;
      const active = new Map<AbortController, Promise<void>>();
      const failed = (operation: string, cause: unknown): IOError => {
        const error = new IOError({ operation, cause }); lastFailure = error; return error;
      };
      // The controlled layer acquires no native player until the first enabled cue.
      const acquire = () => {
        try { return Result.succeed(makePlayer()); }
        catch (cause) { return Result.fail(failed('Audio player startup', cause)); }
      };
      const owner = yield* Effect.acquireRelease(
        Effect.sync(() => ({ resource: initiallyEnabled ? acquire() : undefined })),
        owner => Effect.promise(async () => {
          closed = true;
          for (const controller of active.keys()) controller.abort();
          if (owner.resource && Result.isSuccess(owner.resource)) {
            try { await owner.resource.success.close(); } catch (cause) { failed('Audio player cleanup', cause); }
          }
          // close() may only stop the device; await every playback's own cleanup.
          await Promise.allSettled(active.values());
        }),
      );
      return {
        enabled: Effect.sync(() => enabled && !closed),
        setEnabled: (value: boolean) => Effect.suspend(() => {
          if (closed) return Effect.void;
          enabled = value;
          if (value) return Effect.void;
          const pending = [...active.values()];
          for (const controller of active.keys()) controller.abort();
          return Effect.promise(async () => { await Promise.allSettled(pending); });
        }),
        settings: configured,
        lastFailure: Effect.sync(() => lastFailure),
        play: Effect.fn('AudioNotifications.play')((sound: SoundName) => Effect.suspend(() => {
          if (closed) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'closed' });
          if (!enabled) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'silent' });
          if (configured.muted) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'muted' });
          if (configured.volume === 0) return Effect.succeed<AudioPlayback>({ status: 'skipped', reason: 'zero-volume' });
          const resource = owner.resource ??= acquire();
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
      };
    });
  }
}
