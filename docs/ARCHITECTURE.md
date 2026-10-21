# Runtime and persistence architecture

Victral uses Effect 4.0.2 for validated boundaries and resource-owning workflows.
The read-only reference checkout is `repos/effect`; application imports use the
installed package. Pure view selection, UTF-8 helpers, citation formatting,
terminal rendering and incremental metrics calculations remain ordinary code.

## Session composition

`Session.open` creates one ManagedRuntime and builds a scoped layer. Settings,
model construction, storage, memory, evaluations, metrics and the UI Session are
published as context services. The memory/evaluation/metrics keys expose the same
objects used by snapshots and synchronous callbacks. They do not acquire another
instance. The default audio service is silent.

| Boundary | Ownership and behavior |
| --- | --- |
| Session | Owns runtime startup, partial-acquisition rollback, finalization and the public snapshot/event adapter. |
| Runner | Owns a turn scope, streams native model results, executes validated tools, records one turn outcome and retains full failure Causes privately. |
| Providers / HTTP / MCP | Validate consumed wire fields, preserve native replay extensions, scope transports/readers and await native cleanup. |
| Tool registry | Checks capabilities and decodes unknown arguments before invoking native Effects. Prepared batches validate all members before I/O. |
| Commands / research workers | Retain session-owned jobs after a turn completes; originating-turn signals and explicit stop still cancel their work. Slots remain occupied through cleanup. |
| Memory | Keeps indexed ready-queue ordering and pure view algorithms; supervises eight default compactions and callback-based settle/drain waiters. |
| Evaluations | Owns two default Queue consumers, complete-state guards, independent judgments and only the existing bounded transient-status retry policy. |
| Storage | Owns the single-writer socket lock, validates extensible records and keeps synchronous durable write/publish sections. |
| Metrics | Observes nodes/results and stores telemetry through validated synchronous Storage calls; aggregation and formatting remain incremental pure calculations. |

Construction callbacks can fail before tool ownership transfers. Explicit handoff
flags prevent duplicate cleanup and retain a fallback owner until transfer succeeds.
All acquired resources are finalized even if another cleanup fails; combined Causes
are retained without exposing private payloads in public diagnostics.

## Lifetimes and cancellation

Completed turns retain background commands, workers, compactions and audits.
Session settle drains workers and the parent's late report handling, then memory,
then waits up to 60 seconds for evaluations. The evaluation wait deadline removes
its subscription; the evaluation owner retains the jobs. Each audit attempt has
its own independent 60-second deadline. Canceling memory/audit waiters also leaves
those jobs alive. Worker-drain interruption cancels workers and drains cleanup.

Closing is cached and marks the session closed immediately. Finalization removes
session listeners, closes Runner/tools and their jobs, stops memory, cancels audits
into recoverable queued records, closes metrics and releases storage. Native SDK,
reader, subprocess and playback cleanup is awaited. Caller/origin AbortControllers
remain where the public API or background-job policy requires them; a fiber signal
alone does not replace that origin lifetime.

Slash-command tools and native workflows call native provider/tool/memory/evaluation Effects within the
session runtime or their supervised job scopes. Public Promise adapters remain for
CLI, UI, scripts and injected ports. The unused foundation `LegacyPorts` service
and its generic Promise helpers were removed. Intentional `cli.js` and `runner.js`
entry points remain usable. Runtime disposal runs outside the runtime it closes.

## Session model fallback

The main agent and compactor have independent configured-model-first wrappers.
Configuration/credential construction errors and lone typed provider failures switch
that role to its provider-specific fallback for the session. Cohere selections
use `command-a-plus-05-2026`; other configured providers retain
`muse-wonder-full`. Native `createModel` remains strict for standalone callers;
research workers and Jev keep their existing selection/retry policies.

Fallback initialization uses the fallback provider's environment credential,
never a primary provider key from the primary options. Healthy requests do not
initialize the fallback or make extra calls. A failed primary request can be
replaced once; failure of the replacement retains both Causes without a retry
loop. Provider response scopes finish cleanup before replacement. Interruptions,
compound cleanup failures and typed consumer
callback errors never cause failover. A session stays on the fallback until restart
or an explicit main-model switch. Active model IDs and usage remain accurate.

Primary stream entries already saved are retained. The failed request's pending
result is discarded, so its tool calls cannot execute; Runner executes only the
successful fallback result's calls. No memory, storage or callback failure is
reclassified as a model outage. Oversized complete compactor output still follows
its original five-attempt byte-feedback conversation.

## Durable data and presentation

Storage validates required fields without stripping metadata from legitimate older
records. Semantic task-plan rules belong to TaskPlans; view coverage belongs to the
pure restore algorithm. Native replay validation retains original objects rather
than encoding a Schema projection over provider payloads.

Append commits write, fsync and close before publishing in memory; newly created
log entries also fsync their directory. View commits write/fsync/close a private
temporary file, rename and fsync the directory. These synchronous commit sections
permit no interruptible yield between disk and memory publication. Failed/torn
writes retain the existing explicit failure and restart/backup recovery behavior.

Octane/Ink reads snapshots and subscribes to a small event adapter. Unmount removes
subscriptions and restores raw input. UI batching/copy-feedback timers remain
presentation concerns. Workflow audio observes typed IDs/statuses without parsing
prompts, output or telemetry and cannot fail or retry task work.

## Contributor references

- [Schema patterns](../agent-patterns/effect-schema.md)
- [Runtime, adapters and ownership examples](../agent-patterns/effect-runtime.md)
- [Migration verification and frozen fixtures](EFFECT_MIGRATION_BASELINE.md)
- [Upstream memory alignment](UPSTREAM_ALIGNMENT.md)

Run `bun run check` and `bun run build` for orchestration changes. Run the CPU-only
`bun run benchmark` when changing memory, storage, metrics or their orchestration;
retain zero idle-pump node reads and the recorded regression budget. Offline CLI,
TUI, request-byte and legacy-restart fixtures enforce the external contracts.
