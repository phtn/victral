import { capResult } from './constants.js';

interface Job {
  id: string; child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'>; output: string;
  truncated: boolean; timedOut: boolean; stopped: boolean; done: boolean;
  program: string; startedAt: string; interactive: boolean; inputClosed: boolean; writing: boolean;
  completion: Promise<void>; kill(): void;
}

export class CommandTools {
  private jobs = new Map<string, Job>();
  private sequence = 0;
  private closed = false;
  constructor(private project: string) {}

  private spawn(argv: string[], timeoutMs: number, signal?: AbortSignal, interactive = false): Job {
    if (this.closed) throw new Error('Command tools are closed.');
    signal?.throwIfAborted();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)$/i.test(key)) delete env[key];
    const child = Bun.spawn(argv, { cwd: this.project, env, detached: process.platform !== 'win32', stdin: interactive ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
    // Kill the entire process group, including children that keep output pipes open.
    const kill = () => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const job: Job = { id: `command-${++this.sequence}`, child, output: '', truncated: false, timedOut: false, stopped: false, done: false,
      program: argv[0]!, startedAt: new Date().toISOString(), interactive, inputClosed: !interactive, writing: false, completion: Promise.resolve(), kill };
    const timer = setTimeout(() => { job.timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const capture = (chunk: string) => { const next = job.output + chunk; job.output = capResult(next); job.truncated ||= job.output !== next; };
      for await (const chunk of stream) capture(decoder.decode(chunk, { stream: true }));
      capture(decoder.decode());
    };
    // Convert I/O failures to a tool-visible result; background jobs must not
    // create unhandled rejections after the turn that started them has ended.
    job.completion = Promise.all([child.exited, consume(child.stdout), consume(child.stderr)])
      .then(() => {}, error => { job.output = capResult(`${job.output}\n[command error: ${String(error)}]`); })
      .finally(async () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); kill(); await child.exited; job.done = true; job.inputClosed = true; });
    return job;
  }
  private report(job: Job, includeId = true): string {
    return `${job.output}\n[${includeId ? `command_id: ${job.id}; status: ${job.done ? 'completed' : 'running'}; ` : ''}exit: ${job.done ? job.child.exitCode : 'pending'}; signal: ${job.child.signalCode ?? 'none'}; timeout: ${job.timedOut}${job.stopped ? '; stopped: true' : ''}${job.truncated ? '; output capped' : ''}]`;
  }
  async run(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const job = this.spawn(argv, timeoutMs, signal);
    await job.completion;
    signal?.throwIfAborted();
    return this.report(job, false);
  }
  start(argv: string[], timeoutMs: number, signal?: AbortSignal, interactive = false): string {
    if ([...this.jobs.values()].filter(job => !job.done).length >= 8) throw new Error('At most 8 background commands may run; stop or finish one first.');
    // Keep the most recent completed results without allowing unbounded state.
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < 32) break;
      if (job.done) this.jobs.delete(id);
    }
    const job = this.spawn(argv, timeoutMs, signal, interactive);
    this.jobs.set(job.id, job);
    return this.report(job);
  }
  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown command_id: ${id}. Use an ID returned by start_command in this session.`);
    return job;
  }
  list(): string {
    return JSON.stringify([...this.jobs.values()].map(job => ({ command_id: job.id, program: job.program, started_at: job.startedAt,
      status: job.done ? 'completed' : 'running', exit: job.done ? job.child.exitCode : null, timeout: job.timedOut,
      interactive: job.interactive, stdin_closed: job.inputClosed, output_capped: job.truncated })), null, 2);
  }
  async write(id: string, input: string, eof: boolean, signal?: AbortSignal): Promise<string> {
    const job = this.get(id);
    signal?.throwIfAborted();
    if (job.done || job.child.exitCode !== null) throw new Error('Command has already exited.');
    if (!job.interactive || job.inputClosed || !job.child.stdin) throw new Error('Command stdin is closed; start_command needs interactive: true.');
    if (job.writing) throw new Error('A write to this command is already in progress.');
    if (Buffer.byteLength(input, 'utf8') > 65_536) throw new Error('Command input is limited to 65536 bytes per write.');
    if (!input && !eof) throw new Error('Provide input or set eof: true.');
    job.writing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const pending = (async () => {
        await job.child.stdin!.write(input);
        await job.child.stdin!.flush();
        if (eof) { job.inputClosed = true; await job.child.stdin!.end(); }
      })();
      await new Promise<void>((resolve, reject) => {
        abort = () => { job.stopped = true; job.kill(); reject(signal!.reason); };
        timer = setTimeout(() => { job.stopped = true; job.kill(); reject(new Error('Command input timed out; command stopped to release pending input.')); }, 2000);
        signal?.addEventListener('abort', abort, { once: true });
        void Promise.resolve(pending).then(() => resolve(), reject);
      });
      signal?.throwIfAborted();
      return `Sent ${Buffer.byteLength(input, 'utf8')} bytes to ${id}${eof ? '; stdin closed' : ''}.`;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      job.writing = false;
    }
  }
  async status(id: string, waitMs: number, signal?: AbortSignal): Promise<string> {
    const job = this.get(id);
    signal?.throwIfAborted();
    if (!job.done && waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal!.reason); };
        const timer = setTimeout(finish, waitMs);
        signal?.addEventListener('abort', abort, { once: true });
        void job.completion.then(finish);
      });
    }
    signal?.throwIfAborted();
    return this.report(job);
  }
  async stop(id: string): Promise<string> {
    const job = this.get(id);
    if (!job.done) { job.stopped = true; job.kill(); await job.completion; }
    return this.report(job);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) if (!job.done) { job.stopped = true; job.kill(); }
    await Promise.all([...this.jobs.values()].map(job => job.completion));
    this.jobs.clear();
  }
}
