# Frame Extraction Architecture

> Audience: anyone touching `scripts/frame-extraction/`,
> `scripts/frame-extraction/python/`, or
> `src/frame-extraction/auxiliary-detection.ts`. For the design
> rationale and algorithm rationale, the canonical references are
> [`frame-extraction-design.md`](frame-extraction-design.md)
> and [`frame-ranking-design.md`](frame-ranking-design.md).

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

The Python venv lives at `~/.cache/cortex-indexer/python-venv/`
(override with `CORTEX_VENV`). It is created by `cortex install`, by
`cortex setup frames`, or — since 2.0.3 — **on demand by the first index
that needs it** (`ensureVenv`), all of which call
`scripts/frame-extraction/python/setup-venv.sh` and bootstrap it
idempotently from `requirements.txt`. On-demand creation is what makes a
*bundled* sidecar work: an embedding host unpacks the tarball and never
runs `cortex install`, so before this the venv was never created and
every index returned `{skipped, venv_missing}` forever — invisibly, to a
host whose only surface is a viewer. It is guarded, since it spends
minutes and a network: `CORTEX_FRAMES_SETUP=0` opts out, a failure is
marked and not retried for 24h, and a lock file keeps two concurrent
indexes from pip-installing into one venv. `CORTEX_PYTHON` pins the
interpreter; otherwise it is resolved from `PATH` and then from the usual
absolute locations, because a sidecar spawned by a GUI app inherits that
app's environment rather than a login shell's. Moving it out of the repo (it
historically lived at `scripts/frame-extraction/python/.venv/`) lets
frame extraction work when Cortex is installed as a plugin, where the
repo tree may be read-only. The TS orchestrator's integration test in
`tests/frame-extraction/cluster-tfidf-hdbscan.test.ts` is skipped when
the venv is absent — keeps `npm test` runnable on machines without
Python configured.

**Automatic extraction.** As of 2026-05-26, frame extraction runs
automatically after every successful `index_repository` — both the CLI
(`cortex index`) and the MCP tool — via `src/frame-extraction/run-frames.ts`.
It reclusters on every index (frames are a global property: changing a few
files can shift cluster boundaries). The C indexer is untouched; frames are
an additive TypeScript post-step that reads the just-written graph DB and
updates `nodes.data` in place. Gated by `CORTEX_FRAMES` (set `0` to opt
out), then by the presence of file nodes, then by the venv — in that
order, so a repo with nothing to cluster never pays for provisioning one;
never blocks or fails the index. The importable
core (`co-change`, `cluster-tfidf-hdbscan`, `inject-frames`, `text-blob`,
`path-tokenize`, `types`) now lives under `src/frame-extraction/` (promoted
from `scripts/` since it is production code on the index path); the
`scripts/frame-extraction/` directory retains the Python sources and the
remaining CLI/eval tooling. See
[`../superpowers/specs/2026-05-26-frame-extraction-auto-integration-design.md`](../superpowers/specs/2026-05-26-frame-extraction-auto-integration-design.md).

## Data on disk

| Artifact | Location | Lifetime |
|---|---|---|
| Cloned corpus repos | `.tmp/frame-extraction/corpus/<slug>/` | gitignored; cleared with `rm -rf .tmp` |
| Phase 1 survey JSONL | `.tmp/frame-extraction/results.jsonl` | gitignored |
| Co-change JSONL | `.tmp/frame-extraction/co-change/<repo-slug>.jsonl` | gitignored |
| File-blob JSONL | `.tmp/frame-extraction/blobs/<repo-slug>.jsonl` | gitignored |
| Cluster output | `.tmp/frame-extraction/clusters/<repo-slug>.json` | gitignored |
| Phase 1 results markdown | `docs/specs/archive/cortex-v0.3/phase-1-results.md` | committed (archived) |
| Phase 2 eval markdown | `.tmp/frame-extraction/` | working artifact, not retained |
| Eyeball notes | `.tmp/frame-extraction/` | working artifact, not retained (one per iteration: aux-exclude, real-edges, aggregates, label-quality, …) |

JSONL-on-disk over stdin/stdout is deliberate: every stage is debuggable
in isolation (re-run with different parameters without reindexing) and
caching is just "is the file there?".

## Combined topical + co-change distance

Per [`frame-extraction.md` §Co-change as semantic signal](frame-extraction-design.md):

```
combined_distance = (1 − γ) · topical_distance + γ · co_change_distance
```

- `topical_distance` = cosine distance over TF-IDF vectors.
- `co_change_distance` = `1 − log(1 + count_ab) / log(1 + max_count)`
  for pairs in the co-change JSONL; defaults to `1.0` for unobserved
  pairs ("no evidence these belong together").
- `γ ∈ [0, 1]` controls the mix. `γ = 0` reproduces the topical-only
  baseline (cold-start case — no co-change file). On cortex itself,
  `γ = 0.3` was the eyeball winner.

The combined matrix is fed to HDBSCAN with `metric='precomputed'`.

### Class-hierarchy affinity (OO repos)

Files whose classes share an **in-repo (domain) base class** are pulled together
during clustering, via a distance term blended at γ=0.3 (parallel to co-change).
The base list comes from `base_classes` already stored on class nodes;
`hierarchy-affinity.ts` resolves domain vs external bases (external — `nn.Module`,
`TestCase` — are dropped as cross-topic hubs; measured to add no value) and caps
each base's clique at 60 files. Deterministic. Inert on functional codebases
(no class hierarchy). A modest frame-quality lift on OO repos (label-F1 ↑,
clusters-below-floor ↓); not a `cluster:N` fix in itself. Gates:
`CORTEX_FRAME_HIERARCHY=0` disables; `CORTEX_FRAME_HIERARCHY_GAMMA` overrides γ.

### Label recovery before `cluster:N`

`pickFrameLabel` no longer drops straight to the opaque `cluster:N` after its
four strict passes. Three recovery steps run first (`inject-frames.ts`):

- **Directory-aware short tokens (all passes):** a **2-char** token that names a
  real directory segment (`ws`, `io`, `db`) is eligible; a 1-char segment and a
  short filename stem/extension (`ts`, `js`) stay rejected.
- **Pass 4.5 — relaxed token recovery:** when passes 1–4 fail, accept the
  best TF-IDF top-token at a lowered salience floor (0.3), allowing *soft*
  generics (`index`/`meta`/`ids`, e.g. the `index-meta` cluster) but never
  route-params, dynamic segments, repo-ubiquitous terms, or org-root/layout
  conventions (`src`/`app`/`pages`/… — `LAYOUT_ROOT_TOKENS`). Relaxes only
  topical TF-IDF tokens, never raw path segments (a 30%-frequency segment
  carries no topicality guarantee).
- **Directory descriptor:** if Pass 4.5 still finds nothing, the label is the
  dominant informative directory segment(s) shared by **2+ members** (e.g.
  `decisions/todos`) — never a file count (the viewer renders counts), never a
  one-off dir. `cluster:N` remains only as the absolute floor and is now rare
  (0 on cortex, ≤2 on the OO corpus repos measured).

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

## Frame ranking, layout & layers

Clustering + labeling produces *every* frame a repo yields; real repos
overproduce past a readable budget. Ranking, layout, layer classification, and
ambient selection are the read-time layer that turns the raw frame set into the
ambient map the viewer draws. All of it is **pure, deterministic, and
recompute-on-read** — nothing here is persisted alongside `frame_id`.

Pre-implementation design notes live at
[`frame-ranking-design.md`](frame-ranking-design.md)
and [`frame-layout.md`](frame-layout-design.md) (both retained).
The **shipped ranker is the taxonomy-free "Path-1" subset** those notes were
later extended past — treat this section, not the notes' later chapters, as the
description of what runs.

### The ranker

A deterministic ranker picks an **ambient set** of frames to foreground; the
rest stay queryable (they are ranked, not dropped). The score is a product:

```
score = nameability × structural_weight × kind_weight
nameability      = label_F1 × generic_penalty
structural_weight = sqrt(member_count)
kind_weight       = layer weight × diversity   (see below; default 1)
```

- **budget** = `max(4, min(10, ceil(extracted × 0.7)))` — floors small repos at
  4, caps large ones at 10.
- **tie-break** is lexicographic on `frame_id` (stable across runs).
- Non-ambient frames remain fully queryable; ranking only controls foreground.

### Layout

Positions come from **server-side d3-force**, recomputed on read and fully
deterministic:

- RNG is **mulberry32 seeded from the SHA-256 of the sorted frame records**, so
  identical inputs give byte-identical coordinates.
- Fixed **300 iterations**, then **integer-pixel quantized**.
- Forces are driven by **rolled-up `CALLS`/`USAGE`/`IMPORTS` edges** (symbol →
  file → frame), per-frame **mass**, and **collision**.

### Coverage tuning (HDBSCAN noise)

The dominant noise lever is HDBSCAN **`min_samples`**, *not* `min_cluster_size`.
HDBSCAN silently defaults `min_samples` to `min_cluster_size` — very
conservative, ≈70% noise on cortex. Shipped configuration:

```
min_samples = 1
cluster_selection_method = 'eom'
min_cluster_size = 5
```

This drops noise **70% → 34%** with `f1_weighted` held flat. The gate is
explicit: **F1 must not regress** versus the `min_samples=5` baseline. Fallback
`min_samples=2` if membership wobbles on a given repo.

**Graph-edge reclamation.** The ≈28–34% residual that won't token-cluster is
reclaimed by [`frame-reclamation.ts`](../../src/frame-extraction/frame-reclamation.ts):
each noise file is pulled into the frame it has the most `CALLS`/`USAGE`/`IMPORTS`
edges to (`argmax` over edge counts, gated by a `minEdges` threshold,
deterministic). **Invariant:** reclaimed members count toward **layout mass** but
**nameability F1 is computed over CORE members only** — reclamation can move a
file into a frame but can never inflate that frame's label score.

### Label quality (F1)

Label quality is an **F1** — the harmonic mean of two content measures over a
cluster's file blobs:

- **coverage** = cluster members whose blob contains the label ÷ members.
- **specificity** = members containing the label ÷ *all repo files* containing it.

Specificity is the non-circular half: `pickFrameLabel` only ever looks *inside* a
cluster, so it never optimizes for repo-ubiquity — specificity is what penalizes
framework-idiom labels (`index`, `app`) that saturate the whole repo. Multi-word
labels require a **strict AND** (a blob must contain every word). This same F1 is
reused as the ranker's `nameability` term.

**Known blind spot:** a content-only metric cannot tell an accurate
layer-marker label (`controllers`) from a domain label. The LLM
intruder-detection validator that was trialed as a cross-check was found
**confounded by cluster coherence** (2026-06-06) and is **not a trusted
signal**.

### Layer taxonomy

Frames are classified into **six layers** — `interface` | `orchestration` |
`domain` | `data` | `infrastructure` | `ceremony` — deterministically and
**read-time in [`frame-map.ts`](../../src/frame-extraction/positioning/frame-map.ts)**: pure, no
persistence, no LLM (decision `D-qn7z`).

Classification is **agreement-based**, not first-match-wins: every source emits a
**weight vector over the six layers**; the vectors are summed and `argmax`'d, with
a canonical-order tie-break. This replaced the design notes' first-match chain for
two reasons:

1. That chain's **#1 source (an ACDC dominator symbol) cannot be built** —
   `tfidf`+`hdbscan` produces no dominator data.
2. **Topology and vocabulary are authoritative at opposite ends.** Topology
   separates surface ↔ substrate via a **sink score** `= fanIn / (fanIn + fanOut)`;
   vocabulary refines the middle. Summing lets each speak where it is strong.

Refinements baked in:

- **Test paths are excluded from the path table** (tests co-cluster with their
  subjects, so a `/test/` segment is a poor layer signal). Test-ness is treated
  as content-only: `W_TEST` fires `ceremony` only at a **≥0.8 test fraction**.
- The Nitro/h3 `*.{get,post,…}.ts` handler idiom is detected as **orchestration**,
  scoped to `api`/`routes` directories.
- `is_entry_point` is **unused** — too loose to be a reliable signal.

Named constants (committed):

| Constant | Value | Role |
|---|---|---|
| `W_GRAPH` | `1.0` | weight of the topology (sink-score) source |
| `W_PATH` | `0.8` | weight of the path-table source |
| `W_TEST` | `0.9` | weight of the test-fraction → `ceremony` source |
| `MIN_SIGNAL` | `0.4` | floor a layer must clear to count (raised from `0.25`) |

No internals (per-layer confidence, source contributions) are **ever
serialized** — only the resolved layer surfaces.

### Earnable domain

`domain` carries the top kind-weight, but under the base taxonomy it was only
reachable as a **fallback** (no positive signal) — the collision that made
`D-qn7z` a trap. Fix: `domain` becomes **earnable** by a middle-band runtime
residual

```
W_DOMAIN_RUNTIME = 0.5 × runtimeFrac
```

applied **only when no layer-specific source cleared `MIN_SIGNAL`**, so any real
path/label/content signal still wins — the override protection is **structural
(gated on nothing else firing), not a weight race**. Because `0.5 × 0.8 =
MIN_SIGNAL`, the bar to *earn* domain is **≥80% runtime content, mid-band,
untyped**. An **earned** domain gets kind-weight `1.00`; a **fallback** domain
gets `0.50`, the two kept distinct by a `fallback` flag.

### Kind-weight table

Layer → kind-weight, shipped **on by default** (decision `D-g4qb`):

| Layer | kind-weight |
|---|---|
| `domain` (earned) | `1.00` |
| `interface` | `0.90` |
| `orchestration` | `0.85` |
| `data` | `0.75` |
| `infrastructure` | `0.55` |
| `domain` (fallback) | `0.50` |
| `ceremony` | `0.20` |

**Mechanism invariant:** the ranker stays **layer-agnostic**. `kind_weight` is
threaded as a plain number **defaulting to 1** — omit it and ranking is
byte-identical to the taxonomy-free path. The table, the flag, and the layer
lookup all live at the `frame-map.ts` call site, never inside the ranker.

### Diversity & ambient selection

The naïve top-N ambient cut is replaced by a deterministic greedy selector
([`frame-diversity.ts`](../../src/frame-extraction/frame-diversity.ts), pure), in
two phases:

1. **Greedy fill with geometric repeat-decay.** A frame's *effective* score is
   `score × DIVERSITY_DECAY^k` where `k` is the count of same-layer frames already
   selected (`DIVERSITY_DECAY = 0.6`); `ceremony` is **capped at 1**. This spreads
   the ambient set across layers instead of letting one layer dominate.
2. **Bounded coverage repair.** Guarantee **≥1 of `[domain, interface, data]`**
   for each such layer the repo actually has, swapping in a missing layer's best
   candidate **only if it clears `PROMOTION_FLOOR` (0.5) × the displaced score**
   (the `D-qn7z` junk-leapfrog guard) — and **never** robbing the sole
   representative of another required layer.

Displayed `rank`/`score` stay in **raw-score order**, so the map can honestly show
a rank-11 frame as ambient and a rank-8 frame as not.

### What was tried and discarded

- **Graph-signal clustering** (import/`CALLS` affinity term δ; a TypeScript
  modularity split) was built, swept, and **discarded negative** (2026-06-05). A
  repo's `IMPORTS`/`CALLS` graph couples files *across* the topical boundaries a
  frame expresses (CLI → decisions → MCP; tests → everything), so it is the
  **wrong signal for topical grouping**. Frame-quality work should build on
  tokenization / labeling / auxiliary-detection and **hierarchy affinity**, not
  the import graph. The eval guardrail (corpus + label-quality F1 gate) is the
  regression bar for any such attempt.
- **Convention-aware tokenization** (Phase 1) was, by contrast, a shipped **win**
  (label violations **133 → 10**): down-weight bracketed route params, `use*`
  hooks, and MVC layer markers; prefer domain tokens over layer tokens.

## Status

The pipeline is shipped end-to-end on `cortex` itself. Eyeball
verifications across multiple iterations are checked into
`.tmp/frame-extraction/` (phase-2 eval, not retained). Open follow-ups:

- Tune `γ` per-archetype across the 5-repo Phase 2 corpus
  (`scripts/frame-extraction/phase2-corpus.json`).
- Add the spec's full 4-step label cascade (currently we pick the
  first non-generic top token with a small stop list).
- Compare against alternative algorithms (Leiden, pinned-embedding +
  HDBSCAN) — slots described in
  [`frame-extraction-design.md` §Three pipelines](frame-extraction-design.md).
- Re-introduce live mutation handling in the viewer once the static
  load model has settled.
