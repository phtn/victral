import { Workspace, render } from '../.generated/tui.js';
import type { WorkspaceSession } from './tui-model.js';
import type { CopyResponse } from './clipboard.js';
export { Workspace } from '../.generated/tui.js';
export { safeText, shortProject, wrapLines, type WorkspaceSession } from './tui-model.js';

export function renderWorkspace(session: WorkspaceSession, options?: Parameters<typeof render>[2], copyResponse?: CopyResponse) {
  return render(Workspace, { session, copyResponse }, options);
}

export async function startTui(session: WorkspaceSession): Promise<void> {
  const instance = renderWorkspace(session, { exitOnCtrlC: false, alternateScreen: true, maxFps: 24 });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
    await session.close();
  }
}
