# Phase 2 Eval — Co-change Distance Combination on `self/cortex`

Sweep over the co-change weight γ in the TF-IDF + HDBSCAN combined
distance: `dist(a, b) = (1 − γ) · topical + γ · co_change`. Baseline
report (γ = 0) is the previously-committed
[Users-rka-Development-cortex.md](./Users-rka-Development-cortex.md).
All runs used the same blobs (entity names + path tokens) and the same
180-day co-change window already on disk at
`.tmp/frame-extraction/co-change/Users-rka-Development-cortex.jsonl`.

Generated: 2026-05-17

## Headline

`co_change_agreement_lenient` (the spec's primary signal-quality metric)
moved from **0.108** at γ = 0 to **0.646** at γ = 0.3 — a 6× lift. Going
further (γ ∈ {0.5, 0.7}) was counterproductive: lenient agreement fell
back to 0.431 because the combined distance becomes mostly-uniform 1.0
once co-change dominates, flattening the manifold HDBSCAN's density
estimator works against. Silhouette declines monotonically as expected
— silhouette measures cohesion in the TF-IDF feature space, and we
are explicitly trading some of that off.

## Metrics by γ

| metric | γ = 0.0 | γ = 0.3 | γ = 0.5 | γ = 0.7 |
|---|---:|---:|---:|---:|
| total_files | 544 | 544 | 544 | 544 |
| cluster_count | 14 | 12 | 13 | 13 |
| noise_rate | 0.528 | **0.494** | 0.507 | 0.507 |
| co_change_agreement_strict | 1.000 | 1.000 | 1.000 | 1.000 |
| co_change_agreement_lenient | 0.108 | **0.646** | 0.431 | 0.431 |
| import_agreement_strict | 0.610 | 0.631 | **0.650** | **0.650** |
| import_agreement_lenient | 0.043 | **0.091** | 0.072 | 0.072 |
| silhouette_score (algorithm-internal) | 0.439 | 0.256 | 0.191 | 0.120 |
| vocabulary_size (algorithm-internal) | 2504 | 2504 | 2504 | 2504 |

(Bold = best value across the sweep for that row.)

## Interpretation

- **γ = 0.3 is the sweet spot.** Lenient co_change_agreement is 6× the
  baseline, noise rate is lowest (287 → 269 noise files), and import
  agreement co-improves (CALLS edges and co-change correlate, so the
  same pull that bridges co-changing files also bridges some
  import-coupled ones). This validates the spec's intuition that
  γ ≥ β > α for codebases where co-change dominates — but only up to
  a point.
- **Higher γ is worse, not better.** At γ ≥ 0.5 the combined distance
  is dominated by co-change, and most file pairs have *no* co-change
  observation (distance = 1.0 by construction). HDBSCAN's density
  estimator then sees a near-uniform manifold punctuated by a few
  low-distance "islands" of co-changing pairs. Density-based methods
  thrive on contrast, not uniformity — so going further actually
  *loses* signal. γ = 0.5 and γ = 0.7 produce identical metrics
  because once co-change dominates, both find the same coarse
  density structure.
- **Strict agreement stays pinned at 1.000.** Once γ > 0 pulls
  co-changing pairs together, the cores HDBSCAN is confident about
  are internally pristine on this signal. The headroom is entirely in
  shrinking the noise cluster.
- **Silhouette is misleading on its own.** A drop from 0.439 → 0.256
  could look like a regression, but it's measuring cohesion in pure
  TF-IDF space — i.e. the space we deliberately weighted down. As a
  cross-signal metric, lenient co_change_agreement is the load-bearing
  number, and it moved the right way.
- **Defensible default for the next chunk: γ = 0.3.** Algorithm
  comparison work (Leiden, pinned-embedding + HDBSCAN) should run at
  γ = 0.3 unless the per-archetype data suggests otherwise. We do not
  recommend going higher without per-archetype calibration.

## Method

- Cluster: `npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts <repo> --out ... --gamma <γ>`
- Eval: `npx tsx scripts/frame-extraction/eval.ts --cluster ... --repo <repo> --out ...`
- Co-change source: `.tmp/frame-extraction/co-change/Users-rka-Development-cortex.jsonl`
  (180-day window, big-commit threshold 50, min count 2)
- Determinism: cluster JSON is byte-identical across reruns at the same
  γ. The γ = 0 row above reproduces the previously-committed baseline
  exactly (cluster_count, noise_rate, all four agreements, silhouette,
  vocabulary_size) — the cold-start path is unchanged.

## Per-γ reports

Full per-γ eval reports are not committed (they're large and largely
redundant). Reproduce on demand by re-running the sweep below and
inspecting `.tmp/frame-extraction/eval-sweep/cortex-g<γ>.md`.

```bash
mkdir -p .tmp/frame-extraction/clusters/sweep .tmp/frame-extraction/eval-sweep
for gamma in 0.0 0.3 0.5 0.7; do
  npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts \
    "$(pwd)" \
    --out ".tmp/frame-extraction/clusters/sweep/cortex-g${gamma}.json" \
    --gamma "$gamma"
  npx tsx scripts/frame-extraction/eval.ts \
    --cluster ".tmp/frame-extraction/clusters/sweep/cortex-g${gamma}.json" \
    --repo "$(pwd)" \
    --out ".tmp/frame-extraction/eval-sweep/cortex-g${gamma}.md" \
    --repo-slug "self/cortex (γ=${gamma})"
done
```
