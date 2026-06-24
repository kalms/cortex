# Design — Class-hierarchy affinity as a frame-clustering signal

**Date:** 2026-06-24
**Author:** Claude (Opus 4.8, 1M context) + rka
**Branch:** `feature/frames/embedding-cluster-spike` (spike) → implementation TBD
**Status:** Design — approved to proceed to implementation plan.
**Supersedes claim in:** decision `D-0j21` ("no dense+topical signal exists" — disproven; to be revised).
**Builds on:** spike report [2026-06-24-embedding-cluster-signal.md](../../research/2026-06-24-embedding-cluster-signal.md).

---

## Problem

Frames surface opaque `cluster:N` labels and, more broadly, weakly-labeled
clusters (low label-F1). The clustering signal is pure lexical TF-IDF. A spike
ruled out embeddings, dependency edges, and co-change as alternatives (all either
near-collinear or cross-topic). But a **class-hierarchy** signal — files whose
classes share a base — measured as both **dense and topical** (coherence
0.74–0.82 vs 0.23–0.31 for dependency edges), and it is available **today** from
data the indexer already stores. This design productionizes it.

## What the evidence supports (and bounds)

Measured via spike (`scripts/frame-extraction/eval-hierarchy-spike.ts`), blending
a hierarchy-affinity term into clustering like the existing co-change γ:

| repo (shape) | baseline → hierarchy (γ=0.3) |
|---|---|
| cortex (functional TS) | **inert** — 0 domain bases, identical output |
| peft (OO Python) | label-F1 0.351→0.412, clusters-below-floor 25→19, noise 0.378→0.268 |
| saleor (large OO Django) | `cluster:N` 10→8, below-floor 132→122, F1 0.414→0.423 |

**Bounded claims (honest scope):**
- It is a **modest, OO-only frame-quality lift** — label-F1 ↑, clusters-below-floor ↓,
  related files consolidated. It is **not** a `cluster:N` silver bullet (saleor 10→8;
  peft was never `cluster:N`-bound).
- **Functional codebases get nothing** (no class hierarchy) — and that is fine:
  the term is inert when there is no signal (cortex proved this).
- γ ≈ **0.3** is the sweet spot; γ=0.5 nudges noise up.

## Why cortex-side, not an indexer build

The indexer already stores each class's `base_classes` in node JSON (even when it
drops the `INHERITS` edge). Reading that cortex-side captures the value with **no
indexer change**. Indexer-side additions were measured and rejected:
- **External-base node materialization:** +47% edges, ~0 value (external bases are
  cross-topic hubs; F1 slightly *worse*). Not worth building.
- **TS `implements` extraction:** ≤4 clauses in a real TS repo; `extends` already
  captured. Negligible.
- **Go `IMPLEMENTS`:** the only genuine net-new signal, but high parser cost and
  Go-only — deferred as a separate, independently-justified effort (TODO).

## Design

A new deterministic clustering signal, structured parallel to co-change:

1. **`src/frame-extraction/hierarchy-affinity.ts` (pure module).**
   - Input: class nodes (`{file_path, name, base_classes[]}`) from the graph.
   - Build the set of in-repo class names. A base is **domain** iff its normalized
     name (strip wrapping parens, split comma-lists, take trailing dotted segment,
     drop generics, lowercase) matches an in-repo class name; otherwise **external**
     → dropped.
   - Emit "files sharing a domain base" pairs `{a, b, weight}`. Cap any single
     base's clique at `HIERARCHY_MAX_CLIQUE` (~60) so a broad base can't dominate.
   - Pure: graph rows in, pairs out. No I/O.

2. **Distance term in the Python clusterer** (`tfidf_hdbscan.py`), parallel to
   `--co-change` (a *separate* flag — they are distinct concerns and may coexist):
   `--hierarchy <pairs.jsonl> --hier-gamma <γ>`; combined distance
   `(1-γ)·topical + γ·hierarchy_dist`, hierarchy distance built like the co-change
   matrix (shared-base pairs → low distance, unobserved → 1.0).

3. **Orchestration** (`cluster-tfidf-hdbscan.ts` / `run-frames.ts`): extract the
   pairs from the graph DB, write the JSONL, pass `--hierarchy`/`--hier-gamma`.
   Default γ = `0.3`. Env gate `CORTEX_FRAME_HIERARCHY=0` disables (default on);
   `CORTEX_FRAME_HIERARCHY_GAMMA` overrides γ.

4. **Determinism:** string-matching + fixed-order pair emission + HDBSCAN fixed
   order → deterministic, satisfying the project constraint.

## Testing

- Unit (`hierarchy-affinity.test.ts`): base normalization (`(nn.Module)`,
  `torch.nn.Module, LoraLayer`, generics), domain-vs-external resolution, clique
  cap, pair emission, empty/no-class repos → no pairs.
- Integration: the existing eval harness refreshes the corpus baseline; assert the
  γ=0 path is byte-identical to today's baseline (the term is purely additive).
- Determinism: two runs → identical cluster assignments.

## Risks / open choices for the plan

- **Default-on vs flag-first.** Proposed default-on at γ=0.3 (inert on functional
  repos, measured net-positive on OO). The plan may stage it flag-first if the
  corpus refresh shows any regression on a non-OO repo.
- **Weighting.** v1 uses unweighted shared-base pairs (clique-capped). A future
  refinement could down-weight by base fan-in; deferred (the cap covers the worst case).

## Follow-ups (TODOs)

- Revise `D-0j21` to the accurate claim.
- File a Go-`IMPLEMENTS` indexer TODO (the one real indexer-side gain).
- Keep `T-sy2d` narrowed (layer-axis concern only).
