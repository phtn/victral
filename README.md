# Victral

A persistent coding workspace with a TypeScript CLI and a full-screen terminal
interface, implementing the latest OptChat / UniiChat memory design with Meta and OpenAI models.
The default is Meta `muse-spark-1.3-contributor` for both the agent and the compactor.
The [upstream specification](docs/OPTCHAT_SPEC.md) is pinned to gist revision
`3c190e06f34aba0c69f49042c526093269604935` (October 8, 2026).
[Alignment notes](docs/UPSTREAM_ALIGNMENT.md) describe the implementation and
provider differences; the [original specification](docs/OPTCHAT_SPEC_ORIGINAL.md)
is retained for reference.

Memory appends summary lines until the rendered view exceeds 128,000 UTF-8
bytes, then merges a batch toward 64,000 bytes. It chooses sibling pairs by
age measured from their last message. `view.json` preserves the exact ranges
across restarts; `view-batch.json` retains a batch waiting for unfinished parents.
Compactions share the agent's system prompt, user instructions and tool schema,
and use a separately saved 16,000–32,000-byte context view. Both views contain
complete summaries; compaction context stops at the first unbuilt message.
Failed compactions wait for another message to retry. Long non-tool text is
logged losslessly as consecutive messages of at most 30,000 UTF-8 bytes.
`zoom` retrieves long originals in pages (zero-based `page`, default 0).

Existing chat directories without `view.json` initialize it once from their
saved history. Subsequent launches load it directly, recovering only messages
appended after its last write. Keep the view files with the logs when backing
up or moving a chat; `/backup` includes them automatically.

## Start

Requires Bun 1.4 or later; development type checking also needs Node.js
22.22.2 or later. Install the locked dependencies first; Bun runs the
application, scripts, and test suite and loads local `.env` files automatically.

```sh
bun install
```

Set `META_API_KEY` (or `MODEL_API_KEY`) for the default model, or `OPENAI_API_KEY`
for an OpenAI model, in your environment
or in a local `.env` file. The example
in `.env.example` lists the available settings. Never commit your keys.

```sh
bun run start --project /absolute/path/to/your/project
```

## Select models

| Short name | Model ID | Provider | Credential |
| --- | --- | --- | --- |
| `ms1.3` | `muse-spark-1.3` | Meta | `META_API_KEY` or `MODEL_API_KEY` |
| `ms1.3c` | `muse-spark-1.3-contributor` | Meta | `META_API_KEY` or `MODEL_API_KEY` |
| `luna6` | `gpt-6-luna` | OpenAI | `OPENAI_API_KEY` |
| `sol6.1` | `gpt-6.1-sol` | OpenAI | `OPENAI_API_KEY` |

```sh
bun run start --project /absolute/path/to/your/project --model ms1.3
bun run start --project /absolute/path/to/your/project --model luna6
```

Choose the compactor separately if desired:

```sh
bun run start --model ms1.3 --compactor-model ms1.3c
```

`--models` lists the supported models with their providers and required
credentials, without making API requests. Models can be named by list number,
short name, or full ID: `--model ms1.3` and `--model 1` work like
`--model muse-spark-1.3`. During an interactive session, `/model` shows the
current agent, the compactor, and the numbered choices; `/model meta ms1.3` or
`/model openai sol6.1` switches the main agent between turns while retaining saved
memory. `/model openai` lists only OpenAI models. Model-only shortcuts such as
`/model ms1.3` and `/model luna6` also work. The compactor stays
on its startup selection. Model switches are session-local;
set `VICTRAL_MODEL` and `VICTRAL_COMPACTOR_MODEL` for defaults. Explicit CLI
flags take precedence. The numbered choices are 1 for `muse-spark-1.3` and
2 for `muse-spark-1.3-contributor`, 3 for `gpt-6-luna`, and 4 for `gpt-6.1-sol`.
Short names also work in the environment
settings and smoke scripts, and are case-insensitive. API requests and saved
usage retain the full model IDs. The status bar shows the selected model's short
name and updates when switching with `/model`.

The status bar suggests matching command words as you type. `/m` shows `/metrics`
and `/model`; `/mo` narrows to `/model`. Tab completes the selected word and adds
a space, revealing the next choices: `meta` and `openai`, followed by that
provider's models. For example, type `/mo`, Tab, `o`, Tab, `s`, Tab to compose
`/model openai sol6.1 `. Up/Down or Shift+Tab changes the selected suggestion;
Enter runs the completed command. Suggestions occupy the status bar while
completing, then the usual model, project, and evaluation status returns.

OpenAI supports only [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
and [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) in this
app. Requests use the [Responses API](https://developers.openai.com/api/docs/guides/reasoning)
with medium reasoning effort and `store: false`. Native output items, including
encrypted reasoning and assistant phase, are replayed during tool steps within
a turn; permanent memory stores visible text and tool activity. Both the agent
and compactor can use either supported OpenAI model. Cached input and reasoning
tokens are measured from provider usage without adding them twice to totals.

Meta requests go directly to `https://api.meta.ai/v1/messages`, using the
documented Anthropic-compatible Messages surface to preserve reasoning across
tool steps. Native content, encrypted reasoning, and signatures are replayed
inside a turn and excluded from the permanent memory log. Compactor effort is
`medium`. Meta requires an output limit; this adapter uses 16,384 tokens and
reports incomplete generations instead of silently accepting them.
The agent loop rejects failed or missing completion reasons before executing
tools, and reports a failed turn if a tool step contains no calls.

Meta's Contributor tier permits using prompts and completions for training;
its Standard tier does not. See [Meta models](https://dev.meta.ai/docs/models)
and [Messages API](https://dev.meta.ai/docs/protocols/messages).

The runner defaults to one persistent chat at `~/.local/share/victral/chat`.
Use that same chat directory across launches to retain history. Project file
tools operate on the project selected by `--project`. Its root `AGENTS.md` is
loaded as the user's instructions if present; `--instructions FILE` chooses a
different file. Nested instruction discovery is not implemented.

File reading, directory listing, exact text edits, multi-file patches, glob
discovery, literal or regex search, parallel read operations, persistent task
plans, HTTP(S) fetching, and read-only Git history, blame and diffs are
available by default. Add `--allow-shell` to give the agent
foreground and background CLI execution:

```sh
bun run start --project /absolute/path/to/your/project --allow-shell
```

`run_command` executes a program with a literal argument array, suitable for
builds, tests, and installed developer CLIs. `shell` handles pipelines and
other shell syntax. Both run in the project root and have a default 30-second
timeout (maximum 120 seconds). `start_command` returns a session-local
`command_id` immediately, allowing the agent to continue working during a
build or test run. `command_status` returns cumulative output and exit status,
optionally waiting up to 10 seconds; `stop_command` terminates the job.
Background jobs default to 120 seconds and allow up to 600 seconds, with at
most eight running jobs and the most recent 32 results retained. They have
closed stdin by default, survive completed turns, and stop on cancellation of the turn
that started them or on session shutdown. All commands kill their process
group on cancellation on Unix and cap output. Environment variables ending in KEY, TOKEN, SECRET,
PASSWORD, CREDENTIAL, or AUTHORIZATION are removed from subprocesses.
File tools reject paths and symlinks leaving the project. Command execution
is not an operating-system sandbox and programs can access the host filesystem.
Use `/tools` to see exactly which tools are available.

Set `interactive: true` on `start_command` to keep piped stdin open, then
send literal UTF-8 text through `write_command_input`. Include any newline
needed by the program. `eof: true` closes stdin after sending; omit `input`
to send EOF alone. Each write allows up to 64 KiB. Writes that block for two
seconds or are canceled stop the process to release pending input. These
commands use pipes, so programs requiring a pseudo-terminal are not supported.
`list_commands` and `/jobs` show retained jobs and their IDs, statuses, exit
codes, timeouts, and stdin state. Job IDs remain local to a running session.

`get_plan` and `update_plan` manage a title and up to 50 steps with statuses
`pending`, `in_progress`, or `completed`. At most one step can be in progress.
Updates supply `expected_revision` from `get_plan` (0 for the first plan),
preventing stale updates from overwriting newer progress. Plans are stored
in a separate `plans` log under the chat directory, scoped to the project's
canonical root, restored on restart, included in `/backup`, and supplied
alongside memory at the start of each turn. `/plan` shows the current plan.
The latest user instructions still take precedence over saved progress.
Embedded users of `projectTools` can pass a `planStore`; without one, plans
remain in memory for that tools instance.

`parallel_tools` accepts `calls: [{ tool, arguments }, ...]` with 1–8
independent reads. It runs them concurrently, retains request order, and
reports each success or failure separately. Supported operations include
file reads and searches, memory retrieval, Git inspection, URL fetching,
plan reads, and authorized command status reads. Each result is capped at
3000 UTF-8 bytes; call a tool directly when larger output is needed. Mutation,
command execution, and nested batches are excluded before the batch starts.
Cancellation reaches the child operations. Metrics count both the batch and
its child calls, including `zoom` retrievals.

`git_log` returns recent commits (default 20, maximum 100), `git_show` returns
a commit message and patch, and `git_blame` shows line attribution. All accept
a `ref`, defaulting to `HEAD`, and optional literal project paths; blame
requires a file path and accepts paired `start_line`/`end_line` limits.
`git_diff` also accepts `base` for comparing the current files or staged
changes against a revision. These tools keep external diff and text conversion
programs disabled and are available without `--allow-shell`.

`glob_files` accepts a `pattern`, optional directory `path`, and `max_results`
(default 200, maximum 1000). Patterns such as `**/*.{ts,js}` match paths relative
to the project root, including when `path` scopes the scan. `search_files`
retains literal, case-sensitive matching by default; set `regex: true` for
JavaScript regular expressions, `case_sensitive: false` for case folding,
and `glob` to restrict file types. Its result limit defaults to 100 and allows
up to 1000. Both scan at most 5000 files and skip dependencies, build output,
`.env` files, and symlinks; text search also skips binary files and files over
1 MB. Results report when a scan or result limit is reached.
Regex matching runs in a worker with a two-second deadline per file so a
backtracking pattern can be canceled without blocking the agent.

`apply_patch` accepts a single `patch` string with up to 100 file operations:

```diff
*** Begin Patch
*** Add File: src/new.ts
+export const enabled = true;
*** Update File: src/existing.ts
@@
-export const count = 1;
+export const count = 2;
*** Delete File: obsolete.txt
*** End Patch
```

Update hunks start with `@@` and use a space for unchanged context, `-` for
removed lines, and `+` for added lines. Include enough existing context for a
unique, exact match. `*** End of File` anchors a hunk to the file's end;
`*** Move to: new/path` immediately after an Update File header moves the
updated file. Patches preserve existing newline style and final-newline
presence; added files end with a newline. They reject overwrites, duplicate
targets, binary files, file symlinks, and paths outside the project. Every path
and hunk is validated before writing, and earlier file changes are restored
if a later write fails. This is a file-content rollback, not a filesystem
transaction; newly created empty parent directories may remain after failure.

For a single turn:

```sh
bun run start --project /absolute/path/to/your/project --ask "Inspect this project and tell me what you find."
```

## Terminal workspace

An interactive terminal opens the Beast/Octane workspace automatically, using
the native `@octanejs/ink` terminal renderer. It has
streaming conversation history, tool timing and status, a command menu,
measured metrics, input history, and a composer that stays available during
agent work. The alternate screen restores your previous terminal on exit.
Resize to at least 42 columns × 16 rows. Escape cancels a turn or dismisses a
panel. Input supports pasting, cursor movement, Ctrl+A/Ctrl+E, and Ctrl+U.

| Key | Action |
| --- | --- |
| Ctrl+P | Open the command menu; arrows select, Enter inserts a command |
| Tab | Complete the selected command, provider, or model word and add a space |
| Up / Down / Shift+Tab with suggestions | Select a suggestion |
| Ctrl+O | Toggle the detailed metrics panel |
| Page Up / Page Down | Scroll conversation or metrics |
| Mouse wheel / Shift+Up / Shift+Down | Scroll three lines at a time |
| Home / End | Jump to the beginning / latest messages |
| Up / Down | Recall submitted input |
| Escape | Dismiss a panel or cancel the active turn |
| Ctrl+C | Cancel while working; close while idle |

Scrolling up keeps your place as replies stream. Returning to the bottom
resumes following new messages. Hold Shift to select terminal text with the mouse.
Click **[Copy Markdown]** beneath a response to copy its original Markdown,
including code fences and links. macOS uses the system clipboard; other terminals
receive an OSC 52 clipboard request and show **[Copy sent]**. Those terminals must
allow clipboard writes for the request to take effect.

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
| `/plan` | Display the saved task plan and its revision |
| `/jobs` | List retained background commands and their status |
| `/metrics` | Show accumulated token, timing, memory, retrieval, and evaluation metrics |
| `/jev` | Show recent automatic summary evaluations and their status |
| `/model [PROVIDER] [NUMBER_OR_SHORT_NAME_OR_ID]` | Show models or switch the main agent between turns |
| `/view` | Display the current summary view |
| `/zoom ID N [PAGE]` | Open a memory range; N must be a power of two; PAGE starts at 0 |
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
bun run benchmark  # CPU-only metrics and memory benchmark with 10,000 messages
bun run smoke
bun run smoke:jev
```

The tests run offline and cover CLI lifecycle, terminal keyboard behavior,
incremental Markdown rendering, smooth streaming and cancellation,
file boundaries, unique edits, patch validation and rollback, glob and regex
search, durable plans and backups, concurrent read batches and their metrics,
literal argument handling, interactive input and blocked pipe deadlines,
foreground and background command timeout, cancellation and shutdown,
Git history and attribution, the Meta and OpenAI adapters, staged command completion,
memory, and evaluations. The built CLI
needs the installed dependencies and its adjacent prompt assets.

Metrics accumulate saved usage, turns, and message sizes once, and refresh audit
totals when evaluations change. Streaming UI updates reuse those totals while
reading current view and compactor state. The benchmark measures repeated metrics
updates, memory initialization and saved-view restoration with both a full
summary tree and an unfinished backlog,
and idle compactor scheduling. It makes no API requests or persistent writes. Pass a
history size with `bun run benchmark 1000` to compare different workloads.

Memory maintains view byte totals and eligible sibling merges incrementally.
The compactor indexes unfinished work on restart, then queues nodes as their
sources become ready. Idle scheduling avoids scanning saved history. Ready
queues preserve dependency order, allow up to eight concurrent calls,
and use the updated batch merge order. Cache blocks contain four summary lines;
Meta manages caching automatically and reported usage measures actual hits.

The Meta adapter uses a streaming event parser that preserves UTF-8 text
and accepts LF, CRLF, and CR separators across network chunks. The adapter's
terminal event completes the request immediately; a connection ending before
that event remains an error.

Agent text uses [AI SDK `smoothStream`](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
to display words at 10 ms intervals. The workspace immediately confirms input
with `✓ Received` and keeps an animated working indicator above the composer
while preparing memory, waiting for the model, thinking, responding, or running
tools. `Esc` cancels both the request and any queued display chunks.

The far right of the status bar shows compact Jev evaluations, for example
`Jev 12✓ 1… · U2% O1% P0%`: completed evaluations, pending work, and the latest
probabilities for unsupported claims (U), omitted user decisions (O), and inflated
progress (P). `!` marks errors and `↷` marks skipped evaluations. Narrow terminals
show counts first; `/jev` opens the full results. `Jev off` and `Jev no key` show
when evaluation is unavailable. `--no-metrics` hides this summary.

The full-screen workspace renders Markdown as responses stream: headings,
emphasis, links, lists, task lists, block quotes, code, and tables. Wide tables
switch to labeled rows when needed. Saved responses retain the original Markdown;
`--plain` and piped output stream the original text for scripts. Run `bun run demo`
to preview smoothing and Markdown without API calls.

The CLI, session controller, agent loop, and tools are strict TypeScript. The
terminal UI is authored in `src/workspace.ink.btsx`; Beast generates TSRX and
Octane compiles it for Ink's universal renderer, without React. `bun run start`,
`demo`, `test`, `typecheck`, and `build` compile the UI automatically. `bun run dev`
also rebuilds it when the source changes. Generated TSRX and runtime bundles are
ignored by Git; run `bun run build:ui` before invoking `bun src/cli.ts` directly.
The production CLI bundles the compiled UI and needs no compiler at runtime.

Beast and Octane are pinned to 0.8.0, with the matching Ink binding 0.0.21.
The binding ports Ink 7.1.1; we use no Ink 8-only layout or measurement APIs.
A guarded build adapter retains Ink 8's filtering of unknown terminal replies
and recognition of application-keypad Enter. Tests cover those cases alongside
editing, bracketed paste, Unicode, resizing, and subscription/raw-mode cleanup.
The TSRX checker uses TypeScript 5.9.3, supported by this pinned toolchain.

The Meta and OpenAI adapters, storage, compaction, and evaluation modules remain JavaScript
behind typed application interfaces; they are covered by the existing tests.
Compatibility `.js` entry points keep current scripts and imports working.

The smoke test makes real provider requests using only a
synthetic example. It tests compaction, closing and reopening storage, and
model-driven retrieval through `zoom`. Its artifacts remain in a temporary
directory, separate from your real chat.

Run the same smoke test for a supported model:

```sh
bun run smoke --model muse-spark-1.3
bun run smoke --model muse-spark-1.3-contributor
bun run smoke --model luna6
bun run smoke --model sol6.1
```

## Memory implementation

Storage, binary summaries, compactor prompts, original constants, incremental
view merging, settle, retrieval, and fresh-turn construction follow the
specification. View pieces retain the specification's cache mark positions.
Cache efficiency is measured from actual usage records, not guaranteed.

The runtime prompts use the specification's permitted name substitution:
“OptChat” becomes “Victral”; the reference document remains unchanged.

Optional subagents, computer-use workers, an HTML memory browser, and a daemon
are not implemented. The runner does not attach memory to existing Codex,
Claude Code, or Cursor sessions. Work performed outside this runner is known
only if its transcript or findings are imported.

## Live metrics and automatic Jev evaluation

New chat messages are stored and summarized automatically; no history import
is needed. A compact metrics footer appears after each turn. Completed Jev
evaluations arrive as status lines while idle, and are held until the turn
ends while a reply is streaming. `/metrics` shows detailed totals; `/jev`
shows the five most recently updated evaluations. `/metrics` and the Ctrl+O
panel group activity, usage, agent/compactor totals, memory, and evaluations into
tables, with comma-separated counts and separate rows for each measurement.

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
Cache totals include Meta's separate cache-read counter in total input tokens.
Missing provider measurements display as unavailable.

With `TYPESAFE_API_KEY` set, every newly generated summary is automatically
evaluated in the background. Exact-copy nodes need no lossy-summary audit.
Jev sees the source, chosen summary, and the original compactor context. The
memory algorithm, selection of the shortest summary, and turn readiness remain
unchanged. Evaluations never gate chat or rewrite memory.

Usage, node/turn metrics, and evaluation records are stored in separate daily
JSONL streams beside the chat, included in `/backup`, and excluded from the
agent's conversation view. Pending audit jobs retain references to the
immutable source and context nodes and resume after restart. API failures are
shown as failures rather than passing results. HTTP 429, 503, and 529 failures
get at most two retries with exponential backoff. The error counter includes
saved failed audits across sessions; restarting does not retry those failures.

Jev's documented state-plus-question limit is 32k tokens. This version uses a
conservative 24,000-byte guard on the complete audit state rather than claiming
an exact token count. Oversized audits are marked skipped; their source and
context are never silently truncated. See [TypeSafe models](https://docs.typesafe.ai/models).

`--no-jev` disables background API evaluations, preserving their queue for a
future enabled launch. `--no-metrics` suppresses automatic footers while keeping
saved measurements and the explicit `/metrics` and `/jev` commands available.

## Browsing, integrations and research subagents

Start with provider web search enabled when you need search results and citations:

```sh
bun run start --model sol6.1 --web-search
```

Search is opt-in for the main agent and its research workers. Compaction never
uses web search. Search may incur additional provider charges. Returned source
URLs appear in the answer. The selected model and its effort remain unchanged;
there is no automatic fallback to a cheaper model.

The `browse_url`, `read_web_page` and `find_in_page` tools are always available.
They extract readable HTML or text, retain numbered lines and links, and support
follow-up reads. Each page is limited to 2 MB; the latest 16 snapshots stay in
this session. They do not execute JavaScript, log in, click buttons, or inspect
PDFs. A browser or document MCP server can provide those capabilities.

Load integrations explicitly:

```sh
bun run start --mcp-config /absolute/path/to/mcp.json
```

See [the MCP configuration example](docs/mcp.example.json). Replace its example
server paths and endpoints with your own servers. Local servers use stdio;
remote servers use Streamable HTTP. Servers connect lazily when inspected or
called. `/integrations` lists servers; `/integrations SERVER` discovers their
tool schemas. `allowTools` lists exact callable tool names and defaults to an
empty list, so initial discovery does not grant tool execution. The agent uses
`list_integrations`, `list_integration_tools`, and `call_integration_tool`.

`env` and `headers` map target names to existing environment variable names,
not literal credentials. For example, `Authorization: MCP_AUTHORIZATION`
reads the full header value from that environment variable. Referenced secrets
are redacted from tool output. Explicitly selecting a stdio server permits
starting that program even without `--allow-shell`. Only configure servers you
intend to run. Integration access is separate from authorization to send,
publish, or perform other external actions.

Ask Victral to use subagents for independent research. Workers run in the
background and automatically deliver findings to the parent agent. Each worker
uses the model selected when it starts, with the same effort as the main agent,
and a snapshot of its memory and task plan. Workers may read project files,
inspect Git, browse pages and use enabled provider search. They cannot edit
files, run commands, invoke MCP integrations, or spawn further workers.

Use `/subagents` to list workers, `/subagents ID` for findings, and
`/subagents stop ID` to cancel one. There are at most three concurrent workers;
each is limited to 20 model steps and five minutes. Canceling the originating
turn cancels its running workers; closing Victral stops all workers and MCP
connections. `--ask` and normal piped-input completion wait for research reports
and the parent's response before exiting. `/metrics` shows subagent token usage
separately. Worker IDs and live jobs do not survive a restart; delivered reports
remain in saved memory.

## Standalone Jev evaluation

Jev produces typed judgments, rather than summary text. Meta `muse-spark-1.3-contributor`
is the default main agent and compactor. Jev observes the original memory algorithm without
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
