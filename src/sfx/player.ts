import fs from 'node:fs/promises';
import path from 'node:path';
import type { SoundName } from './patch.js';
import { parseAudioVolume } from './settings.js';
export interface SoundPlayer {
  readonly backend: string; readonly available: boolean;
  play(sound: SoundName, volume: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export function playbackCommand(player: string, filename: string, volume: number): string[] {
  volume = parseAudioVolume(volume);
  if (path.basename(player) === 'afplay') return [player, '-v', String(volume), filename];
  if (path.basename(player).replace(/\.exe$/i, '') === 'ffplay') return [player, '-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.round(volume * 100)), filename];
  throw new Error('Unsupported audio player.');
}
export class NativeSoundPlayer implements SoundPlayer {
  readonly available: boolean;
  readonly backend: string;
  private player: string | null;
  private children = new Set<Bun.Subprocess>();
  private closed = false;
  constructor(private directory?: string, executable?: string) {
    this.player = executable ?? (process.platform === 'darwin' ? Bun.which('afplay') : null) ?? Bun.which('ffplay');
    this.available = !!this.player;
    this.backend = this.player ? path.basename(this.player) : 'Unavailable · needs afplay (macOS) or ffplay';
  }
  async play(sound: SoundName, volume: number, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Audio player is closed.');
    signal.throwIfAborted();
    volume = parseAudioVolume(volume);
    if (!this.player) throw new Error(this.backend);
    if (volume === 0) return;
    // First path is used by the distribution bundle; second by the source CLI.
    const directories = this.directory ? [this.directory] : [path.join(import.meta.dir, 'audio'), path.resolve(import.meta.dir, '../../.generated/audio')];
    let filename: string | undefined;
    for (const directory of directories) {
      const candidate = path.join(directory, `${sound}.wav`);
      if (await fs.access(candidate).then(() => true, () => false)) { filename = candidate; break; }
    }
    signal.throwIfAborted();
    if (this.closed) throw new Error('Audio player is closed.');
    if (!filename) throw new Error('Sound assets are missing; run bun run build:sfx.');
    const child = Bun.spawn(playbackCommand(this.player, filename, volume), { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    this.children.add(child);
    const stop = () => { try { child.kill(); } catch { /* Already exited. */ } };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 5000);
    try {
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      signal.throwIfAborted();
      if (code !== 0) throw new Error(`Audio playback failed: ${error.trim().slice(0, 300) || `exit ${code}`}`);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); this.children.delete(child); }
  }
  async close(): Promise<void> {
    this.closed = true;
    const children = [...this.children];
    for (const child of children) try { child.kill(); } catch { /* Already exited. */ }
    await Promise.allSettled(children.map(child => child.exited));
    this.children.clear();
  }
}
