import { test, expect } from 'bun:test';
import * as Schema from 'effect/Schema';
import { ValidationError } from '../src/core/errors.js';
import { AudioSettingsSchema, parseAudioSettings } from '../src/sfx/settings.js';
import { SoundLabModel } from '../src/sfx/lab-model.js';
import { playbackCommand, type SoundPlayer } from '../src/sfx/player.js';

test('audio settings decode defaults and explicit values and round-trip as plain settings', () => {
  expect(parseAudioSettings({})).toEqual({ volume: 0.5, muted: false });
  expect(parseAudioSettings({ volume: undefined, muted: undefined })).toEqual({ volume: 0.5, muted: false });
  for (const volume of [0, 0.25, 1]) for (const muted of [true, false]) {
    const settings = parseAudioSettings({ volume, muted });
    expect(Schema.encodeSync(AudioSettingsSchema)(settings)).toEqual({ volume, muted });
    expect(parseAudioSettings(Schema.encodeSync(AudioSettingsSchema)(settings))).toEqual(settings);
  }
});

test('audio settings reject malformed values with typed errors and without echoing inputs', () => {
  for (const volume of [NaN, Infinity, -Infinity, -0.01, 1.01, null, 'secret-volume']) {
    let failure: unknown;
    try { parseAudioSettings({ volume }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ValidationError);
    if (!(failure instanceof ValidationError)) throw new Error('Expected validation failure.');
    expect(failure.boundary).toBe('Audio settings'); expect(failure.cause).toBeInstanceOf(Schema.SchemaError);
    expect(failure.message).toContain('volume'); expect(failure.message).not.toContain('secret-volume');
  }
  for (const value of [null, [], { muted: null }, { muted: 1 }, { muted: 'false' }, { voluem: 0.2 }]) {
    expect(() => parseAudioSettings(value)).toThrow(ValidationError);
  }
  for (const volume of [NaN, Infinity, -1, 2]) expect(() => playbackCommand('afplay', '/tmp/test.wav', volume)).toThrow(ValidationError);
});

test('settings validate before changing lab state or canceling an active preview', async () => {
  let started!: () => void, aborted = 0, played = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const player: SoundPlayer = { available: true, backend: 'silent test', async play(_sound, _volume, signal) {
    played++; started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  }, async close() {} };
  const lab = new SoundLabModel(player, { volume: 0.25 });
  try {
    expect(played).toBe(0);
    const work = lab.playSelected(); await ready;
    const before = lab.snapshot();
    for (const value of [{ volume: NaN, muted: true }, { volume: 0.7, muted: 'yes' }, { volume: 2 }]) {
      expect(() => lab.configure(value)).toThrow(ValidationError);
      expect(lab.snapshot()).toEqual(before); expect(aborted).toBe(0);
    }
    for (const delta of [NaN, Infinity, -Infinity]) {
      expect(() => lab.volume(delta)).toThrow(ValidationError); expect(lab.snapshot()).toEqual(before);
    }
    lab.configure({ volume: 0.75, muted: true }); await work;
    expect(aborted).toBe(1); expect(lab.snapshot()).toMatchObject({ volume: 0.75, muted: true, active: false });
    await lab.playSelected(); expect(played).toBe(1);
    expect(() => new SoundLabModel(player, { volume: 2 })).toThrow(ValidationError);
  } finally { await lab.close(); }
});
