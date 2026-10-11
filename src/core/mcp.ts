import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Scope from 'effect/Scope';
import { TimeoutError, IOError } from './errors.js';

export class McpFailure extends Schema.TaggedError<McpFailure>()('McpFailure', {
  operation: Schema.String, message: Schema.String, cause: Schema.Defect(),
}) {}
export type McpClient = Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool' | 'onclose'>;
export interface McpResource { client: McpClient; transport: Transport }
export interface McpFactoryContext {
  readonly requests: AsyncLocalStorage<AbortSignal>;
  readonly signal: AbortSignal;
  readonly nativeCleanup: WeakMap<AbortSignal, Set<() => Promise<void>>>;
}
export type McpFactory = (name: string, context: McpFactoryContext) => Effect.Effect<McpResource, McpFailure, Scope.Scope>;
export interface McpOptions { connectTimeoutMs?: number; callTimeoutMs?: number }
export interface McpService {
  readonly connected: (name: string) => boolean;
  readonly request: <A>(name: string, operation: string,
    run: (client: McpClient, options: { timeout: number; signal: AbortSignal }) => Promise<A>) => Effect.Effect<A, McpFailure | TimeoutError>;
}

// Each resource is registered before the next constructor/handshake runs.
// SDK initialization can call client.close() itself; memoize native close so
// that path and our scope finalizers still release each transport only once.
export function acquireMcpResource(makeClient: () => McpClient, makeTransport: () => Transport,
  failure: (cause: unknown) => McpFailure): Effect.Effect<McpResource, McpFailure, Scope.Scope> {
  return Effect.gen(function*() {
    const client = yield* Effect.acquireRelease(Effect.try({ try: makeClient, catch: failure }),
      client => Effect.tryPromise({ try: () => client.close(), catch: cause => new IOError({ operation: 'MCP client cleanup', cause }) }).pipe(Effect.orDie));
    const transport = yield* Effect.acquireRelease(Effect.try({ try: () => {
      const transport = makeTransport(), close = transport.close.bind(transport);
      let closing: Promise<void> | undefined;
      transport.close = () => closing ??= Promise.resolve().then(close);
      return transport;
    }, catch: failure }), transport => Effect.tryPromise({ try: () => transport.close(),
      catch: cause => new IOError({ operation: 'MCP transport cleanup', cause }) }).pipe(Effect.orDie));
    // The SDK may close the client from a failed initialize before our finalizer.
    const closeClient = client.close.bind(client);
    let closingClient: Promise<void> | undefined;
    client.close = () => closingClient ??= Promise.resolve().then(closeClient);
    return { client, transport };
  });
}

export class Mcp extends Context.Service<Mcp, McpService>()('victral/core/Mcp') {
  static acquire(factory: McpFactory, failure: (operation: string, cause: unknown) => McpFailure,
    options: McpOptions = {}): Effect.Effect<McpService, never, Scope.Scope> {
    return Effect.gen(function*() {
      const owner = Scope.makeUnsafe();
      const lifetime = new AbortController();
      const requests = new AsyncLocalStorage<AbortSignal>();
      const nativeCleanup = new WeakMap<AbortSignal, Set<() => Promise<void>>>();
      const clients = new Map<string, McpClient>();
      const pending = new Map<string, Promise<Exit.Exit<McpClient, McpFailure | TimeoutError>>>();
      const active = new Set<Promise<unknown>>();
      let closed = false;
      const connectTimeout = options.connectTimeoutMs ?? 15_000, callTimeout = options.callTimeoutMs ?? 30_000;
      yield* Effect.addFinalizer(() => Effect.gen(function*() {
        closed = true; lifetime.abort();
        // Drain interrupted SDK calls and handshake rollback before closing owners.
        yield* Effect.promise(() => Promise.allSettled([...pending.values(), ...active]));
        yield* Scope.close(owner, Exit.void).pipe(Effect.ensuring(Effect.sync(() => {
          clients.clear(); requests.disable();
        })));
      }));
      const clientFor = (name: string): Effect.Effect<McpClient, McpFailure | TimeoutError> => Effect.suspend(() => {
        if (closed) return Effect.fail(failure('MCP connection', new Error('Integrations are closed.')));
        const existing = clients.get(name);
        if (existing) return Effect.succeed(existing);
        return Effect.callback<McpClient, McpFailure | TimeoutError>((resume, signal) => {
          let work = pending.get(name), initiated = false;
          if (!work) {
            initiated = true;
            const scope = Scope.forkUnsafe(owner);
            let handshake: Promise<void> | undefined;
            const acquisition = Effect.gen(function*() {
              const resource = yield* factory(name, { requests, signal: lifetime.signal, nativeCleanup });
              yield* Effect.tryPromise({ try: requestSignal => {
                handshake = requests.run(requestSignal, () => resource.client.connect(resource.transport,
                  { timeout: connectTimeout, signal: requestSignal }));
                return handshake;
              }, catch: cause => failure('MCP connection', cause) });
              if (closed) return yield* Effect.interrupt;
              clients.set(name, resource.client);
              resource.client.onclose = () => { if (clients.get(name) === resource.client) clients.delete(name); };
              return resource.client;
            }).pipe(Effect.provideService(Scope.Scope, scope), Effect.timeoutOrElse({ duration: connectTimeout,
              orElse: () => Effect.fail(new TimeoutError({ operation: 'MCP connection', cause: undefined })),
            }), Effect.onExit(exit => Exit.isFailure(exit) ? Scope.close(scope, exit).pipe(
              Effect.ensuring(Effect.promise(async () => { if (handshake) await handshake.catch(() => {}); })),
            ) : Effect.void));
            work = Effect.runPromiseExit(acquisition, { signal: AbortSignal.any([signal, lifetime.signal]) });
            pending.set(name, work);
            void work.then(() => { if (pending.get(name) === work) pending.delete(name); });
          }
          void work.then(exit => resume(exit));
          // The initiating waiter owns the handshake signal. Shared waiters can
          // interrupt independently, without canceling another caller's acquisition.
          return initiated ? Effect.promise(() => work!.then(() => undefined)) : Effect.void;
        });
      });
      return {
        connected: name => clients.has(name),
        request: Effect.fn('Mcp.request')(function*<A>(name: string, operation: string,
          run: (client: McpClient, options: { timeout: number; signal: AbortSignal }) => Promise<A>) {
          const client = yield* clientFor(name);
          return yield* Effect.scoped(Effect.gen(function*() {
            const controller = new AbortController();
            let work: Promise<A> | undefined, requestSignal: AbortSignal | undefined;
            yield* Effect.addFinalizer(() => Effect.promise(async () => {
              controller.abort();
              if (work) { await work.catch(() => {}); active.delete(work); }
              if (requestSignal) {
                const exits = await Promise.allSettled([...(nativeCleanup.get(requestSignal) ?? [])].map(close => close()));
                const errors = exits.flatMap(exit => exit.status === 'rejected' ? [exit.reason] : []);
                if (errors.length) throw new IOError({ operation: 'MCP HTTP cleanup', cause: new AggregateError(errors) });
                nativeCleanup.delete(requestSignal);
              }
            }));
            return yield* Effect.tryPromise({ try: signal => {
              requestSignal = AbortSignal.any([signal, lifetime.signal, controller.signal]);
              work = Promise.resolve().then(() => requests.run(requestSignal!, () => {
                requestSignal!.throwIfAborted();
                return run(client, { timeout: callTimeout, signal: requestSignal! });
              }));
              active.add(work); return work;
            }, catch: cause => failure(operation, cause) }).pipe(Effect.catch(error => lifetime.signal.aborted ? Effect.interrupt : Effect.fail(error)));
          })).pipe(Effect.timeoutOrElse({ duration: callTimeout,
            orElse: () => Effect.fail(new TimeoutError({ operation, cause: undefined })),
          }));
        }),
      } satisfies McpService;
    });
  }
  static layer(factory: McpFactory, failure: (operation: string, cause: unknown) => McpFailure,
    options: McpOptions = {}): Layer.Layer<Mcp> { return Layer.effect(Mcp, Mcp.acquire(factory, failure, options)); }
}
