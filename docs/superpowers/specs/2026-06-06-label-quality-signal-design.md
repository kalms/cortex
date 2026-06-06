# Independent Label-Quality Signal — Design

**Date:** 2026-06-06
**Status:** Approved (design) — pending implementation plan
**Area:** frame extraction / eval guardrail
**Related:** [import-aware frame extraction §4, §11](2026-06-04-import-aware-frame-extraction-design.md) · [eval-guardrail plan](../plans/2026-06-04-frame-eval-guardrail.md)

## Problem

The frame-extraction eval has no independent signal that cluster labels are
*semantically good*. The current check, `checkLabelQuality`
([src/frame-extraction/eval-labels.ts](../../../src/frame-extraction/eval-labels.ts)),
runs the production labeler `pickFrameLabel` over each cluster and then validates
the result against the **same predicates the labeler already satisfies** —
`isStructuralLabelToken` and `pathSalience < 0.5`. The metric and the generator
share one rule set, so the check can only ever pass. It is circular by
construction (the eval-guardrail plan describes it as scoring labels "against the
spec's readability rules using the existing `pickFrameLabel`").

The prior arc named three failure modes this circular check cannot catch:

- **Framework idioms leaking in** — labels like `index`, `app`, `model`, `main`.
- **Layer markers standing alone** — `controllers`, `views` as a label when the
  cluster is really about a domain.
- **Single-member labels** — a 10-file cluster labeled after one file's
  distinctive token.

The `cluster:N` opaque-label bug was fixed in the 2026-06-06 session, but "is
this the *right* label" remains unvalidated. This design adds the independent
signal.

## Key insight — what breaks the circularity

`pickFrameLabel` only ever looks *inside* a cluster: it picks terms frequent
among the cluster's members (TF-IDF top tokens, `pathSalience`, the pass-4
majority-segment rule). It never asks the opposite question: **is this term
distinctive to this cluster, or does it appear all over the repo?** That blind
spot is the independent, deterministic, content-derived signal we exploit.

## Approach — label as a classifier of the corpus

Score each cluster's label as if it were a classifier predicting cluster
membership, measured against the **full per-file token blob** (path + content
identifiers + structural tokens) — the same surface the clusterer drew from.

- **Coverage (recall)** = `|members whose blob contains the label| / |members|`
  Low coverage ⇒ the label describes a minority of the cluster. Catches
  **single-member misrepresentation**.
- **Specificity (precision)** =
  `|members whose blob contains the label| / |all repo files whose blob contains the label|`
  Low specificity ⇒ the term is everywhere. Catches **framework idioms**.
- **F1** = harmonic mean of coverage and specificity (`0` if either is `0`).
  Aggregate across clusters → the corpus metric.

Specificity is exactly what `pickFrameLabel` never optimizes for, so the metric
is genuinely non-circular — not a re-check of the stop-list.

**Multi-word labels:** a file "contains the label" only if **all** the label's
words are present in that file's token set (strict AND). A label must
characterize the file as a whole; partial-credit averaging would reward a word
that does not apply.

### The one blind spot (documented, not solved)

A content-only metric cannot distinguish a *layer marker* from a *domain label*
when both are accurate. If a cluster genuinely is `app/controllers/*`, then
"controllers" scores high coverage **and** high specificity — the metric calls
it good, though it is a structural-layer word, not domain-informative. This
distinction ("controllers" vs "billing") is irreducibly semantic and no token
count resolves it. This is the explicit limitation of the deterministic gate; it
is characterized (not eliminated) by the intruder-detection validator below.

## Architecture

Two layers, matching the "gate built on a diagnostic" decision:

1. The **deterministic F1 metric** is both the diagnostic and the regression
   gate.
2. An **offline LLM intruder-detection validator** confirms the F1 score tracks
   a semantically-grounded measure of label discriminativeness, and characterizes
   the residual blind spot. It earns trust in the cheap deterministic gate. It is
   run manually and is **not** part of CI or the gate computation.

### Components

**1. New pure module: `src/frame-extraction/label-quality.ts`**

No file/DB/network I/O. Depends only on `types` and `pickFrameLabel`.

- `buildCorpusIndex(blobs: FileBlob[]): CorpusIndex`
  Returns `{ tokensByPath: Map<string, Set<string>>, df: Map<string, number> }`.
  Tokenization: lowercase, split `blob.text` on whitespace (the blob is already a
  space-separated token string). `df` is single-term document frequency
  (files-per-term) across the whole corpus — a fast path for the common
  single-word label; `tokensByPath` is the authoritative source for multi-word
  labels.
- `scoreLabel(label: string, memberPaths: readonly string[], idx: CorpusIndex): LabelScore`
  Returns `{ label, terms: string[], coverage, specificity, f1 }`.
  `terms` = the label lowercased and split on whitespace.
  A path "contains the label" iff every term is in `idx.tokensByPath.get(path)`.
  Specificity denominator = number of files whose blob contains **all** terms:
  for a single-term label this is `idx.df.get(term)`; for a multi-word label it
  is the co-occurrence count derived by scanning `tokensByPath`.
- `scoreClusters(clusters, topTokensPerCluster, idx): ClusterLabelScore[]`
  For each non-noise cluster: `pickFrameLabel(...)` → `scoreLabel(...)`, carrying
  `cluster_id` and `member_count`.
- `aggregateLabelQuality(scores): LabelQualityAggregate`
  Returns `{ f1_mean, f1_weighted, coverage_mean, specificity_mean, clusters_below: number }`
  where `f1_weighted` weights each cluster's F1 by its member count and
  `clusters_below` counts clusters under a configurable F1 floor (default `0.5`,
  used only for diagnostics, not the gate).

**2. Wire into `scripts/frame-extraction/eval-all.ts`**

`runTfIdfHdbscan` already returns `blobs_path` (a JSONL of `FileBlob`). After the
existing `checkLabelQuality` call, read that file, `buildCorpusIndex`,
`scoreClusters`, `aggregateLabelQuality`, and extend `RepoEvalRow` with:
`label_f1_mean`, `label_f1_weighted`, `label_coverage_mean`,
`label_specificity_mean`, `clusters_below_f1`. The existing
`label_violations` / `violation_rules` fields stay.

**3. Baseline + gate**

Extend the committed baseline snapshot with the new fields. The gate fails when
the corpus `f1_weighted` regresses below `baseline − ε`. **No hard threshold is
chosen blind** — the first deliverable reports the metric and writes the
baseline; the regression `ε` and any absolute floor are set in a follow-up once
real corpus numbers exist.

**4. Offline LLM intruder-detection validator: `scripts/frame-extraction/validate-label-quality.ts`**

Manual, isolated, not in CI, shares no code with the gate. It does **not** ask
the LLM for a subjective goodness rating (unfalsifiable, and circular if the LLM
reasons from the same paths). Instead it gives the LLM a task with an objective
answer drawn from data we already have — **cluster membership** — and measures
its accuracy. We never need a "correct label" (which is subjective and which we
do not have).

This is the intruder-detection paradigm (Chang et al., "Reading Tea Leaves"),
the field-standard for topic/cluster-label evaluation, applied to labels:

- For each non-noise cluster `C` with generated label `L`: sample ~5 real member
  files of `C` plus **1 intruder** file drawn from a *different* cluster.
  Present `L` + the file set (paths **and** small content snippets, size-capped
  to fit context) and ask: *"which file does not fit a group described by `L`?"*
- The correct answer is the intruder — known from **membership**, not from any
  label judgment.
- Structured output per trial:
  `{ cluster_id, intruder_path, chosen_path, correct: boolean }`.
- The signal is **intruder-detection accuracy** aggregated across clusters (run
  multiple trials per cluster with different intruders to reduce variance).

What this measures and why it is the right basis:

- A discriminative label (`"authentication"`) lets the LLM exclude a non-member
  (`billing/invoice.ts`); a vague/idiom label (`"typescript"`, `"index"`)
  does not → low accuracy exposes it. The label is the decision lens, so accuracy
  reflects label quality, not just cluster coherence.
- It is the **semantic mirror of the deterministic metric**: F1 uses literal
  token-presence as the matcher to test whether the label discriminates members;
  this uses semantic understanding as the matcher against the same membership
  ground truth. Agreement ⇒ F1 is a validated proxy. Divergence ⇒ F1's blind
  spots are *measured*, not guessed.
- It directly probes the **layer-marker blind spot**: an optional "hard intruder"
  variant draws the intruder from the *same structural layer but a different
  domain* (e.g. a controller from another cluster against a `"controllers"`
  label). A layer-marker label cannot exclude it → low accuracy, surfacing
  exactly the case F1 scores as good.

Output: a report of intruder-detection accuracy per cluster and corpus-wide,
correlated against the deterministic F1. Results inform the gate threshold and
any future structural-token penalty. Skipped for corpora with fewer than two
clusters (no intruder source).

**5. Tests (TDD): `tests/frame-extraction/label-quality.test.ts`**

Synthetic clusters covering: perfect convention (high coverage + specificity),
framework idiom (high coverage, low specificity), single-member token (low
coverage), multi-word label (strict AND), label absent from all blobs
(specificity `0`, flagged), empty cluster / empty corpus edge cases.

## Data flow

```
runTfIdfHdbscan → { result: ClusterResult, blobs_path }
  blobs_path (JSONL of FileBlob)         → buildCorpusIndex → CorpusIndex
  result.clusters                         ┐
  result.parameters.top_tokens_per_cluster ┘ → scoreClusters → ClusterLabelScore[]
                                              → aggregateLabelQuality → RepoEvalRow fields
                                              → eval-all.json (+ baseline snapshot)
```

The intruder-detection validator consumes the same `ClusterLabelScore[]` +
member paths (and samples content snippets) out-of-band; it does not touch the
gate path.

## Module boundaries

- `label-quality.ts` — pure, unit-tested, no I/O. What it does: scores labels
  against the corpus token distribution. Depends on: `types`, `pickFrameLabel`.
- `eval-all.ts` — owns all file I/O (reading blobs, writing the report).
- `validate-label-quality.ts` — fully isolated LLM path; depends on the Anthropic
  SDK and the eval output, nothing in the gate.

## Relationship to the existing `checkLabelQuality`

`checkLabelQuality` stays as a cheap structural guard, but this design documents
it as **circular** and explicitly **not** the quality signal. The F1 metric is
the independent signal. Retiring or repurposing `checkLabelQuality` once F1 + the
judge are trusted is **out of scope** here.

## Scope / non-goals

- No new clustering or labeler behavior changes; `pickFrameLabel` is unchanged.
- No hard gate threshold chosen in this change (baseline + reported metric only).
- The layer-marker/domain semantic distinction is characterized, not solved.
- Embedding-based scoring and a human gold set were considered and rejected as
  the anchor (model noise on word-vs-code embeddings; gold-set brittleness as
  cluster membership shifts between runs).
