import { execFile } from 'node:child_process';

export type CopyResult = 'copied' | 'sent';
export type CopyResponse = (text: string, stdout: Pick<NodeJS.WriteStream, 'write'>) => Promise<CopyResult>;

// OSC 52 lets the user's terminal handle the clipboard, including over SSH.
export async function copyMarkdown(text: string, stdout: Pick<NodeJS.WriteStream, 'write'>, platform = process.platform): Promise<CopyResult> {
  if (platform === 'darwin' && !process.env.SSH_CONNECTION) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile('/usr/bin/pbcopy', [], { timeout: 2000 }, (error) => error ? reject(error) : resolve());
        child.stdin?.on('error', reject);
        child.stdin?.end(text, 'utf8');
      });
      return 'copied';
    } catch { /* Fall back to the terminal clipboard protocol. */ }
  }
  stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  return 'sent';
}
