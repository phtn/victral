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
