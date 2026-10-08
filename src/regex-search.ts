import { Worker } from 'node:worker_threads';

// Keep backtracking expressions off the agent's event loop so both the deadline
// and turn cancellation remain effective. Inline source also works in dist/cli.js.
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const expression = new RegExp(workerData.query, workerData.flags);
parentPort.on('message', ({ lines, limit }) => {
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (expression.test(lines[i])) {
      matches.push(i);
      if (matches.length >= limit) break;
    }
  }
  parentPort.postMessage(matches);
});
`;

export class RegexSearch {
  private worker: Worker;
  private failure?: Error;
  constructor(query: string, caseSensitive: boolean) {
    try { new RegExp(query, caseSensitive ? '' : 'i'); }
    catch { throw new Error('Invalid regular expression.'); }
    this.worker = new Worker(SOURCE, { eval: true, workerData: { query, flags: caseSensitive ? '' : 'i' } });
    this.worker.on('error', error => { this.failure = error instanceof Error ? error : new Error(String(error)); });
  }
  match(lines: string[], limit: number, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.worker.off('message', message); this.worker.off('error', error); this.worker.off('exit', exited);
      };
      const message = (matches: number[]) => { cleanup(); resolve(matches); };
      const error = (cause: Error) => { cleanup(); reject(cause); };
      const exited = () => error(new Error('Regular expression worker exited before completing the search.'));
      const abort = () => { cleanup(); reject(signal!.reason); };
      const timer = setTimeout(() => error(new Error('Regular expression search timed out; simplify the query.')), 2000);
      this.worker.once('message', message); this.worker.once('error', error); this.worker.once('exit', exited);
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({ lines, limit });
    });
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}
