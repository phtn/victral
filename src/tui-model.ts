import os from 'node:os';
import stringWidth from 'string-width';
import type { Session } from './session.js';
import { safeText } from './terminal-text.js';
export { safeText } from './terminal-text.js';

export function wrapLines(text: string, width: number): string[] {
  const result: string[] = []
  for (const line of safeText(text).split('\n')) {
    let current = '',
      columns = 0
    for (const char of line) {
      const size = stringWidth(char)
      if (columns + size > width && current) {
        result.push(current)
        current = ''
        columns = 0
      }
      current += char
      columns += size
    }
    result.push(current)
  }
  return result
}
export interface WorkspaceSession extends Pick<Session, 'snapshot' | 'submit' | 'cancel' | 'close'> {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
  options: { project: string; allowShell: boolean }
  metrics: { detailed(): string }
}

export function shortProject(project: string): string {
  const home = os.homedir()
  if (project === home) return '~'
  if (project.startsWith(home + '/')) return `~/${project.slice(home.length + 1)}`
  return project
}

