import { afterEach, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Scope from 'effect/Scope';
import { AudioNotifications } from '../src/sfx/notifications.js';
import type { SoundPlayer } from '../src/sfx/player.js';
import type { SoundName } from '../src/sfx/patch.js';
import { workflowAudioObserver } from '../src/sfx/workflow.js';
import type { ValidationError } from '../src/core/errors.js';

const runtimes: ManagedRuntime.ManagedRuntime<AudioNotifications, ValidationError>[] = [], scopes: Scope.Closeable[] = [];
afterEach(async () => {
  await Promise.all(scopes.splice(0).map(scope => Effect.runPromise(Scope.close(scope, Exit.void))));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(settings: unknown = { volume: 0.4, muted: false }, play?: SoundPlayer['play']) {
  const played: Array<{ sound: SoundName; volume: number }> = [];
  const player: SoundPlayer = { backend: 'fake', available: true, async close() {}, play(sound, volume, signal) { played.push({ sound, volume }); return play?.(sound, volume, signal) ?? Promise.resolve(); } };
  const runtime = ManagedRuntime.make(AudioNotifications.layerLive(settings, () => player)); runtimes.push(runtime);
  const audio = await runtime.runPromise(AudioNotifications), scope = Scope.makeUnsafe(); scopes.push(scope);
  let time = 1000;
  return { played, audio, runtime, scope, tick() { time += 300; }, observe: workflowAudioObserver(audio, scope, () => time) };
}

test('workflow audio maps typed turn outcomes once, caps onset frequency and keeps volume', async () => {
  const f = await fixture();
  f.observe({ operationId: 'turn-1', kind: 'turn', status: 'processing' });
  f.observe({ operationId: 'turn-1', kind: 'turn', status: 'processing' });
  f.observe({ operationId: 'model-1', kind: 'model', status: 'processing' });
  f.observe({ operationId: 'tool-1', kind: 'tool', status: 'completed' });
  f.observe({ operationId: 'turn-2', kind: 'turn', status: 'processing' }); // Rate limited.
  await Bun.sleep(0); f.tick();
  f.observe({ operationId: 'turn-1', kind: 'turn', status: 'retry' }); await Bun.sleep(0);
  f.observe({ operationId: 'turn-1', kind: 'turn', status: 'completed' });
  f.observe({ operationId: 'turn-2', kind: 'turn', status: 'failed' });
  f.observe({ operationId: 'turn-3', kind: 'turn', status: 'canceled' });
  await Bun.sleep(0);
  expect(f.played).toEqual((['processing', 'retry', 'success', 'error', 'close'] as const).map(sound => ({ sound, volume: 0.4 })));
});

test('muted workflow notifications never invoke the fake player', async () => {
  const f = await fixture({ volume: 0.4, muted: true });
  f.observe({ operationId: 'turn', kind: 'turn', status: 'processing' });
  f.observe({ operationId: 'turn', kind: 'turn', status: 'completed' }); await Bun.sleep(0);
  expect(f.played).toEqual([]);
});

test('processing playback follows turn cancellation and scope closure drains its cleanup', async () => {
  const started = deferred(), aborted = deferred(), cleanup = deferred(); let drained = false;
  const f = await fixture(undefined, async (_sound, _volume, signal) => {
    signal.addEventListener('abort', aborted.resolve, { once: true }); started.resolve();
    await cleanup.promise; drained = true; signal.throwIfAborted();
  });
  const controller = new AbortController();
  f.observe({ operationId: 'turn', kind: 'turn', status: 'processing' }, controller.signal);
  await started.promise; controller.abort(); await aborted.promise;
  let closed = false;
  const pending = Effect.runPromise(Scope.close(f.scope, Exit.void)).then(() => { closed = true; });
  expect(closed).toBe(false); expect(drained).toBe(false); cleanup.resolve(); await pending;
  expect(drained).toBe(true); expect(closed).toBe(true);
});

test('playback failure has no recursive error cue or workflow retry', async () => {
  const f = await fixture(undefined, async () => { throw new Error('private player failure'); });
  f.observe({ operationId: 'turn', kind: 'turn', status: 'completed' }); await Bun.sleep(0);
  expect(f.played).toEqual([{ sound: 'success', volume: 0.4 }]);
  expect(await f.runtime.runPromise(f.audio.lastFailure)).toBeDefined();
});
