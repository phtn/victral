# Upstream alignment

Checked October 9, 2026 (Asia/Manila) against
[VictorTaelin's OptChat / UniiChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
The latest content revision is `3c190e06f34aba0c69f49042c526093269604935`, committed
October 8, 2026 at 01:58:24 UTC. GitHub's gist metadata was updated October 9.
[OPTCHAT_SPEC.md](OPTCHAT_SPEC.md) contains that revision; the original project
recipe is preserved in [OPTCHAT_SPEC_ORIGINAL.md](OPTCHAT_SPEC_ORIGINAL.md).

## Changes from the original implementation

| Updated requirement | Implementation |
| --- | --- |
| Measure merge age from the pair's last message | `SummaryView` ranks `(T - last) / 2^childLevel`, oldest first on ties. The independent rollback-push test matches every step through t=20,000, including the T=10 regression. |
| Batch main view from 128 KB to 64 KB | Appends retain existing ranges; crossing the high threshold starts a batch that remains active while waiting for parents. Budgets count the rendered UTF-8 bytes, including range labels and chat tags. |
| Save the live view | `view.json` stores range pairs, atomically replaced and flushed. Restart validates and restores them, appending only a log suffix committed after the last view save. Invalid saved state fails visibly. |
| Smaller compaction view | A separate saved view batches from 32 KB toward 16 KB and resets when the main view merges. It includes only built summaries and stops at the task's end or the first unbuilt message, whichever is earlier. |
| Same system prompt and tools for both calls | `systemPrompt` combines the turn, view and compaction instructions. The runner passes the identical prompt, user instructions and tool definitions to memory. Compactions never execute tools. |
| Dash ruler and revised tasks | Compaction tasks use a 512-dash ruler, IDs and `<input>` delimiters, with explicit oversize feedback and up to five attempts retaining the shortest response. |
| Eight concurrent calls and ready queues | Leaves start with fewer than eight earlier unbuilt leaves; ready merges require both children. No historical tree scan occurs in an idle pump. |
| Retry failures at the next message | Failed jobs leave the active slots and wait for new input; a fresh turn retries before waiting for memory. A failed settle reports an error and retains the user input. |
| Four-line cache blocks | Turn and compaction views use stable content blocks of four summary lines. Growing the view preserves completed blocks. |
| Keep long non-tool text | Text is split on UTF-8 boundaries into consecutive records, without loss. Legacy long records and long tool results are retrievable with zero-based `zoom` pages sized to fit the tool-output cap. |
| Updated prompt behavior | Memory must be retrieved through zoom before using other sources. Compaction instructions treat messages as data and protect the user's decisions, exact identifiers and progress status. |
| Preserve log and turn invariants | Existing append-only logs, fsync, lock, one-time node construction, fresh turns, head/tail tool clipping and exclusion of reasoning remain. `work` is accepted as a distinct message kind. |

## Deliberate project adaptations

- **Provider and effort:** Victral retains its selectable Meta models and medium
  compactor effort. The gist uses Claude Haiku at xhigh. The user can continue
  choosing the agent and compactor independently; this alignment does not add
  an Anthropic adapter or change model defaults.
- **Caching:** [Meta's caching documentation](https://dev.meta.ai/docs/prompt-caching)
  describes automatic prefix caching. Its [Messages API](https://dev.meta.ai/docs/protocols/messages)
  reports cache-read usage. The Anthropic-specific explicit marks, write-start
  waiting and five-minute / subscription TTL rules are not implemented or
  claimed for Meta. No keep-alive requests or extended-retention purchases are
  introduced, and live cache rates remain an external verification step.
- **Existing logs:** Assistant replies keep the existing `talk` kind rather than
  renaming persisted history to `unii` or `victral`. Prompts describe `talk`
  consistently. Existing nodes are immutable and are not regenerated with the
  revised prompt.
- **Migration:** Older installations never saved a view, so their exact live
  ranges cannot be recovered. The first launch initializes and saves one from
  existing history, causing a one-time prefix change. Later launches load the
  saved view. The main and compaction batch-state files supplement the gist's
  range file so unfinished batches and compaction caching survive restart.
- **Optional integrations:** Subagents, `zoom("Name")`, images and device tools
  remain unimplemented. The project retains its file/Git/command tools, plans,
  UI and evaluation features. The prompt omits device-specific claims and uses
  Victral's existing tool names.

View thresholds are targets while parents are unfinished. A compaction includes
only complete built lines; it never substitutes the beginning of raw text or a
placeholder for missing context. The saved compaction view may open its boundary
node to stop exactly at an earlier task's end.

## Validation scope

The offline suite covers corrected merge order against the independent rollback
algorithm, sawtooth growth, exact saved ranges, suffix recovery, stalled batches,
corrupt-state rejection, shared prompt/tools, compaction context boundaries,
concurrent leaves, next-message retries, UTF-8 splitting, paged retrieval and
backup inclusion. Full type checking, tests, production build and CPU benchmark
are the local acceptance checks. These checks establish harness behavior; live
provider caching and semantic summary quality require API-backed evaluation.
