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
   the residual blind spot. It earns trust in the cheap deterministic gate. It
   runs **corpus-wide** (pooling clusters across all corpus repos — one repo is
   too few data points to establish a correlation), as an **opt-in phase of the
   eval runner**, manually, and is **not** part of CI or the gate computation.
   It is an **internal calibration tool**: it validates the shared labeler +
   metric once over a representative corpus; it is never run per-user and never
   ships to users (see Scope / non-goals).

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

**4. Offline LLM intruder-detection validator: opt-in `--validate` phase of `eval-all.ts` + a lazy-loaded module `scripts/frame-extraction/validate-labels.ts`**

Runs **corpus-wide** as an opt-in phase of the eval runner: `npm run eval:frames`
is the gate path and never touches the LLM; `npm run eval:frames -- --validate`
reuses the *same single* clone+index+cluster pass over the corpus and, per repo,
runs the intruder step. The Anthropic SDK and the validator module are
**lazy-loaded** (dynamic `import()`) only when `--validate` is set, so the default
gate path never loads the SDK — isolation is preserved in practice without
re-cloning the corpus a second time (large fixtures like `saleor` are expensive).

It does **not** ask the LLM for a subjective goodness rating (unfalsifiable, and
circular if the LLM reasons from the same paths). Instead it gives the LLM a task
with an objective answer drawn from data we already have — **cluster
membership** — and measures its accuracy. We never need a "correct label" (which
is subjective and which we do not have).

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

**Cost bound:** corpus-wide means one LLM call per sampled cluster across every
repo — potentially hundreds. The phase caps trials per repo
(`--validate-sample N`, default 15) and **logs how many clusters were sampled vs
skipped** (no silent truncation). Calls run sequentially or with a small
concurrency cap.

**Correlation / output:** pool every `(f1, intruder_found)` pair across the whole
corpus and report (a) overall intruder-detection accuracy, (b) accuracy split by
F1 band — below vs at/above the `0.5` floor — which is the interpretable headline
("do low-F1 labels actually fail more often?"), and (c) the **blind-spot list**:
clusters with high F1 but a missed intruder (suspected layer-marker /
non-discriminative labels). A point-biserial correlation coefficient is a
nice-to-have but the band split is the robust signal at modest sample sizes.
Results inform the gate threshold and any future structural-token penalty.
Skipped for a repo with fewer than two clusters (no intruder source).

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

Under `--validate`, the same per-repo `ClusterLabelScore[]` + member paths feed
the intruder phase, which additionally reads content snippets and calls the LLM.
The default (no-flag) run never enters this path.

## Module boundaries

- `label-quality.ts` — pure, unit-tested, no I/O. What it does: scores labels
  against the corpus token distribution. Depends on: `types`, `pickFrameLabel`.
- `intruder.ts` — pure, unit-tested, no I/O, no LLM. Builds intruder trials from
  clusters (membership = ground truth); seedable for determinism.
- `eval-all.ts` — owns the corpus loop + all file I/O (reading blobs, writing the
  report). Under `--validate` it lazy-imports the SDK and the validator glue;
  the default gate path imports neither.
- `validate-labels.ts` — the lazy-loaded LLM glue: given trials + labels, calls
  Claude and scores intruder accuracy. Depends on the Anthropic SDK; reached only
  via the `--validate` dynamic import.

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
- **The LLM validator is internal-only and never runs per-user.** It validates
  the *shared labeler + the F1 metric* (both shared code) once over a
  representative corpus; users running the same labeler inherit that confidence
  with zero LLM cost. Requiring per-user LLM calls during frame extraction
  (API key, network, cost, nondeterminism) is an explicit non-goal — frame
  extraction stays cheap and offline. The deterministic F1 is the only part that
  *could* later generalize to an in-product per-label confidence signal; that is
  out of scope here.
- **Generalization assumption:** this trusts that the corpus (spanning the
  Next.js / Django / Rails / Nuxt archetypes) is representative of users' repos.
  A repo structurally unlike anything in the corpus is not strictly covered;
  broadening the corpus, not per-user validation, is the remedy.

## Phase B run outcome (2026-06-06) — the validator is confounded; redesign needed

First corpus-wide `--validate` run (Sonnet 4.6, 122 trials over 11 repos):

- Overall intruder-detection accuracy **0.877**.
- F1≥0.5 band **0.919** vs F1<0.5 band **0.833** — nearly flat.
- Point-biserial **r(F1, intruder_found) = 0.077** ≈ zero.

At face value this reads as "F1 is far too harsh." **That conclusion is unsafe**,
because the test is confounded by **cluster coherence**: the LLM is shown the
label *and* the candidate file contents, so when a cluster is visually coherent
it identifies the intruder from the files regardless of label informativeness.
The proof: both trials whose label was the opaque `cluster:N` fallback (zero
label information) were solved **100%**, and near-zero-F1 trials solved at 75%.
A meaningless label cannot help — so the LLM is not relying on the label.

**Therefore the intruder-detection validator, as built, measures cluster
coherence rather than label quality, and cannot adjudicate whether F1's
specificity component is too harsh.** The large "F1<0.5 but intruder found"
bucket (`demo`, `examples`, `composables`, …) is confounded and is not evidence
of harshness.

**Recommended redesign (Phase B.2):** remove the LLM's ability to lean on
inter-file similarity. Instead of "which of these N does not belong" (a
comparison that invites coherence-spotting), present **one candidate at a
time** — *"does the label `X` describe this file? yes/no"* — and score the
label-as-predicate against membership (members → yes, sampled non-members →
no). The label is then the only basis for the decision, so an opaque `cluster:N`
can no longer score above chance. A "hard intruder" drawn from the same
structural layer but a different domain would further stress layer-marker
labels, but per-candidate judgment is the fundamental fix.

The deterministic F1 metric and gate (Phase A) are unaffected by this finding —
they remain a defensible label metric; what is deferred is the *independent
validation* of that metric, pending the Phase B.2 redesign.
