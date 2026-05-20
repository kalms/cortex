# Viewer Eyeball Check — anthill-cloud (cross-project verification)

Generated: 2026-05-18

Cross-project test of the frame extraction + viewer pipeline. After
PRs #11–#14 wired everything against cortex's own data, this run
indexes a second repo (`../anthill-cloud`, a pnpm/turbo TypeScript
monorepo) and verifies the full pipeline + project switcher.

Source data:
- Indexed: `/Users/rka/Development/anthill-cloud` → 5,010 nodes, 5,746 edges
- Clustered: TF-IDF + HDBSCAN + co-change, γ=0.3 → 9 clusters, 116 noise (out of 231 files)
- Frames injected: 115 files across 9 frames
- Viewer screenshots: [.playwright-mcp/anthill-overview.png](../../../../.playwright-mcp/anthill-overview.png), [.playwright-mcp/cortex-reloaded.png](../../../../.playwright-mcp/cortex-reloaded.png), [.playwright-mcp/anthill-roundtrip.png](../../../../.playwright-mcp/anthill-roundtrip.png)

## What worked

- **End-to-end pipeline transfers cleanly.** The cortex-indexer (run with `CORTEX_DB=…`), clustering script (with `.cortex/db` symlinked as `graph.db`), inject-frames script (with `--db` flag), and viewer all worked against the new repo without code changes. Only operational gymnastics, not engineering blockers.
- **Project switcher** works in both directions. Selecting `Users-rka-Development-anthill-cloud` triggers a full re-fetch of `/api/graph?project=`, `/api/decisions?project=`, `/api/aggregates?project=`, `/api/file-edges?project=` — frames, aggregates, and edges all swap to the new project in ~1s with no console errors.
- **9 cortex-meaningful frames** on anthill-cloud (vs cortex's 7 after re-cluster): `server utils` (25), `packages dsl` (23), `id` (14), `use store` (13), `refresh` (11), `public` (10), `documents` (7), `__dirname` (6), `arcane chat` (6). The labels mostly map to recognisable parts of the codebase.
- **3 aggregates** correctly identify auxiliary content: `momentum-728x90` (4 — looks like an ad banner asset folder), `css` (3), `studio-assets` (1).
- **Real CALLS edges** show inter-frame connectivity: `server utils` ↔ `arcane chat`, `id` ↔ `arcane chat`, `packages dsl` ↔ `__dirname`. Many fewer edges than on cortex (5,746 raw vs cortex's 46k → after CALLS-only + weight≥2 filter, only a handful land between frame-clustered files), so the canvas reads sparse — honest for a 5k-edge repo.

## Operational pain (real architecture findings)

The current single-DB-per-project architecture made cross-project demo painful:

1. **The cortex-indexer overwrites all nodes/edges on each run** — not just the project being indexed. Indexing anthill into cortex's DB wiped cortex's nodes; re-indexing cortex wiped anthill's. This forced a workaround: index each repo into its own `.cortex/db`, then `ATTACH` + `INSERT` to merge into a shared DB with **manually re-keyed node IDs** (collision: both DBs assign sequential `ctx-N` IDs from 1).
2. **Re-indexing wipes injected frame_id values** — after the merge dance, both projects need re-clustered and re-injected to render in the viewer.
3. **The clustering script hard-codes `<repo>/.cortex/graph.db`** — anthill's actual DB file is at `.cortex/db` (no `.db` extension is the new convention per `resolveCortexDbPath`). Symlink workaround.

None of these are blockers for individual-repo usage, but they make multi-project demo brittle. Two follow-ups worth doing (separate from any frame-extraction work):

- **Indexer: project-scoped writes.** The dump pass should `DELETE FROM nodes WHERE project=?` then `INSERT` only that project's data, instead of full-table replace. With that, two repos coexist in one DB by just running the indexer twice with `CORTEX_DB=<shared>` set.
- **Indexer: project-namespaced node IDs.** Generate IDs like `<project>:ctx-N` so multi-project merging is mechanical, not a manual re-key.
- **Clustering script: honour the actual DB path.** Either look for `db` then `graph.db`, or use `resolveCortexDbPath` directly.

## Decision

**Verified: the pipeline works on a second repo.** Multi-project switching in the viewer works, given the merged-DB setup. The operational pain isn't a viewer bug — it's an indexer / tooling concern that's worth filing as separate work but doesn't gate the current frame-extraction story.

## Steps to reproduce

```bash
# Index both repos into their own DBs
CORTEX_DB=/Users/rka/Development/cortex/.cortex/graph.db \
  bin/cortex-indexer cli index_repository '{"repo_path":"/Users/rka/Development/cortex"}'
CORTEX_DB=/Users/rka/Development/anthill-cloud/.cortex/db \
  bin/cortex-indexer cli index_repository '{"repo_path":"/Users/rka/Development/anthill-cloud"}'

# Merge anthill into cortex's DB (re-keying IDs)
sqlite3 /Users/rka/Development/cortex/.cortex/graph.db <<EOF
ATTACH '/Users/rka/Development/anthill-cloud/.cortex/db' AS anthill;
INSERT INTO ctx_projects SELECT * FROM anthill.ctx_projects;
INSERT INTO nodes
  SELECT 'anth-' || substr(id, 5), kind, name, qualified_name, file_path, data, tier,
         created_at, updated_at, start_line, end_line, project
  FROM anthill.nodes;
INSERT INTO edges
  SELECT 'anth-' || substr(id, 5),
         'anth-' || substr(source_id, 5),
         'anth-' || substr(target_id, 5),
         relation, data, created_at, project
  FROM anthill.edges;
DETACH anthill;
EOF

# Cluster + inject both (anthill needs the symlink workaround)
ln -sf db /Users/rka/Development/anthill-cloud/.cortex/graph.db

for repo in /Users/rka/Development/cortex /Users/rka/Development/anthill-cloud; do
  name=$(basename $repo)
  slug="Users-rka-Development-$name"
  npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts "$repo" --gamma 0.3
  npx tsx scripts/frame-extraction/inject-frames.ts \
    --cluster ".tmp/frame-extraction/clusters/$slug.json" \
    --project "$slug" \
    --db /Users/rka/Development/cortex/.cortex/graph.db
done

# Start viewer; switch between projects via toolbar dropdown
CORTEX_DB_PATH=/Users/rka/Development/cortex/.cortex/graph.db npm run dev
```
