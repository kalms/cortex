# Research Report — Label-Quality Verdict, Path-Ordered Rendering, and the F1 Gate

**Type:** Research report (empirical analysis of an existing metric + three changes it justified).
**Date:** 2026-06-07
**Author:** Claude (Opus 4.8, 1M context) + rka
**Subject:** Frame-extraction label quality — adjudicating whether the deterministic label-F1 metric is "too harsh," and two changes (path-ordered label rendering, F1 regression gate) plus one downstream fix (viewer membership matching) that followed from the finding.
**Spec:** [2026-06-06-label-quality-signal-design.md](../superpowers/specs/2026-06-06-label-quality-signal-design.md)
**Decisions:** `11c742ec` (path-ordered labels), `ccd1ab6c` (viewer membership matching), `2990a57e` (F1 regression gate). Supersedes the Phase-B.2 direction in `8d2ced0c`.
**Outcome:** **The F1 metric is sound, not too harsh.** Low scores correctly flag genuinely-vague labels. The LLM validator (Phase B.2) is unnecessary to make this call. Three changes shipped off the finding.

---

## Question

The prior session (label-quality arc) shipped a deterministic label-quality metric — each cluster's label scored as a corpus classifier, **coverage × specificity → F1**, where specificity (precision over the whole repo) is the non-circular axis `pickFrameLabel` never optimizes. It then built an LLM intruder-detection validator (Phase B) to *independently* check the metric, and found the validator **confounded by cluster coherence** (it measured whether the clustering was coherent, not whether the label was good — opaque `cluster:N` labels scored 100%). So the central question was left open:

> **Is the F1 specificity axis too harsh?** The corpus had a large "F1 < 0.5 but the cluster is clearly coherent" bucket (`demo`, `examples`, `composables`…). Is that the metric being unfair to good labels, or is it correctly flagging weak labels?

The handoff's proposed next step was **Phase B.2** — rebuild the validator per-candidate. Before investing in that, we tested a cheaper hypothesis: *the metric is already right, and a manual read of the low-F1 clusters will show it.*

## Method

**No pipeline re-run.** The eval harness caches, per repo, the cluster assignments (`.tmp/frame-extraction/clusters/<project>.json`, including `parameters.top_tokens_per_cluster`) and the per-file token blobs (`.tmp/frame-extraction/blobs/<project>.jsonl`). That is exactly the input `scoreClusters`/`buildCorpusIndex` consume. So per-cluster label scores were reconstructed **offline and deterministically** using the *real production scoring code* — clustering nondeterminism is frozen out because the cached assignments are reused verbatim.

The reconstruction (an ad-hoc probe; the core is reproducible from this snippet):

```ts
import { buildCorpusIndex, scoreClusters } from "src/frame-extraction/label-quality.js";
// for each cached repo:
const blobs = readJSONL(`blobs/${base}.jsonl`);              // FileBlob[]
const cj    = readJSON(`clusters/${base}.json`);             // { clusters, parameters }
const scores = scoreClusters(cj.clusters, cj.parameters.top_tokens_per_cluster,
                             buildCorpusIndex(blobs));        // ClusterLabelScore[]
// inspect scores where f1 < 0.5: label, coverage, specificity, member sample paths
```

Three analyses were run over the 11-repo corpus this way: (1) read every sub-0.5 cluster's label against its member files; (2) measure, for every two-word label, whether the word order matches directory nesting; (3) compute the corpus F1 distribution to ground a regression gate.

## Results

### 1. Corpus F1 distribution (258 real clusters)

```
min 0.000 · p25 0.147 · median 0.468 · p75 0.833 · max 1.000
histogram [0,.1,.2,…,1.0]:  46 33 17 16 25 19 14 14 25 49
below 0.5: 137 clusters
```

**Bimodal** — tall bars at both ends (46 near-zero, 49 near-one). Labels are mostly either clearly good or clearly vague, not a smear of borderline-harsh cases.

### 2. What the sub-0.5 clusters actually are

Reading all 137: the low scores are **overwhelmingly correct**. The labels that score low are genuinely non-characterizing:

| Pattern | Examples (label · cov · spec) | Why low F1 is right |
|---|---|---|
| **Repo name** | `saleor` ×~20 clusters (cov 1.00 · spec 0.00) | The repo name is in nearly every file — zero discriminating power |
| **Directory name** | `examples` (TanStack/peft/nuxt/trpc), `demo` (vueuse), `migrate`, `content` | Names file *location*, not function |
| **Framework/tech tag** | `react`, `angular`, `vue`, `graphql`, `runtime` | A tech tag, not a cluster identity |
| **Garbage token** | `auto` (from migration filenames `0002_auto_…`) | Not a concept |
| **Opaque fallback** | `cluster:3`, `cluster:8`, `cluster:15` (f1 0.000) | Correctly zero by construction |

The single genuine sliver of harshness: **multi-word labels where one term saturates the repo** — `TableDevtools`/`table-core` in a *table* library score ~0.10–0.18 because "table" appears in half the files, inflating the specificity denominator. Real, but narrow, and does not change the verdict.

**Artifacts surfaced (each minor, logged for later):**
- nuxt `composables` cluster scores **coverage 0.00** — the label token is absent from every member blob (a path/tokenization edge worth a look).
- Duplicate `member_paths` (saleor/TanStack/trpc) inflate clusters (monorepo dup files upstream).
- trpc fragments generated `.gen.ts` into **9 near-identical `routers` clusters**.

### 3. Two-word label order vs directory nesting (173 two-word labels)

For each two-word label, each word was located by its earliest matching path segment across members; the tally of which word is the **ancestor** directory:

```
word1 is ancestor (label order already = path order) : 136  (79%)
word2 is ancestor (label order REVERSED vs path)     :   2  (~1%)
tie / same path segment                              :  34  (20%)
neither word locatable in paths                      :   1
```

So `word1/word2` is faithful to real containment ~99% of the time. The two reversals were nuxt `get api` (paths nest `api/` above `get/` → `api/get` is correct) and one weak saleor case. The 20% "same segment" cases are compound terms living in one directory (`react query` → `react-query`, `frame extraction` → `frame-extraction`), where a slash would imply a hierarchy that doesn't exist.

## Findings

1. **The F1 metric is doing its job.** A coherent cluster of `*/demo.vue` files labeled `demo` *should* score low on specificity — `demo` is a location, not a concept. The large "coherent but low-F1" bucket is **not** evidence of harshness; it's the metric correctly flagging that `pickFrameLabel` emits weak labels. The prior session's worry that "F1 specificity is too harsh" is **refuted by construction**: the labels in that bucket are, on inspection, genuinely uninformative.

2. **Phase B.2 is unnecessary for this decision.** The open question was adjudicated by a cheap manual read; rebuilding the LLM validator per-candidate is not on the critical path. (It remains optional if independent validation of the metric is ever wanted for its own sake.)

3. **The real lead the metric surfaced is `pickFrameLabel`.** The low scores are diagnosing the label *picker*, not the metric. The biggest bucket is the repo name; then structural directory names; then framework tags.

4. **Two-word labels carry a real, recoverable hierarchy.** 79% already encode an ancestor→descendant directory relationship in their word order; rendering them path-like (`saleor/graphql`) makes that legible, and deriving the order from the paths (rather than trusting the TF-IDF n-gram order) fixes the ~1% reversals for free.

## What shipped from this

- **Path-ordered label rendering** (decision `11c742ec`). `pickFrameLabel` now renders multi-word labels path-like: words ordered ancestor-first by earliest path segment, `/` for genuine hierarchy, `-` for same-segment compounds. Display-only and **metric-safe** — `splitSymbol` already treats `/` and `-` as token boundaries, so F1 tokenizes identically to the spaced form. Post-change corpus tally: **137 slash / 36 hyphen / 1 spaced-fallback / 81 single-word** labels; F1 distribution unchanged (smoke Δ −0.001, see below).

- **Viewer membership matching** (decision `ccd1ab6c`). A consumer trace for the slash change found the viewer matched decision-governed file paths to frames with `path.startsWith(frameLabel + '/')` — conflating a *label* with a real path, fragile and made worse once labels contain `/`. Replaced with cluster-membership matching (`buildFramePathIndex`/`frameIdForPath` in `adapters.js`): resolve a governed path to the frame that actually *contains* the file. Verified with unit tests + Gate-0 visual QA.

- **F1 regression gate** (decision `2990a57e`). Grounded in the baseline distribution below.

### Baseline grounding for the gate

Committed baseline (`baselines/2026-06-06.json`), weighted-F1 per repo:

```
self/cortex 0.643 · vueuse 0.511 · TanStack/table 0.557 · trpc 0.529 · nuxt/ui 0.474
spf13/cobra 0.000 (0 clusters!) · pallets/click 0.678 · huggingface/peft 0.499
saleor 0.361 · rubygems 0.639 · private-monorepo 0.723
mean over 11 = 0.510   |   mean over 10 (excluding cobra's 0-cluster collapse) = 0.561
```

`cobra` at 0.000 with **0 clusters** is the design tell: it is a clustering *collapse* (HDBSCAN nondeterminism), not a label regression. A per-repo gate, or an aggregate that includes degenerate runs, would be perpetually flaky. The shipped gate therefore: compares the **corpus mean over repos common to both runs**, **excludes 0-cluster runs**, only **enforces** (exit 3) at ≥3 comparable repos, and fails on **>0.05 mean regression** or a **<0.45 mean floor** (≈0.11 headroom under the 0.561 comparable baseline). Smoke (committed baseline vs last cached run): 10 comparable repos, **0.561 vs 0.562 → pass**.

## Recommendation / next

1. **Improve `pickFrameLabel`** (the lead from Finding 3). Caveat for whoever picks this up: `pickFrameLabel` only sees *member* paths, not the whole repo, so it cannot measure true specificity itself — the repo name has member-salience 1.0, identical to a good label, which is why the existing salience gate can't catch it. Approaches, cheapest first: (a) **repo-name suppression** (pass the project name in, exclude it as a label term — kills the biggest bucket); (b) + structural-dir stop-list expansion (`examples`, `demo`, `content`, `migrate` — but these are sometimes the only label, risking `cluster:N` fallbacks); (c) plumb corpus document-frequency into `pickFrameLabel` for specificity-aware candidate selection (most principled, larger pipeline change). **Any of these raises F1 → regenerate the committed baseline afterward to lock the gain.**
2. **The metric and gate are trustworthy as-is** — no change needed before pursuing (1); the gate will catch a regression and the raised baseline will lock an improvement.

## Reproduction

The analyses ran from the eval cache (`.tmp/frame-extraction/clusters/` + `blobs/`) via the snippet in *Method* — no clone/index/cluster needed while the cache persists. The gate smoke is `evaluateF1Gate(currentRows, baselineRows)` from `src/frame-extraction/eval-gate.ts` (8 unit tests in `tests/frame-extraction/eval-gate.test.ts`). The probe scripts themselves were ad-hoc and not committed; the method above is sufficient to recreate them.
