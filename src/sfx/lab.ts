import { SoundLab, render } from '../../.generated/tui.js';
import { SoundLabModel } from './lab-model.js';
export function renderSoundLab(lab: SoundLabModel, options?: Parameters<typeof render>[2]) {
  return render(SoundLab, { lab }, options);
}
export async function startSoundLab(): Promise<void> {
  const lab = new SoundLabModel();
  const instance = renderSoundLab(lab, { exitOnCtrlC: false, alternateScreen: true, maxFps: 24 });
  try { await instance.waitUntilExit(); }
  finally { instance.cleanup(); await lab.close(); }
}
