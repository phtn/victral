# OptChat setup

Implement the specification in `OPTCHAT_SPEC.md`. That file is an unchanged
copy of the original `file.txt`. The original `file.md` is a saved HTML page.

## Current state

A Bun application with a strict TypeScript CLI, agent loop, tool layer,
and Beast/Octane terminal workspace with `@octanejs/ink` implements the core
memory loop with Meta `muse-spark-1.3-contributor` as the default agent and compactor,
and selectable Meta `muse-spark-1.3`. Runtime
prompts use the name Victral, with only the permitted name substitution. See
`../README.md` for commands, verification, and Meta request behavior.
Jev automatically evaluates generated summaries in the background when its
key is configured. Live metrics show evaluation probabilities, token usage,
latency, and memory progress. Observations live outside the memory algorithm;
the standalone audit command remains available. No history import is needed
for new conversations. No always-on service or existing-agent integration is
installed. Install dependencies with `bun install`; run `bun run check` for
TypeScript and offline verification, `bun run build` for the distributable
entry point, or `bun run demo` to preview the workspace without network calls.
File search, exact edits, and Git inspection are built in; `--allow-shell` adds
structured CLI and shell execution with bounded output and cancellation.

## Before choosing the integration

Identify the first agent interface to support and how its model calls, tools,
and streamed events can be controlled. The specification requires control over
the turn loop; reading a Markdown file in an existing agent is insufficient.
Choose the model access method and compactor model after identifying this
interface. Verify the provider-specific API fields in section 8 against the
chosen interface before implementing them. Record any incompatibility rather
than silently substituting different behavior.

## Implementation order

1. Storage (section 2): daily JSONL message and tree files, global message IDs,
   UTF-8 sizes, one write plus fsync per record, torn-line handling, and a
   lifetime single-writer lock. Keep model reasoning out of the permanent log.
2. Tree and view (sections 3 and 5): purely binary nodes, free nodes when the
   source fits, `id+n` addressing, incremental append and merge, the specified
   age rule, and no splitting. Reconstruct the view by replaying append and fit
   at startup.
3. Compactor (section 4): use the supplied COMPACT prompt and context format,
   build nodes in the specified dependency order, measure UTF-8 bytes, retry
   oversized output as described, and persist nodes before exposing them.
4. Readiness and retrieval (sections 6 and 7.1): settle before each new turn,
   cancellation support, and tools implementing `zoom` and `date`.
5. Agent turn loop (section 7): render prior history before logging new input,
   start each turn fresh, inject the view and the new message separately,
   capture messages and tool events as they happen, cap tool results using the
   specified head-and-tail scheme, and handle input arriving during a turn.
6. Caching (section 8): stable system prompt and tools, specified view marks,
   provider-compatible request layout, and validation using actual usage
   fields. Do not assume a cache hit solely because the input is similar.
7. Persistence and imports (section 10): persist after turns, back up the log,
   test restart recovery, and import only available historical records.
8. Optional integrations (section 9): add subagents and computer tasks only
   after the core loop works. Their reports enter the main memory; their own
   tool traces stay in their separate sessions.

## Reference constants

Keep the initial implementation at the specification's values:

| Constant | Value |
| --- | --- |
| NODE | 512 UTF-8 bytes, a target rather than a hard bound |
| VIEW | 128,000 UTF-8 bytes |
| JOBS | 8 |
| TRIES | 5 |
| RETRY | 10 seconds |
| CAP | 30,000 characters |
| MARKS | 50,000 / 80,000 / 100,000 characters |

Use the supplied MASTER and VIEW_DOC prompts, with only the permitted agent
name substitution. Keep user's instructions distinct from historical content.

## Initial acceptance checks

- A restart preserves all successfully written messages and tree nodes.
- A second process cannot write to the same chat directory.
- Torn final records are reported and subsequent appends remain readable.
- Tree ranges and view coverage are correct; merges never split later.
- Retrieval reaches the original stored message, including Unicode content.
- A turn does not start with an unsummarized view entry.
- A fresh turn receives prior history and new input in the specified order.
- Cancellation and mid-turn input do not lose or duplicate messages.
- A decision recorded in one turn is available after a process restart.
- Provider usage fields establish the measured cache behavior and cost.

Do not call the setup complete until these checks pass with the chosen runtime.
Track future improvements separately so the initial implementation remains
traceable to the original specification.
