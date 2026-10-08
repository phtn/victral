import { EventEmitter } from 'node:events';
import { renderWorkspace, type WorkspaceSession } from '../src/tui.js';

class Output extends EventEmitter {
  columns = 100;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
  lastFrame = () => this.frames.at(-1);
}

class Input extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  rawMode = false;
  write(data: string) {
    this.data = data;
    this.emit('readable');
  }
  setEncoding() {}
  setRawMode(enabled: boolean) { this.rawMode = enabled; }
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() { const data = this.data; this.data = null; return data; }
}

const instances = new Set<ReturnType<typeof renderWorkspace>>();
export function render(session: WorkspaceSession) {
  const stdout = new Output(), stderr = new Output(), stdin = new Input();
  const instance = renderWorkspace(session, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, interactive: true, exitOnCtrlC: false, patchConsole: false,
  });
  instances.add(instance);
  return { ...instance, stdout, stderr, stdin, frames: stdout.frames, lastFrame: stdout.lastFrame };
}

export async function cleanup() {
  for (const instance of instances) {
    instance.unmount();
    await instance.waitUntilExit();
    instance.cleanup();
  }
  instances.clear();
}
