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
