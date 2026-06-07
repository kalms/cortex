# Cortex — Session Handoff (2026-06-07, in-place incremental persist + post-commit refresh)

## ✅ DONE (2026-06-07 — in-place incremental persist + Task 10, read this first)

Made incremental indexing **inode-preserving** and shipped the deferred
post-commit refresh (decision `04c848f0`;
[spec](docs/superpowers/specs/2026-06-07-incremental-in-place-persist-design.md),
[plan](docs/superpowers/plans/2026-06-07-incremental-in-place-persist.md)). This is
the durable fix that lets the graph self-heal **mid-session**, not just at SessionStart.

- **What changed (Approach A2):** `dump_and_persist`
  ([pipeline_incremental.c](internal/indexer/src/pipeline/pipeline_incremental.c))
  no longer `unlink`s `.cortex/db`. It B-tree-dumps the merged graph to a temp
  sibling DB (nodes+edges+vectors), backfills hashes + FTS on the temp, then
  page-copies it into the **live inode** via `ctx_store_restore_from` (SQLite online
  backup) + `ctx_store_checkpoint`. The live file/handle survives, so the MCP
  server sees the refresh on its next read. `snprintf` truncation is guarded and a
  retry/backoff loop layers on the live connection's `busy_timeout`; on any failure
  the live DB is left untouched.
- **Task 10 shipped:** `hooks/post-commit-refresh.sh` (gated by `CORTEX_AUTO_REFRESH`)
  runs `cortex index` after every `git commit`, registered as a sibling on the
  existing `PostToolUse → Bash` `git commit*` matcher in
  [hooks/hooks.json](hooks/hooks.json).
- **Verified:** new TDD test `incr_inplace_preserves_inode` (inode unchanged + a
  handle opened *before* the refresh sees the new data) passes; full C suite shows
  **no new failures** vs baseline. End-to-end with the rebuilt binary: an incremental
  index keeps `.cortex/db` at the **same inode** and `cortex freshness` = `fresh`.
  The SessionStart hook-vs-server bind race (prior "secondary follow-up") is
  dissolved — the live file is never unlinked.
- **Deferred (documented):** Approach C (true per-file delta) remains a future
  *optimization* — not an unblocker — needing incremental load+resolve and its own
  cycle. See the spec's "Deferred: Approach C" section.

## ▶ NEXT STEP — the viewer

The internal API / tooling + reliability groundwork is now sealed off (contract
edges, freshness signal, in-place persist + post-commit refresh). The next frontier
is the **viewer**. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md).

---

## ⚑ PRIOR (2026-06-07 — graph freshness signal + auto-refresh)

Shipped Phase 1 (the trust signal) + Task 9 of Phase 2 (SessionStart
auto-refresh) of the freshness plan
([plan](docs/superpowers/plans/2026-06-07-graph-freshness-and-auto-refresh.md),
[spec](docs/superpowers/specs/2026-06-07-graph-freshness-and-auto-refresh-design.md);
decision `bbf0fce5`). This is the durable fix for the "stale/empty DB read
silently" watch-for that bit the previous session.

- **What it does:** both index paths write a baseline (`indexed_commit`,
  `indexed_dirty_sig`, `indexed_at`) into a `cortex_index_meta` table
  (`src/graph/index-meta.ts`, captured by `src/graph/capture-index-meta.ts`).
  A pure classifier + 2s-memoized per-repo resolver (`src/mcp-server/freshness.ts`)
  computes a verdict; `registerTool` attaches it to the 7 read tools at the
  single chokepoint (`freshnessAware: true`). Fresh → result unchanged; stale/
  empty/unknown → a `⚠ cortex freshness: …` note is appended + a structured
  `freshness` field added. `RepoContext.canonical` (new field) drives the
  `empty` (degraded fallback DB) verdict.
- **CLI + banner:** `cortex freshness` prints the cwd repo's verdict;
  `hooks/check-index.sh` folds it into the SessionStart banner and now uses
  `-s` (non-empty) so a **0-byte `.cortex/db` reads as not-indexed** (the exact
  drift from last session).
- **Auto-refresh (SessionStart only):** when `CORTEX_AUTO_REFRESH != 0`, the
  hook runs `cortex index` (auto-routes full for empty/unknown, incremental for
  stale) before the agent reads. Gates: `CORTEX_FRESHNESS=0`, `CORTEX_AUTO_REFRESH=0`.
- **Task 10 (post-commit in-session refresh) deliberately NOT shipped.** The
  Phase-2 prerequisite investigation found the indexer's incremental path is
  **delete+recreate, not in-place** (`pipeline_incremental.c:265 ctx_unlink`,
  `pipeline.c:691`): it loads the graph into memory, merges, then unlinks
  `.cortex/db` and re-dumps. Refreshing mid-session under the MCP server's open
  pooled handle would reproduce the stale-reads bug. SessionStart (separate
  process, before reads) is the safe boundary. Full rationale + alternatives in
  decision `bbf0fce5`.
- **Status:** `tsc` clean; **802/802 TS tests** green; RPC-seam regression guard
  green. Cortex's own index reindexed → `cortex freshness` = `fresh`.
- **Follow-up (now DONE):** the "make incremental truly in-place" + Task 10 work
  this section flagged shipped in the same day — see the ✅ DONE section at the top.
