import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderToWav, type SoundDefinition } from '@web-kits/audio';
import { OfflineAudioContext } from 'web-audio-engine';
import { PATCH, type SoundName } from '../src/sfx/patch.js';

export const AUDIO_DIRECTORY = path.resolve(import.meta.dir, '../.generated/audio');
export function durationFor(sound: SoundDefinition): number {
  const layers = 'layers' in sound ? sound.layers : [sound];
  return Math.max(...layers.map(layer => (layer.delay ?? 0) + (layer.envelope
    ? (layer.envelope.attack ?? 0) + layer.envelope.decay + (layer.envelope.release ?? 0)
    : 0.5))) + 0.14;
}
export async function renderCue(name: SoundName): Promise<Uint8Array> {
  // Build-time compatibility only: no real-time context, browser or speakers.
  globalThis.OfflineAudioContext ??= OfflineAudioContext;
  const blob = await renderToWav(PATCH.sounds[name], {
    duration: durationFor(PATCH.sounds[name]), sampleRate: 44_100, numberOfChannels: 1,
  });
  return new Uint8Array(await blob.arrayBuffer());
}
export async function buildSfx(): Promise<void> {
  const names = Object.keys(PATCH.sounds) as SoundName[];
  const hash = createHash('sha256').update(JSON.stringify({ patch: PATCH, renderer: 1, sampleRate: 44_100 })).digest('hex');
  const manifest = path.join(AUDIO_DIRECTORY, 'manifest.json');
  const saved = await fs.readFile(manifest, 'utf8').then(JSON.parse).catch(() => undefined);
  if (saved?.hash === hash && (await Promise.all(names.map(name => fs.access(path.join(AUDIO_DIRECTORY, `${name}.wav`)).then(() => true, () => false)))).every(Boolean)) return;
  await fs.mkdir(AUDIO_DIRECTORY, { recursive: true });
  for (const name of names) await fs.writeFile(path.join(AUDIO_DIRECTORY, `${name}.wav`), await renderCue(name));
  await fs.writeFile(manifest, JSON.stringify({ hash, sounds: names, sampleRate: 44_100 }, null, 2) + '\n');
}
if (import.meta.main) await buildSfx();
