# Victral

A persistent coding workspace with a TypeScript CLI and a full-screen terminal
interface, implementing the OptChat specification with Cohere and Meta models.
The default is Meta `muse-spark-1.3-contributor` for both the agent and the compactor. The original specification is preserved in [docs/OPTCHAT_SPEC.md](docs/OPTCHAT_SPEC.md).

## Start

Requires Bun 1.4 or later. Install the locked dependencies first; Bun runs the
application, scripts, and test suite and loads local `.env` files automatically.

```sh
bun install
```

Set `COHERE_API_KEY` in your environment or in a local `.env` file. The example
in `.env.example` lists the available settings. Never commit your keys.

```sh
bun run start --project /absolute/path/to/your/project
```

## Select models

| Model ID | Provider | Credential |
| --- | --- | --- |
| `command-a-plus-05-2026` | Cohere | `COHERE_API_KEY` |
| `muse-spark-1.3` | Meta | `META_API_KEY` or `MODEL_API_KEY` |
| `muse-spark-1.3-contributor` | Meta | `META_API_KEY` or `MODEL_API_KEY` |

```sh
bun run start --project /absolute/path/to/your/project --model muse-spark-1.3
```

Choose the compactor separately if desired:

```sh
bun run start --model muse-spark-1.3 --compactor-model command-a-plus-05-2026
```

`--models` lists the supported models with their providers and required
credentials, without making API requests. Models can be named by list number,
short name, or full ID: `--model 2` works like
`--model muse-spark-1.3`. During an interactive session, `/model` shows the
current agent, the compactor, and the numbered choices; `/model 2` switches
the main agent between turns while retaining saved memory. The compactor stays
on its startup selection. Model switches are session-local;
set `VICTRAL_MODEL` and `VICTRAL_COMPACTOR_MODEL` for defaults. Explicit CLI
flags take precedence. Legacy `COHERE_MODEL` and `COHERE_COMPACTOR_MODEL`
variables remain accepted.

Meta requests go directly to `https://api.meta.ai/v1/messages`, using the
documented Anthropic-compatible Messages surface to preserve reasoning across
tool steps. Native content, encrypted reasoning, and signatures are replayed
inside a turn and excluded from the permanent memory log. Compactor effort is
`medium`. Meta requires an output limit; this adapter uses 16,384 tokens and
reports incomplete generations instead of silently accepting them.

Meta's Contributor tier permits using prompts and completions for training;
its Standard tier does not. See [Meta models](https://dev.meta.ai/docs/models)
and [Messages API](https://dev.meta.ai/docs/protocols/messages).

The runner defaults to one persistent chat at `~/.local/share/victral/chat`.
Use that same chat directory across launches to retain history. Project file
tools operate on the project selected by `--project`. Its root `AGENTS.md` is
loaded as the user's instructions if present; `--instructions FILE` chooses a
different file. Nested instruction discovery is not implemented.

File reading, directory listing, exact text edits, recursive literal search,
fetching pages over HTTP(S), and read-only Git status/diff are available by default. Add `--allow-shell` to
give the agent CLI execution:

```sh
bun run start --project /absolute/path/to/your/project --allow-shell
```

`run_command` executes a program with a literal argument array, suitable for
builds, tests, and installed developer CLIs. `shell` handles pipelines and
other shell syntax. Both run in the project root, have a default 30-second
timeout (maximum 120 seconds), kill their process group on cancellation on
Unix, and cap output. Environment variables ending in KEY, TOKEN, SECRET,
PASSWORD, CREDENTIAL, or AUTHORIZATION are removed from subprocesses.
File tools reject paths and symlinks leaving the project. Command execution
is not an operating-system sandbox and programs can access the host filesystem.
Use `/tools` to see exactly which tools are available.

For a single turn:

```sh
bun run start --project /absolute/path/to/your/project --ask "Inspect this project and tell me what you find."
```

## Terminal workspace

An interactive terminal opens the Ink/React workspace automatically. It has
streaming conversation history, tool timing and status, a command menu,
measured metrics, input history, and a composer that stays available during
agent work. The alternate screen restores your previous terminal on exit.
Resize to at least 42 columns × 16 rows. Escape cancels a turn or dismisses a
panel. Input supports pasting, cursor movement, Ctrl+A/Ctrl+E, and Ctrl+U.

| Key | Action |
| --- | --- |
| Ctrl+P | Open the command menu; arrows select, Enter inserts a command |
| Ctrl+O | Toggle the detailed metrics panel |
| Page Up / Page Down | Scroll conversation or metrics |
| Up / Down | Recall submitted input |
| Escape | Dismiss a panel or cancel the active turn |
| Ctrl+C | Cancel while working; close while idle |

Preview without credentials, API calls, tool execution, or saved data:

```sh
bun run demo
```

`--plain` selects the line-oriented interface; pipes select it automatically.
`--tui` requires an interactive terminal. `--ask` always uses plain streaming
output and returns a nonzero exit code on a failed turn. Closing stdin finishes
queued work before releasing the chat lock.

## Commands

| Command | Effect |
| --- | --- |
| `/help` | Show commands and keyboard shortcuts |
| `/tools` | List agent tools and command execution access |
| `/metrics` | Show accumulated token, timing, memory, retrieval, and evaluation metrics |
| `/jev` | Show recent automatic summary evaluations and their status |
| `/model [NUMBER_OR_ID]` | Show models or switch the main agent between turns |
| `/view` | Display the current summary view |
| `/zoom ID N` | Open a memory range; N must be a power of two |
| `/date ID` | Display a stored message's local date and time |
| `/usage` | Show the last ten provider usage records |
| `/import FILE` | Save a plain-text historical transcript as a note |
| `/backup PATH` | Copy saved logs to a new backup directory |
| `/cancel` | Cancel the current turn; completed log entries stay saved |
| `/exit` | Stop the runner and release its chat lock |

You can type new messages during a turn. They enter the running call at the
next tool boundary. Ctrl+C cancels; `/exit` closes. Keep the process running
for background compaction, or launch again to resume unfinished summaries.
This version does not install an always-on service.

## Verification

```sh
bun run check       # strict TypeScript checks and offline tests
bun run build       # builds dist/cli.js and copies runtime prompt assets
bun dist/cli.js --help
bun run benchmark  # CPU-only metrics benchmark with 10,000 saved messages
bun run smoke
bun run smoke:jev
```

The tests run offline and cover CLI lifecycle, terminal keyboard behavior,
file boundaries, unique edits, literal argument handling, command timeout and
cancellation, Git inspection, providers, memory, and evaluations. The built CLI
needs the installed dependencies and its adjacent prompt assets.

Metrics accumulate saved usage, turns, and message sizes once, and refresh audit
totals when evaluations change. Streaming UI updates reuse those totals while
reading current view and compactor state. The benchmark measures repeated metrics
updates after replay; it makes no API requests or persistent writes. Pass a
history size with `bun run benchmark 1000` to compare different workloads.

Both provider adapters share a streaming event parser that preserves UTF-8 text
and accepts LF, CRLF, and CR separators across network chunks. A provider's
terminal event completes the request immediately; a connection ending before
that event remains an error.

The CLI, session controller, agent loop, tools, and TUI are strict TypeScript.
Existing provider, storage, compaction, and evaluation modules remain JavaScript
behind typed application interfaces; they are covered by the existing tests.
Compatibility `.js` entry points keep current scripts and imports working.

The smoke test makes real provider requests using only a
synthetic example. It tests compaction, closing and reopening storage, and
model-driven retrieval through `zoom`. Its artifacts remain in a temporary
directory, separate from your real chat.

Run the same smoke test for either Meta model:

```sh
bun run smoke --model muse-spark-1.3
bun run smoke --model muse-spark-1.3-contributor
```

## Cohere adaptation

Storage, binary summaries, compactor prompts, original constants, incremental
view merging, settle, retrieval, and fresh-turn construction follow the
specification. Cohere's native V2 API is used:

- Provider-neutral view pieces use the specification's cache mark positions.
  The documented Cohere API does not expose the Anthropic/OpenAI breakpoint
  fields in the specification; unsupported fields are not sent. Usage records
  retain actual `cached_tokens` when returned. Cache efficiency is measured,
  not guaranteed.
- Cohere rejects replayed thinking content combined with `tool_plan`. When
  thinking blocks exist, they remain intact in the in-turn request history
  and the separate `tool_plan` field is omitted. Thinking is never stored in
  the permanent chat log. Non-reasoning tool plans are replayed normally.
- Provider-native reasoning defaults are used; Cohere has no documented
  equivalent of the reference compactor's “medium effort” setting.

The runtime prompts use the specification's permitted name substitution:
“OptChat” becomes “Victral”; the reference document remains unchanged.

Optional subagents, computer-use workers, an HTML memory browser, and a daemon
are not implemented. The runner does not attach memory to existing Codex,
Claude Code, or Cursor sessions. Work performed outside this runner is known
only if its transcript or findings are imported.

Provider documentation: [Chat](https://docs.cohere.com/reference/chat),
[streaming tools](https://docs.cohere.com/docs/tool-use-streaming), and
[reasoning](https://docs.cohere.com/docs/reasoning).

## Live metrics and automatic Jev evaluation

New chat messages are stored and summarized automatically; no history import
is needed. A compact metrics footer appears after each turn. Completed Jev
evaluations arrive as status lines while idle, and are held until the turn
ends while a reply is streaming. `/metrics` shows detailed totals; `/jev`
shows the five most recently updated evaluations.

The display includes:

- Turn duration, time waiting for summaries, average API latency, and average
  time to first visible response text (including time spent reasoning).
- Input, output, reasoning, and cache-read tokens, separated by agent and
  compactor. Reasoning tokens are already included in output tokens.
- Message count, saved nodes, raw/view byte ratio, view budget, pending
  summaries, and active or retrying compactor jobs.
- Tool calls and `zoom` retrievals.
- Jev's per-summary unsupported-claim, omitted-decision, and inflated-progress
  probabilities, plus evaluation latency, token usage, pending jobs, errors,
  skips, and average probabilities.

These are measured counters, not estimated spend or claims of correctness.
Cache totals account for Cohere's inclusive input counter and Meta's separate
cache-read counter. Missing provider measurements display as unavailable.

With `TYPESAFE_API_KEY` set, every newly generated summary is automatically
evaluated in the background. Exact-copy nodes need no lossy-summary audit.
Jev sees the source, chosen summary, and the original compactor context. The
memory algorithm, selection of the shortest summary, and turn readiness remain
unchanged. Evaluations never gate chat or rewrite memory.

Usage, node/turn metrics, and evaluation records are stored in separate daily
JSONL streams beside the chat, included in `/backup`, and excluded from the
agent's conversation view. Pending audit jobs retain references to the
immutable source and context nodes and resume after restart. API failures are
shown as failures rather than passing results; rate-limit retries are bounded.

Jev's documented state-plus-question limit is 32k tokens. This version uses a
conservative 24,000-byte guard on the complete audit state rather than claiming
an exact token count. Oversized audits are marked skipped; their source and
context are never silently truncated. See [TypeSafe models](https://docs.typesafe.ai/models).

`--no-jev` disables background API evaluations, preserving their queue for a
future enabled launch. `--no-metrics` suppresses automatic footers while keeping
saved measurements and the explicit `/metrics` and `/jev` commands available.

## Standalone Jev evaluation

Jev produces typed judgments, rather than summary text. Cohere remains the
main agent and compactor. Jev observes the original memory algorithm without
automatic filtering, deletion, rewriting, or gating.

Set `TYPESAFE_API_KEY` locally, then evaluate an explicitly chosen source and
summary:

```sh
bun run audit --source original.txt --summary summary.txt
```

The command sends those two files to TypeSafe's `jev-latest`. It returns three
independent Noul probabilities: whether the summary adds unsupported facts,
omits an explicit user decision, or inflates progress. These are fallible
model judgments, not proof that a summary is correct. No threshold or memory
change is applied automatically. Keep evaluation records and compare them
with human-reviewed examples before deciding on a future integration.

See [TypeSafe introduction](https://docs.typesafe.ai/introduction) and
[API reference](https://docs.typesafe.ai/api).
