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
