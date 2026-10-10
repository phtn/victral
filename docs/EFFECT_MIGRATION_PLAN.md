# Effect integration plan

Prepared October 10, 2026 for Victral at `ba82ad30e`, including the pending
configuration and Schema-guide changes. This is an implementation backlog.

## Implementation status

Migration began October 10, 2026 from `c0f9a7d3e`. Steps 0 and 1 are complete;
step 2 now includes MCP configuration, task plans, audio settings, browsing,
file/Git reads, mutations and command-tool registries. These boundaries use the
pinned published Effect 4.0.2 dependency. The latest change passes 204 tests, typecheck
and build; legacy rendering, browsing/read/mutation output, file bytes/modes,
Git/command arguments and provider request/tool fixtures match unchanged.
Workers/MCP and the batch envelope remain ahead of the step-2 gate.

See the [baseline and frozen fixtures](EFFECT_MIGRATION_BASELINE.md),
[Schema patterns](../agent-patterns/effect-schema.md) and
[runtime/error conventions](../agent-patterns/effect-runtime.md).

## Recommendation

Integrate Effect now, incrementally: start with Schema at external boundaries,
then give resources and background work explicit lifetimes, then migrate the
agent loop. Migrate persistence and memory scheduling after those foundations
are proven. Keep pure algorithms and terminal rendering in ordinary TypeScript.

The first production upgrade should be **MCP configuration validation**, followed
by task-plan validation. These have small, well-tested boundaries and establish
patterns that later tool and provider migrations can reuse. Do not begin by
rewriting `Session`, memory, or the UI.

Use the read-only `repos/effect` checkout and
[the project Schema guide](../agent-patterns/effect-schema.md) as references.
Its package identifies itself as 4.0.3. Select and verify a matching published
package during setup; this document does not claim that the vendored version is
installed or is the newest release. Import from normal package dependencies,
never from `repos/`.

## Audio prototype before migration

The [sound lab](SFX_PROTOTYPE.md) is the pre-migration audition page. Run
`bun run sfx` and review success, processing, failure, retry, attention and
cancellation cues. It does not connect sounds to real model or tool events.
Complete this audition before enabling notifications in regular chat.

During the migration, add an `AudioNotifications` service at step 3. Keep the
sound patch, native playback adapter, and notification policy separate. Provide
an opt-in live layer and a silent test layer. The session owns playback resources;
turn interruption stops cues tied to that turn, while background job cues retain
their job lifetime.

Add schema-validated volume/mute settings at step 2. At steps 7–9, emit typed
workflow events carrying stable operation IDs, not raw payloads or credentials:
processing on start, success on verified completion, failure on failed completion,
retry on an actual retry attempt, and a separate canceled event on interruption.
Connect an independent audio observer to those events; do not add sounds to
conversation memory or derive them by parsing display text.

Deduplicate events and limit frequent cues. Processing should be a short onset
cue, not a loop or one sound per token. Audio failure must not fail an agent task,
trigger a workflow retry, or recursively play an error cue. Add fake-player tests
for event mapping, cancellation, duplicate suppression and notification volume.
Preserve the existing retry policy and selected model; SFX never causes an
additional model call. Expose mute, volume and stop controls before enabling
live notifications.

## Sequence

Implement each row as a separately reviewable change, in this order. Each row
must meet its acceptance gate before the next production migration starts.
Effort is relative: S = contained boundary change, M = several cooperating
modules, L = stateful subsystem requiring extensive compatibility checks.

| Order | Upgrade | Main files | Effort | Outcome |
| --- | --- | --- | --- | --- |
| 0 | Baseline and invariants | Tests, fixtures, benchmark | S | A migration can demonstrate unchanged behavior |
| 1 | Dependency and conventions | `package.json`, `bun.lock`, new core modules | S | One verified Effect version and common error/adapter patterns |
| 2 | Schema boundaries | `integrations.ts`, `task-plans.ts`, tool inputs | M | Unknown input becomes validated domain data |
| 3 | Session runtime and resource ownership | `session.ts`, new runtime/service layers | M | One session runtime with explicit cleanup ownership |
| 4 | HTTP, browsing and MCP services | `web-browser.ts`, `integrations.ts` | M | Cancellation and cleanup propagate to actual I/O |
| 5 | Provider transport and streaming | `meta.js`, `openai.js`, `models.js`, `sse.js` | M | Typed provider failures and scoped response streams |
| 6 | Tool execution and command jobs | `tools.ts`, `command-tools.ts`, `parallel-tools.ts` | M | Validated dispatch and supervised processes |
| 7 | Turn execution | `runner.ts`, `smooth-response.ts` | L | A turn is one interruptible workflow |
| 8 | Research workers | `subagents.ts` | M | Supervised workers with automatic report delivery |
| 9 | Background evaluations | `evaluations.js`, `jev.js` | M | Explicit concurrency and existing retry policy |
| 10 | Persistence, then memory | `storage.js`, `memory.js` | L | Typed durable state and supervised compaction |
| 11 | Composition and cleanup | `session.ts`, `cli.ts`, metrics adapters | M | One coherent service graph and fewer compatibility shims |

## 0. Establish the baseline

- [x] Run `bun run check` and `bun run build`; record the results. The most recent
      completed check before this plan passed 137 tests across 18 files.
- [x] Record `bun run benchmark` results with the same history size and machine
      settings for later comparisons; set acceptable regressions before implementation.
- [x] Identify coverage gaps and add only missing contract tests: partial startup
      failure, cancel during acquisition, repeated close, and late worker reports.
- [x] Save representative provider request/replay fixtures and prompt/tool-schema
      bytes, using fake credentials. Preserve a legacy chat fixture and restart
      expectations. Keep these fixtures outside `repos/`.

**Gate:** the baseline covers behavior and resource cleanup, and all application
checks pass without discovering vendored tests.

## 1. Add the dependency and establish patterns

- [x] Verify a published Effect version compatible with the inspected v4 API,
      pin the dependency, and update the lockfile. Confirm Bun and TypeScript
      compatibility with a minimal compiled/runnable application example.
- [x] Use `Context.Service`, `Layer`, and `Effect.fn` following the vendored
      examples. Define shared typed errors for validation, I/O, timeout,
      protocol failure, and denied tool access, introducing domain-specific
      errors where callers need distinct handling.
- [x] Define how interruption differs from ordinary failure and from defects.
      Preserve original causes internally and redact public messages.
- [x] Establish narrow Promise/AbortSignal adapters for existing `ModelPort`,
      `AgentTools`, and UI consumers. Do not convert those consumers yet.
- [x] Keep existing Bun tests. Add Effect testing dependencies only when a real
      clock/fiber testing need arises; inspect their matching vendored examples.

**Gate:** the version and examples compile; failure and cancellation adapters
have meaningful tests. No application import resolves into `repos/`.

## 2. Upgrade Schema boundaries first

- [x] Replace `parseIntegrations` checks with schemas for stdio and HTTP variants,
      server names, environment-variable references, and exact tool allowlists.
      Preserve defaults, size limits, unknown-field policy, and error usefulness.
- [x] Migrate task-plan input and saved-plan validation. Encode the step status
      enum, bounded text/collections, safe revisions, and at-most-one active
      step. Preserve trimming, revision conflicts, and save-before-publish behavior.
- [x] Add schema-validated notification volume/mute settings before the step-3
      audio service. Keep live playback opt-in after the prototype audition.
- [ ] Introduce a tool registry that associates each tool name with its argument
      schema, capability requirements, and implementation. Migrate tool groups
      in sequence: browsing, file/Git reads, mutations, commands, workers/MCP.
      Browsing, file/Git reads, mutations and commands are complete, including `zoom`,
      `date`, `get_plan`, `write_file`, `edit_file`, `apply_patch` and `update_plan`.
      Registered batch inputs validate before any call starts;
      runtime failures remain individual results. File line options preserve
      null/undefined behavior; blame requires paired endpoints, and containment
      stays in the shared filesystem resolver. Mutation strings remain literal;
      patch parsing, preflight and rollback stay in the existing engine. Plan
      updates preserve conflict-before-payload validation, recheck the revision
      when prepared calls run, and save before publishing. Command schemas retain
      literal argv, nullish timeouts/waits, flag defaults and UTF-8 stdin limits.
      Enabled command reads validate during batch preparation; job/pipe state
      remains in the existing command service. Shell permission still gates all
      command tools, including status/listing. Next: workers/MCP. Those groups
      and the batch envelope retain their legacy validation for now.
- [ ] Remove duplicate argument interfaces only after schemas can derive their
      types. Treat refinement rules such as project containment and tool
      permission as explicit domain checks, not type assertions.
- [x] Preserve provider-facing tool definitions exactly at first. Generating
      their JSON Schemas from Effect is a separate change requiring request
      fixture comparisons; otherwise schema conversion can disrupt cache prefixes.

**Gate:** valid existing input still works, invalid input fails before side
effects, and tool permissions and persisted plan shapes remain unchanged.

## 3. Introduce one runtime and explicit resource ownership

- [ ] Add one `ManagedRuntime` per session. Keep the existing Session/UI API as
      the external adapter, with runtime execution at that boundary.
- [ ] Start with small services for settings, model creation, and storage access.
      Add other services as they migrate; avoid a layer for every pure helper.
- [ ] Initially wrap `Storage.open`/`close` without changing its durable writes
      or format. Use scoped acquisition/finalization for the chat lock and other
      resources as they become Effect-owned.
- [ ] Document one owner for every acquired resource. Hand ownership from legacy
      `close()` code to Effect finalizers explicitly so both systems do not close
      the same resource or omit cleanup during partial construction.
- [ ] Define session, turn, and background-job lifetimes. Completed turns must
      not dispose session services or work allowed to continue in the background.
- [ ] Make shutdown idempotent and expose cleanup failures without losing the
      original failure. Keep synchronous persistence callbacks synchronous while
      compatibility adapters still depend on them.

**Gate:** startup failures release the lock and every acquired resource; close
is safe to repeat. Restart and existing Session/CLI behavior remain compatible.

## 4. Migrate external I/O services

- [ ] Wrap fetch operations with typed failures and interruption-aware
      `Effect.tryPromise` adapters. Pass the supplied cancellation signal into
      fetch, rather than merely stopping the waiting fiber.
- [ ] Scope response readers so success, failure, timeout, and interruption all
      cancel/release them. Preserve browsing byte limits, line/URL behavior,
      snapshot retention, and read-only operation.
- [ ] Give MCP clients/transports session-scoped acquisition and cleanup.
      Preserve lazy connections, shared pending handshakes, exact allowlists,
      redaction, discovery pagination, and separate connect/call deadlines.
- [ ] Provide fake fetch and MCP layers in tests so transport behavior can be
      tested without live provider calls or paid integration operations.

**Gate:** canceled I/O and failed handshakes leave no client, process, reader,
or pending promise behind; no permission or credential behavior changes.

## 5. Migrate provider adapters and streaming

- [ ] Convert provider adapters and request instrumentation to TypeScript as
      they acquire Effect service interfaces. Retain explicit model/compactor
      selection and current effort behavior.
- [ ] Model HTTP, malformed response, truncated stream, and output-limit failures
      explicitly. Validate fields the adapter consumes while preserving unknown
      native provider blocks and encrypted reasoning for exact in-turn replay.
- [ ] Adapt the proven SSE parser into scoped stream consumption. Do not replace
      its framing algorithm just because orchestration moves to Effect.
- [ ] Keep visible text, thoughts, tool entries, citations, and native replay
      separate. Ensure a terminal event finishes even if the connection stays open.
- [ ] Keep usage reporting exactly once per request, with agent/compactor/subagent
      attribution. Preserve smoothing and time-to-first-text behavior.

**Gate:** current request, replay, SSE, streaming, and usage fixtures pass.
There is no model fallback or new automatic retry policy. Retrying a partially
streamed response must not silently duplicate text, tool calls, or charges.

## 6. Migrate tools and command supervision

- [ ] Route the schema-backed registry through Effect implementations while
      retaining the existing public tool names and result formats.
- [ ] Move parallel reads to bounded Effect concurrency. Preserve input order,
      independent per-call failures, cancellation, full-batch validation before
      execution, and existing output caps.
- [ ] Supervise Bun child processes and output readers with scoped finalizers.
      Preserve literal arguments, filtered credentials, process-group killing,
      interactive stdin, EOF, and blocked-write deadlines.
- [ ] Place background commands in the session/job scope. Retain originating-turn
      cancellation without terminating them when that turn completes normally.
- [ ] Keep patch rollback, project containment, read-only worker restrictions,
      and MCP permissions enforced at execution, not only tool discovery.

**Gate:** no leaked process trees or pipes; permission, patch, parallel-read,
and interactive-command tests pass with the same observable results.

## 7. Migrate the agent turn loop

- [ ] Make settle → render → take queued input → provider call → tools → next
      call a typed Effect workflow, retaining that exact ordering.
- [ ] Give each turn an explicit scope and cancellation handle. Preserve message
      injection at tool boundaries and the distinction between user and `work`.
- [ ] Introduce queues/refs only where they replace shared mutable asynchronous
      state. Keep a single logical turn owner and preserve submission order.
- [ ] Preserve canceled/failed input retention, partial saved entries, finish
      reason checks, model-step limits, and exactly-once turn metrics.
- [ ] Adapt smoothing to the new workflow without changing display cadence or
      letting queued display text escape into a subsequent canceled turn.

**Gate:** runner and streaming tests pass, plus races involving queued input,
cancellation during tools/settle, and worker reports arriving at boundaries.

## 8. Migrate research subagents

- [ ] Represent workers as supervised fibers using the migrated runner.
      Keep the model/effort and read-only context selected at spawn time.
- [ ] Use session-owned job scopes with explicit originating-turn interruption.
      A normally completed parent turn must not interrupt its research workers.
- [ ] Preserve three concurrent workers, retained results, 20 model steps,
      five-minute deadlines, stop/drain behavior, and disabled recursive delegation.
- [ ] Deliver each completion report once through the parent input queue as
      agent-authored `work`; handle delivery failure and shutdown explicitly.
- [ ] Keep `--ask` and piped-input draining aware of both workers and the parent's
      final handling of reports.

**Gate:** late reports, stop, concurrent limits, parent cancellation, session
close, and separate subagent usage attribution remain correct.

## 9. Migrate background evaluations

- [ ] Convert `jev.js`/`evaluations.js` boundaries to typed Schema/Effect code.
      Preserve the complete-state size guard and independent judgment fields.
- [ ] Replace manual concurrency and retry timers with supervised work and an
      explicit schedule: two workers, retries only for existing transient status
      codes, and at most two retries with the current exponential delays.
- [ ] Preserve saved pending-job recovery, visible failures, and canceled jobs
      remaining recoverable. Evaluation must never gate turns or rewrite memory.
- [ ] Use a controllable clock/test layer for retry timing, inspecting the
      vendored testing examples before choosing a testing package.

**Gate:** retry limits, restart recovery, oversized skips, and metrics agree
with current evaluation tests, without additional API calls.

## 10. Migrate persistence, then memory scheduling

Split this phase into two reviewable changes and complete them in order.

### 10a. Persistence

- [ ] Convert storage to TypeScript with schemas for message/tree records, view
      state, plans, and telemetry. Retain compatibility with legitimate older
      records and explicitly distinguish required fields from extensible metadata.
- [ ] Preserve append-only logs, immutable nodes, file permissions, short-write
      failures, fsync ordering, atomic view replacement, lock recovery, and backups.
- [ ] Define durable commit sections carefully: interruption must not strand a
      partially committed in-memory/disk state. Do not make every storage
      operation uninterruptible; limit it to the required commit boundary.
- [ ] Keep synchronous adapters until callers have migrated. Replacing fsync
      persistence with async platform APIs is a separate design decision.

**Gate:** legacy restart, corrupt-state handling, lock contention, backup,
short/failed writes, and commit-order tests demonstrate identical guarantees.

### 10b. Memory

- [ ] Move compactor jobs, settle/drain coordination, and shutdown to supervised
      effects while keeping the memory algorithm and ready-queue ordering intact.
- [ ] Preserve eight concurrent compactions, exact-copy handling, shortest-summary
      selection, byte budgets, immutable committed nodes, and retries triggered
      by a new message rather than a background timer.
- [ ] Keep main/compaction view ranges, four-line cache blocks, complete source
      context, prompt bytes, UTF-8 splitting, and zoom paging unchanged.
- [ ] Convert event delivery through adapters without making audits/metrics part
      of the agent memory or blocking compaction on observers.

**Gate:** memory and upstream-alignment tests pass; baseline fixtures show the
same views, requests, saved nodes, and restart behavior. CPU benchmarks remain
within the agreed limits. Any algorithm change needs a separate proposal.

## 11. Finish composition and remove obsolete scaffolding

- [ ] Compose the migrated services in Session and simplify CLI startup,
      cancellation, and shutdown around runtime ownership.
- [ ] Retain a small event/snapshot adapter for Octane/Ink. Convert metrics I/O
      where useful, while keeping pure aggregation and formatting ordinary code.
- [ ] Remove superseded AbortControllers, timers, manual resource tracking, and
      broad error casts only after their replacement is covered by tests.
- [ ] Remove temporary compatibility shims once all consumers migrate. Preserve
      any intentional public JS re-export entry points used by integrations.
- [ ] Update architecture documentation, the Schema guide, and contributor
      examples to describe the final service boundaries and lifetime rules.

**Gate:** application checks, build, benchmark comparison, and CLI/TUI scenarios
pass. Closing releases sockets, transports, jobs, subprocesses, and subscriptions.

## Rules throughout the migration

- Change orchestration and behavior separately. Every step should remain usable
  and revertible without a persisted-data downgrade or a feature flag maze.
- Keep provider-native replay and prompt/tool-schema bytes stable unless an
  explicitly reviewed change requires otherwise. Effect alone does not improve
  model cache hit rates or lower API prices.
- Preserve selected models and effort. No cheaper-model fallback, automatic
  routing, additional model calls, or broader retries as a migration side effect.
- Use typed errors internally; convert them to redacted user-facing messages at
  the external adapter. Do not treat interruption as a successful empty result.
- One session runtime owns services; turn/job scopes own their work. Avoid a new
  disposable runtime for every tool invocation or uncontrolled detached fibers.
- Keep filesystem/Git SDKs, MCP SDKs, and provider protocol implementations when
  wrapping them is sufficient. Effect does not require replacing every dependency.
- Leave command completion, Markdown rendering, byte/string helpers, file
  discovery algorithms, summary-view selection, and citation formatting as pure
  code unless a concrete need emerges.
- Validate changed contracts with targeted tests during development, then
  `bun run check` and `bun run build` before completing each production step.
  Re-run relevant benchmarks for orchestration, storage, or memory changes.

## Vendored patterns to consult during implementation

- [Services](../repos/effect/ai-docs/src/01_effect/03_services/01_service.ts)
  and [layer composition](../repos/effect/ai-docs/src/01_effect/03_services/20_layer-composition.ts).
- [ManagedRuntime integration](../repos/effect/ai-docs/src/04_integration/10_managed-runtime.ts).
- [Scoped acquisition](../repos/effect/ai-docs/src/01_effect/05_resources/10_acquire-release.ts).
- [Effect interruption/fork APIs](../repos/effect/packages/effect/src/Effect.ts),
  [Queue](../repos/effect/packages/effect/src/Queue.ts), and
  [Stream](../repos/effect/packages/effect/src/Stream.ts).
- [Service-layer tests](../repos/effect/ai-docs/src/09_testing/20_layer-tests.ts).

Use this sequence as the backlog: complete the foundation through step 3 before
adding further capability families, then migrate each existing subsystem before
expanding its scope.
