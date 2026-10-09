# Victral setup

Follow the current [upstream specification](OPTCHAT_SPEC.md), pinned to gist
revision `3c190e06f34aba0c69f49042c526093269604935` from October 8, 2026.
The [alignment report](UPSTREAM_ALIGNMENT.md) records adaptations and verification.
The previous recipe is archived in [OPTCHAT_SPEC_ORIGINAL.md](OPTCHAT_SPEC_ORIGINAL.md).

Victral runs on Bun with a TypeScript CLI, tool layer and Beast/Octane terminal
workspace. Meta `muse-spark-1.3-contributor` remains the default agent and compactor;
`muse-spark-1.3` is also available. See [README](../README.md) for credentials,
commands, instructions and model selection. Jev evaluations and metrics remain
separate from the conversation memory.

## Memory implementation

1. Daily `main` and `tree` JSONL logs keep permanent IDs and UTF-8 sizes.
   Writes flush before returning; a lifetime lock permits one writer.
   Thoughts never enter the log. Tool results retain a capped head and tail;
   other long text is split losslessly into consecutive messages.
2. Each tree node is written once. A source fitting 512 bytes is copied exactly;
   longer sources use the compactor. Sibling nodes cover aligned binary ranges.
3. The main view appends until it exceeds 128,000 rendered UTF-8 bytes, then
   batches toward 64,000 bytes using the age of each sibling pair's last message.
   Only built parents can merge. An unfinished batch stays active until it
   reaches the low threshold.
4. `view.json` stores `[level, index]` pairs. Load them directly at restart and
   recover only an unsaved suffix. `view-batch.json` preserves pending batch
   intent, and `compaction-view.json` saves the smaller context view.
   These files use atomic replacement plus fsync and are included in `/backup`.
5. Turns and compactions share one system prompt, user instructions and tool
   definitions. Compactions use a 16,000–32,000-byte sawtooth view containing
   only built summaries, ending before a leaf or at a merge's last message.
6. Ready queues allow up to eight calls. Leaves can start when fewer than eight
   earlier leaves are unbuilt; merges start when both children are built.
   Context stops at the first unbuilt message. Failures retry on another message.
7. Compactions use a 512-dash ruler, `<input>` tags and byte feedback, retaining
   the shortest of at most five attempts. Tools are supplied but never executed.
8. Every turn starts fresh, renders memory before logging new input, and waits
   for prior summaries. Input received during work enters at a tool boundary.
   `zoom` retrieves source ranges and paged originals; `date` retrieves timestamps.

## Constants

| Setting | Value |
| --- | --- |
| Summary target | 512 UTF-8 bytes |
| Main view low / high | 64,000 / 128,000 rendered UTF-8 bytes |
| Compaction view low / high | 16,000 / 32,000 rendered UTF-8 bytes |
| Concurrent compactions | 8 |
| Oversize attempts | 5 |
| Tool result cap | 30,000 Unicode characters, including the omission marker |
| Non-tool log chunk | 30,000 UTF-8 bytes |
| View content block | 4 summary lines |

View thresholds are batching targets: a backlog without built parents can
temporarily exceed them. Summary output slightly above the target is retained
after five attempts and counted at its actual rendered size.

Meta manages prefix caching automatically. Anthropic cache marks, cache-write
coordination and TTLs from the gist are provider-specific; they are not claimed
for this adapter. Keep prompts and tools stable, and use returned usage to
measure caching. The retained Meta compactor uses medium effort.

## Verification

Run `bun run check`, `bun run build`, and `bun run benchmark`. The offline suite
checks the rollback merge order through t=20,000, batching, saved-view recovery,
stalled batches, bounded compaction context, shared prompt/tool identity,
concurrency, retries, paged retrieval, backups and existing CLI/tool behavior.
`bun run smoke` makes real provider requests with synthetic data when requested;
offline checks do not establish live cache hit rates or summary quality.
