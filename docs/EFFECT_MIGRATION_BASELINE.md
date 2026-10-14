# Effect migration baseline

Captured October 10, 2026 from application commit `c0f9a7d3e`, before adding
Effect. The starting worktree was clean. The vendored checkout is read-only.

## Environment and checks

- Bun 1.4.0 (`34cbb9a40`), TypeScript 5.9.3, strict checking.
- Apple M2 Pro, arm64, macOS 27.0 (`26A428`).
- Initial `bun run check`: 145 passing tests across 19 files, no failures.
- Initial `bun run build`: passed; application entry point bundled 43 modules.
- After adding baseline contracts, before installing Effect: `bun run check`
  passed 149 tests across 20 files, and `bun run build` passed.
- Test discovery stays under `./test`; vendored tests are excluded.

The four new contracts freeze prompt/tool/request bytes, restore legacy chat
state twice, recover from partial Session construction and repeated close, and
cancel an MCP handshake before successfully reconnecting. The existing
`session receives late research reports` test already covers late report
delivery, parent drain, persisted `work` entries and subagent usage attribution;
it does not need a duplicate.

## CPU benchmark

Command: `bun run benchmark` (10,000 messages, 200 iterations, five rounds).
The initial measurement ran alongside the initial typecheck. This benchmark
uses fake in-memory storage/model ports, makes no API requests and writes no
chat state. Keep the machine and command/history size fixed for comparisons;
use an otherwise idle machine for follow-up measurements.

| Measurement | Baseline |
| --- | ---: |
| Median metrics snapshot | 0.01002104 ms |
| Saved summary nodes | 19,995 |
| View parts | 156 |
| Median memory initialization | 1,157.959875 ms |
| Median saved-view restore | 4.822959 ms |
| Median pending-view restore | 12.017875 ms |
| Median idle pump | 0.00005271 ms |
| Node reads per idle pump | 0 |

Migration regression budget: investigate a slowdown greater than both 20% and
0.1 ms for snapshot/restore measurements, or both 20% and 10 ms for memory
initialization. Timing alone does not establish a regression: repeat a flagged
measurement on an idle machine. Zero idle-pump node reads and unchanged fixture
bytes are hard requirements.

Schema configuration parsing does not alter memory or metrics scheduling. Re-run
and compare this benchmark when those subsystems or their orchestration migrate.

## Frozen compatibility fixtures

`test/fixtures/effect-migration/` contains:

- `prompt.txt`: exact `systemPrompt('Offline migration fixture.')` bytes.
- `tools.json`: provider-facing definitions for a fully enabled session.
- `meta-request.json` and `openai-request.json`: exact streaming request bodies
  with Unicode history, tools, native encrypted-reasoning placeholders, a tool
  result and steering input. OpenAI includes an assistant phase item.
- `legacy-chat.json`: historical main/tree records without newer size metadata,
  a saved view and the expected rendered memory after restart.
- `legacy-task-plans.json` and `legacy-browsing.json`: boundary fixtures captured
  from their pre-migration implementations, as described below.
- `legacy-read-tools.json`: pre-migration file/discovery/memory output and Git
  argument arrays, described below.
- `legacy-mutations.json`: pre-migration mutation output, literal file bytes,
  moved-file modes and saved-plan records, described below.
- `legacy-command-tools.json`: pre-migration command-service calls, defaults,
  cancellation-signal forwarding and result bytes, described below.
- `legacy-extension-tools.json`: pre-migration MCP requests/redacted output and
  worker output, prompts and automatic reports, described below.
- `legacy-parallel-tools.json`: pre-migration batch preparation, signal forwarding,
  ordered result/error bytes, UTF-8 caps and disabled-command results, described below.

The messages and service setup live in `test/migration-fixtures.ts`. All keys,
encrypted strings and records are synthetic. Providers use injected fake fetch;
the MCP cancellation contract uses only a local loopback HTTP server. Fixtures
were captured before changing production code and must not be regenerated to
hide a migration difference. Review intentional contract changes separately.

## Dependency verification

The reference checkout reports 4.0.3. The npm registry returned 404 for that
version and published metadata for **4.0.2**, which is pinned in `package.json`
and `bun.lock`. See [published package metadata](https://www.npmjs.com/package/effect/v/4.0.2).
The lockfile integrity matches the registry. Application examples and tests
verify the needed v4 `Schema`, `Context.Service`, `Layer`, `Effect.fn`, scoped
cleanup and cancellation APIs against the installed package, using Bun and the
existing TypeScript compiler. No testing package or vendored import is added.

## First migration verification

After dependency setup, error/adapter foundations and MCP Schema migration:

- `bun run check`: 160 tests passed across 22 files, no failures; typecheck passed.
- `bun run build`: passed; entry point bundled 45 application modules.
- Frozen prompt, tool-definition and provider request bytes matched exactly.
- MCP transport, reference, allowlist, invalid-input and codec tests passed.
- `git diff --check` passed; no changes or imports under `repos/`.

Production uses public Effect module imports (`effect/Schema`, `effect/Effect`,
etc.) to limit module loading when Bun keeps packages external. A separate
five-run `bun src/cli.ts --help` sample had a 175.996 ms median on this machine;
this is a startup observation, not a provider latency or memory benchmark.

## Task-plan migration verification

The next boundary change migrates task-plan input and saved records to Schema.
It adds `legacy-task-plans.json`, captured by running the pre-migration
`task-plans.ts` from `3117966e2` against synthetic records. The fixture retains
title whitespace, non-ISO date strings, revision gaps, extra saved metadata and
the exact `get()`/`context()` rendering, including object key order.

- `bun run check`: 168 tests passed across 23 files, no failures; typecheck passed.
- `bun run build`: passed; entry point bundled 46 application modules.
- Legacy plan rendering and all frozen prompt/tool/provider bytes matched.
- New contracts cover raw length bounds, trimming, ignored tool/step extras,
  extensible saved metadata, invalid records, project selection, codec round
  trips, conflict precedence and previous-state retention on failed replacement.
- Generated revision overflow now fails before saving. A plan at the maximum
  safe revision can still be restored, but cannot generate an unsafe next record.

The existing real-storage restart, CLI `/plan`/backup, runner plan context and
partial-startup cleanup tests also pass. This boundary changes neither storage
I/O nor memory scheduling; the original CPU benchmark remains the comparison
point for their later migrations.

## Audio-settings migration verification

- `bun run check`: 171 tests passed across 24 files; typecheck passed.
- `bun run build`: passed; entry point bundled 48 application modules.
- Frozen prompt, tool definitions, provider requests and legacy rendering match.
- Settings codec tests cover defaults, mute, volume endpoints, non-finite and
  malformed input, unknown setting keys, and encoding/decoding round trips.
- Silent fake-player tests verify invalid settings do not change lab state or
  cancel active playback, while valid settings stop playback before the next
  preview. Existing UI clamping, serialization, stop and native-process cleanup
  tests pass. No live notification service is enabled by this boundary change.

## Browsing-registry migration verification

`legacy-browsing.json` was captured by running `web-browser.ts` and the raw-fetch
handler from `762c52c26` with synthetic URLs and response bodies. Its exact output
strings cover HTML extraction, Unicode, relative links, nullish/default line
options, literal queries, URL normalization, text metadata and omitted binary
content. Existing frozen fixtures were not regenerated.

- `bun run check`: 180 tests passed across 25 files; typecheck passed.
- `bun run build`: passed; entry point bundled 52 application modules.
- All prompt/tool/provider fixtures, legacy plans/chat and browsing output match.
- Browsing schemas preserve safe integer bounds, nullish defaults, unknown-field
  policy, custom raw-fetch timeout, URL normalization and the distinct credential
  policies of browsing and raw fetch. Errors retain internal Schema causes and
  useful field paths without displaying rejected input values.
- Registry contracts verify capability denial before decoding, typed transformed
  handler arguments, preparation without execution, duplicate registration and
  pre-aborted invocation. Browsing contracts cover request cancellation, page
  retention, line/UTF-8 caps and unchanged read-only worker access.
- Malformed registered arguments now reject a parallel batch during preparation,
  before any I/O or nested-call telemetry. Runtime errors remain individual
  results in input order. Unregistered tool groups still use legacy validation.

The registry owns argument dispatch only; Promise I/O, resource ownership and
permission policy remain at their existing boundaries. File/Git reads are the
next group. Memory and metrics scheduling are unchanged, so their original CPU
benchmark remains the comparison point for later subsystem migrations.

## File/Git read-registry migration verification

`legacy-read-tools.json` was captured before this change from the `tools.ts`
handlers at `a08ab9663`. File/discovery output uses real temporary files and a
symlink with synthetic content; memory lookups use a deterministic fake port.
Git argument arrays, configured timeout and output passthrough were captured
with a fake `CommandTools.run`, without starting a process. Existing fixtures
were not regenerated. Real Git history, staged/unstaged diffs, literal paths and
blame remain covered by the existing temporary-repository contracts.

- `bun run check`: 188 tests passed across 26 files; typecheck passed.
- `bun run build`: passed; entry point bundled 55 application modules.
- All prompt/tool/provider fixtures, legacy plans/chat/browsing and the new read
  output/Git argument fixtures match.
- Twelve tools now join browsing in the registry: memory `zoom`/`date`, plan
  reads, directory/file reads, glob/search, and all five Git inspections. Their
  implementations consume inferred schema types and require read capability.
- New tests cover nullish numeric defaults, optional boolean/ref distinctions,
  file numbering, paired/ordered blame ranges, safe bounds, literal query text,
  codec shapes, malformed argument objects and safe field-path errors.
- Invalid registered arguments and regex syntax reject a parallel batch before
  any I/O or nested-call telemetry. Missing files still yield individual runtime
  failures. Filesystem containment, external symlink rejection, allowed internal
  symlinks, worker permissions and pre-aborted reads are preserved. Cancellation
  during Git path resolution prevents starting the subprocess.

File-length defaults and memory reference/history rules remain in their domain
implementations. Regex execution retains its existing worker, deadline and
cancellation behavior. Only validation/dispatch moved; mutations, commands,
workers/MCP and the batch envelope are still pending. Memory scheduling and
metrics are unchanged, so their original CPU benchmark remains the comparison
point for their later migrations.

## Mutation-registry migration verification

`legacy-mutations.json` was captured before this change from the `tools.ts`
handlers at `98ce40136`. It uses real temporary files, synthetic content and a
fixed clock; only the canonical project root is normalized to `/fixture/project`.
The fixture includes empty files/replacements, whitespace, Unicode, NUL and CRLF
text, a multi-file add/update/move/delete patch, executable-file mode and two
saved-plan revisions. Existing fixtures were not regenerated.

- `bun run check`: 196 tests passed across 27 files; typecheck passed.
- `bun run build`: passed; entry point bundled 57 application modules.
- All frozen prompt/tool/provider fixtures and legacy chat/plan/browsing/read
  fixtures match, as do the new mutation outputs, file bytes/modes and saved plans.
- Four tools now require write capability in the registry: `write_file`,
  `edit_file`, `apply_patch` and `update_plan`. Malformed input fails with safe
  Schema paths before filesystem resolution or persistence. Empty content and
  replacements remain valid; empty search text remains invalid.
- Plan preparation checks revision conflicts before validating the rest of the
  payload. Invocation rechecks the revision before the synchronous save/publish
  section, preventing stale prepared or repeated calls from overwriting a plan.
  Tests verify save-before-publish, failed-save state retention and cancellation.
- Capability denial still precedes validation; read-only workers and parallel
  batches reject mutations before any I/O or nested-call telemetry. File writes
  and edits preserve containment and external-symlink checks. Cancellation during
  path resolution leaves files and parent directories unchanged.
- Existing patch contracts pass for stale/ambiguous context, malformed hunks,
  escapes, symlinks, duplicate paths, no-overwrite rules, ordered/end-anchored
  hunks, newline/mode retention, rollback after partial writes and cancellation.

The patch engine and Promise filesystem I/O remain unchanged. Commands are the
next registry group, followed by workers/MCP and the batch envelope. Memory
scheduling and metrics are unchanged; their original CPU benchmark remains the
comparison point for their later migrations.

## Command-registry migration verification

`legacy-command-tools.json` was captured before this change from the `tools.ts`
handlers at `98ce40136`. Command-service methods were stubbed to capture argv,
timeout/wait defaults, interactive flags, stdin/EOF, signal forwarding and result
passthrough without spawning processes. Shell selection uses a synthetic fixed
environment value. Existing fixtures were not regenerated; real process behavior
remains covered by the native command contracts.

- `bun run check`: 204 tests passed across 28 files; typecheck passed.
- `bun run build`: passed; entry point bundled 59 application modules.
- All frozen prompt/tool/provider and legacy chat/plan/browsing/read/mutation
  fixtures match, as do the new command-service calls and result bytes.
- Seven command tools now use Schema-backed registry entries. Run/shell timeouts
  retain configured defaults and a 120-second maximum; background starts retain
  their independent 120-second default and 600-second maximum. Numeric options
  default on null/undefined, while boolean flags reject null. Wait permits zero.
- Executables/argv retain their NUL restrictions and literal argument arrays.
  Stdin preserves whitespace, NUL and Unicode, defaults missing/undefined input
  for EOF-only writes, and validates the 65536-byte UTF-8 cap before service work.
  Endpoint tests include ASCII, two/four-byte text and unpaired surrogates.
- Malformed objects, missing fields, sparse/invalid argv, unsafe numeric values,
  bad flags and invalid stdin fail with safe Schema paths before any service
  operation. Preparation performs no command work; pre-aborted invocations are
  rejected before entering the service. Shell selection remains at invocation.
- Command status/listing require read and shell capabilities; all command tools
  require shell authorization. Disabled tools remain undiscoverable and retain
  their existing errors; read-only workers still reject them. Enabled command
  reads validate during full-batch preparation before I/O/telemetry, while unknown
  job IDs remain individual runtime failures. Writes/starts/stops remain excluded.
- Existing native contracts pass for literal argv/output caps, credential
  filtering, command deadlines, process-group cancellation, background limits,
  status-wait cancellation, session/turn lifetimes, interactive stdin/EOF and
  blocked-input cancellation/deadlines. The command service itself is unchanged.

Workers/MCP and the batch envelope are next, before the step-2 gate. Process
supervision will migrate separately at step 6. Memory scheduling and metrics
remain unchanged; their original CPU benchmark remains the comparison point
for their later migrations.

## Worker/MCP registry migration verification

`legacy-extension-tools.json` was captured before this change from the
`integrations.ts` and `subagents.ts` implementations at `a85765cd3`. The SDK
methods use deterministic stubs with synthetic configuration and credential
references; no process or remote request is started. Workers use a fake model,
empty tools and fixed clock. The fixture records exact SDK request shapes and
deadlines, paginated native schemas, connected/discovery state, redacted text,
non-text omission, structured output and tool failures. It also freezes worker
start/list/status/stop rendering, raw prompts, selected model and automatic
report bytes. Existing fixtures were not regenerated.

- `bun run check`: 214 tests passed across 29 files; typecheck passed.
- `bun run build`: passed; entry point bundled 63 application modules.
- All frozen prompt/tool/provider and prior legacy fixtures match, as do the new
  worker output/prompt/report bytes and MCP SDK requests/redacted output.
- Four worker and three MCP tools now use Schema-backed registry entries with
  subagent/integration capabilities; listing/status/discovery also require read.
  Disabled tools, read-only workers and parallel-read exclusions remain unchanged.
- Worker schemas preserve the original identifier pattern and raw 12000-code-unit
  task bound, nonblank check, whitespace and literal Unicode/NUL. Bad inputs fail
  before model/tool/context factories. Prepared starts recheck capacity and closure
  at invocation; stopping frees a slot without changing the selected model.
- MCP call preparation retains configured-server and exact-allowlist denial
  precedence. Full payload validation now finishes before credential references
  or client acquisition. Invalid arguments cannot connect. Typed invocation
  rechecks the allowlist, including literal `*`, before acquisition.
- Remote arguments use an opaque object schema: JSON keys, nested values and
  own `__proto__`/`constructor` keys survive encoding and exact request comparison.
  Native discovered schemas and SDK response handling retain their existing form.
- Tests cover useful redacted Schema paths, malformed envelopes, unknown state
  IDs, prototype-named servers, pre-aborted calls, prepared-call revocation and
  closure, repeated-cursor/500-tool guards, output caps and visible report-delivery
  failure with exactly one delivery attempt.
- Existing real stdio discovery/redaction, canceled HTTP acquisition/recovery,
  worker concurrency/stop, originating-turn cancellation and late-report/session
  usage contracts pass. Client cleanup, worker timers, model-step limits and
  report delivery logic remain at their existing resource boundaries.

The batch envelope and final registry integration are next before the step-2
gate. Resource ownership and supervision will migrate in their later steps.
Memory scheduling and metrics are unchanged; their original CPU benchmark
remains the comparison point for those migrations.

## Batch envelope and step-2 gate verification

`legacy-parallel-tools.json` was captured before this change from
`parallel-tools.ts` and `tools.ts` at `d9898e319`. Preparation/execution use
deterministic stubs; a project toolset captures disabled command reads with no
processes or external I/O. The fixture freezes one/eight-call endpoints,
preparation order and payload keys, signal forwarding, independent runtime
errors, ordered formatting and clipping near a four-byte Unicode boundary.
Existing fixtures were not regenerated.

- `bun run check`: 223 tests passed across 30 files; 5815 assertions and typecheck passed.
- `bun run build`: passed; entry point bundled 63 application modules, 1.11 MB.
- Every enabled provider tool, including `parallel_tools`, uses a validating
  registry entry. Provider definitions, prompts and request bytes match all
  frozen fixtures. Public tool and Effect adapters accept unknown arguments;
  the Runner no longer asserts that parsed JSON is a record.
- The batch schema validates 1–8 calls, explicit read-tool literals and argument
  objects. It ignores legacy envelope/call extras and preserves opaque nested
  argument keys, including own `__proto__` and `constructor` keys. Its types
  infer from Schema rather than a duplicate call interface.
- Malformed roots, missing fields, invalid collections/calls, sparse arrays,
  unknown names, mutation/recursion and invalid argument objects fail with typed,
  redacted Schema paths before nested preparation, I/O or telemetry. Every nested
  schema validates before batch preparation returns an invocation.
- Tests prove prepared values survive caller mutation, preparation performs no
  work, capability denial precedes decoding, and pre-aborted invocations do no
  nested work. Concurrent calls retain input order after later calls finish first.
  In-flight interruption reaches every nested signal and escapes result formatting.
- Legacy ordered output, independent runtime-error bytes, 3000-byte UTF-8 caps
  and disabled-command failures match the captured implementation. Enabled command
  reads still validate during preparation; read-only worker batches retain their
  existing permissions. Runner nested-call/retrieval counts remain unchanged.
- Configuration defaults/exact allowlists, plan persistence/conflict rules,
  audio settings, browsing, file/Git reads, mutations, commands and workers/MCP
  retain their prior boundary and native-resource contracts. The step-2 gate is
  complete; runtime ownership begins at step 3.

Memory scheduling and metrics remain unchanged; their original CPU benchmark
remains the comparison point for those later migrations.

## Session runtime and resource ownership verification

The session now has one `ManagedRuntime` with settings, model-creation and
storage services. Startup builds a scoped context before publishing the existing
Session object. Model switches and worker model factories use that same runtime;
the agent loop, UI API and synchronous persistence methods retain their native
behavior. The [ownership table](../agent-patterns/effect-runtime.md) records the
scoped owners and explicit handoffs to legacy Runner/toolset cleanup.

- `bun run check`: 236 tests passed across 31 files; 5959 assertions and typecheck passed.
- `bun run build`: passed; entry point bundled 65 application modules, 1.12 MB.
- All frozen provider/prompt/tool and legacy output/request fixtures still match.
  No existing fixtures were regenerated and the vendored source remains read-only.
- Thirteen new tests prove runtime/storage reuse across completed turns and
  model switches, cached repeated close, listener removal, storage reopen and
  rejection of work on the disposed runtime.
- Failures at instruction checks, compactor creation, memory/evaluation/metrics
  construction, plan loading, Runner configuration and initial pump each release
  every acquired owner exactly once. Toolset acquisition transfers integration
  and worker ownership only when it succeeds; a failed Runner still closes its
  already-created toolset. Every scenario permits reopening the chat lock.
- Original startup failure identity/messages remain intact when cleanup succeeds.
  Simultaneous memory/metrics cleanup failures retain their typed internal causes
  alongside the original startup reason, with fixed public messages. Remaining
  finalizers still run and release storage.
- Toolset cleanup awaits all owned services even when one fails and another
  remains pending; shutdown cannot release memory/storage ahead of that service.
  Multiple tool failures and failed Runner drain/cleanup retain all original
  errors. Failed close remains cached, emits `closed` once and never retries owners.
- Memory stops before evaluations, then metrics, then storage, preserving the
  existing final-write/subscription order. Storage open/close is wrapped without
  changing append, plan, view or telemetry callbacks, file formats or durable writes.
- A real background process survives two completed turns and stops at session
  scope close. Existing originating-turn cancellation, interactive commands,
  worker late reports, MCP acquisition cancellation/recovery, restart and CLI
  model-switch/backup contracts still pass. Providers use deterministic mocks;
  no paid model requests or live audio are used in these checks.

At this checkpoint, runtime ownership checks passed and the audio service remained
before completing step 3; its verification follows below. Transport and job
supervision remain in their later phases. Memory and metrics scheduling algorithms
are unchanged, so their original CPU benchmark remains the comparison point.

## Audio notification service verification

`AudioNotifications` completes step 3 with a silent default layer in the Session
runtime and an opt-in live layer. The sound patch, native player and prototype
remain separate from notification policy. No workflow listeners or regular-chat
audio are enabled. Settings are decoded before player acquisition and remain
immutable for the layer lifetime; audition and live controls/event checks still
precede enabling actual notifications in steps 7–9.

- `bun run check`: 248 tests passed across 32 files; 6083 assertions and typecheck passed.
- `bun run build`: passed; entry point bundled 66 application modules, 1.13 MB.
- Twelve new tests cover silent/default behavior, lazy/shared player acquisition,
  invalid settings before acquisition, volume/mute/unavailable-device behavior,
  partial layer startup, cached disposal and no playback after scope closure.
- Foreground interruption aborts its cue, waits for native cleanup and leaves an
  independent background cue alive. Session disposal interrupts and drains all
  managed cues before closing the player once. The layer also aborts/drains
  captured-service playback outside the runtime, even if player close fails.
- Discovery, synchronous/asynchronous playback and audio-only cleanup failures
  retain original causes in typed internal diagnostics without changing task
  results, triggering retries or playing recursive error cues. Cancellation
  retains its interruption cause and does not become an audio failure.
- A fake `afplay` executable runs a real silent subprocess; cancellation verifies
  that the process has exited before the playback effect finishes. No live audio
  or paid provider requests are used in these checks.
- Session tests verify the actual runtime resolves the silent service and never
  calls native playback/cleanup. Frozen provider, tool, output and persistence
  fixtures still match; none were regenerated, and vendored source is read-only.

Step 3 is complete. Next is step 4's external I/O migration, beginning with
interruption-aware fetch and scoped response readers. Memory/metrics scheduling
and the agent-loop migration retain their original later phases.


## External I/O service verification

Step 4 is complete. HTTP/browsing and MCP now use typed Effect services with
scoped native I/O ownership behind their existing Promise-based tool facades.
The Session still owns one ManagedRuntime; the integration facade's scope closes
through the existing session/toolset resource handoff. Provider transport and
stream parsing retain their later step-5 migration.

- `bun run check`: 263 tests passed across 33 files; 6186 assertions and typecheck passed.
- `bun run build`: passed; entry point bundled 70 application modules, 1.14 MB.
- Fifteen new tests in `test/external-io.test.ts` use fake HTTP/MCP layers,
  fake protocol responses and local native HTTP/stdio fixtures. They make no
  live external-provider, paid integration or audio calls.
- Fetch acquisition receives the actual Effect signal. Body interruption also
  aborts the request after headers have arrived. Stalled reader cancellation is
  awaited before lock release and rejection; late acquisition disposes its body.
  Success, read failure, byte-limit failure, invalid redirect metadata and timeout
  leave no native reader locked. Cleanup failure retains the original typed
  failure together with its defect. Stored stream errors, including native
  AbortError, do not fabricate an additional cleanup defect.
- Browsing keeps its 2 MB limit, URL/line/link behavior, read-only snapshots and
  16-page retention. Raw fetch preserves status/size reporting, text truncation,
  binary summaries and valid empty responses. Its old arrayBuffer-only test stub
  now supplies a real Response to exercise stream ownership; expected output is
  unchanged. Frozen legacy browsing fixtures were not regenerated.
- MCP acquisition remains lazy and shares one pending handshake. A joining
  waiter cancels independently; canceling the initiator drains rollback for all
  shared waiters and permits a later connection. Partial transport construction,
  failed handshakes and connection timeouts release acquired owners once.
- Connection and call deadlines remain 15 and 30 seconds. Each discovery page
  retains a separate call deadline. Pagination bounds/cursor guards, exact
  allowlists, environment references, secret redaction/caps, native input schemas
  and SDK request arguments match their frozen legacy contracts.
- SDK protocol cancellation reaches the actual HTTP fetch through an async
  request context. A scoped byte-stream wrapper drains detached SDK SSE bodies:
  call completion waits for its reader cleanup, and session shutdown waits for
  connection streams. The SDK still owns all JSON/SSE parsing and protocol work.
- Shutdown aborts/drains pending handshakes and active calls before disposing
  connection scopes, caches its Promise, and attempts all remaining finalizers
  when one cleanup fails. Client/transport close is memoized because SDK failed
  initialization can also close them. Native stdio initialization cancellation
  proves its process has exited before the operation rejects.
- Session/restart, provider requests/replays, tool permissions, mutation/file
  bytes, commands, workers and every other frozen fixture pass unchanged.
  No vendored files were edited or imported into application code.

Next is step 5, provider adapters and streaming. Memory/metrics scheduling and
the agent loop remain in their original later phases, so their original baseline
measurements remain the comparison point for those subsystem migrations.


## Provider transport and streaming verification

Step 5 is complete. Meta/OpenAI adapters, model creation/instrumentation and SSE
consumption are TypeScript. `ProviderModel` exposes borrowed Effect `chat`/`stream`
services while Runner, memory and Session retain compatible Promise model APIs.
The session still has one ManagedRuntime, and selected models, compactor effort,
web-search policy and caller retry policies are unchanged.

- `bun run check`: 289 tests passed across 34 files; 6423 assertions and typecheck passed.
- `bun run build`: passed; entry point bundled 73 application modules, 1.16 MB.
- After the final HTTP request-signal adjustment, typecheck and all 50 focused
  provider, browsing and external-I/O tests passed (576 assertions).
- Twenty-six new tests in `test/provider-effects.test.ts` use fake transport
  responses, a borrowed service layer and local native HTTP streams. No live
  provider, paid integration or audio operations are used.
- Shared `Http.withRequest` supplies interruption-aware POST acquisition and
  scoped JSON/SSE response readers. Acquisition cancellation, stalled body reads,
  native HTTP disconnects and terminal events on still-open connections release
  readers before reporting or returning. HTTP response text retains redaction
  and its existing 1500-character diagnostic cap.
- The original SSE scan cursor, UTF-8 decoder, multiline-data handling,
  LF/CRLF/CR framing and unterminated final-frame behavior remain unchanged.
  Both adapters stop at their terminal event without reading later frames.
  Existing SSE, request, provider, smoothing and streaming tests pass unchanged
  in expected output. The cancellation test now checks the actual supplied Effect
  signal instead of requiring caller-signal object identity.
- Schema checks validate consumed response/event fields and classify malformed
  JSON, invalid tool/text payloads, HTTP failures, native transport rejection,
  explicit provider errors and truncated streams. Private Schema/native causes
  remain available internally; public diagnostics do not expose them.
- Check-only wire validation retains the original native objects rather than
  encoding a Schema projection. Tests compare exact JSON/key order for unknown
  nested extensions, encrypted reasoning, signatures, native blocks and assistant
  phase. Visible text, thought callbacks, entries and citations keep their existing
  separation and replay contracts. Unknown native event/item types remain opaque.
- `ProviderOutputLimit` explicitly retains partial native output in the typed
  error channel. Existing Promise callers recover only a lone limit as
  `MAX_TOKENS`, preserving their current policy with no transport retry or model
  fallback. Cause-preserving error translation retains cleanup defects alongside
  the original limit; failed cleanup cannot become a successful partial result.
- Usage instrumentation now belongs to the borrowed Effect service and reports
  once through either API. Request IDs, latency, first nonempty visible-text timing,
  selected model and agent/compactor/subagent attribution remain intact. Failure
  and cancellation do not fabricate successful usage. A throwing reporting sink
  is invoked once, and response cleanup finishes before reporting success.
- Text/thought callbacks remain synchronous; entry callbacks keep awaited order.
  Interrupting an asynchronous entry callback aborts HTTP immediately and drains
  the already-started callback before releasing its response. Callback failure
  closes the reader and produces one safe error report.
- Frozen provider request bytes were not regenerated. Their baseline test now
  invokes public `stream` with a valid offline terminal response instead of the
  removed internal response-returning `request` helper. This verifies the migrated
  production path while preserving the same expected requests.
- Pure labels/aliases/completion use `model-catalog.ts`; `models.ts` reexports the
  existing catalog API. Separating this import prevents provider Effect/Schema
  initialization from entering the terminal UI bundle. Session/restart, all tool
  and MCP contracts, memory/evaluation policy and persistence fixtures still pass.
  The vendored checkout remains read-only and is not imported by application code.

Next is step 6, tool execution and command supervision. The agent loop, worker/job
supervision, persistence and memory/metrics scheduling remain in their planned
later phases; their existing baseline remains the comparison point.


## Tool execution and command supervision verification

Step 6 is complete. The Schema registry supplies native Effect invocations and
compatible Promise boundaries. `LegacyPorts` prefers a toolset's native Effect
implementation and keeps its borrowed ownership. There is still one session
ManagedRuntime; commands use an explicit closeable scope and scoped fibers.

- `bun run check`: typecheck and 301 tests across 35 files passed, with 6456 assertions.
- `bun run build`: passed; 74 application modules, 1.17 MB.
- After the final atomic foreground-acquisition review, typecheck, build and all
  57 focused tool/command tests passed (854 assertions).
- Twelve new tests in `test/tool-effects.test.ts` cover native registry execution,
  batch cancellation/drain, full-batch validation, independent domain failures,
  retained compound causes, worker restrictions, borrowed service dispatch,
  output-reader failures/locks, native foreground process trees, owner shutdown,
  background lifetimes and blocked native stdin writes.
- Batches use `Effect.forEach` with concurrency 8, retaining immediate dispatch,
  ordered results, independent ordinary tool errors, UTF-8 caps and nested counts.
  Every nested argument/capability check completes before any operation starts.
  Interruption, defects and compound failures escape batch result formatting.
- All Schema-bound implementations execute in Effect. Existing filesystem and
  patch transaction bodies use an interruption-aware callback adapter that waits
  for started native work and rollback before returning. Public Promise methods,
  error messages, provider tool descriptors and frozen fixtures remain compatible.
- Foreground and background commands share a session-owned job scope.
  `forkIn` prevents a successful start invocation from ending its job, while an
  explicit originating-turn signal stays attached until that job is cleaned up.
  Native foreground interruption and owner close kill inherited-pipe descendants.
  Close is memoized and now drains foreground jobs as well as the job list.
- Stdout/stderr readers acquire their locks atomically with scoped cleanup.
  Read failure interrupts the other reader; finalizers kill the process group
  before canceling/releasing reads and await child exit. Pending stdin writes are
  also drained before the command owner finishes cleanup.
- Interactive input uses scoped Effect writes with the existing 2-second
  blocked-write deadline, UTF-8 byte limit, concurrent-write exclusion, literal
  text and EOF semantics. Failure/cancellation kills the command before awaiting
  the native FileSink operation. Status wait cancellation leaves another turn's
  job running, and stop requests drain cleanup even if interrupted.
- Existing command IDs, result/list formats, credential filtering, literal argv,
  process-group killing, output caps, job bounds and completed-result retention
  pass unchanged. Patch rollback, containment/symlink checks, read-only worker
  guards and MCP execution permissions remain enforced in the execution path.
  No vendored source or baseline fixture was changed for step 6.

Next is step 7, the agent turn loop. Worker orchestration, evaluation, persistence
and memory scheduling remain in their planned later phases.


## Agent turn-loop verification

Step 7 is complete. Runner executes settle → render → take input → provider →
tools → boundary input → next call as a typed Effect workflow. The public Session
and Runner Promise APIs remain compatible, and the main Runner borrows the
existing session runtime. Standalone Runner callers use a service-free boundary;
there is no additional ManagedRuntime per turn or request.

- `bun run check`: typecheck and 323 tests across 37 files passed, with 6568 assertions.
- `bun run build`: passed; 75 application modules, 1.17 MB.
- Seventeen new `test/runner-effects.test.ts` tests verify native dispatch, exact
  operation order/native replay, one logical owner, queued inputs during settle,
  late worker reports, reentrant completion/start observers, canceled settle/tool
  cleanup, retained input and partial entries, typed output limits, model-step
  policy, nested tool metrics, observer failure and full cancellation diagnostics.
- `test/streaming.test.ts` adds native smoothing cancellation during an awaited
  persistence callback: display stops immediately, cancellation waits for that
  callback, and no queued text appears in the subsequent response. Existing word
  cadence, thoughts, partial-error flush, tool-boundary display drain and finish
  reason checks pass unchanged.
- The input queue remains synchronous and ordered. There is no competing queue
  consumer or redundant Ref. Ownership and the shared drain Promise are published
  before callbacks can reenter submit. Input received in a provider/tool call is
  logged once with its original user/work kind and injected at the next boundary.
  Settling failures and cancellation retain unanswered input in memory.
- Each turn has a scope, a scoped execution fiber and an explicit AbortController.
  A scoped watcher requests `Fiber.interrupt`, and the owner awaits `Fiber.await`
  for the actual completed Exit. A targeted test found that using `raceFirst`
  here loses a canceled loser's cleanup defects. Internal `Runner.lastFailure`
  retains the complete Cause; no raw diagnostic enters memory or workflow events.
  Successful turn completion does not abort the origin signal for background jobs.
- `TurnFailure` is a tagged Schema error with settle/model/tool/callback phases.
  Translation uses Cause-preserving mapping. Ordinary tool domain failures remain
  model-visible error results; interruption and compound failures fail the turn.
  Native Promise-backed I/O combines the originating turn signal with the
  invocation fiber's signal, so a failed batch can cancel siblings while the
  origin signal stays live for background jobs. Only legacy registry Promise
  boundaries preserve caller-signal identity for their existing fixtures.
  Existing incomplete-finish messages, step limits and retry policy remain intact.
  Metrics report once after cleanup, including when the error callback throws.
- `smoothResponseEffect` owns its display reader and provider work. It prefers
  native provider effects, keeps the original ai smoothStream settings, flushes
  partial text on failure and suppresses queued text on interruption. Native output
  limits stay typed; the compatible smoothing Promise adapter recovers a lone
  limit only after cleanup, preserving compound failures.
- Typed turn/model/tool events carry stable operation IDs and status, with no raw
  prompts, arguments or output. Four `test/workflow-audio.test.ts` tests use fake
  players for turn-cue mapping, volume/mute, duplicate/onset suppression, turn
  cancellation, scoped playback drain and failure isolation. Model/tool events
  cause no extra sound. The Session layer remains silent and no live audio was enabled.
  No retry event is fabricated; current turn execution performs no added retry.
- Session runtime tests now use offline HTTP/SSE fixtures instead of spying on
  provider Promise methods bypassed by the native Runner. The native-audio test
  uses macOS system `/tmp` for its executable fixture because per-user temporary
  shell startup stalled in isolation; its failure now includes fixture diagnostics.
  Production audio code is unchanged. Native process shutdown is still asserted.
- Frozen fixtures and vendored source remain unchanged. Session restart, completed
  background jobs, permission/patch checks, late worker reports and all existing
  memory/evaluation contracts pass. Worker scheduling, evaluation and memory
  orchestration remain in their planned later migrations.

Next is step 8, research subagents.


## Research-worker supervision verification

Step 8 is complete, verified October 12, 2026. Workers execute the migrated Runner
as fibers in their own job scopes. The research owner supervises these jobs in a
session-owned closeable scope. Native spawn captures runtime services, including
Clock, while job and turn scopes replace the caller's transient resource lifetime.
No new ManagedRuntime is created for a worker.

- `bun run check`: typecheck and 345 tests across 38 files passed, with 6714 assertions.
- `bun run build`: passed; 75 application modules, 1.18 MB.
- Twenty-one new tests in `test/subagent-effects.test.ts` cover native model/tool
  dispatch, frozen model/context/instructions, execution-time read-only guards,
  completed parent turns, late report queuing, origin/stop/drain cancellation,
  resource rollback, shutdown, report receipts/failures, result retention, reentrant
  stop/close observers, cleanup diagnostics and inherited signal policy.
- Native `spawnEffect`, `stopEffect` and `drainEffect` share the existing public
  Promise/string API and Schema registry. Existing worker names, definitions,
  prompts, raw task text, start/list/status/stop JSON, automatic reports, validation
  and disabled recursive delegation match their frozen fixtures unchanged.
- Each worker owns a supervisor fiber, a Runner scope and a completion Deferred.
  The Deferred replaces the old work Promise and completes after cleanup/report
  acceptance, including failure and shutdown paths. It is available before
  callbacks can reenter stop. Stop awaits it uninterruptibly; canceled drain stops
  every worker and awaits their native cleanup before returning interruption.
- The three-worker limit covers still-draining lifetimes, including resource
  cleanup and receipt acceptance, so those phases cannot create an unbounded
  backlog. Completed results retain their existing maximum of 32. Workers still
  stop at 20 model steps. The five-minute deadline uses scoped Effect sleep;
  TestClock verifies the exact boundary without a five-minute wall-clock wait.
  Deadline/stop strings and result caps remain compatible.
- The originating-turn listener lives until execution finishes; normally ending
  the parent turn removes no job lifetime and does not abort its signal. The
  worker's own controller also cancels its processing cue. A separate scope owns
  its Runner and read-only tools, and failed construction rolls back those tools.
  Native failed/canceled starts wait for rollback; synchronous starts retain their
  original exception while managed rollback remains owned and close drains it.
- Each report is attempted once after execution and cleanup. Async report results
  mean acceptance/enqueuing, not completion of the parent's response. Delivery
  rejection updates retained status/result and preserves its Cause without retry.
  Shutdown suppresses reports not yet started and drains receipts already in
  flight. Draining re-snapshots jobs created by report handling rather than ending
  after its initial snapshot. Full cleanup/interruption Causes remain private.
- Worker runtime context explicitly restores native I/O signal policy. A legacy
  spawn boundary must not carry its caller-signal identity override into the worker
  Runner. A targeted test starts through that legacy registry and verifies a native
  failed batch interrupts sibling I/O while the worker origin signal stays live.
- Real CLI subprocesses with offline provider preloads verify both `--ask` and
  piped EOF wait for late workers and the parent's final response. Each run makes
  one worker request and three parent requests, saves one report as `work`, records
  one separately attributed subagent usage event, and releases storage on exit.
  Existing Session late-report and runtime-ownership tests also pass.
- Worker workflow events use stable operation IDs without task/model payloads.
  One additional fake-player test verifies a worker processing cue follows its job
  signal independently of an unrelated canceled turn. The Session audio layer
  remains silent. An existing native-audio fixture initially missed its startup
  marker; isolated and full rerun checks passed. Its diagnostics now distinguish a
  completed playback result from an actually pending operation. Production audio
  playback code is unchanged, and process exit remains asserted.
- The existing CPU benchmark was rerun with 10,000 messages, 200 iterations and
  five rounds. It makes no API calls or storage writes and does not measure worker
  throughput. Median metrics snapshot: 0.001925 ms; initialization: 707.299333 ms;
  saved-view restore: 3.097042 ms; pending-view restore: 7.239083 ms; idle pump:
  0.000044165 ms. Nodes/view parts remain 19,995/156, and idle-pump node reads stay
  zero. No measurement exceeds the baseline regression budget.
- No vendored source or frozen fixtures were changed. Evaluation scheduling,
  persistence and memory orchestration remain in their planned later phases.

Next is step 9, background evaluations.

## Background evaluation verification — October 13, 2026

Step 9 is complete. `bun run check` passes typecheck and 366 tests across 39
files with 6,791 assertions. `bun run build` succeeds with 75 modules and a
1.19 MB CLI bundle. All new audit tests use offline responses/injected functions;
no live TypeSafe/provider API calls were made.

- `jev.ts` validates complete state and three independent finite probabilities
  in [0, 1], retaining native result extensions. Scoped HTTP consumption releases
  body readers before returning failure or allowing a retry. Credential diagnostics
  retain the existing redaction/cap and native status is a typed failure field.
- `evaluations.ts` validates persisted envelopes and owns two default scoped Queue
  consumers. Generated summaries dispatch once; exact copies require no calls.
  The 24,000-byte serialized complete-state guard skips without truncation. Existing
  metrics, missing-credential visibility, saved queued/running recovery and
  summarization independence tests remain unchanged and pass.
- New tests borrow the vendored TestClock/Schedule patterns through `pumpEffect`.
  They prove exact 999/1/1999/1ms retry boundaries, a 60-second per-attempt deadline,
  and cancellation during backoff. Only HTTP 429/503/529 retries, at most twice;
  existing persistent-failure tests prove the three-call ceiling. Other HTTP status
  codes, schema failures, timeouts and compound cleanup failures do not retry.
- Two active audit lifetimes occupy their slots through native cleanup. Closing
  awaits both, starts no remaining queued requests and persists active jobs as
  queued for recovery. Canceling a drain waiter leaves those audits running.
  Cleanup Causes remain private even when a canceled job must remain recoverable.
- Typed evaluation events use stable IDs without source/context/credentials. The
  shared audio observer deduplicates cues and retains the silent Session default.
  The pre-existing native audio fixture missed its two-second startup marker in
  one full run; its isolated run and subsequent full check passed. Its code and
  process-exit assertions were not changed in this step.
- The CPU benchmark (10,000 messages, 200 iterations, five rounds) reports median
  snapshot 0.001949375 ms, initialization 791.984417 ms, saved-view restore
  3.417208 ms, pending-view restore 7.681959 ms and idle pump 0.00005 ms. Nodes/view
  parts remain 19,995/156 and idle-pump node reads remain zero. These timings do
  not measure audit throughput or make network requests.
- Vendored files and frozen request/legacy-chat fixtures were not changed.
  Memory received only a storage-field type declaration for the typed evaluation
  boundary; persistence and memory scheduling remain for step 10.

Next is step 10a, persistence, followed by step 10b, memory scheduling.

## Persistence and memory verification — October 13, 2026

Steps 10a and 10b were implemented and verified in order. The persistence-only
check passed typecheck and 374 tests across 40 files (6,813 assertions), plus build.
The combined `bun run check` passes typecheck and 383 tests across 41 files with
6,868 assertions. The final build contains 78 modules and a 1.20 MB CLI bundle.
No live provider/TypeSafe requests or vendored/frozen fixture changes were made.

### 10a — persistence

- `storage.ts` retains synchronous append-only/fsync persistence and introduces
  check-only schemas for message/tree records, three view files, plan envelopes,
  usage and metrics/evaluation telemetry. Legitimate missing legacy metadata stays
  optional, extensions and nested opaque usage counters stay intact, and tree byte
  sizes are recomputed as before. Plan semantic/project/revision validation remains
  in TaskPlans. Evaluation storage and scheduling share one extracted schema.
- Storage.acquire owns the lock in SessionStorage's existing session layer.
  Constructor rollback releases it; repeated close returns the same Promise. Live
  contention, stale socket probing, inode protection, private permissions, torn
  JSON reporting/skipping, newline repair and backup/restart behavior remain.
- Native append/node/view operations expose synchronous durable commit sections;
  reads remain interruptible. New fault-injection tests verify write/fsync/close,
  fresh-directory fsync before publication, temporary-view fsync/rename/directory
  fsync, short writes, failed node fsync, failed view rename and immutable nodes.
  An abort requested inside fsync cannot separate the saved append from its
  in-memory publication; restart sees exactly the published record.
- Existing legacy restart/corruption and real CLI backup tests pass unchanged.
  The new stale-lock test kills a real socket owner before reopening, rather than
  treating arbitrary non-socket files as safe stale locks.

### 10b — memory

- MemoryJobs supervises native compactor fibers in a parallel owner scope, while
  Memory keeps the same indexed level/index ready queues, child availability,
  early-message admission window and eight default slots. Session borrows runtime
  services and starts recovery only after Runner installs the complete prompt and
  tools. Native providers avoid the Promise bridge; injected models/build overrides
  retain it and drain native cleanup on interruption.
- The original compaction algorithm remains in memory.js. Exact copies make no
  model request; generated summaries use complete source/context, five attempts,
  the same byte-feedback conversation, shortest selection and immutable node
  writes. A new native/legacy comparison asserts complete request conversations and
  saved summaries agree. Existing main/compaction view, four-line block, UTF-8,
  zoom-paging, most-due folding and upstream-alignment tests also pass.
- Settle/drain coordinate through Effect callback subscriptions with listener
  cleanup and compatible Boolean Promise adapters. Canceling a waiter leaves jobs
  alive; stop interrupts all active jobs, waits for cleanup and is cached. Tests
  hold all eight native cleanups, prove a ninth request never starts during shutdown,
  prevent late node commits and recover unfinished work after reopening storage.
- Failed jobs retain the new-input/explicit-settle retry policy. Advancing a borrowed
  TestClock by six minutes causes no background retry. Native output limits keep
  the existing incomplete-compactor diagnostic and never save partial text;
  simultaneous cancellation/cleanup defects stay in private full-Cause diagnostics.
- Node/change adapters deliver synchronously but isolate each observer and track
  rejected async receipts without waiting for them. Audit/metrics errors do not
  invalidate a committed node, block another observer or rewrite memory. The
  independent memory view oracle now explicitly surfaces any assertion captured
  by that observer adapter, retaining its original regression coverage.
- The existing native-audio subprocess fixture initially missed its startup marker
  during the persistence-only check; its isolated and full reruns passed. The final
  combined check passes it. No audio fixture or production playback changes were made.

The independent CPU-only benchmark uses 10,000 messages, 200 iterations and five
rounds. Median snapshot: 0.002827085 ms; initialization: 1,037.910750 ms; saved-view
restore: 4.966500 ms; pending-view restore: 11.356291 ms; idle pump: 0.000085 ms.
Nodes/view parts remain 19,995/156 and idle-pump node reads remain zero. All
measurements stay within the agreed baseline regression limits; the benchmark
makes no API requests or filesystem writes and does not measure model throughput.

Next is step 11, final composition and removal of obsolete scaffolding.

## Final composition verification — October 14, 2026

Step 11 is complete. `bun run check` passes typecheck and 387 tests across 41 files
with 6,888 assertions. `bun run build` succeeds with 78 modules and a 1.20 MB CLI
bundle. No vendored or frozen fixture files were changed and no live API requests
were made. The Effect migration backlog is complete.

- Session publishes the existing memory/evaluation/metrics owners as context
  services alongside storage, settings/model construction and audio. Tests prove
  all service values are the same session-owned objects and only one runtime and
  storage instance are acquired. Partial-startup transfer/cleanup ordering remains
  covered, including preservation of every simultaneous cleanup Cause.
- Session settle now composes native worker, parent-report, memory and evaluation
  drain operations in the session runtime. The native audit wait deadline replaces
  the superseded AbortSignal timeout. A borrowed-clock test verifies a timed-out
  evaluation waiter removes its subscription without interrupting the audit owner.
- Slash-command native tools use that runtime too. Piped `/exit` finishes previously
  accepted input before disposing it and ignores later lines; EOF still finishes
  late worker reports and parent handling. Existing plain-command, plan/backup,
  model-switch and both ask/piped-worker subprocess scenarios pass.
- A real CLI subprocess with an offline pending fetch verifies SIGINT reaches
  native I/O, preserves status 130 despite the later canceled-turn diagnostic,
  saves the original input and releases the lock for reopening. No live model is
  called. The intentional `cli.js` entry point remains usable; `runner.js` remains
  the intentional integration re-export.
- TUI close rejections are observed before exit. A component test verifies cleanup
  failure still releases subscriptions and raw input. Existing terminal rendering,
  resize, mount/unmount, clipboard, Markdown and audio scenarios all pass.
- The unused LegacyPorts service and application-wide foundation Promise helpers
  were removed after all production callers had native boundaries. Foundation
  tests now exercise the production ProviderModel layer and Schema tool registry;
  Cause formatting and intentional public/injected-port adapters remain covered.
- Metrics persistence already flows through validated synchronous Storage APIs;
  its pure incremental calculations and formatting remain ordinary code. Origin
  signals, native watchdogs, UI feedback timers and input receipt tracking remain
  where they have intentional ownership/presentation contracts. No resource cleanup
  was removed merely because a fiber exists.
- [Architecture](ARCHITECTURE.md), README contributor links and the Schema/runtime
  guides now describe final services and lifetime rules rather than retired scaffolding.

The independent CPU benchmark (10,000 messages, 200 iterations, five rounds)
reports median snapshot 0.001858750 ms; initialization 775.893958 ms; saved-view
restore 3.263500 ms; pending-view restore 8.631125 ms; idle pump 0.000053540 ms.
Nodes/view parts remain 19,995/156 and idle-pump node reads remain zero. These
measurements meet the recorded regression budget and make no API requests or
filesystem writes.
