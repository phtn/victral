# Victral

A terminal agent named Victral, implementing the OptChat specification with
Cohere and Meta models. The default is Cohere `command-a-plus-05-2026`. The original
specification is preserved in [docs/OPTCHAT_SPEC.md](docs/OPTCHAT_SPEC.md).

## Start

Requires Node.js 22 or later. There are no packages to install.

Set `COHERE_API_KEY` in your environment or in a local `.env` file. The example
in `.env.example` lists the available settings. Never commit your keys.

```sh
npm start -- --project /absolute/path/to/your/project
```

## Select models

| Model ID | Provider | Credential |
| --- | --- | --- |
| `command-a-plus-05-2026` | Cohere | `COHERE_API_KEY` |
| `muse-spark-1.3` | Meta | `META_API_KEY` or `MODEL_API_KEY` |
| `muse-spark-1.3-contributor` | Meta | `META_API_KEY` or `MODEL_API_KEY` |

```sh
npm start -- --project /absolute/path/to/your/project --model muse-spark-1.3
```

Choose the compactor separately if desired:

```sh
npm start -- --model muse-spark-1.3 --compactor-model command-a-plus-05-2026
```

`--models` lists the supported models without making API requests. During an
interactive session, `/model` shows the current choices and `/model MODEL_ID`
switches the main agent between turns while retaining saved memory. The
compactor stays on its startup selection. Model switches are session-local;
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

Read, list, and write tools are available by default. Add `--allow-shell` if
you want the agent to run commands. Shell commands use the project as their
working directory; this option is not an operating-system sandbox.

For a single turn:

```sh
npm start -- --project /absolute/path/to/your/project --ask "Inspect this project and tell me what you find."
```

## Commands

| Command | Effect |
| --- | --- |
| `/model [MODEL_ID]` | Show models or switch the main agent between turns |
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
npm test
npm run smoke
```

The tests run offline. The smoke test makes real provider requests using only a
synthetic example. It tests compaction, closing and reopening storage, and
model-driven retrieval through `zoom`. Its artifacts remain in a temporary
directory, separate from your real chat.

Run the same smoke test for either Meta model:

```sh
npm run smoke -- --model muse-spark-1.3
npm run smoke -- --model muse-spark-1.3-contributor
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

## Optional Jev evaluation

Jev produces typed judgments, rather than summary text. Cohere remains the
main agent and compactor. Jev is deliberately separate from the original
memory algorithm: no automatic filtering, deletion, rewriting, or gating.

Set `TYPESAFE_API_KEY` locally, then evaluate an explicitly chosen source and
summary:

```sh
npm run audit -- --source original.txt --summary summary.txt
```

The command sends those two files to TypeSafe's `jev-latest`. It returns three
independent Noul probabilities: whether the summary adds unsupported facts,
omits an explicit user decision, or inflates progress. These are fallible
model judgments, not proof that a summary is correct. No threshold or memory
change is applied automatically. Keep evaluation records and compare them
with human-reviewed examples before deciding on a future integration.

See [TypeSafe introduction](https://docs.typesafe.ai/introduction) and
[API reference](https://docs.typesafe.ai/api).
