import type { SoundName } from './patch.js';
export interface Cue { sound: SoundName; label: string; description: string; group: 'Workflow' | 'Interface' }
export const CUES: readonly Cue[] = [
  { sound: 'success', label: 'Success', description: 'Task or operation completed', group: 'Workflow' },
  { sound: 'processing', label: 'Processing', description: 'Work started; one short cue, not a continuous loop', group: 'Workflow' },
  { sound: 'error', label: 'Failure', description: 'Task or operation failed', group: 'Workflow' },
  { sound: 'retry', label: 'Retry', description: 'An actual retry attempt is starting', group: 'Workflow' },
  { sound: 'warning', label: 'Warning', description: 'Recoverable issue or important warning', group: 'Workflow' },
  { sound: 'notification', label: 'Attention', description: 'A result or user action needs attention', group: 'Workflow' },
  { sound: 'close', label: 'Canceled / close', description: 'Work canceled or a panel closed', group: 'Workflow' },
  { sound: 'blocked', label: 'Blocked', description: 'Unavailable or denied action', group: 'Workflow' },
  ...([
    ['tap', 'Tap', 'Soft button interaction'], ['select', 'Select', 'Choose a list item'],
    ['toggleOn', 'Toggle on', 'Enable an option'], ['toggleOff', 'Toggle off', 'Disable an option'],
    ['open', 'Open', 'Open a panel'], ['tick', 'Tick', 'Light progress tick'],
    ['sliderTick', 'Slider', 'Adjust a value'], ['destructive', 'Destructive', 'Destructive action feedback'],
    ['key', 'Key', 'Typing preview; not enabled for every keystroke'], ['copy', 'Copy', 'Copy completed'],
    ['swoosh', 'Swoosh', 'Transition'], ['chirp', 'Chirp', 'Small confirmation'],
    ['command', 'Command', 'Command selected'],
  ] as const).map(([sound, label, description]) => ({ sound, label, description, group: 'Interface' as const })),
];
export const SUCCESS_SCENARIO: readonly SoundName[] = ['processing', 'retry', 'processing', 'success'];
export const FAILURE_SCENARIO: readonly SoundName[] = ['processing', 'retry', 'error'];
