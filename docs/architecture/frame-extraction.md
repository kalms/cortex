# Frame Extraction Architecture

> Audience: anyone touching `scripts/frame-extraction/`,
> `scripts/frame-extraction/python/`, or
> `src/frame-extraction/auxiliary-detection.ts`. For the design
> rationale and algorithm rationale, the canonical references are
> [`docs/specs/cortex-v0.3/frame-extraction.md`](../specs/cortex-v0.3/frame-extraction.md)
> and [`docs/specs/cortex-v0.3/frame-ranking.md`](../specs/cortex-v0.3/frame-ranking.md).

## What is a frame?

A **frame** is a cluster of files that belong together by topic and
co-change behaviour. The frames viewer at `/viewer` renders one box
per frame, with file nodes inside; governance pills (decisions),
edges (CALLS), and auxiliary aggregates render relative to frames.

Frames live as three keys on `nodes.data`:

```
data.frame_id          integer cluster id (never -1; noise files are unset)
data.frame_label       string — top non-generic token from the cluster
data.frame_confidence  float in [0, 1] — 1.0 for clustered, null for noise
```

There is **no schema migration**. Frames ride on the existing JSON
`data` column, so the indexer can keep replacing the `nodes` table
without knowing about them. (Re-running the indexer wipes injected
frame_ids; recluster + inject is fast enough that this isn't a real
cost — see [`known-limitations.md`](known-limitations.md).)

## Pipeline shape

The pipeline is a chain of pure scripts that read and write JSON/JSONL
files on disk. Each stage is independently runnable so you can debug
or replace one without recomputing the rest.

```
                ┌──────────────────────────────────────┐
                │  .cortex/db  (indexed by cortex-indexer)
                └──────────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
       co-change.ts        text-blob.ts        eval-edges.ts
       (git log →           (graph DB →         (graph DB →
       JSONL of            JSONL of              CALLS edges)
       file pairs)         per-file blobs)
              │                   │                   │
              │                   ▼                   │
              │            tfidf_hdbscan.py            │
              │            (TF-IDF + HDBSCAN;          │
              │             combined topical +         │
              │             co-change distance)        │
              │                   │                    │
              │                   ▼                    │
              │           ClusterResult JSON           │
              │           (assignments + parameters    │
              │            + silhouette + top tokens)  │
              │                   │                    │
              └───────────┐       │       ┌────────────┘
                          ▼       ▼       ▼
                          eval-metrics.ts
                          eval-report.ts
                          (markdown report)
                                  │
                                  ▼
                          inject-frames.ts
                          (write frame_id /
                           frame_label into
                           nodes.data)
                                  │
                                  ▼
                          /viewer renders frames
```

### Stages

| Stage | Owns | Pure? |
|---|---|---|
| `clone.ts` / `indexer.ts` | Clone + index a corpus repo via `bin/cortex-indexer cli` | side-effectful (FS, subprocess) |
| `path-tokenize.ts` | Framework-aware path/symbol tokeniser. Strips universal/frontend/backend/test segments + role suffixes. | yes |
| `text-blob.ts` | Build per-file blob string (path tokens + symbol identifiers from the graph) | yes |
| `co-change.ts` | Read `git log --name-only --since=180.days.ago --no-renames -M`, drop ≥50-file commits, accumulate file-pair counts → JSONL | side-effectful (git) |
| `tfidf_hdbscan.py` | TF-IDF over blobs → cosine distance → optional convex combination with co-change distance → HDBSCAN | side-effectful (subprocess) |
| `cluster-tfidf-hdbscan.ts` | TS orchestrator: emit blob JSONL, spawn Python, parse output → `ClusterResult` | side-effectful |
| `eval-edges.ts` | Read CALLS edges from the graph DB, return file-path-keyed `ImportEdge[]` | yes (over a DB handle) |
| `eval-metrics.ts` | `coChangeAgreement`, `importAgreement`, `clusterCount`, `noiseRate` (strict + lenient) | yes |
| `eval-report.ts` | Markdown reporter consuming an `EvalReport` | yes |
| `eval.ts` | CLI orchestrator: read cluster JSON + co-change JSONL + graph DB → metrics → report | side-effectful |
| `inject-frames.ts` | Write `frame_id`/`frame_label`/`frame_confidence` into `nodes.data` for clustered files; clear for noise | side-effectful |
| `merge-indexed-db.ts` | Re-key `ctx-N` IDs with a caller-supplied prefix and copy nodes/edges across DBs (multi-project workaround — see [`known-limitations.md`](known-limitations.md)) | side-effectful |
| `auxiliary-detection.ts` (in `src/`) | `groupAuxiliaryPaths` — bucket file nodes by path segment (`locales`, `vendored`, `__snapshots__`, …) for the viewer's aggregate strip | yes |

## Languages

| Concern | Language | Why |
|---|---|---|
| Orchestration (cloning, IO, subprocess wiring) | TypeScript | matches the rest of the repo; reuses `better-sqlite3` for graph reads |
| ML (TF-IDF, HDBSCAN, silhouette) | Python | mature ecosystem; sklearn + hdbscan are best-in-class |

The Python venv lives at `scripts/frame-extraction/python/.venv/`
(gitignored). `npm run setup-python` (calls `setup-venv.sh`)
bootstraps it idempotently from `requirements.txt`. The TS
orchestrator's integration test in
`tests/frame-extraction/cluster-tfidf-hdbscan.test.ts` is skipped
when the venv is absent — keeps `npm test` runnable on machines
without Python configured.

## Data on disk

| Artifact | Location | Lifetime |
|---|---|---|
| Cloned corpus repos | `.tmp/frame-extraction/corpus/<slug>/` | gitignored; cleared with `rm -rf .tmp` |
| Phase 1 survey JSONL | `.tmp/frame-extraction/results.jsonl` | gitignored |
| Co-change JSONL | `.tmp/frame-extraction/co-change/<repo-slug>.jsonl` | gitignored |
| File-blob JSONL | `.tmp/frame-extraction/blobs/<repo-slug>.jsonl` | gitignored |
| Cluster output | `.tmp/frame-extraction/clusters/<repo-slug>.json` | gitignored |
| Phase 1 results markdown | `docs/specs/cortex-v0.3/phase-1-results.md` | committed |
| Phase 2 eval markdown | `docs/specs/cortex-v0.3/phase-2-eval/<repo-slug>.md` | committed |
| Eyeball notes | `docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-<scenario>.md` | committed (one per iteration: aux-exclude, real-edges, aggregates, label-quality, …) |

JSONL-on-disk over stdin/stdout is deliberate: every stage is debuggable
in isolation (re-run with different parameters without reindexing) and
caching is just "is the file there?".

## Combined topical + co-change distance

Per [`frame-extraction.md` §Co-change as semantic signal](../specs/cortex-v0.3/frame-extraction.md):

```
combined_distance = (1 − γ) · topical_distance + γ · co_change_distance
```

- `topical_distance` = cosine distance over TF-IDF vectors.
- `co_change_distance` = `1 − log(1 + count_ab) / log(1 + max_count)`
  for pairs in the co-change JSONL; defaults to `1.0` for unobserved
  pairs ("no evidence these belong together").
- `γ ∈ [0, 1]` controls the mix. `γ = 0` reproduces the topical-only
  baseline (cold-start case — no co-change file). On cortex itself,
  `γ = 0.3` was the eyeball winner per
  [`docs/superpowers/2026-05-17-frame-extraction-co-change-combination.md`](../superpowers/2026-05-17-frame-extraction-co-change-combination.md).

The combined matrix is fed to HDBSCAN with `metric='precomputed'`.

## Multi-project workflow

The C indexer has two open issues (full-table replace on every index
run, sequential `ctx-N` IDs colliding across DBs) that make naive
multi-project clustering lose data. The canonical workaround is in
[`known-limitations.md`](known-limitations.md). Briefly:

```bash
# Index each repo into its own DB
bin/cortex-indexer cli index_repository '{"repo_path":"/repo/a"}'
bin/cortex-indexer cli index_repository '{"repo_path":"/repo/b"}'

# Merge into a shared DB (re-keys IDs)
SHARED=.cortex/db
npx tsx scripts/frame-extraction/merge-indexed-db.ts \
  --source /repo/a/.cortex/db --target "$SHARED" --prefix a
npx tsx scripts/frame-extraction/merge-indexed-db.ts \
  --source /repo/b/.cortex/db --target "$SHARED" --prefix b

# Cluster + inject per-project, write into shared DB
for repo in /repo/a /repo/b; do
  slug=$(basename "$repo" | sed 's@/@-@g')
  npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts "$repo" --gamma 0.3
  npx tsx scripts/frame-extraction/inject-frames.ts \
    --cluster ".tmp/frame-extraction/clusters/$slug.json" \
    --project "Users-rka-Development-$slug" \
    --db "$SHARED"
done

CORTEX_DB_PATH="$SHARED" npm run dev
```

The viewer's `/api/graph?project=<name>` toolbar selector lets you
switch between merged projects without restarting.

## Auxiliary content

Files matching path segments like `locales`, `vendored`,
`__snapshots__`, `assets`, `static`, `public`, `vendor`, `generated`,
`dist`, `build`, `node_modules`, `fixtures`, `i18n` are treated as
**auxiliary**:

- They are **bypassed** from clustering (their TF-IDF vectors swamp
  the signal otherwise — observed on cortex with the `vendored/`
  grammars dominating the top tokens).
- They are **surfaced separately** in the viewer via `/api/aggregates`
  and rendered as bare dots in a bottom strip, so the structure is
  still visible without competing for frame attention.

The detection rule lives in
[`src/frame-extraction/auxiliary-detection.ts`](../../src/frame-extraction/auxiliary-detection.ts).
`DEFAULT_AUXILIARY_SEGMENTS` is the canonical list. Path matching is
exact-segment (split on `/`), not substring, so `static` does not
match `staticAnalysis`.

## Status

The pipeline is shipped end-to-end on `cortex` itself. Eyeball
verifications across multiple iterations are checked into
`docs/specs/cortex-v0.3/phase-2-eval/`. Open follow-ups:

- Tune `γ` per-archetype across the 5-repo Phase 2 corpus
  (`scripts/frame-extraction/phase2-corpus.json`).
- Add the spec's full 4-step label cascade (currently we pick the
  first non-generic top token with a small stop list).
- Compare against alternative algorithms (Leiden, pinned-embedding +
  HDBSCAN) — slots described in
  [`docs/specs/cortex-v0.3/frame-extraction.md` §Three pipelines](../specs/cortex-v0.3/frame-extraction.md).
- Re-introduce live mutation handling in the viewer once the static
  load model has settled.
