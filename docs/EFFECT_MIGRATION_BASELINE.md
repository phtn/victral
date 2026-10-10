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
