import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PATCH, type SoundName } from '../src/sfx/patch.js';
import { CUES } from '../src/sfx/catalog.js';
import { SoundLabModel } from '../src/sfx/lab-model.js';
import { NativeSoundPlayer, playbackCommand, type SoundPlayer } from '../src/sfx/player.js';
import { AUDIO_DIRECTORY, buildSfx } from '../scripts/build-sfx.js';
import { renderLab, cleanup } from './terminal-harness.js';

const labs: SoundLabModel[] = [];
afterEach(async () => { await cleanup(); await Promise.all(labs.splice(0).map(lab => lab.close())); });
function fixture(play?: SoundPlayer['play']) {
  const played: { sound: SoundName; volume: number }[] = [];
  let closed = 0;
  const player: SoundPlayer = { backend: 'test player', available: true, async play(sound, volume, signal) {
    played.push({ sound, volume }); await play?.(sound, volume, signal);
  }, async close() { closed++; } };
  const lab = new SoundLabModel(player); labs.push(lab);
  return { lab, played, closed: () => closed };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 60));

test('all adapted patch sounds render non-silent, unclipped PCM WAV assets and reuse the cache', async () => {
  expect(new Set<string>(CUES.map(cue => cue.sound))).toEqual(new Set(Object.keys(PATCH.sounds)));
  await buildSfx();
  for (const cue of CUES) {
    const buffer = Buffer.from(await fs.readFile(path.join(AUDIO_DIRECTORY, `${cue.sound}.wav`)));
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF'); expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buffer.readUInt16LE(20)).toBe(1); expect(buffer.readUInt16LE(22)).toBe(1);
    expect(buffer.readUInt32LE(24)).toBe(44_100); expect(buffer.readUInt16LE(34)).toBe(16);
    let peak = 0, energy = 0;
    for (let i = 44; i < buffer.length; i += 2) { const sample = buffer.readInt16LE(i); peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
    expect(energy).toBeGreaterThan(1000); expect(peak).toBeGreaterThan(50); expect(peak).toBeLessThan(32_767);
    expect(buffer.length / (44_100 * 2)).toBeLessThan(1);
  }
  const file = path.join(AUDIO_DIRECTORY, 'success.wav'), before = (await fs.stat(file)).mtimeMs;
  await buildSfx(); expect((await fs.stat(file)).mtimeMs).toBe(before);
});

test('lab starts silently, previews cues, bounds volume, and skips muted or zero-volume playback', async () => {
  const { lab, played } = fixture();
  expect(played).toHaveLength(0); expect(lab.snapshot().volume).toBe(0.5);
  await lab.playSelected(); expect(played).toEqual([{ sound: 'success', volume: 0.5 }]);
  lab.mute(); await lab.playSelected(); expect(played).toHaveLength(1); expect(lab.snapshot().status).toContain('Muted');
  lab.mute(); lab.volume(-100); await lab.playSelected(); expect(played).toHaveLength(1);
  expect(lab.snapshot().volume).toBe(0); lab.volume(100); expect(lab.snapshot().volume).toBe(1);
});

test('lab scenario follows processing, retry and success while failures stay visible', async () => {
  const { lab, played } = fixture();
  await lab.scenario(); expect(played.map(cue => cue.sound)).toEqual(['processing', 'retry', 'processing', 'success']);
  expect(lab.snapshot().status).toContain('Scenario completed'); expect(lab.snapshot().active).toBe(false);
  const broken = fixture(async () => { throw new Error('Audio device unavailable'); });
  await broken.lab.playSelected(); expect(broken.lab.snapshot().status).toBe('Audio device unavailable');
  expect(broken.lab.snapshot().active).toBe(false);
});

test('replacement previews, mute, and close cancel playback and release the player once', async () => {
  let active = 0, peak = 0, aborted = 0;
  const { lab, played, closed } = fixture(async (_sound, _volume, signal) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise<void>((_resolve, reject) => {
      const abort = () => { aborted++; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }); } finally { active--; }
  });
  const first = lab.playSelected(); await flush();
  lab.select(1); const second = lab.playSelected(); await flush();
  expect(played.map(cue => cue.sound)).toEqual(['success', 'processing']); expect(peak).toBe(1);
  lab.mute(); await Promise.all([first, second]); expect(aborted).toBe(2); expect(active).toBe(0);
  lab.mute(); const final = lab.playSelected(); await flush();
  await lab.close(); await final; await lab.close(); expect(aborted).toBe(3); expect(closed()).toBe(1);
});

test('native player commands use literal paths and explicit volume', () => {
  expect(playbackCommand('/usr/bin/afplay', '/tmp/file with spaces.wav', 0.25)).toEqual(['/usr/bin/afplay', '-v', '0.25', '/tmp/file with spaces.wav']);
  expect(playbackCommand('/bin/ffplay', '/tmp/test.wav', 0.5)).toContain('50');
  expect(() => playbackCommand('afplay', '/tmp/test.wav', NaN)).toThrow('Volume');
});

test('sound lab TUI previews, navigates, changes volume, mutes, and releases listeners', async () => {
  const { lab, played } = fixture();
  const view = renderLab(lab); await flush();
  expect(view.lastFrame()).toContain('SOUND LAB'); expect(view.lastFrame()).toContain('no API calls');
  expect(view.lastFrame()).toContain('Success'); expect(view.lastFrame()).toContain('Retry'); expect(played).toHaveLength(0);
  view.stdin.write('\r'); await flush(); expect(played[0]).toEqual({ sound: 'success', volume: 0.5 });
  view.stdin.write('\x1b[B'); await flush(); expect(view.lastFrame()).toContain('patch: processing');
  view.stdin.write('j'); await flush(); expect(view.lastFrame()).toContain('patch: error');
  view.stdin.write('k'); await flush(); expect(view.lastFrame()).toContain('patch: processing');
  view.stdin.write('\x1b[C'); await flush(); expect(view.lastFrame()).toContain('55%');
  view.stdin.write('m'); await flush(); expect(view.lastFrame()).toContain('MUTED');
  view.stdin.write('\r'); await flush(); expect(played).toHaveLength(1);
  view.stdout.columns = 40; view.stdout.rows = 14; view.stdout.emit('resize'); await flush();
  expect(view.lastFrame()).toContain('SOUND LAB');
  view.stdout.columns = 30; view.stdout.rows = 10; view.stdout.emit('resize'); await flush();
  expect(view.lastFrame()).toContain('Resize');
  view.unmount(); await flush(); expect(lab.listenerCount('update')).toBe(0); expect(lab.listenerCount('closed')).toBe(0);
});

test('native playback interruption and close terminate actual player subprocesses without audio', async () => {
  if (process.platform === 'win32') return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'victral-sfx-player-'));
  const executable = path.join(directory, 'afplay');
  await fs.writeFile(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
  const player = new NativeSoundPlayer(AUDIO_DIRECTORY, executable);
  try {
    const controller = new AbortController();
    const canceled = player.play('success', 0.5, controller.signal).catch(error => error);
    await flush(); controller.abort();
    expect((await canceled).name).toBe('AbortError');
    const closed = player.play('processing', 0.5, new AbortController().signal).catch(error => error);
    await flush(); await player.close();
    expect((await closed).message).toContain('Audio playback failed');
    await player.close();
  } finally { await player.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
