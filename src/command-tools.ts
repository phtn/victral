import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import { runToolEffect } from './tool-effects.js';
import { capResult } from './constants.js';

// Native output reads own their locks. A failure kills the process group before
// canceling a read so descendants cannot keep the other pipe open indefinitely.
export const readCommandOutput = (stream: ReadableStream<Uint8Array>, capture: (chunk: string) => void, kill: () => void) => Effect.scoped(Effect.gen(function*() {
  const reader = yield* Effect.acquireRelease(Effect.sync(() => stream.getReader()), (reader, exit) => Effect.promise(async () => {
    if (Exit.isFailure(exit)) kill();
    try { await reader.cancel(); }
    catch (error) {
      // An errored stream rejects cancel with its stored read error. Preserve a
      // genuinely new cancellation failure as a cleanup defect instead.
      const stored = await reader.closed.then(() => undefined, cause => cause);
      if (stored !== error) throw error;
    } finally { reader.releaseLock(); }
  }));
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: error => error });
    if (chunk.done) break;
    capture(decoder.decode(chunk.value, { stream: true }));
  }
  capture(decoder.decode());
}));

interface Job {
  id: string; child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'>; output: string;
  truncated: boolean; timedOut: boolean; stopped: boolean; done: boolean;
  program: string; startedAt: string; interactive: boolean; inputClosed: boolean; writing: boolean;
  completion: Promise<void>; inputPending?: Promise<void>; kill(): void;
}

export class CommandTools {
  private jobs = new Map<string, Job>();
  private sequence = 0;
  private closed = false;
  private readonly scope = Scope.makeUnsafe();
  private closing?: Promise<void>;
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
    const capture = (chunk: string) => { const next = job.output + chunk; job.output = capResult(next); job.truncated ||= job.output !== next; };
    const supervise = Effect.scoped(Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        clearTimeout(timer); signal?.removeEventListener('abort', kill);
        kill(); await child.exited; await job.inputPending?.catch(() => {});
      }));
      yield* Effect.all([Effect.tryPromise({ try: () => child.exited, catch: error => error }), readCommandOutput(child.stdout, capture, kill), readCommandOutput(child.stderr, capture, kill)], { concurrency: 3 });
    })).pipe(
      Effect.catchCause(cause => Effect.sync(() => {
        if (!Cause.hasInterruptsOnly(cause)) capture(`\n[command error: ${String(Cause.squash(cause))}]`);
      })),
      Effect.ensuring(Effect.sync(() => { job.done = true; job.inputClosed = true; })),
    );
    // A session-owned fiber outlives a successful start invocation. The explicit
    // originating signal remains attached until job cleanup, including later aborts.
    const fiber = Effect.runSync(Effect.forkIn(supervise, this.scope, { startImmediately: true }));
    job.completion = Effect.runPromise(Fiber.await(fiber)).then(() => {});
    return job;
  }
  private report(job: Job, includeId = true): string {
    return `${job.output}\n[${includeId ? `command_id: ${job.id}; status: ${job.done ? 'completed' : 'running'}; ` : ''}exit: ${job.done ? job.child.exitCode : 'pending'}; signal: ${job.child.signalCode ?? 'none'}; timeout: ${job.timedOut}${job.stopped ? '; stopped: true' : ''}${job.truncated ? '; output capped' : ''}]`;
  }
  runEffect(argv: string[], timeoutMs: number, origin?: AbortSignal): Effect.Effect<string, unknown> {
    return Effect.scoped(Effect.gen({ self: this }, function*() {
      const job = yield* Effect.acquireRelease(
        Effect.try({ try: () => this.spawn(argv, timeoutMs, origin), catch: error => error }),
        job => Effect.promise(async () => { job.kill(); await job.completion; }),
      );
      yield* Effect.promise(() => job.completion);
      yield* Effect.try({ try: () => origin?.throwIfAborted(), catch: error => error });
      return this.report(job, false);
    }));
  }
  run(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return runToolEffect(this.runEffect(argv, timeoutMs, signal), signal);
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
  writeEffect(id: string, input: string, eof: boolean, origin?: AbortSignal): Effect.Effect<string, unknown> {
    return Effect.scoped(Effect.gen({ self: this }, function*() {
      const { job, pending } = yield* Effect.acquireRelease(Effect.try({ try: () => {
        const job = this.get(id);
        origin?.throwIfAborted();
        if (job.done || job.child.exitCode !== null) throw new Error('Command has already exited.');
        if (!job.interactive || job.inputClosed || !job.child.stdin) throw new Error('Command stdin is closed; start_command needs interactive: true.');
        if (job.writing) throw new Error('A write to this command is already in progress.');
        if (Buffer.byteLength(input, 'utf8') > 65_536) throw new Error('Command input is limited to 65536 bytes per write.');
        if (!input && !eof) throw new Error('Provide input or set eof: true.');
        job.writing = true;
        const pending = (async () => {
          await job.child.stdin!.write(input);
          await job.child.stdin!.flush();
          if (eof) { job.inputClosed = true; await job.child.stdin!.end(); }
        })();
        job.inputPending = pending;
        return { job, pending };
      }, catch: error => error }), ({ job, pending }, exit) => Effect.promise(async () => {
        // Stop first: process exit releases a blocked native FileSink flush.
        if (Exit.isFailure(exit)) { job.stopped = true; job.kill(); }
        await pending.catch(() => {});
        if (job.stopped) await job.completion;
        job.inputPending = undefined; job.writing = false;
      }));
      yield* Effect.tryPromise({ try: () => pending, catch: error => error }).pipe(Effect.timeoutOrElse({
        duration: 2000, orElse: () => Effect.fail(new Error('Command input timed out; command stopped to release pending input.')),
      }));
      yield* Effect.try({ try: () => origin?.throwIfAborted(), catch: error => error });
      return `Sent ${Buffer.byteLength(input, 'utf8')} bytes to ${id}${eof ? '; stdin closed' : ''}.`;
    }));
  }
  write(id: string, input: string, eof: boolean, signal?: AbortSignal): Promise<string> {
    return runToolEffect(this.writeEffect(id, input, eof, signal), signal);
  }
  statusEffect(id: string, waitMs: number, origin?: AbortSignal): Effect.Effect<string, unknown> {
    return Effect.gen({ self: this }, function*() {
      const job = yield* Effect.try({ try: () => { const job = this.get(id); origin?.throwIfAborted(); return job; }, catch: error => error });
      if (!job.done && waitMs > 0) yield* Effect.race(Effect.promise(() => job.completion), Effect.sleep(waitMs));
      yield* Effect.try({ try: () => origin?.throwIfAborted(), catch: error => error });
      return this.report(job);
    });
  }
  status(id: string, waitMs: number, signal?: AbortSignal): Promise<string> {
    return runToolEffect(this.statusEffect(id, waitMs, signal), signal);
  }
  stopEffect(id: string): Effect.Effect<string, unknown> {
    return Effect.gen({ self: this }, function*() {
      const job = yield* Effect.try({ try: () => this.get(id), catch: error => error });
      if (!job.done) {
        job.stopped = true; job.kill();
        // Once stop is requested, drain its process/readers even on interruption.
        yield* Effect.uninterruptible(Effect.promise(() => job.completion));
      }
      return this.report(job);
    });
  }
  stop(id: string): Promise<string> { return runToolEffect(this.stopEffect(id)); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of this.jobs.values()) if (!job.done) { job.stopped = true; job.kill(); }
    this.closing = Effect.runPromise(Scope.close(this.scope, Exit.void)).then(() => { this.jobs.clear(); });
    return this.closing;
  }
}
