import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CUES, SUCCESS_SCENARIO, FAILURE_SCENARIO } from './catalog.js';
import type { SoundName } from './patch.js';
import { NativeSoundPlayer, type SoundPlayer } from './player.js';
import { errorMessage } from '../types.js';
import { parseAudioSettings, parseVolumeAdjustment, type AudioSettings } from './settings.js';
export interface LabState extends AudioSettings {
  selected: number; active: boolean;
  error: boolean; status: string; backend: string; available: boolean; log: readonly string[];
}
export class SoundLabModel extends EventEmitter {
  private state: LabState;
  private controller?: AbortController;
  private work?: Promise<void>;
  private closed = false;
  constructor(private player: SoundPlayer = new NativeSoundPlayer(), settings: unknown = {}) {
    super();
    this.state = { selected: 0, ...parseAudioSettings(settings), active: false,
      error: false, status: 'Ready · choose a cue and press Enter', backend: player.backend, available: player.available, log: [] };
  }
  snapshot(): LabState { return { ...this.state, log: [...this.state.log] }; }
  private update(): void { if (!this.closed) this.emit('update'); }
  select(delta: number): void { this.state.selected = (this.state.selected + delta + CUES.length) % CUES.length; this.update(); }
  configure(settings: unknown): void {
    const validated = parseAudioSettings(settings);
    this.state = { ...this.state, ...validated }; this.stop();
  }
  volume(delta: number): void {
    const volume = Math.round(Math.max(0, Math.min(1, this.state.volume + parseVolumeAdjustment(delta))) * 100) / 100;
    this.configure({ volume, muted: this.state.muted });
  }
  mute(): void { this.configure({ volume: this.state.volume, muted: !this.state.muted }); }
  stop(): void {
    this.controller?.abort(); this.controller = undefined;
    this.state.active = false; this.state.error = false; this.state.status = this.state.muted ? 'Muted' : this.state.volume === 0 ? 'Volume is zero' : 'Stopped · ready'; this.update();
  }
  playSelected(): Promise<void> { return this.start([CUES[this.state.selected]!.sound]); }
  scenario(failure = false): Promise<void> { return this.start(failure ? FAILURE_SCENARIO : SUCCESS_SCENARIO); }
  private start(sounds: readonly SoundName[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.controller?.abort();
    const previous = this.work;
    const controller = this.controller = new AbortController();
    this.state.active = true; this.state.error = false;
    const work = (async () => {
      try {
        await previous; controller.signal.throwIfAborted();
        if (this.state.muted || this.state.volume === 0) { this.state.status = this.state.muted ? 'Muted · cue skipped' : 'Volume is zero · cue skipped'; return; }
        for (const [index, sound] of sounds.entries()) {
          controller.signal.throwIfAborted();
          const label = CUES.find(cue => cue.sound === sound)!.label;
          this.state.status = `${sounds.length > 1 ? `Scenario ${index + 1}/${sounds.length} · ` : 'Playing · '}${label}`;
          this.state.log = [...this.state.log, `${label} · ${Math.round(this.state.volume * 100)}%`].slice(-4); this.update();
          await this.player.play(sound, this.state.volume, controller.signal);
          if (index < sounds.length - 1) await delay(150, undefined, { signal: controller.signal });
        }
        this.state.status = sounds.length > 1 ? 'Scenario completed · ready' : 'Preview completed · ready';
      } catch (error) {
        if (!controller.signal.aborted) { this.state.error = true; this.state.status = errorMessage(error); this.state.log = [...this.state.log, 'Playback failed · ' + this.state.status].slice(-4); }
      } finally {
        if (this.controller === controller) { this.state.active = false; this.controller = undefined; this.update(); }
      }
    })();
    this.work = work; this.update(); return work;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.controller?.abort();
    await this.work; await this.player.close(); this.emit('closed');
  }
}
