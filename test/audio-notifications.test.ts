import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { IOError, ValidationError, publicFailureMessage } from '../src/core/errors.js';
import { AudioNotifications } from '../src/sfx/notifications.js';
import { NativeSoundPlayer, type SoundPlayer } from '../src/sfx/player.js';
import type { SoundName } from '../src/sfx/patch.js';

const runtimes: ManagedRuntime.ManagedRuntime<AudioNotifications, ValidationError>[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });
function runtime(layer: Layer.Layer<AudioNotifications, ValidationError> = AudioNotifications.layerSilent) {
  const value = ManagedRuntime.make(layer); runtimes.push(value); return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(play?: SoundPlayer['play'], close?: SoundPlayer['close'], available = true) {
  const played: { sound: SoundName; volume: number }[] = [];
  let acquired = 0, closed = 0;
  const player: SoundPlayer = { available, backend: 'silent test', play(sound, volume, signal) {
    played.push({ sound, volume }); return play?.(sound, volume, signal) ?? Promise.resolve();
  }, async close() { closed++; await close?.(); } };
  return { make: () => { acquired++; return player; }, played, acquired: () => acquired, closed: () => closed };
}
function cue(owner: ManagedRuntime.ManagedRuntime<AudioNotifications, ValidationError>, sound: SoundName, signal?: AbortSignal) {
  return owner.runPromiseExit(Effect.flatMap(AudioNotifications, audio => audio.play(sound)), { signal });
}
function heldCue() {
  const started = deferred(), aborted = deferred(), finish = deferred();
  let signal: AbortSignal | undefined;
  return { started, aborted, finish, signal: () => signal, async play(value: AbortSignal) {
    signal = value; value.addEventListener('abort', aborted.resolve, { once: true }); started.resolve();
    try { await finish.promise; value.throwIfAborted(); }
    finally { value.removeEventListener('abort', aborted.resolve); }
  } };
}

test('the default notification layer stays silent even with unmuted defaults', async () => {
  const owner = runtime(), audio = await owner.runPromise(AudioNotifications);
  expect(audio.settings).toEqual({ volume: 0.5, muted: false }); expect(Object.isFrozen(audio.settings)).toBe(true);
  for (const sound of ['processing', 'success', 'error'] as const) {
    expect(await owner.runPromise(audio.play(sound))).toEqual({ status: 'skipped', reason: 'silent' });
  }
  expect(await owner.runPromise(audio.lastFailure)).toBeUndefined();
});

test('live notification acquisition is lazy, shared across cues, and closed once at session disposal', async () => {
  const fake = fixture(), owner = runtime(AudioNotifications.layerLive({ volume: 0.25 }, fake.make));
  expect(fake.acquired()).toBe(0);
  const audio = await owner.runPromise(AudioNotifications);
  expect(fake.acquired()).toBe(1); expect(fake.played).toHaveLength(0);
  expect(await owner.runPromise(audio.play('processing'))).toEqual({ status: 'played' });
  expect(await owner.runPromise(audio.play('success'))).toEqual({ status: 'played' });
  expect(await owner.runPromise(AudioNotifications)).toBe(audio);
  expect(fake.played).toEqual([{ sound: 'processing', volume: 0.25 }, { sound: 'success', volume: 0.25 }]);
  expect(fake.acquired()).toBe(1); expect(fake.closed()).toBe(0);
  await owner.dispose(); await owner.dispose(); expect(fake.closed()).toBe(1);
  expect(await Effect.runPromise(audio.play('success'))).toEqual({ status: 'skipped', reason: 'closed' });
});

test('a failed layer graph releases an already acquired live player once', async () => {
  const fake = fixture(), failure = new ValidationError({ boundary: 'fixture', message: 'Fixture failed.', cause: undefined });
  const layer = Layer.effectDiscard(Effect.andThen(AudioNotifications, Effect.fail(failure))).pipe(
    Layer.provideMerge(AudioNotifications.layerLive({}, fake.make)),
  );
  const owner = runtime(layer), exit = await owner.runPromiseExit(AudioNotifications);
  expect(Exit.isFailure(exit)).toBe(true); expect(fake.acquired()).toBe(1); expect(fake.played).toHaveLength(0);
  await owner.dispose(); await owner.dispose(); expect(fake.closed()).toBe(1);
});

test('invalid live settings fail safely before player acquisition', async () => {
  for (const settings of [null, { volume: 'private-volume' }, { volume: NaN }, { volume: 2 }, { muted: 'false' }, { enabled: true }]) {
    const fake = fixture(), owner = runtime(AudioNotifications.layerLive(settings, fake.make));
    const exit = await owner.runPromiseExit(AudioNotifications);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error('Expected settings failure.');
    const reason = exit.cause.reasons[0]!;
    expect(Cause.isFailReason(reason)).toBe(true);
    if (!Cause.isFailReason(reason)) throw new Error('Expected typed settings failure.');
    expect(reason.error).toBeInstanceOf(ValidationError);
    expect(publicFailureMessage(reason.error)).not.toContain('private-volume');
    expect(fake.acquired()).toBe(0); await owner.dispose(); expect(fake.closed()).toBe(0);
  }
});

test('live settings apply default volume and skip muted, zero-volume and unavailable devices', async () => {
  for (const item of [
    { settings: {}, available: true, reason: undefined },
    { settings: { muted: true }, available: true, reason: 'muted' },
    { settings: { volume: 0 }, available: true, reason: 'zero-volume' },
    { settings: {}, available: false, reason: 'unavailable' },
  ] as const) {
    const fake = fixture(undefined, undefined, item.available), owner = runtime(AudioNotifications.layerLive(item.settings, fake.make));
    const audio = await owner.runPromise(AudioNotifications), result = await owner.runPromise(audio.play('success'));
    expect(result).toEqual(item.reason ? { status: 'skipped', reason: item.reason } : { status: 'played' });
    expect(fake.played).toEqual(item.reason ? [] : [{ sound: 'success', volume: 0.5 }]);
    expect(await owner.runPromise(audio.lastFailure)).toBeUndefined();
    await owner.dispose(); expect(fake.closed()).toBe(1);
  }
});

test('synchronous and asynchronous playback failures retain diagnostics without failing or retrying task work', async () => {
  for (const synchronous of [true, false]) {
    const failure = new Error('private device detail'), fake = fixture(() => {
      if (synchronous) throw failure; return Promise.reject(failure);
    });
    const owner = runtime(AudioNotifications.layerLive({}, fake.make));
    const exit = await owner.runPromiseExit(Effect.gen(function*() {
      const audio = yield* AudioNotifications;
      const playback = yield* audio.play('success');
      return { task: 'completed', playback, diagnostic: yield* audio.lastFailure };
    }));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) throw new Error('Audio changed task result.');
    expect(exit.value.task).toBe('completed'); expect(exit.value.playback.status).toBe('failed');
    expect(exit.value.diagnostic).toBeInstanceOf(IOError);
    expect(exit.value.diagnostic?.cause).toBe(failure);
    expect(publicFailureMessage(exit.value.diagnostic)).toBe('Audio playback failed.');
    expect(fake.played).toEqual([{ sound: 'success', volume: 0.5 }]);
  }
});

test('player discovery and cleanup failures degrade only audio and retain their original causes', async () => {
  const startup = new Error('private executable discovery');
  const owner = runtime(AudioNotifications.layerLive({}, () => { throw startup; }));
  const audio = await owner.runPromise(AudioNotifications), playback = await owner.runPromise(audio.play('success'));
  expect(playback.status).toBe('failed');
  if (playback.status !== 'failed') throw new Error('Expected audio diagnostic.');
  expect(playback.error.cause).toBe(startup); expect(publicFailureMessage(playback.error)).toBe('Audio player startup failed.');
  await owner.dispose();
  const cleanup = new Error('private device cleanup'), fake = fixture(undefined, async () => { throw cleanup; });
  const second = runtime(AudioNotifications.layerLive({}, fake.make)), secondAudio = await second.runPromise(AudioNotifications);
  await second.dispose(); await second.dispose(); expect(fake.closed()).toBe(1);
  const diagnostic = Effect.runSync(secondAudio.lastFailure);
  expect(diagnostic?.cause).toBe(cleanup); expect(publicFailureMessage(diagnostic)).toBe('Audio player cleanup failed.');
});

test('turn interruption awaits its playback cleanup and leaves an independent background cue alive', async () => {
  const turn = heldCue(), background = heldCue(), controller = new AbortController();
  const fake = fixture((sound, _volume, signal) => (sound === 'processing' ? turn : background).play(signal));
  const owner = runtime(AudioNotifications.layerLive({}, fake.make));
  let turnSettled = false;
  const turnWork = cue(owner, 'processing', controller.signal).then(exit => { turnSettled = true; return exit; });
  const jobWork = cue(owner, 'notification');
  await Promise.all([turn.started.promise, background.started.promise]);
  controller.abort(); await turn.aborted.promise;
  expect(turnSettled).toBe(false); expect(background.signal()?.aborted).toBe(false); expect(fake.closed()).toBe(0);
  turn.finish.resolve(); expect(Exit.hasInterrupts(await turnWork)).toBe(true);
  expect(background.signal()?.aborted).toBe(false); expect(fake.closed()).toBe(0);
  background.finish.resolve(); expect(await jobWork).toEqual(Exit.succeed({ status: 'played' }));
  const audio = await owner.runPromise(AudioNotifications); expect(await owner.runPromise(audio.lastFailure)).toBeUndefined();
  await owner.dispose(); expect(fake.closed()).toBe(1);
});

test('runtime shutdown interrupts and drains all managed cues before closing the player once', async () => {
  const first = heldCue(), second = heldCue();
  const fake = fixture((sound, _volume, signal) => (sound === 'processing' ? first : second).play(signal));
  const owner = runtime(AudioNotifications.layerLive({}, fake.make)), audio = await owner.runPromise(AudioNotifications);
  const firstWork = cue(owner, 'processing'), secondWork = cue(owner, 'notification');
  await Promise.all([first.started.promise, second.started.promise]);
  let disposed = false;
  const closing = owner.dispose().then(() => { disposed = true; });
  await Promise.all([first.aborted.promise, second.aborted.promise]);
  expect(disposed).toBe(false); expect(fake.closed()).toBe(0);
  first.finish.resolve(); expect(Exit.hasInterrupts(await firstWork)).toBe(true); expect(disposed).toBe(false);
  second.finish.resolve(); expect(Exit.hasInterrupts(await secondWork)).toBe(true);
  await closing; await owner.dispose(); expect(fake.closed()).toBe(1);
  expect(Effect.runSync(audio.lastFailure)).toBeUndefined();
});

test('the player scope drains captured-service playback even when native close fails', async () => {
  const failure = new Error('private close detail'), held = heldCue();
  const fake = fixture((_sound, _volume, signal) => held.play(signal), async () => { throw failure; });
  const owner = runtime(AudioNotifications.layerLive({}, fake.make)), audio = await owner.runPromise(AudioNotifications);
  const work = Effect.runPromiseExit(audio.play('success')); await held.started.promise;
  let disposed = false;
  const closing = owner.dispose().then(() => { disposed = true; }); await held.aborted.promise;
  expect(disposed).toBe(false);
  held.finish.resolve(); expect(Exit.hasInterrupts(await work)).toBe(true);
  await closing; expect(fake.closed()).toBe(1); expect(Effect.runSync(audio.lastFailure)?.cause).toBe(failure);
});

test('a pre-aborted request starts no playback', async () => {
  const fake = fixture(), owner = runtime(AudioNotifications.layerLive({}, fake.make));
  await owner.runPromise(AudioNotifications);
  const controller = new AbortController(); controller.abort();
  expect(Exit.hasInterrupts(await cue(owner, 'success', controller.signal))).toBe(true);
  expect(fake.played).toHaveLength(0); await owner.dispose(); expect(fake.closed()).toBe(1);
});

test('live-layer interruption terminates a real native subprocess without playing sound', async () => {
  if (process.platform === 'win32') return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-audio-scope-'));
  const executable = path.join(directory, 'afplay');
  // The marker is derived from the WAV argument; no shell interpolation of paths.
  await fs.writeFile(path.join(directory, 'success.wav'), 'silent fixture');
  await fs.writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$$" > "$3.pid"\ntouch "$3.started"\nexec sleep 30\n', { mode: 0o700 });
  const owner = runtime(AudioNotifications.layerLive({}, () => new NativeSoundPlayer(directory, executable)));
  const controller = new AbortController(), work = cue(owner, 'success', controller.signal);
  try {
    const marker = path.join(directory, 'success.wav.started');
    const deadline = Date.now() + 2000;
    while (!await fs.access(marker).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error('Fake native player did not start.');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const pid = Number(await fs.readFile(path.join(directory, 'success.wav.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).not.toThrow();
    controller.abort(); expect(Exit.hasInterrupts(await work)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    const audio = await owner.runPromise(AudioNotifications); expect(await owner.runPromise(audio.lastFailure)).toBeUndefined();
    await owner.dispose();
  } finally { controller.abort(); await work; await owner.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
