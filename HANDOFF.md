# Cortex — Session Handoff

## ✅ DONE (2026-06-10 — graph DB transactional-swap publish, read this first; SUPERSEDES the in-place section below)

Fixed a **graph-DB index-corruption** bug (contracts failing every reindex with
`database disk image is malformed`; stale/partial frames) and the **viewer
stale-map** read bug, and merged to `main` (`--no-ff`, merge `501ce72`).

- **Root cause:** the C indexer wrote `.cortex/db` via `fopen(path,"wb")` — an
  out-of-band truncate-rewrite — while the long-lived MCP server held the file
  open in WAL mode. That bypassed SQLite's coherence protocol, so the next
  libsqlite3 write desynced the index b-trees. The 2026-06-07 in-place approach
  below (`04c848f0`, page-copy into the **live inode** via the SQLite backup API)
  was the *same class* of out-of-band write into the open live file — it is
  **superseded**, not extended.
- **Fix (transactional staging-swap):** indexing now builds into a **private
  staging DB** (`.cortex/db.stage-<pid>`) — the C indexer, cache import, and
  frame/contract passes all target it — then `publishStagedDb`
  ([src/db/swap-graph-db.ts](src/db/swap-graph-db.ts)) reloads the canonical
  `.cortex/db` via **one libsqlite3 WAL transaction** (`ATTACH` + per-table
  `DELETE`/`INSERT…SELECT`). Every byte reaching the live file goes through
  libsqlite3, so corruption is impossible, the cutover is crash-atomic, and the
  server's open handle sees the new snapshot with **no reopen**. Serialized
  per-repo by `withIndexLock` ([src/db/index-lock.ts](src/db/index-lock.ts)).
  **The C writer (`sqlite_writer.c`) is unchanged.**
- **Also:** `resolveGraphDbForRead` now prefers an openable `.cortex/db` over a
  stale legacy `graph.db` (`f1950d3`); `busy_timeout=5000` on all graph-DB
  handles; contentless FTS5 `ctx_nodes_fts` recreated + repopulated from `nodes`.
- **Verified:** TS suite green (967); end-to-end `cortex index` with the server
  holding the DB open → `integrity_check ok`, contracts `0 mismatches`, frames
  restored, no staging leftovers. Single-write-path invariant reviewed
  end-to-end (TS → C subprocess → staging → publish).
- **Spec:** [docs/.../2026-06-09-graphdb-transactional-swap-design.md](docs/superpowers/specs/2026-06-09-graphdb-transactional-swap-design.md) ·
  **Plan:** [docs/.../2026-06-09-graphdb-transactional-swap.md](docs/superpowers/plans/2026-06-09-graphdb-transactional-swap.md) ·
  **Decision:** `D-47xb`.

## ▶ NEXT STEP

1. **Restart Claude Code / the MCP server.** The live server still runs the
   pre-merge code (issue #2, dev-reload). The **CLI path is fixed + verified**,
   but the MCP `index_repository` tool keeps using the old in-place-truncate code
   (which can still corrupt `.cortex/db`) **until restart** — avoid MCP-triggered
   reindex until then. `main` is **not pushed** (40 commits ahead of origin).
2. **#2 dev-reload (optional follow-up):** run the post-index frame/contract
   passes in a fresh subprocess so a stale long-lived server can't reindex with
   stale in-memory code. Lower priority now that the swap makes any reindex
   corruption-safe; restart-before-reindex is the interim discipline.
3. **The viewer / Mesh.** The substrate is now corruption-safe and the
   `/api/*` HTTP boundary is the intended embedding seam (webview+HTTP). See
   [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md). Note the
   deferred **#1 part-B** (viewer default-path reopen-on-change) folds into this
   rework — though with the swap, an open handle already sees the refresh.

---

## ⚑ PRIOR (2026-06-07 — in-place incremental persist + post-commit refresh) — SUPERSEDED by the 2026-06-10 section above

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

### (prior next-step note — the viewer; now folded into the 2026-06-10 NEXT STEP above)

The internal API / tooling + reliability groundwork is now sealed off (contract
edges, freshness signal, transactional-swap publish). The next frontier
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
