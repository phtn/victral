# Effect runtime patterns for Victral

The initial dependency is pinned to `effect@4.0.2`. Consult the read-only v4
checkout under `repos/effect`, then compile against the installed package.
Import from `effect` or its public modules, never from the checkout. Prefer
public module imports such as `effect/Schema` in production boundaries to limit
cold module loading with the application's external-package Bun build.

## Services and ownership

Follow the vendored [service example](../repos/effect/ai-docs/src/01_effect/03_services/01_service.ts):
extend `Context.Service` with a package-qualified identifier, implement traced
methods with `Effect.fn`, and provide implementations through `Layer`. Keep
pure helpers as ordinary functions. `src/core/legacy-ports.ts` is the initial
compiled application example; its tests provide a fake layer with existing
`ModelPort` and `AgentTools` implementations.

`LegacyPorts.layer` borrows ports and adapts methods only. It does not acquire
ownership or call `close()`. Session now owns one `ManagedRuntime`, following the
vendored
[integration example](../repos/effect/ai-docs/src/04_integration/10_managed-runtime.ts).
Do not add a runtime per turn, tool call, model switch or worker request.

[Session.open](../src/session.ts) builds a scoped `Layer.effectContext` and awaits
the private session service before publishing the Session. Small services expose
[settings, model creation and storage](../src/core/session-services.ts). Runtime
startup builds them once; synchronous model switches and worker model factories
use its cached context through `runSyncExit`. The external Session/UI API remains
Promise-based, and the Runner loop remains in ordinary TypeScript for now.

## Current resource owners

| Resource | Owner and release |
| --- | --- |
| Session runtime | `Session.close()` caches one disposal promise; failed startup also disposes it. |
| Chat storage and lock | `SessionStorage.acquire` uses `Effect.acquireRelease`; its finalizer calls the original `Storage.close()` once. |
| Memory, evaluations and metrics | Session layer finalizers stop/close the existing instances, in that order, before releasing storage. |
| Session listeners and UI timer | A session finalizer detaches them before closing the Runner. |
| Main Runner and project toolset | A guarded toolset finalizer closes the Runner when construction succeeded, or closes the toolset directly when Runner construction failed. |
| Integrations and research workers | Scoped fallback owners cover partial startup; successful toolset acquisition transfers ownership to toolset `close()`. Integrations closes its Effect-owned MCP connection scope; workers retain legacy internals. |
| Command processes and worker Runners | Existing command/worker services retain their internal lifetimes; the project toolset closes those services. |
| Audio player and active cues | The opt-in `AudioNotifications.layerLive` owns one player; each playback observes its caller's interruption. Scope close aborts/drains remaining playback and closes the player once. The Session uses `layerSilent`. |

Make ownership transfers explicit. The integration and worker fallback finalizers
become inactive only inside successful, uninterruptible toolset acquisition.
They must not also close resources now owned by that toolset. The toolset's
single finalizer covers Runner construction failure, including an exception in
memory configuration or instruction loading. Register listener cleanup before
starting pumps, so a failed pump does not leave subscriptions or timers alive.

Metrics and evaluation finalizers register before memory acquisition and capture
their instances inside synchronous construction. This intentionally preserves
the existing memory-stop, evaluations-close, metrics-close, storage-close order;
metrics remains subscribed while final work completes. A partially acquired graph
releases only the instances that exist. Do not add duplicate per-instance layers
that also invoke those same legacy cleanup methods.

Storage access exposes the original object. `append`, `saveNode`, `savePlan`,
view writes and telemetry remain synchronous and durable, with unchanged file
formats. Keep persistence callbacks synchronous while the memory/plan adapters
depend on their ordering; do not add a Promise or a fiber around each write.

The runtime and these resources live for the entire session. Runner cancellation
still controls the originating turn's AbortSignal. Completed turns do not dispose
the runtime, close integrations or stop allowed background commands. Worker
Runners and command jobs retain their existing step limits, deadlines and session
cleanup. Their Effect supervision belongs to later migration steps.

`Session.close()` marks the session closed immediately, disposes the runtime,
emits `closed` once after finalization, and returns the same promise on every call,
including a rejected close. Startup and cleanup failures cannot skip remaining
finalizers. Toolset cleanup waits for every owned service with `allSettled`, and
Runner cleanup retains a failed drain together with a tool cleanup failure.

## Audio notification service

[AudioNotifications](../src/sfx/notifications.ts) exposes an awaited `play(sound)`
effect, immutable Schema-validated settings and a bounded `lastFailure` diagnostic.
The session graph installs `layerSilent`, which acquires no player and always
skips playback, even though the defaults are unmuted. Selecting `layerLive` is an
explicit opt-in after the sound-lab audition; constructing that layer does not
play a sound. Pass a player factory for silent tests. Settings decode before
the factory runs, and one player is shared until its layer scope closes.

```ts
import * as Effect from 'effect/Effect';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { AudioNotifications } from '../src/sfx/notifications.js';

const runtime = ManagedRuntime.make(AudioNotifications.layerSilent);
try {
  const playback = await runtime.runPromise(Effect.flatMap(
    AudioNotifications, audio => audio.play('success'),
  )); // { status: 'skipped', reason: 'silent' }
} finally {
  await runtime.dispose();
}
```

Use the caller's turn/job lifetime for playback. Do not detach a turn cue into a
session fiber or stop independent background cues when the turn ends. The adapter
uses `Effect.callback` with a cancellation finalizer, following the vendored
[callback interruption tests](../repos/effect/packages/effect/test/Effect.test.ts).
Effect aborts the supplied signal; the finalizer awaits the native playback
Promise. This is necessary because `tryPromise` alone can return from interruption
before a subprocess has exited. The player scope also aborts and drains captured
service calls that were run outside the ManagedRuntime.

Audio is optional: discovery and playback errors become a `failed` playback value
containing an internal `IOError`, rather than a task failure or retry. Audio-only
cleanup failure is retained in `lastFailure`; it cannot skip draining active cues
or fail session disposal. Display only `publicFailureMessage(error)`, never its
cause. Interruption remains interruption, and does not populate failure diagnostics.
No failure handler plays a second cue. Workflow event mapping, operation IDs,
deduplication, frequency limits and live chat controls belong to steps 7–9;
the service does not listen to Runner/UI events or parse their display strings.

## Promise and AbortSignal boundaries

`fromAbortablePromise` adapts a possibly failing Promise through
`Effect.tryPromise({ try, catch })`. It is lazy and catches both synchronous
throws and Promise rejections. Always pass its supplied AbortSignal into the
actual operation. An interrupted waiting fiber cannot stop an SDK, stream or
process that ignores cancellation. Resource-owning adapters also need scoped
finalizers; `tryPromise` does not acquire ownership or wait for arbitrary
legacy cleanup to finish.

`toLegacyPromise` runs already-provided effects outside a Session. It
checks a pre-aborted signal before executing any side effects, and uses
`runPromiseExit` so structured causes survive. It rejects only after Effect
scope finalizers finish. Session edges use their ManagedRuntime runners and
the shared `legacyExitValue` cause handling. Runtime disposal is executed outside
the runtime itself, as `ManagedRuntime.dispose()` does, so it can finish closing
the managed scope and interrupt/await any runtime-owned fibers.

The adapters preserve callbacks, result objects, provider definitions, selected
models and call counts. They add no retries, deadlines, fallback models or
background fibers. Translate caller AbortSignals at the execution boundary;
use Effect's signal inside operations.

## Failure, interruption and defects

`src/core/errors.ts` defines `ValidationError`, `IOError`, `TimeoutError`,
`ProtocolError`, `ToolAccessDenied` and `ToolExecutionError`. Use tagged errors
for expected outcomes that callers need to distinguish. A validation error
retains its Schema cause and an application-owned safe message. The temporary
legacy model/tool adapters retain unclassified Promise failures as `IOError`
or `ToolExecutionError`; do not classify legacy failures by matching display
strings. Add domain-specific failures when the implementations migrate.

The temporary `sessionExitValue` adapter preserves a lone legacy startup/model
failure's original Promise error and message; instruction, model and saved-plan
diagnostics therefore remain compatible. It never classifies errors by matching
their messages. Combined failures use fixed application messages and retain the
complete Cause. Provider/storage acquisition failure types will migrate at their
own boundaries rather than being guessed during this ownership change.

`releaseSessionResource` wraps cleanup causes in `IOError` with a constant
operation name and uses `orDie` for the finalizer's non-failing type. A cleanup
defect remains visible in the returned Cause, alongside any original startup
failure and other cleanup defects. This is not a swallowed cleanup error or an
instruction to retry finalization. Tests inject multiple failures and verify both
cause preservation and release of the remaining resources/lock.

- **Failure** is an expected value in Effect's typed error channel. Handle it
  with typed handlers and domain policy.
- **Interruption** ends a workflow's lifetime. Preserve it through error
  handlers; do not convert it into success, an empty result or a retry.
- **Defect** signals an unexpected implementation failure. Keep it distinct
  from recoverable failures. A throwing error-mapper itself creates a defect.

The public adapter rejects with `EffectAdapterError`: `kind` distinguishes these
outcomes, interruption uses the `AbortError` name, and `cause` retains the full
Effect Cause. Combined cleanup/original failures remain present. Only its safe
message should reach UI consumers; never stringify diagnostic causes, private
provider errors or configuration payloads into public output. Operation names
and `ValidationError.message` must be application-owned text. Use constant
messages for unknown failures and defects.

Refer to [Effect.tryPromise](../repos/effect/packages/effect/src/Effect.ts),
[Cause](../repos/effect/packages/effect/src/Cause.ts), and
[scoped acquisition](../repos/effect/ai-docs/src/01_effect/05_resources/10_acquire-release.ts).
Keep Bun tests until a real controllable-clock/fiber testing need arises.

## HTTP, browsing and MCP services

[Http](../src/core/http.ts) provides `withResponse(url, timeoutMs, consume)`.
Run `readResponseBytes` inside its consumer so the response scope owns the reader.
Only completed bytes and inert response metadata may leave the consumer. The
`Http.layer(fakeFetch)` test layer uses the same ownership as the live adapter;
application browsing bridges use `Http.service(fetchImpl)` without another runtime.

Fetch acquisition uses `tryPromise` with its supplied signal. A response controller
covers the body lifetime after headers arrive. Reader finalization aborts that
controller, awaits cancellation and releases the lock, including a stalled read.
Acquisition finalization drains a late fetch and cancels any unconsumed body.
`timeoutOrElse` retains a typed `TimeoutError` after those finalizers complete.
Native fetches must honor cancellation; abandoning their Promise does not prove
cleanup. Do not use `acquireRelease`'s default uninterruptible acquisition around
a network handshake or fetch that can stall.

`browse_url` keeps its 2 MB limit and original URL/content/line/snapshot policies.
`fetch_url` keeps its legacy full response size reporting, text cap and binary
summary; it also consumes its body with a scoped reader. Empty raw responses stay
valid; browsing still requires a body. A canceled native fetch may leave its stream
in an errored state. `cancelResponseReader` distinguishes that stored read error
from a new cancellation failure; only the latter becomes a cleanup defect.

[Mcp](../src/core/mcp.ts) provides lazy connections and typed request effects.
`Mcp.layer(factory, failureMapper)` is available for deterministic tests. The
Promise-based `Integrations` facade acquires the same service in one explicit
Effect scope. Session/toolset ownership closes that scope through the existing
`Integrations.close()` handoff; standalone tools own it through their `close()`.
This bridge adds no ManagedRuntime. The service's private owner scope releases
connection child scopes after aborting/draining pending handshakes and calls.
Failed acquisition closes its child scope before clearing the shared pending exit.
Successful connections remain available across turns.

Register client and transport finalizers before connecting. Memoize native close:
SDK initialization itself can invoke `client.close()`, and that in turn closes its
transport. Constructor, handshake, timeout, interruption and shutdown paths must
not invoke the underlying release twice. Keep cleanup defects and the original
failure together; attempt every remaining finalizer even when a close fails.
The facade caches the disposal Promise, including a failed disposal.

The first connection caller owns a shared pending handshake. A joining caller can
stop waiting independently; interrupting the initiator rolls acquisition back for
all waiters, and a subsequent request can reconnect. The connection deadline is
15 seconds; each call or discovery page retains its separate 30-second deadline.
Do not turn pagination into a single total deadline or add automatic retries.

[MCP HTTP ownership](../src/core/mcp-http.ts) carries the current Effect signal
through `AsyncLocalStorage` into the SDK's custom fetch hook and combines it with
SDK, connection and session signals. Protocol cancellation alone does not cancel
the actual HTTP POST. The wrapper owns native response byte readers and drains
them on call completion/cancellation or session shutdown. SDK JSON/SSE parsing,
replay and protocol behavior remain in the SDK; this is not a replacement parser.
Request cleanup hooks wait for detached native reader cancellation, and the
connection scope covers optional GET streams and late fetch acquisition.

[External Promise adapters](../src/core/external-io.ts) retain typed Causes, safe
browsing messages and the existing capped/redacted MCP diagnostics. `HttpFailure`
and `McpFailure` retain private causes for diagnostics; never expose those causes.
Exact allowlists, lazy environment references, secret redaction and opaque native
tool schemas remain in the integration facade, before any client acquisition.
