# Incremental in-place persist (inode-preserving) + post-commit refresh — Design

**Date:** 2026-06-07
**Status:** proposed
**Related:** decision `bbf0fce5` (freshness signal + the delete+recreate limitation it documented), [graph freshness plan](../plans/2026-06-07-graph-freshness-and-auto-refresh.md) (Task 10, previously deferred)

## Problem

The graph freshness signal (shipped) tells an agent *when* `.cortex/db` is stale,
but mid-session it cannot safely *fix* it. Auto-refresh therefore runs only at
SessionStart. The blocker is the incremental indexer's persistence step:

`dump_and_persist` in `internal/indexer/src/pipeline/pipeline_incremental.c:259-299`
**unlinks** `.cortex/db` (+ `-wal`/`-shm`) and then re-dumps a fresh file via the
B-tree writer (`ctx_gbuf_dump_to_sqlite` → `ctx_write_db`), which requires an empty
file. The MCP server holds long-lived pooled handles to `.cortex/db`. When the file
is unlinked out from under those handles, they are pinned to a deleted inode: the
server keeps reading the old (or, mid-write, a 0-byte/garbage) database and never
sees the refresh. This is the exact `graph-db-stale-reads` failure class.

Because of this, the post-commit in-session refresh (Task 10 of the freshness plan)
was deliberately not shipped.

## Goal

Make the incremental persist **inode-preserving**: the live `.cortex/db` file (and
any handle already open on it) survives a refresh, and a committed refresh becomes
visible to those handles on their next read. This unblocks shipping the deferred
**Task 10** post-commit refresh.

Non-goal: making incremental indexing *faster*. This change keeps the existing
"load the whole project graph into memory, merge, write it all" granularity. The
per-file delta optimization is explicitly deferred (see "Deferred: Approach C").

## Chosen approach — A2: B-tree dump to temp + page-level copy into the live inode

Keep the fast B-tree writer, but never unlink the live file. Dump the merged
in-memory graph to a sibling temp database, then copy it page-by-page **into the
already-open live connection** with SQLite's online backup API. The backup writes
pages through the destination connection and does not unlink/recreate the file, so
the live inode is preserved and the server's pooled handle sees the new graph on its
next read transaction (WAL semantics).

### Why A2 over the alternatives

- **A (transactional row re-flush via `ctx_gbuf_flush_to_store`)** — inode-safe, but
  (1) `flush_to_store` writes only nodes+edges, not vectors (vectors are written
  *only* by the B-tree writer at the raw-record level — `extract/sqlite_writer.c`),
  so it would need a hand-written vector-persistence SQL path, and (2) it re-inserts
  the entire project row-by-row, likely slower than today's full dump. A2 avoids both:
  the B-tree writer still writes vectors, and the copy is page-level.
- **B (B-tree dump to temp + `rename()`)** — fast, but `rename()` swaps in a *new*
  inode; the server's already-open fd keeps reading the old one. Does not deliver
  mid-session freshness without also reopening server handles. Rejected: fails the
  core goal.
- **C (true per-file delta)** — a performance optimization, not an unblocker.
  Deferred (see below).

### The persist step (revised `dump_and_persist`)

```
tmp = "<db_path>.tmp"
unlink(tmp, tmp-wal, tmp-shm)               # safe: temp only, never the live file
ctx_gbuf_dump_to_sqlite(gbuf, tmp)          # B-tree writer: nodes + edges + vectors

open tmp_store at tmp:
    persist_hashes(tmp_store, project, files, file_count)   # file hashes for next incremental
    FTS rebuild (existing nodes_fts delete-all + reinsert SQL)

live = ctx_store_open_path(db_path)         # the live inode; created if missing
ctx_store_restore_from(live, tmp_store)     # sqlite3_backup page copy tmp -> live (inode preserved)
ctx_store_checkpoint(live)                  # WAL TRUNCATE — folds frames into the main file

close live; close tmp
unlink(tmp, tmp-wal, tmp-shm)               # best-effort cleanup
```

All hash-persist and FTS-rebuild work happens against the **temp** database before
the copy, so the single page copy carries a complete, ready database (nodes, edges,
vectors, FTS shadow tables, file hashes) into the live inode.

### Reused primitives (already implemented and tested)

- `ctx_store_restore_from(dst, src)` — `store.c:2038`; page-level `sqlite3_backup`
  copy of all pages from `src` into `dst`. Tested: `tests/test_store_nodes.c:811`
  (`store_restore_from`).
- `ctx_store_checkpoint(s)` — `store.c:825`; `sqlite3_wal_checkpoint_v2(..., TRUNCATE)`.
  Directly addresses the historical 0-byte-`.cortex/db` drift (WAL not checkpointed).
- `ctx_gbuf_dump_to_sqlite` / `ctx_write_db` — the existing B-tree writer, unchanged;
  continues to write vectors and token-vectors.

The only new code in the indexer is the rewrite of `dump_and_persist` to orchestrate
the above; no new low-level store primitive is required.

## Error handling / failure mode

If the temp dump or `ctx_store_restore_from` fails, the **live database is left
untouched** (old-but-consistent), the pipeline sets the `dump` error phase and
propagates `INCR_RAN_FAILED`. This is strictly safer than the current behavior:
there is no window in which the live file is missing or half-written. The freshness
signal then reports `stale`, and the next full index repairs the graph. Temp
artifacts (`<db>.tmp`, `-wal`, `-shm`) are cleaned up best-effort on both the success
and error paths.

## Task 10 — post-commit incremental refresh (now safe to ship)

With incremental persist inode-safe, the deferred post-commit refresh is safe to run
mid-session against the live server:

- **New** `hooks/post-commit-refresh.sh`: gated by `CORTEX_AUTO_REFRESH` (default on),
  runs `cortex index` best-effort and silently. `cortex index` already auto-routes to
  the incremental path when a valid DB + stored file hashes exist (established by the
  shipped SessionStart auto-refresh).
- **Modify** `hooks/hooks.json`: add a *second* hook object to the existing
  `PostToolUse → Bash` matcher with `"if": "Bash(git commit*)"`, as a sibling to the
  existing `suggest-capture.sh` hook.

The plan's `cortex index changes-refresh` CLI verb is **not** introduced — the shipped
auto-refresh already uses plain `cortex index` as the auto-routing entry point.

### Secondary win

In-place persist also dissolves the SessionStart hook-vs-server bind race noted as a
follow-up in decision `bbf0fce5`: there is no longer any window where `.cortex/db`
does not exist, so the order in which the SessionStart reindex and the server's handle
bind no longer matters.

## Testing

- **C unit test** (extends the store/pipeline test suite): record `stat().st_ino` of
  `.cortex/db`, run an incremental persist, then assert:
  - the inode is **unchanged**;
  - node / edge / vector counts are correct after the refresh;
  - an FTS query returns the expected rows;
  - a database handle opened **before** the refresh and held across it observes the new
    data on a fresh read transaction (the live-server simulation).
- **Regression guard:** an incremental index followed by a query returns the updated
  symbols (never stale/empty), guarding the persisted-read path.
- **Build/health:** full TS suite stays green; the indexer binary is rebuilt via
  `scripts/build-indexer.sh`.
- **Manual:** edit a file, `git commit`, and confirm `cortex freshness` reports `fresh`
  with the MCP server still running (exercises Task 10 end-to-end).

## Deferred: Approach C (true per-file delta) — documented future value

Approach C would touch only changed-file rows on persist, and — to actually pay off —
would also make the *load* and *resolve* phases incremental (resolving cross-boundary
edges by querying the DB instead of loading the entire project graph into memory).

- **Value:** end-to-end incremental indexing speed on very large graphs. The current
  pipeline (and A2) pays an O(graph) cost every incremental in `ctx_gbuf_load_from_db`
  + edge resolution regardless of how small the change set is; C is the only approach
  that removes that floor.
- **Why deferred:** it is an optimization, not a prerequisite — A2 already delivers
  inode-safety and live freshness, which is all Task 10 needs. C carries real
  correctness risk: an edge can change without its file changing (a new symbol in a
  changed file resolves a previously-dangling reference in an unchanged file), so a
  correct delta requires dirty-edge tracking through merge/resolve and careful
  cross-file edge reconciliation. This warrants its own brainstorm → spec → plan cycle.

## Files touched

- `internal/indexer/src/pipeline/pipeline_incremental.c` — rewrite `dump_and_persist`
  to the temp-dump + `restore_from` + checkpoint flow; remove the `ctx_unlink` of the
  live DB.
- `hooks/post-commit-refresh.sh` — new.
- `hooks/hooks.json` — add the sibling post-commit hook.
- `internal/indexer/tests/` — inode-preservation + cross-handle-visibility test.
