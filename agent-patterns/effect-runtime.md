# Effect runtime patterns for Victral

The dependency is pinned to `effect@4.0.2`. Consult the read-only v4
checkout under `repos/effect`, then compile against the installed package.
Import from `effect` or its public modules, never from the checkout. Prefer
public module imports such as `effect/Schema` in production boundaries to limit
cold module loading with the application's external-package Bun build.

## Services and ownership

Follow the vendored [service example](../repos/effect/ai-docs/src/01_effect/03_services/01_service.ts):
extend `Context.Service` with a package-qualified identifier, implement traced
methods with `Effect.fn`, and provide implementations through `Layer`. Keep
pure helpers as ordinary functions. The production examples are
[ProviderModel](../src/providers/core.ts), [Session services](../src/core/session-services.ts),
and the Schema-backed [tool registry](../src/tool-registry.ts). Tests exercise fake
implementations of these actual boundaries rather than a parallel migration-only
service.

Session owns one `ManagedRuntime`, following the vendored
[integration example](../repos/effect/ai-docs/src/04_integration/10_managed-runtime.ts).
Do not add a runtime per turn, tool call, model switch or worker request.

[Session.open](../src/session.ts) builds a scoped `Layer.effectContext` and awaits
the private session service before publishing the Session. Small services expose
[settings, model creation and storage](../src/core/session-services.ts). Runtime
startup builds them once; synchronous model switches and worker model factories
use its cached context through `runSyncExit`. The external Session/UI API remains
Promise-based; the Runner executes typed, scoped Effect turns in that runtime.

## Current resource owners

| Resource | Owner and release |
| --- | --- |
| Session runtime | `Session.close()` caches one disposal promise; failed startup also disposes it. |
| Chat storage and lock | `SessionStorage.acquire` uses `Effect.acquireRelease`; its finalizer calls the original `Storage.close()` once. |
| Memory, evaluations and metrics | Session layer finalizers stop/close the existing instances, in that order, before releasing storage. |
| Session listeners and UI timer | A session finalizer detaches them before closing the Runner. |
| Main Runner and project toolset | A guarded toolset finalizer closes the Runner when construction succeeded, or closes the toolset directly when Runner construction failed. |
| Integrations and research workers | Scoped fallback owners cover partial startup; successful toolset acquisition transfers ownership to toolset `close()`. Integrations closes its Effect-owned MCP connection scope; workers close their Effect-owned supervisor/job scopes. |
| Command processes and worker Runners | Commands own scoped job fibers; research workers own supervisor fibers and scoped Runners. The project toolset closes both owners. |
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
cleanup. Their scoped Effect owners drain native cleanup before releasing capacity.

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
turn mapping/deduplication/frequency limits are supplied by the step-7 observer; worker events are connected in step 8; live chat controls and evaluation observers remain in later phases;
the service does not listen to Runner/UI events or parse their display strings.

## Promise and AbortSignal boundaries

Use `Effect.tryPromise({ try, catch })` for plain Promise acquisition/reads only
when its scope already owns all required cleanup. Pass Effect's supplied signal
into actual I/O. It does not drain arbitrary pending native work on interruption.
Resource-owning Promise bridges use [toolPromise](../src/tool-effects.ts), whose
interruption finalizer aborts and awaits native cleanup. Provider/HTTP/MCP boundaries
own their acquisition and body readers in scopes.

`runToolEffect` and provider public adapters run already-provided effects outside a
Session. They check pre-aborted signals, use `runPromiseExit` and preserve complete
Causes. Native session effects execute in the session ManagedRuntime, including
settle/drain coordination; its only external disposal runner closes the runtime
itself, as `ManagedRuntime.dispose()` does. No new runtime is allocated per call.
The removed `LegacyPorts` service and generic foundation Promise helpers had no
remaining application consumers. Intentional `cli.js`/`runner.js` entry points,
Promise APIs, synchronous durable writes and injected-model/tool bridges remain.

The adapters preserve callbacks, result objects, provider definitions, selected
models and call counts. They add no retries, deadlines, fallback models or
background fibers. Translate caller AbortSignals at the execution boundary;
use Effect's signal inside operations.

## Failure, interruption and defects

`src/core/errors.ts` defines `ValidationError`, `IOError`, `TimeoutError`,
`ProtocolError`, `ToolAccessDenied` and `ToolExecutionError`. Use tagged errors
for expected outcomes that callers need to distinguish. A validation error
retains its Schema cause and an application-owned safe message. Providers, storage,
turns, commands and other external boundaries define their domain failures. Do not
classify failures by matching display strings, except the documented compatibility
adapter for externally injected legacy Jev HTTP errors.

`sessionExitValue` is an intentional public-boundary adapter. It preserves lone
startup/model failures and compatible instruction/model/plan diagnostics. Combined
failures use fixed application messages and retain the complete Cause. Native
provider/storage error classification remains at its own boundary.

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

## Provider transport, streaming and usage

[Meta](../src/meta.ts), [OpenAI](../src/openai.ts) and the model factory are now
TypeScript. Each adapter exposes a borrowed `effects` service; install it with
`ProviderModel.layer(model.effects)` when composing Effect callers. Its `chat`
and `stream` methods receive an Effect lifetime. Translate external AbortSignals
at `runPromiseExit`/ManagedRuntime boundaries, rather than passing them in service
options. Existing memory and Session callers keep the Promise-based
`chat`/`stream` API until their scheduled migrations. The factory still chooses
only an explicit supported model and preserves compactor effort/web-search policy.

```ts
import * as Effect from 'effect/Effect';
import { ProviderModel } from '../src/providers/core.js';
import { createModel } from '../src/models.js';

const model = createModel('sol6.1', { apiKey: 'configured-key', purpose: 'agent' });
const result = Effect.flatMap(ProviderModel, provider => provider.stream([], {
  onText: text => process.stdout.write(text),
}));
// In a session, provide this borrowed layer to its existing runtime.
const provided = result.pipe(Effect.provide(ProviderModel.layer(model.effects)));
// Run at a standalone boundary only; the effect returns typed failures.
const exit = await Effect.runPromiseExit(provided);
```

`Http.withRequest` owns POST acquisition and body consumption without introducing
a provider deadline, retry, fallback or output-buffer limit. `consumeSse` in
[sse.ts](../src/sse.ts) keeps the original scan cursor and framing algorithm:
UTF-8 fragmentation, LF/CRLF/CR boundaries, multiline data and a final
unterminated frame. Its handler returns false at a terminal event, so an open
connection or invalid later frame cannot stall or corrupt a completed response.
Each read uses `tryPromise`; the response scope aborts/cancels/drains/releases its
reader on success, failure and interruption. The test-only compatibility
`sseData` iterator uses the same framer.

Keep visible text, thoughts, awaited entry callbacks, citations and native replay
separate. Text/thought callbacks stay synchronous; no new smoothing timer or
buffer is added. Entry callbacks preserve their awaited ordering. Interrupting
an asynchronous entry callback aborts the native request immediately and waits
for the already-started callback to settle before releasing its response. Do not
abandon a persistence callback and allow it to write after the canceled operation
has returned.

`ProviderFailure` distinguishes transport, HTTP, malformed, truncated and explicit
provider failures. It retains private causes, safe constant malformed/transport
messages and redacted provider HTTP/error diagnostics. HTTP status is explicit.
`ProviderOutputLimit` retains a typed partial result in the error channel. The
legacy Promise adapter recovers a **lone** limit as `MAX_TOKENS`, preserving the
existing caller policy and native replay without silently retrying or duplicating
text/tool calls. A compound failure containing a cleanup defect must still reject.

Preserve complete Causes when translating a scoped operation's errors. In this
vendored v4 implementation, `mapError` and `catchTag` can select one typed failure
from a compound Cause and discard other reasons. The provider uses `catchCause`
with `Cause.map` for error translation and checks the completed Exit before
recovering a lone limit. Never erase reader cleanup defects or interruption while
handling a nominally recoverable provider outcome.

Instrumentation lives in the borrowed Effect service, covering both Effect and
Promise calls exactly once. The `createModel` factory adds request IDs, measured
latency, first nonempty visible-text timing and completed/error/canceled status;
agent, compactor and subagent purposes remain distinct. Direct provider
construction retains its legacy successful-usage callback behavior. Limit results
report completion with `MAX_TOKENS`; failed cleanup reports error. Report only
after response cleanup, and do not re-report when the usage sink itself throws.
No failure report fabricates successful token usage.

The [pure model catalog](../src/model-catalog.ts) supplies labels, aliases and
completion without importing provider transport into the terminal UI bundle.
`models.ts` reexports the existing catalog API for compatibility. The remaining
compactor scheduling and evaluation orchestration belong to their later steps.


## Tools, batches and command lifetimes

[ToolRegistry](../src/tool-registry.ts) exposes `executeEffect`, with the existing
Promise `execute` as its compatibility boundary. `schemaTool` decodes once during
preparation, then binds the decoded argument type to a lazy Effect invocation.
Supply `executeEffect` when an implementation already uses Effect; native command
operations take this path. The fallback [toolPromise](../src/tool-effects.ts)
adapter preserves the audited filesystem/patch transaction bodies and drains
already-started work on interruption. Do not replace it with `tryPromise` if that
would let a canceled tool return before a file write or patch rollback finishes.
An expected abort rejection belongs to interruption; a different failure during
drain remains a cleanup defect. Promise edges retain existing domain messages;
compound causes must never be squashed into a nominally successful tool result.

`AgentTools.executeEffect` is optional for legacy/fake ports. Runner and Session
prefer it within their existing runtime; injected Promise ports retain the draining
adapter. Typed failure translation uses `catchCause`/`Cause.map` and preserves
defects and interruption. The toolset owner remains unchanged. Apply read-only guards
to both public entry points, and keep MCP permission checks inside execution.

[parallelTools](../src/parallel-tools.ts) prepares every nested invocation before
executing any of them. Use `Effect.forEach(..., { concurrency: 8 })` for the
validated maximum-eight batch. Output stays in input order, and ordinary runtime
failures are per-call error results. Cancellation, defects and compound causes
fail the operation. Keep the 3000-byte cap, exact headings and nested-call counts.
Do not decode each nested tool inside its running fiber: a later invalid tool
must prevent earlier valid tools from performing I/O.

[CommandTools](../src/command-tools.ts) owns one closeable job scope. Its child
supervision follows the vendored
[`forkIn` tests](../repos/effect/packages/effect/test/Effect.test.ts) and
[`Scope` implementation](../repos/effect/packages/effect/src/Scope.ts).
A job fiber belongs to this scope through `forkIn`, rather than to its transient
start invocation. The owner closes the scope once and drains all jobs, including
foreground commands. This uses fibers, not another ManagedRuntime.

Pass the originating turn's long-lived signal explicitly when starting jobs:
`tools.executeEffect(name, args, onNestedCall, turnSignal)`. Existing Promise
callers supply it through `execute(name, args, turnSignal, onNestedCall)`.
Run the Effect invocation with the appropriate turn interruption signal as well.
Do not attach background work to `Effect.abortSignal` from the short tool scope:
normal scope closure would terminate a job that must outlive its starting call.
Removing a completed invocation does not remove the job's original abort listener;
the listener is released when job cleanup ends. This seam is available for the
Effect turn loop, which supplies the original controller signal to background starts.

Sync process/reader acquisition uses atomic finalizer registration. Never acquire
a process and yield before installing its cleanup. Concurrent stdout/stderr reads
own their locks; read failure interrupts the sibling and kills the process group
before awaiting native cancellation. Ignore only a reader's *same stored error*
from cancel; retain a new cancellation failure as a defect. Release locks in
`finally`. Child exit and pending stdin work must settle before owner shutdown.

Foreground cancellation kills and drains its job. Interactive writes use scoped
acquisition of the write guard, a two-second Effect deadline, and cleanup that
kills before draining a blocked FileSink operation. EOF changes stdin state only
when requested. Status waiting is a race between job completion and the bounded
wait; interrupting that wait must not stop someone else's job. Stop drains native
cleanup uninterruptibly after issuing the kill. Keep literal argv, filtered
environment, process-group kills, job limits and legacy report/list bytes.


## Agent turns and presentation

[Runner](../src/runner.ts) preserves settle → render → take queued input →
provider → tools → boundary input → next call. Its public methods still return
Promises. Session supplies its existing runtime executor; standalone callers use
one service-free run boundary. Do not create a ManagedRuntime per turn.

Publish the owner flag and shared drain Promise before invoking callbacks.
Reentrant submit calls must share that owner, and their input must keep submission
order. The current queue is only synchronously appended/spliced by this owner and
its callbacks; adding a Queue or Ref would not replace competing asynchronous
state. Input during a call is logged immediately once, keeping `work` distinct
from `user`, and is injected as user content at the next tool boundary. Render
before taking a fresh turn's input. On settle failure/cancellation, log unanswered
input for the next explicit submission; do not retry it automatically.

A turn scope owns an execution fiber and an abort watcher. The watcher resumes on
the explicit controller signal and requests `Fiber.interrupt(turn)`. The owner
uses `Fiber.await(turn)` to obtain the actual completed Exit after finalizers.
This follows the vendored
[Fiber examples](../repos/effect/packages/effect/src/Fiber.ts) and
[scoped-fork patterns](../repos/effect/packages/effect/test/Effect.test.ts).
Do **not** race cancellation against the whole turn with `raceFirst` when you
must retain cleanup errors: its winning cancellation result can discard cleanup
defects from the interrupted loser. The native cancellation diagnostic test
proves the scoped-fiber pattern retains both interruption and a rollback defect.
The watcher is removed when the turn completes, without aborting the original
signal attached to background commands. The command/job owner remains Session.

`TurnFailure` retains a phase, public message and private original cause. Translate
with `catchCause`/`Cause.map`; ordinary tool domain failures remain error results,
while defects, compound failures and interruption escape per-tool formatting.
`Runner.lastFailure` holds the completed Cause for internal diagnostics only.
Never place it in saved messages or events. Finish checks and limits remain
application policy: no extra model fallback, retry or tool execution after an
incomplete finish. Report one turn metric after cleanup; an error-display callback
failure must not skip that metric. Close is memoized and drains the turn before
closing the toolset, retaining both drain and cleanup failures.

[smoothResponseEffect](../src/smooth-response.ts) keeps `smoothStream` at the
existing 10ms word cadence and keeps native content/entries outside presentation.
The display reader and provider belong to its scope. Display interruption sets
the canceled latch and cancels the reader immediately, even while provider cleanup
must wait for a started entry callback. Await that callback and native work before
ending the turn; no old display chunk may escape into a later response. Provider
failure flushes partial display before failing. Native adapters retain typed limits;
the legacy Promise smoother recovers only a lone limit after scoped cleanup.
Use offline transport fixtures when testing native providers rather than spying
on their Promise methods, which the migrated Runner no longer calls.

[Workflow events](../src/workflow-events.ts) contain an operation ID, kind and
status only. Emit start and verified terminal states for turns/model calls/tools;
emit retry only when actually retrying. The independent
[audio observer](../src/sfx/workflow.ts) maps turn events to existing cues, ignores
model/tool chatter, deduplicates operation/status pairs with bounded retention,
and rate limits onset cues. Processing playback follows turn cancellation; terminal
cues belong to Session's short playback scope. Observer/player failure cannot
fail a turn, create a retry or recursively emit an error cue. Events and cues
never enter memory. Session still installs the silent layer; live notifications
remain an explicit opt-in with controls required before activation.


A native invocation's I/O signal must combine its originating lifetime signal
with the callback fiber's interruption signal. Otherwise a failed batch can
interrupt a sibling fiber while that sibling's native I/O keeps waiting on a
still-live turn signal. `toolPromise` combines those signals for native calls;
`legacyToolEffect` is confined to actual registry Promise entry points that retain
caller-signal identity. Do not apply that compatibility override to the whole
Runner workflow or session runtime. The nested-I/O interruption test verifies
that a native failed batch cancels its sibling while leaving the background-job
origin signal un-aborted.


## Research workers and report acceptance

[Subagents](../src/subagents.ts) owns a closeable supervisor scope; each worker
owns a Runner scope, controller, fiber and completion Deferred. Follow vendored
[`forkIn` examples](../repos/effect/packages/effect/test/Effect.test.ts),
[Scope finalizers](../repos/effect/packages/effect/src/Scope.ts) and
[Deferred](../repos/effect/packages/effect/src/Deferred.ts). The Deferred replaces
shared work-Promise state and is allocated before callbacks can reenter stop.
It completes once after execution, native cleanup and report acceptance, even
when execution/delivery fails. Keep shutdown and stop memoized/draining rather
than returning after merely requesting interruption.

Snapshot the selected model/effort, read-only toolset, parent context and custom
instructions synchronously at spawn. Preserve three active worker lifetimes,
32 retained results, 20 model steps and the five-minute deadline. Capacity must
not be released while owned cleanup or receipt work is still outstanding. Native
spawn borrows the caller's runtime context (including Clock), but the job's scopes
must replace the short calling scope. The Runner workflow is forked into the job
scope; no worker creates a ManagedRuntime. `TestClock` tests exercise the deadline
through native spawn with borrowed services, not a production timeout override.

The original turn's abort listener stays attached during worker execution.
Ordinary parent completion must not close the job or abort that signal. Stop,
deadline, canceled drain and owner close cancel the worker's controller and Runner,
then wait for scoped cleanup. Deadline sleep lives in the execution scope and is
removed before tool cleanup and report delivery. Keep existing reason/result bytes.
The worker controller also ends its processing cue, independently of other turns.

Register tool/Runner cleanup before later factories can throw. Native failed spawn
waits for rollback, including if its caller is canceled during rollback. Legacy
synchronous spawn preserves its original exception while a managed rollback fiber
owns cleanup and owner close awaits it. Combine original and release Causes rather
than erasing either reason. Execution/cleanup diagnostics remain internal through
`lastFailure`; no Cause or raw task data belongs in workflow events.

Borrowed context can carry a legacy Promise entry point's signal-identity policy.
Use `nativeToolEffect` for worker supervision and Runner workflows so native
operations combine invocation interruption with the originating signal. Preserve
other borrowed services. Otherwise a failing nested batch could interrupt a fiber
while its I/O still waits on a live origin signal. A legacy-spawn/native-worker
regression test protects this boundary.

Reports keep the existing agent-authored marker and enter the parent queue as
`work`, once. An optional async report return is a receipt for acceptance/enqueuing.
**Do not return the parent's whole submission/response Promise as that receipt**:
a parent waiting in stop/drain can otherwise deadlock with its worker waiting for
that same parent turn. Session enqueues synchronously and observes parent handling
separately. Report rejection is retained as a delivery failure without retry.
Shutdown suppresses new deliveries but drains receipts already started, preventing
writes after release. Re-snapshot drain until all owned jobs finish, since report
handling may start more workers. Session then waits for the parent's response and
repeats if workers were created; both CLI `--ask` and piped EOF use that boundary.

Worker events have their own stable IDs and job lifetime. The independent audio
observer handles turn/worker outcomes, excludes model/tool chatter and retains its
deduplication/onset limits. Observer failure never fails or retries a worker;
Session remains silent by default. Keep execution-time read-only/recursion guards,
provider usage purpose `subagent`, literal prompts and report/list/status formats.

## Background evaluation ownership and retries

[Evaluations](../src/evaluations.ts) owns a parallel closeable scope and an Effect
Queue with two default consumers. Pending records are saved before dispatch;
recovered queued/running records enter the same queue. `pumpEffect` captures the
caller's context once, including Clock, while keeping the owner scope independent
of any turn. The legacy `pump` adapter starts with the default runtime context.
Session starts native consumers with its runtime services and installs the same
isolated workflow observer used by turns/workers. Drain cancellation ends only
that wait; closing the owner interrupts consumers and awaits their native cleanup.
Active canceled jobs return to persisted queued state, with full diagnostic Causes
retained privately even if cleanup fails. Evaluations never append chat messages
or rewrite memory, and exact-copy nodes need no audit.

Each attempt has a 60-second Effect deadline. A `Schedule.exponential(1000)`
restricted to two recurrences retains 1,000/2,000ms retry delays. Only a lone typed
HTTP 429/503/529 failure can retry; compound cleanup failures, schema failures,
network errors and timeouts cannot. Retries increment and emit a typed event when
the next request actually starts, rather than when a delay is scheduled. Native
Jev HTTP bodies are consumed in the scoped transport before retrying. Injected
Promise audits use `toolPromise` to abort and drain pending native work.

Tests borrow `effect/testing/TestClock` using `pumpEffect`; this follows vendored
`test/TestClock.test.ts` and `test/Schedule.test.ts` examples without adding a
second testing package. Advancing 999/1/1999/1ms verifies both delay boundaries
and the exact three-call ceiling. Offline fixtures also verify worker capacity,
shutdown/restart, cancellation during backoff, deadlines and probability bounds.

## Synchronous durable commits and scoped storage

[Storage](../src/storage.ts) keeps the synchronous adapter required by memory,
plan and telemetry callbacks. `Storage.acquire` follows the vendored acquire/release
pattern and the SessionStorage service owns it in the session layer. Construction
rollback releases the lock, preserving both construction and cleanup errors if both
fail. Closing is cached. The socket lock retains live-contention rejection, stale
socket probing and inode-change protection.

Native append/node/view effects wrap only the synchronous durable operation as an
uninterruptible section. There is no yield between writing, fsync, closing the file,
fsyncing a newly created parent entry, and publishing the record in memory. Views
write/fsync/close a private temporary file, rename, then fsync the directory. Reads
remain interruptible Effect operations; no async filesystem/fsync replacement is
introduced. Fault-injection tests verify exact order, permissions, short writes,
failed fsync/rename, immutable nodes and an interruption requested during fsync.

Do not publish before a durable write succeeds, put an interruptible Promise between
write and publish, or make an entire session uninterruptible. A failed append can
leave bytes requiring the existing restart recovery; this migration does not turn
append-only logs into transactional rewrites. View coverage and compaction ranges
still belong to the original pure restore/view algorithms.

## Supervised compactions preserve the indexed scheduler

[MemoryJobs](../src/memory-effects.ts) owns compactor fibers in a parallel scope.
[Memory](../src/memory.js) keeps its existing level/index heaps, source eligibility,
early-message admission window and eight default active slots. Effect is responsible
for job lifetimes, not for selecting a different candidate order. Both native and
legacy compactor models retain the same prompt/tools/context and five attempts with
byte feedback, selecting the shortest complete summary. Native output limits retain
the legacy incomplete-response diagnostic; compound cleanup failures never become
successful partial summaries.

Session calls native `pumpEffect` only after Runner configuration installs the
complete system prompt and tool schema. The owner borrows runtime services once;
completed turns and canceled settle/drain waiters leave compactions alive. Native
provider effects use the owner scope directly. Injected legacy Promise models and
build overrides use the draining `toolPromise` adapter, with native signal policy
restored before job execution. Slots stay occupied until native cleanup finishes.

Settle/drain use scoped callback subscriptions, remove listeners on every exit and
retain their existing Boolean Promise adapters. Stop requests interruption of all
active fibers, awaits them and is cached; canceled jobs are reconstructed from the
unchanged saved history/node set after restart. Ordinary failures retry on new input
or an explicit settle request, with no background retry timer. Full Causes remain
in owner diagnostics rather than chat or persisted memory.

Node/change event adapters retain synchronous delivery and once-listener behavior,
but isolate each observer and observe rejected async receipts without waiting for
them. Audit/metrics failures cannot invalidate a committed immutable node or prevent
another observer from running. Summary bytes, view folding, four-line cache blocks,
UTF-8 splitting and zoom paging remain in their original pure implementations.


## Final session composition and contributor example

The session layer publishes the same acquired objects as SessionStorage,
SessionMemory, SessionEvaluations and SessionMetrics, alongside settings, model
construction, the silent audio layer and the UI Session instance. Context bindings
do not acquire duplicate owners. The existing handoff flags are deliberate: the
resource factories can fail between integration/worker acquisition and ownership
transfer to the toolset. Removing those guards would double-close shared resources
or leak a partial acquisition; startup-failure tests cover every transfer point.

Use native operations within that runtime after its layer is acquired:

```ts
import * as Effect from 'effect/Effect'
import { SessionMemory } from './core/session-services.js'

const settledView = Effect.gen(function*() {
  const memory = yield* SessionMemory
  yield* memory.settleEffect()
  return memory.render()
})
// Execute from the existing session runtime; do not construct another runtime.
```

Session settle composes worker drain, late parent handling, memory settle and a
60-second audit-drain wait. The wait deadline unsubscribes without canceling audit
jobs. Caller interruption still cancels/drains workers, while memory/audit waiters
leave their background owners alive until session shutdown. Evaluation's own
per-attempt 60-second deadline remains independent.

CLI EOF finishes pending input and late reports before settling. Explicit piped
`/exit` finishes previously accepted input and ignores later lines before closing.
Its pending-input Set is an intentional external adapter receipt tracker, not a
second resource owner. Slash-command native tools execute in the session runtime. SIGINT cancels
an ask and retains exit status 130 even when its canceled-turn diagnostic arrives
later. SIGTERM requests the cached close; CLI finally awaits it and reports cleanup
failure once. The TUI uses the small snapshot/event interface and observes close
rejections before exiting; unmount removes listeners and restores raw input.

Metrics aggregation/formatting remain ordinary incremental code. Their synchronous
persistence callbacks already use validated, durable Storage methods; wrapping each
callback in a new asynchronous fiber would break publish/write ordering. UI batching,
copy-feedback/demo timers and native process/player/regex watchdogs remain deliberate
presentation/native-boundary mechanisms, not superseded workflow retry timers.
Origin AbortControllers also remain where public signals and background-job
cancellation require them. Never remove these merely because a fiber also exists.


## Explicit session fallback policy

The user-requested [FallbackModel](../src/fallback-model.ts) wraps only session
agent/compactor selections. Healthy calls retain the configured provider and exact
messages/options. On a lone typed provider failure, the original response scope
must finish before constructing/requesting `muse-wonder-full`. Cache the replacement
per role and keep it active for the session; never recursively retry the replacement.
Construction failure can also select it before any request. Native createModel and
research-worker/Jev policies remain unchanged.

Use catchCause and inspect a single FailReason before replay. Preserve compound
Causes, interruption and cleanup defects rather than treating their first failure
as recoverable. ProviderCallbackFailure is an intentional ProviderFailure subclass:
consumer/persistence callbacks must not replay model requests. Keep full Causes
when both primary and replacement fail, and report only model IDs in notices.
Fallback consumes Meta environment credentials; do not forward a primary OpenAI
API key into a Meta request. Usage instrumentation remains on each native provider,
so both requests retain their actual model, purpose and outcome.
