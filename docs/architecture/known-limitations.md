# Known Limitations

Engineering issues that surfaced during real-world testing and need follow-up work, but aren't blockers for current functionality.

## Cortex-indexer: full-table replace per run

**File:** `internal/indexer/src/pipeline/*` (C source)

**Behaviour:** The C indexer's `gbuf.dump` pass replaces the entire `nodes` and `edges` tables on each run — not scoped to the project being indexed. Indexing project B into a DB that contains project A wipes project A's data.

**Symptom:** Sequential `bin/cortex-indexer cli index_repository ...` calls against different repos into the same `CORTEX_DB` leave only the last-indexed repo in the DB. The MCP `index_repository` tool defaults to per-repo `.cortex/db` files, so this only bites if you manually point at a shared DB.

**Workaround:** Index each repo into its own `.cortex/db`, then merge via [`scripts/frame-extraction/merge-indexed-db.ts`](../../scripts/frame-extraction/merge-indexed-db.ts) (re-keys node IDs with a caller-supplied prefix so they don't collide).

**Real fix:** Change the dump pass to `DELETE FROM nodes WHERE project = ?` then `INSERT` only that project's rows. Same for `edges`. Requires recompiling the C binary.

## Cortex-indexer: sequential `ctx-N` IDs collide across DBs

**File:** `internal/indexer/src/pipeline/*` (ID generator)

**Behaviour:** Node IDs are sequential `ctx-N` starting from `ctx-1` for every DB. Two DBs indexed independently will both contain `ctx-1`, `ctx-2`, etc. — primary-key collisions if you try to merge.

**Symptom:** Naively `ATTACH` + `INSERT INTO nodes SELECT * FROM other.nodes` silently drops all rows when `INSERT OR IGNORE` is used, or errors out when not.

**Workaround:** The `merge-indexed-db.ts` script re-keys IDs with a caller-supplied prefix (`<prefix>-<oldId>`) during the merge.

**Real fix:** Generate IDs as `<project>:ctx-N` natively in the C indexer. Existing DBs would need a one-shot migration to rewrite IDs in-place.

## Multi-project indexing UX

Until both indexer fixes land, here's the canonical multi-project workflow:

```bash
# 1. Index each repo into its own DB (MCP tool default already does this).
bin/cortex-indexer cli index_repository '{"repo_path":"/path/to/repo-a"}'  # → /path/to/repo-a/.cortex/db
bin/cortex-indexer cli index_repository '{"repo_path":"/path/to/repo-b"}'  # → /path/to/repo-b/.cortex/db

# 2. Pick a shared DB. cortex's own .cortex/db works fine.
SHARED=/Users/rka/Development/cortex/.cortex/db

# 3. Merge the others into it.
npx tsx scripts/frame-extraction/merge-indexed-db.ts \
  --source /path/to/repo-a/.cortex/db --target "$SHARED" --prefix a
npx tsx scripts/frame-extraction/merge-indexed-db.ts \
  --source /path/to/repo-b/.cortex/db --target "$SHARED" --prefix b

# 4. Cluster + inject frames for each project (cluster script reads from the
#    repo's own DB, inject writes to the shared one).
for repo in /path/to/repo-a /path/to/repo-b; do
  slug=$(basename "$repo" | sed 's@/@-@g')
  npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts "$repo" --gamma 0.3
  npx tsx scripts/frame-extraction/inject-frames.ts \
    --cluster ".tmp/frame-extraction/clusters/$slug.json" \
    --project "Users-rka-Development-$slug" \
    --db "$SHARED"
done

# 5. Start the viewer pointing at the shared DB.
CORTEX_DB_PATH="$SHARED" npm run dev
```

## Re-indexing wipes injected frame_id

**Symptom:** After re-running the indexer on a project, the `frame_id` and `frame_label` values that `inject-frames.ts` wrote into `nodes.data` are gone (because the dump pass replaced the `nodes` table).

**Workaround:** Re-cluster + re-inject after every re-index. The frame-extraction pipeline is fast enough (~seconds on a typical repo) that this isn't a real cost; just remember to do it.

**Real fix:** Same as the indexer scoping fix — once dump is project-scoped and incremental, frame_id values on other projects' nodes survive.

## Incremental indexing is delete+recreate, not in-place — RESOLVED (2026-06-09)

**Was:** The indexer rebuilt the DB *file* — it `ctx_unlink()`ed `.cortex/db`
(+`-wal`/`-shm`) and re-dumped, so any open SQLite handle pinned to the inode
was orphaned → stale/empty reads (`project-graph-db-stale-reads`), and worse,
the out-of-band `fopen("wb")` truncate under an open WAL handle corrupted the
index b-trees. This was why auto-refresh ran only at SessionStart.

**Resolved by the transactional-swap publish** (see
[graph-storage.md](graph-storage.md#write-path-staging-build--transactional-publish)): the C
indexer now writes a private staging DB (`.cortex/db.stage-<pid>`), and
`publishStagedDb` reloads the live `.cortex/db` via one libsqlite3 WAL
transaction (`ATTACH` + per-table `DELETE`/`INSERT…SELECT`). The canonical file
is never unlinked or truncated out-of-band, so the server's open handle survives
and sees the new snapshot with no reopen — exactly the "UPDATE rows in the
existing DB" real-fix this section called for, achieved at the TS layer with the
C writer unchanged. Mid-session post-commit refresh is now safe.

## FTS5 `ctx_nodes_fts` is repopulated by the swap, not copied

**Behaviour:** `ctx_nodes_fts` is a *contentless* FTS5 table (`content=''`) — its
shadow tables are write-protected and there is no source table to rebuild from,
so it cannot be copied across DBs via SQL. `publishStagedDb` therefore recreates
it from staging's DDL and **repopulates it from the freshly-copied `nodes`**,
keyed by the numeric suffix of the node id to satisfy the C BM25 handler's
`JOIN nodes n ON n.id = 'ctx-' || fts.rowid` (handlers.c). The C-only
`ctx_camel_split` tokenizer is unavailable in TS, so repopulation uses plain
`name` — the same fallback `pipeline.c` itself uses. The product's
`search_graph`/`search_code` query `nodes.name` directly (idx_nodes_name), not
the FTS index, so this path is shadowed today; the repopulation keeps the C BM25
capability functional regardless.

## Swap publish fails-fast on a C-writer column *addition*

**Behaviour:** If a future C-indexer schema upgrade ADDS a column to a table,
the first publish sees a staging table with a column the live table lacks;
`INSERT INTO live.t (cols) SELECT cols FROM stage.t` throws and the transaction
rolls back — **non-corrupting (old state intact), but the index does not
publish** until the live schema is migrated. A future migration step should
`ALTER TABLE … ADD COLUMN` (from staging's schema) before the row copy.

## Swap WAL can stay ~1× DB size under a continuously-busy reader

**Behaviour:** `publishStagedDb` ends with `wal_checkpoint(PASSIVE)`, which does
not block readers; if a reader pins a snapshot at the checkpoint instant, frames
aren't reclaimed and the `-wal` stays ~1× the DB size until a quiescent moment.
Not corrupting; a steady-state disk cost on very busy large repos. Bounded by
autocheckpoint + a future `journal_size_limit`.

## Cross-process index lock busy-waits synchronously

**Behaviour:** `withIndexLock` serializes same-process callers with an async
promise queue, but cross-process contention (a CLI `cortex index` racing an MCP
`index_repository` on the *same* repo) falls to a synchronous `BEGIN EXCLUSIVE`
with a 30 s `busy_timeout` — which blocks the waiter's event loop until the
holder finishes or the timeout throws. Rare (same-repo concurrent index from two
processes) and bounded; a fully-async cross-process wait (poll + `setTimeout`)
would remove the block if it ever matters.
