# Sound notification prototype

Run `bun run sfx` in an interactive terminal, or use `bun run start --sfx-test`.
This is a standalone TUI audition page. It uses no model calls, integrations,
conversation storage, or browser window. It starts silently and does not yet
add audio to the main chat.

## Preview controls

| Key | Action |
| --- | --- |
| ↑ / k · ↓ / j / Tab | Select a cue; the list scrolls to keep it visible |
| Enter / Space | Play the selected cue |
| ← / → or − / + | Change volume in 5% steps, bounded to 0–100% |
| m | Mute/unmute; muting stops current playback |
| s | Processing → retry → processing → success |
| f | Processing → retry → failure |
| x / Esc | Stop the current cue or scenario |
| q / Ctrl+C | Close the lab and release playback resources |

Default volume is 50%. Zero volume and mute skip playback. Settings are kept
only for this lab session. New previews replace the previous preview; sounds
are serialized rather than overlapping. Scenario events are illustrative, not
real workflow results. The status and recent-cue display stay visible even
when sound is unavailable or a player fails.

## Conversion from the browser component

`src/web-kits/index.btsx` provides the original 19 sound definitions. The lab
extracts their patch data into `src/sfx/patch.ts`, preserving oscillator,
filter, envelope, gain and layer-delay settings. It adds soft processing and
ascending retry cues. The browser component and its provider remain reference
material; the TUI does not import them.

DOM event classification, browser storage, SVG controls, and browser hooks are
replaced by explicit terminal input and lab state. Pitch jitter is not applied
per playback in this prototype; generated noise is baked into the WAV asset.
Future notification policy belongs at workflow boundaries rather than global
keypress listeners.

`@web-kits/audio` renders the patch to mono 44.1 kHz, 16-bit PCM WAV files at
build time. [web-audio-engine](https://github.com/mohayonao/web-audio-engine)
provides the build-time `OfflineAudioContext`; it is a development dependency
and is not imported by the runtime player. Rendering does not use speakers.
Assets are cached under `.generated/audio` using a patch/render-settings hash.
`bun run build:sfx` regenerates them when needed, and `build:ui` prepares them
for the lab. The application build copies them to `dist/audio`.

The runtime player uses `afplay` on macOS, or an available `ffplay` executable
on other platforms. It passes literal argument arrays, scales master volume,
limits playback lifetime, and terminates playback on stop/close. If neither
player is available, the lab remains visible and reports what it needs. Native
playback is separate from the agent's optional command-execution tools.

## Files

- `src/sfx/patch.ts`: shared sound definitions.
- `src/sfx/catalog.ts`: audition labels and illustrative scenarios.
- `scripts/build-sfx.ts`: offline rendering and asset cache.
- `src/sfx/player.ts`: native playback and cancellation.
- `src/sfx/lab-model.ts`: testable selection, volume, mute and scenario state.
- `src/sfx/lab.ink.btsx`: terminal audition page.
- `src/sfx/lab.ts`: render/start adapter.
- `test/sfx.test.ts`: WAV signal checks and silent fake-player/UI tests.

## Before live Effect integration

Audition the sounds at comfortable volume on the actual output device. Review
processing frequency, distinction between retry and warning, and whether
failure/success sounds are easy to recognize. Automated waveform tests verify
non-silent signal, PCM format and no clipping; they cannot judge the sound's
perceived quality.

Follow the audio section of [the migration plan](EFFECT_MIGRATION_PLAN.md):
introduce a session-owned `AudioNotifications` service, a silent testing layer,
and typed events with stable operation IDs. Map success after completion,
retry when an actual attempt begins, and cancellation separately from failure.
Deduplicate and limit cues; a playback failure must not change the task result
or retry policy. Keep notifications opt-in until audition and event tests pass.
