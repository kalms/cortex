# Spike — Embedding-signal clustering to reduce `cluster:N` fallback labels

**Type:** Designed experiment (spike), not a production commitment.
**Date:** 2026-06-24
**Author:** Claude (Opus 4.8, 1M context) + rka
**Branch:** `feature/frames/embedding-cluster-spike`
**Relates to:** TODO `T-sy2d` (Frame-quality: Louvain/Leiden concern axis), decisions `D-8vbv` / `D-qn7z`, and the negative results in
[2026-06-05-modularity-split.md](../../research/2026-06-05-modularity-split.md).

---

## Problem

Frames in the viewer surface a "fair bit" of opaque `cluster:N` labels. These are
the honest last-resort output of [`pickFrameLabel`](../../../src/frame-extraction/inject-frames.ts):
emitted only when a cluster has **no** label-eligible token, **no** common path
prefix, and **no** dominant path segment. The labeler is honest; the problem is
upstream — the *clustering* groups files that share no nameable topical surface.
On cortex itself the current baseline is `label_f1_weighted ≈ 0.36` with **55
clusters below the F1 floor**.

## What was already tried (and why this is different)

The deferred task `T-sy2d` proposes reviving community detection (Leiden-grade)
to fix fragmented clusters. But two prior graph-signal experiments already
**failed** for the same root reason ([modularity-split research](../../research/2026-06-05-modularity-split.md)):
community detection over `IMPORTS`+`CALLS` produced *incoherent, less* nameable
clusters (more `cluster:N`), because **dependency edges cross the topical
boundaries frames must express** (CLI→decisions→MCP, tests→everything).

> "The import graph is the wrong signal for topical grouping… future
> frame-quality work should build on tokenization/labeling, not the import graph."

The diagnosis this spike acts on: **the failure was the edge *semantics*, not the
algorithm.** The graph already carries a *topical* signal the clustering pipeline
ignores — the indexer's **algorithmic code embeddings** (`ctx_node_vectors`,
768-dim int8, "zero external dependencies", emitted by `pass_semantic_edges.c`).
This spike tests whether clustering on that semantic signal — rather than
dependency edges or lexical TF-IDF alone — yields more nameable clusters.

## Hypothesis

Clusters formed by code-embedding affinity are more nameable (fewer `cluster:N`,
higher label F1) than TF-IDF+HDBSCAN clusters, **and** deterministic.

## Determinism (hard constraint)

The whole Arm-1 chain is deterministic: the indexer's embeddings are algorithmic
(no model, no randomness); int8 → float aggregation, cosine distance, and
HDBSCAN with fixed input ordering are all deterministic. This is the reason an
embedding/clustering route is admissible where an LLM naming pass is not.

## Arms (cheapest first; gate after Arm 1)

- **Arm 0 — baseline.** Current TF-IDF + HDBSCAN, re-measured on a fixed snapshot.
- **Arm 1 — embedding HDBSCAN.** Build a per-file embedding by aggregating
  (IDF-weighted mean, falling back to plain mean) the int8 vectors of the
  functions/methods each file `DEFINES`; feed a precomputed cosine-distance
  matrix into the *same* HDBSCAN step. Files with no functions (rare after
  auxiliary filtering) fall back to the TF-IDF vector. `top_tokens_per_cluster`
  is still computed from TF-IDF over each resulting cluster, so the existing
  labeler keeps working.
- **Arm 2 — Leiden over a semantic k-NN graph** *(only if Arm 1 clears the bar)*.
  Build a k-NN graph from file embeddings, run version-pinned `leidenalg`
  (deterministic). The "Leiden-grade" form of `T-sy2d`, but over topical edges.

Dependency-graph communities (`IMPORTS`/`CALLS`) are **not** re-tested — settled negative.

## Metrics (per-repo + corpus aggregate, via the existing eval harness)

- **Primary:** count of `cluster:N` labels (new `eval-metrics` field) and
  `label_clusters_below_f1` (beat 55 on cortex).
- **Guardrails:** `label_f1_weighted` must not regress; watch `noise_rate`,
  `cluster_count`, `silhouette`.
- **Determinism gate:** two runs → byte-identical cluster assignments.

## Corpus

Full `phase2-corpus.json` sweep (nuxt/ui, excalidraw, caddy, huggingface/peft,
trpc/trpc) plus cortex itself as the known-bad case. cortex is used as the fast
inner-loop smoke test before the full sweep.

## Decision rule

Adopt the embedding signal only if **`cluster:N` drops materially AND
`label_f1_weighted` holds AND output is deterministic**. Otherwise: record a
negative result (in the spirit of the prior two), discard the implementation,
and fall back to deterministic labeling-only improvements — the path the prior
research already recommended.

## Coupling risk to watch

Embedding clusters may group files that are semantically similar but share **no
surface tokens** — which the current TF-IDF-token labeler could still fail to
name. If Arm 1 improves cohesion but `cluster:N` doesn't fall, the bottleneck is
the *labeler*, not the clustering, and the report should say so.
