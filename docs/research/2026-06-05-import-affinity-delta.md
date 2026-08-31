# Research Report — Import-Affinity `delta` Signal (Phase 2): Null Result

**Type:** Research report (designed experiment, not active-use feedback).
**Date:** 2026-06-05
**Author:** Claude (Opus 4.8, 1M context) + rka
**Subject:** Frame-extraction Phase 2 — blending an import/call adjacency signal into the HDBSCAN distance via a `delta` weight.
**Spec:** [2026-06-04-import-aware-frame-extraction-design.md](../superpowers/specs/2026-06-04-import-aware-frame-extraction-design.md) §6
**Outcome:** **Negative.** No safe corpus-wide `delta` recovers the targeted files. Implementation **discarded** (not merged); recoverable from git history if a follow-up pursues adaptive delta.

---

## Question

Phase 1 (convention-aware tokenization) traded a small slice of coverage for large label/coherence gains: dropping bracketed route segments de-glued maximally-generic framework files into the noise cluster (private-monorepo's `design-system/[id]/*.vue` attribute leaves; vercel/commerce's `app/[page]/*` routes — named in decision `19e20fe4` as the Phase-2 reclaim target). Phase 2 asked: **can an import/call adjacency signal (`delta`) pull those import-coupled files back out of noise** — `dist = (1−γ−δ)·topical + γ·co_change + δ·import` — without harming the repos that already cluster well?

## Method

Built the full machinery (collector reading `IMPORTS`+`CALLS` → `{a,b,count}` JSONL; a Python `delta` blend parallel to the co-change `gamma`; orchestrator + eval plumbing) and swept `delta ∈ {0, 0.15, 0.30, 0.45}` on the two local app fixtures (private-monorepo, cortex) plus vercel/commerce, measuring cluster count, noise rate, label violations, and **file-level movement** (which files cross between noise and clusters), plus the explicit placement of the named targeted files. The independent signal is **noise/coverage** (the delta feeds on CALLS, so CALLS-agreement is circular and was not used as the acceptance metric).

## Results — before (`delta=0`) vs after (`delta=0.15`)

`delta=0.15` was the only value that didn't collapse dense graphs (see below); default `min_cluster_size`.

| repo | clusters 0→.15 | noise% 0→.15 | rescued (noise→clustered) | lost (clustered→noise) | **named targets rescued** |
|---|---|---|---|---|---|
| private-monorepo | 10→10 | 53%→51% | 6 | 1 | **0 / 5** |
| cortex (self) | 9→9 | 66%→**67%** | 13 | 16 | — |
| vercel/commerce | 2→2 | 68%→**72%** | 4 | 7 | **0 / 3** |

**Higher delta over-merges.** On cortex (dense TS-monorepo import graph): `delta=0.30` → 6 clusters; `delta=0.45` → **2 clusters**, noise 0.26 (pathological fusion). CALLS-agreement rose monotonically to 1.0 — the circular artifact of near-total merge, confirming why it's not a valid acceptance metric.

## Findings

1. **It churns membership without achieving the goal.** Files move both directions, but the net coverage is flat-to-negative — cortex and commerce get *worse* (66→67%, 68→72%); only private-monorepo improves (−2pt), and that −2pt is *other* files. **0 of 8 named targeted files** were rescued at any safe delta.

2. **Root cause — edge sparsity vs over-merge, with no safe global value.** The targeted framework leaves have too few, too-diffuse edges to pull on (private-monorepo's DS leaves: **1–3** cross-file import/call edges each, pointing at shared utils rather than the design-system cluster core; commerce routes: 4–14, but already clustered). A `delta` low enough to be safe on a dense monorepo (cortex) is too weak to move those sparse-edge files; a `delta` high enough to move them collapses the dense graph. **There is no single corpus-wide `delta` that helps sparse-edge framework files without over-merging dense ones.**

3. **The co-change `gamma` precedent shares this fate.** `gamma` was likewise plumbed but left at 0 in production — the same "global blend weight" shape, never enabled. This is corroborating evidence that a single global affinity weight is the wrong knob.

## Recommendation

- **Keep `delta=0`** (the machinery was discarded, so production is unchanged — pure topical clustering, identical to Phase 1).
- **Do not pursue a global `delta`.** If import-affinity is revisited, the lead is **adaptive per-repo delta** — scale the weight down as import-graph density rises (so sparse-framework repos get a higher effective weight without collapsing monorepos) — or, more fundamentally, **improve extraction** so framework leaves (e.g. Vue page → store/composable) carry the edges that would make them clusterable at all. Both are larger than a weight knob and belong in their own design pass.
- **Phase 3 (TS modularity split) is independent of this** and remains on the table — it addresses the *coarse-cluster* failure, not coverage, and does not depend on import-affinity blending.

## Status of the implementation

The Phase-2 code (collector, Python `delta` blend, orchestrator/run-frames plumbing, `eval --delta`) was built and tested on branch `feature/frames/import-affinity-delta` but **deliberately not merged**: at `delta=0` it is inert yet adds per-index overhead (collecting import edges that the clusterer discards), and keeping it for a speculative future is YAGNI. The approach is fully specified here and in spec §6; re-implementation (3 small tasks) is cheap if adaptive delta is ever pursued.
