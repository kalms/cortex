# Frame coverage — retune + graph reclamation (taxonomy-free) — design

**Date:** 2026-06-09
**Status:** approved (brainstorm), pending implementation plan
**Branch:** `feature/frames/coverage`
**Builds on:** the Path 1 frame ranker + force-directed layout
(`docs/superpowers/specs/2026-06-08-frame-ranking-path1-design.md`) and the
existing tf-idf+HDBSCAN clustering (`src/frame-extraction/cluster-tfidf-hdbscan.ts`,
`scripts/frame-extraction/python/tfidf_hdbscan.py`).

> **Origin:** this started as "place the auxiliary/bare nodes drawn at the bottom
> of the graph" but the diagnosis (below) reframed it: the real problem is that
> most semantic files never enter a frame at all. We pivoted to *coverage*.

## Problem

On the Cortex self-graph, of **1015 file nodes**: only **109 (~11%)** carry a
`frame_id`. The rest are **378 auxiliary** (vendored/fixtures/generated — correctly
bypassed from clustering, rendered in the bottom aggregate strip) and **528 bare**
semantic files that landed in HDBSCAN's noise bucket and are **rendered nowhere**.
Those 528 bare files carry **1,511 CALLS/USAGE/IMPORTS edges into the framed code** —
they are not peripheral, they are simply unclustered.

The clustering input (after auxiliary exclusion) is ~400 files; at the shipped
default it produces **8 clusters and 282 noise = 70% noise**.

## Diagnosis (read-only, performed during brainstorm)

The clustering is TF-IDF (min_df=2, max_df=0.8, ngram 1–2, cosine) → HDBSCAN on a
precomputed cosine-distance matrix, `min_cluster_size=5`, with **`min_samples` and
`cluster_selection_method` left at HDBSCAN defaults**.

**Finding 1 — `min_cluster_size` is a weak, non-monotonic lever** (sweep on the
real 400-file corpus):

| min_cluster_size | clusters | noise | noise % |
|---|---|---|---|
| 2 | 49 | 173 | 43% |
| 3 | 19 | 236 | 59% |
| 4 | 10 | 242 | 60% |
| **5 (default)** | **8** | **282** | **70%** |
| 8 | 5 | 256 | 64% |
| 10 | 2 | 290 | 73% |

Noise barely improves and cluster count swings wildly. Even the most permissive
setting (mcs=2) floors at 43% noise *and* explodes to 49 clusters (unusable for a
readable map).

**Finding 2 — `min_samples` is the dominant lever.** HDBSCAN silently defaults
`min_samples` to `min_cluster_size` (5), which is very conservative. Decoupling it
roughly halves the noise (`eom` = excess-of-mass selection):

| config | clusters | noise % |
|---|---|---|
| **default** (mcs=5, min_samples=5, eom) | 8 | **70%** |
| mcs=5, **min_samples=1**, eom | 24 | **34%** |
| mcs=5, min_samples=1, leaf | 25 | 38% |
| mcs=3, min_samples=1, leaf | 59 | 28% |

`eom` beats `leaf` (138 vs 153 noise) and `min_cluster_size=5` keeps every cluster
≥5 files (no singletons).

**Finding 3 — the recovered clusters are real, not junk.** Top tf-idf tokens of the
16 clusters `min_samples=1` recovers from noise name genuine Cortex subsystems:
`decisions`, `decisions seed`, `cli commands`, `indexer discover`, `indexer
semantic`, `indexer extract`, … — crisp, nameable. The 70% noise rate was hiding
real frames behind a parameter default.

**Finding 4 — a real residual remains (~28–34%).** Even maximally aggressive,
~a third of files won't densely cluster in tf-idf token space — code files aren't
all token-similar to ≥5 neighbours. That residual is exactly where the 1,511 graph
edges (call/import structure, not token overlap) are the untapped signal.

**Conclusion:** most of the coverage gap is a conservative parameter default, fixable
for ~hours; the residual needs a non-token (graph) signal. This motivates a phased
fix rather than a from-scratch graph-native (Leiden) rewrite.

## Goals

- Roughly halve the noise rate via a safe parameter retune, gated on label quality.
- Reclaim the graph-connected residual into the frame it actually belongs to.
- Keep the *map* readable: more raw clusters is fine because the Path 1 ambient
  ranker caps the displayed set; junk clusters are caught by the F1 gate.
- Stay deterministic and taxonomy-free (consistent with Path 1).

## Non-goals (deferred)

- **Leiden / graph-native clustering.** Documented as the future option, gated on
  whether Phases 1–2 leave an unacceptable residual. Not built here.
- **Floating-entity placement** of the post-reclamation residual + auxiliary
  aggregates (the original question). Phase 2 *shrinks* that residual; placing
  whatever remains is a separate follow-up.
- **Replacing the auxiliary bottom strip.** Unchanged.
- **Changing the ambient ranker or force layout** (Path 1). Unchanged.

## Design

### Phase 1 — Retune (`min_samples`) + quality gate

- **Python (`scripts/frame-extraction/python/tfidf_hdbscan.py`):** add a
  `--min-samples INT` argument; pass it to `hdbscan.HDBSCAN(min_samples=...)`.
  Keep `cluster_selection_method="eom"` and `min_cluster_size` default 5. When the
  flag is omitted, preserve today's behaviour (HDBSCAN default = `min_cluster_size`)
  so the script's own default is unchanged; the new default is set by the caller.
- **Wrapper (`src/frame-extraction/cluster-tfidf-hdbscan.ts`):** add `min_samples?:
  number` to `RunOptions`; pass `--min-samples` when set; **default it to `1`** in
  the wrapper (and surface a `--min-samples` CLI flag mirroring `--min-cluster-size`).
- **Call sites:** the indexer invocation of the clustering inherits the wrapper
  default (1); no per-call change needed beyond confirming nothing overrides it.
- **Quality gate:** run the existing label-quality eval (`scoreClusters` +
  `aggregateLabelQuality` in `label-quality.ts`, via `eval-gate.ts`) on the retuned
  output and assert `f1_weighted` does not regress materially versus the
  `min_samples=5` baseline (and stays ≥ `DEFAULT_F1_FLOOR` = 0.5). This is the safety
  net that justifies lowering the parameter.
- **Ranker interaction:** none. 24 clusters → ambient budget `max(4, min(10,
  ceil(24×0.7)))` = 10 displayed; the rest stay searchable/non-ambient.

Expected effect (measured): noise 70% → ~34%; framed semantic files roughly double.

### Phase 2 — Graph reclamation of the residual

- **New module `src/frame-extraction/frame-reclamation.ts`** (pure, no I/O):
  ```
  reclaimNoise(cluster: ClusterResult, nodes: NodeRow[], edges: EdgeRow[],
               opts?: { minEdges?: number; relations?: string[] }): ClusterResult
  ```
  For each file in the noise cluster (`cluster_id === -1`):
  1. Map every node id → its file's frame/cluster via `file_path` (the Path 1
     `buildNodeFrameIndex` pattern, here keyed on cluster membership).
  2. Sum rolled-up CALLS/USAGE/IMPORTS edge weights from the noise file to the
     members of each non-noise cluster.
  3. Assign the noise file to the argmax cluster **iff** its weight `≥ minEdges`
     (default to be tuned, start at 2); deterministic tie-break on lowest
     `cluster_id`. Below threshold → stays noise.
  - Output: an augmented `ClusterResult` where reclaimed files move from the noise
    cluster into their assigned cluster's `member_paths` and are also listed in that
    cluster's `reclaimed_paths`.
- **Core vs reclaimed:** reclaimed members count toward `member_count` (so layout
  size/mass and the structural-weight term reflect them), but **nameability F1 is
  computed over CORE members only** (the original topical cluster). This keeps the
  ranker's label score honest and self-limits over-reclamation. Requires threading
  `reclaimed_paths` from the cluster result through `inject-frames` (which marks those
  file nodes' `data` with `reclaimed: true`), and having the ranker's corpus/label
  scoring exclude reclaimed members.
- **Residual:** files still below threshold remain noise → input to the future
  floating-entity placement.
- **Pipeline placement:** runs in TS after `runTfIdfHdbscan` returns and before
  `injectFrames`, where graph edges are already accessible. Python stays a pure
  topical clusterer.

## Key files

- `scripts/frame-extraction/python/tfidf_hdbscan.py` — add `--min-samples`.
- `src/frame-extraction/cluster-tfidf-hdbscan.ts` — `RunOptions.min_samples`,
  default 1, CLI flag.
- `src/frame-extraction/frame-reclamation.ts` — NEW, the reclamation pass.
- `src/frame-extraction/inject-frames.ts` — thread the `reclaimed` marker into node
  `data`.
- `src/frame-extraction/frame-ranker.ts` — scope nameability to core members.
- `src/frame-extraction/run-frames.ts` (or the indexer clustering entrypoint) — wire
  the reclamation pass between clustering and injection.
- `src/frame-extraction/types.ts` — add `ClusterAssignment.reclaimed_paths?: string[]`
  (the subset of `member_paths` that were reclaimed, since the marker is per-file,
  not per-cluster).
- eval: `eval-gate.ts` / `eval-labels.ts` — the F1 quality gate.

## Verification

- **Determinism:** reclamation is a pure argmax over summed integer edge weights →
  byte-identical across re-runs; HDBSCAN remains deterministic given fixed input.
- **Phase 1 gate:** `f1_weighted` ≥ baseline (`min_samples=5`) and ≥ 0.5; noise rate
  drops to ~34% on the Cortex corpus.
- **Phase 2 checks:** reclaimed-file precision proxy — what fraction of reclaimed
  files share the assigned frame's dominant path prefix (a sanity signal, not a hard
  gate); coverage delta (framed files before/after); residual noise count.
- **Corpus harness:** reuse `scripts/frame-extraction/` eval scripts; report
  noise_rate, cluster count, F1, coverage across the corpus, not just Cortex.
- **Gate-0 visual QA:** the viewer shows more frames / denser maps without junk
  labels; no console errors.

## Risks / open questions

- **`min_samples=1` sensitivity:** HDBSCAN becomes more sensitive; cluster membership
  may wobble more across small re-indexes. The F1 gate catches degenerate cases;
  monitor stability on the corpus. If wobble is bad, `min_samples=2` (52% noise) is
  the fallback.
- **Reclamation threshold (`minEdges`):** too low pulls weakly-related files into
  frames (label dilution — but nameability-on-core-members absorbs this); too high
  leaves coverage on the table. Tune against the F1 gate + coverage delta.
- **Cluster-count growth:** 8 → ~24 raw clusters. Confirmed the ambient ranker caps
  the displayed set; verify non-ambient frames stay navigable.
- **Cross-repo generalisation:** all measurements are Cortex-only; validate the
  retune + reclamation on the corpus (tRPC, anthill-cloud, …) before trusting the
  defaults.

## Relationship to other specs

- **Builds on** Path 1 (ranker + layout + symbol→file→frame rollup) — Phase 2 reuses
  the rollup approach; the ranker change (nameability on core members) is additive.
- **Feeds** the deferred floating-entity placement: Phase 2 shrinks the bare-node
  residual to genuinely-peripheral files, which is a smaller, cleaner placement
  problem.
- **Leiden / graph-native clustering** remains the principled end-state, gated on
  Phases 1–2 evidence.
