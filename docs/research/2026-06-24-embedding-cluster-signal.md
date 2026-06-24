# Research Report — Embedding / alternative-signal clustering: Negative Result

**Type:** Research report (designed experiment, not active-use feedback).
**Date:** 2026-06-24
**Author:** Claude (Opus 4.8, 1M context) + rka
**Subject:** Reducing opaque `cluster:N` frame labels by clustering on a
non-lexical signal (code embeddings, semantic edges, or co-change) instead of /
in addition to TF-IDF.
**Spike plan:** [2026-06-24-embedding-cluster-signal-spike.md](../superpowers/specs/2026-06-24-embedding-cluster-signal-spike.md)
**Branch:** `feature/frames/embedding-cluster-spike`
**Outcome:** **Negative.** No available graph/embedding signal beats lexical
TF-IDF for topical clustering. Implementation kept on-branch (not merged).
**Relates to:** TODO `T-sy2d`, decision `D-8vbv`, and the prior graph-signal
negatives in [2026-06-05-modularity-split.md](2026-06-05-modularity-split.md).

---

## Question

Frames surface a "fair bit" of opaque `cluster:N` labels — the honest fallback
in `pickFrameLabel` when a cluster shares no nameable token, path prefix, or
dominant segment. `T-sy2d` proposed reviving Leiden-grade community detection to
fix this. But two prior experiments (modularity split, import-affinity blend)
already failed because **dependency edges (`CALLS`/`IMPORTS`) cross the topical
boundaries frames must express**. This spike asked the sharper question: is there
a *different* signal — code embeddings, semantic edges, or co-change — that is
both **topical** and **usable** for clustering, and would it reduce `cluster:N`?

## Method

1. **Arm 1 — embedding HDBSCAN.** Built a per-file embedding by mean-aggregating
   the indexer's per-function int8 vectors (`ctx_node_vectors`, 768-dim, emitted
   by `pass_semantic_edges.c`; 100% function/method coverage, 75% of files have
   ≥1 function). Fed a precomputed cosine-distance matrix into the existing
   HDBSCAN step (additive `--embeddings` flag on `tfidf_hdbscan.py`, off by
   default). Scored `cluster:N` count + label F1 against the TF-IDF baseline on
   the same cortex snapshot. Determinism checked by re-running.
2. **Signal-coherence diagnostic.** For every candidate edge type, measured
   **topical coherence** = fraction of cross-file edges whose endpoints live in
   the same subsystem (2nd path segment, e.g. `src/decisions`). A signal useful
   for topical grouping must be both *dense* (enough cross-file edges to cluster)
   and *coherent* (edges stay within subsystems).

## Results

### Arm 1 — embedding clustering (cortex, same snapshot)

| arm | clusters | `cluster:N` | clusters < F1 floor | label f1 (wt) | noise |
|---|---|---|---|---|---|
| baseline (TF-IDF) | 18 | 5 | 11 | 0.494 | 0.302 |
| embedding (eg=1.0) | **4** | **4** | 4 | **0.000** | 0.010 |

Embedding clustering collapsed 308 files into **4 mega-clusters, 100% of them
unnameable** (`cluster:N`), label F1 → 0. Determinism: **PASS** (algorithmic
embeddings are deterministic — the signal is admissible, just not useful).

**Why:** the file embeddings are near-collinear. Pairwise cosine distance:
median **0.022**, max **0.091**; **96% of file pairs within 0.05**. Per-dim std
across files is 0.61 (vectors are distinct — no decode bug), but they are
dominated by a shared "this is code" component, so after normalization there is
almost no topical separation. HDBSCAN correctly collapses a near-equidistant
space. The indexer's embeddings encode code **structure/shape**, which is
globally similar across a codebase — **not topic.**

### Signal-coherence diagnostic (cortex)

| edge type | total | same-file | cross-file same-subsystem | cross-subsystem | topical coherence |
|---|---|---|---|---|---|
| CALLS | 2175 | 540 | 433 | 1202 | 0.26 |
| IMPORTS | 856 | 2 | 262 | 592 | 0.31 |
| FILE_CHANGES_WITH (co-change) | 86 | 0 | 20 | 66 | **0.23** |
| SEMANTICALLY_RELATED | 124 | 92 | 26 | 6 | **0.81** |
| SIMILAR_TO | 19 | 11 | 6 | 2 | 0.75 |

The signals split cleanly into two non-viable groups:

- **Dense but cross-topic.** CALLS, IMPORTS, **and co-change** all sit at
  0.23–0.31 — they mostly connect *different* subsystems. Co-change is no rescue:
  a feature commit touches cli + decisions + mcp-server together, coupling across
  topical lines exactly like dependency edges.
- **Topically coherent but far too sparse.** SEMANTICALLY_RELATED is genuinely
  topical (**0.81**) — but **92 of 124 edges are intra-file**, leaving ~32
  cross-file edges to cluster 308 files. SIMILAR_TO: ~8 usable cross-file edges.
  Most files have zero topical edges, so no frame structure can be built from
  them.

## Findings

1. **There is no dense *and* topically-coherent graph signal in the index.** The
   dense signals are dependency (cross-topic); the only coherent signal (semantic
   edges) is too sparse. This is the structural reason lexical TF-IDF wins — it
   is the only signal that is simultaneously dense and topical.
2. **`cluster:N` is not fixable by a better clustering *signal*.** The clusters
   are already as coherent as the available signals allow; the residual
   bottleneck is the **labeler**, on genuinely hard clusters.
3. **This generalises by mechanism, not luck.** Dependency/co-change edges couple
   across subsystems in every codebase; algorithmic structural embeddings are
   globally similar in every codebase. The cortex measurement is one instance of
   a structural tradeoff, consistent with the two prior graph-signal negatives.

## Cross-arc conclusion

Three independent attempts — modularity split (`CALLS`/`IMPORTS`), import-affinity
blend, and now embeddings / semantic edges / co-change — have each tried to use a
non-lexical signal to improve frames, and all three failed for one underlying
reason: **the signals that are dense couple across topics, and the signal that is
topical is too sparse.** Lexical/path tokenization, cleaned of framework idioms
(the Phase-1 win), remains the durable basis for topical frames.

## Recommendation

- **Do not pursue embedding / semantic-edge / co-change clustering, and do not
  revive Leiden over any of these graphs.** `T-sy2d`'s premise (community
  detection fixes fragmented clusters) is disproven for the available edge sets.
- **Pivot `cluster:N` work to deterministic labeling improvements** on the
  clusters TF-IDF already produces — the path this report and the prior research
  both point to, and one that keeps the determinism constraint.

## Status of the implementation

The additive `--embeddings` / `--embed-gamma` flag on `tfidf_hdbscan.py`, the
`embeddings_path`/`embed_gamma` options on `RunOptions`, and the spike harness
(`scripts/frame-extraction/eval-embed-spike.ts`) live on
`feature/frames/embedding-cluster-spike`. Inert at the default gate (off →
byte-identical baseline) but **not merged** — kept as a recoverable, tested
artifact in the spirit of the modularity-split branch.
