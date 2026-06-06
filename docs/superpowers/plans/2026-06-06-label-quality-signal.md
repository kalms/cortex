# Label-Quality Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent, deterministic label-quality metric to the frame-extraction eval (label-as-classifier: coverage × specificity / F1), breaking the circular `checkLabelQuality`, plus an offline LLM intruder-detection validator that earns trust in the cheap metric.

**Architecture:** A pure module `src/frame-extraction/label-quality.ts` scores each cluster's `pickFrameLabel` output against the full per-file token blob (path + content), measuring coverage (recall over members) and specificity (precision over the whole repo). `scripts/frame-extraction/eval-all.ts` reads the blobs JSONL it already produces, computes per-repo aggregates, and writes them into each `RepoEvalRow`. A separate offline script runs intruder detection (ground truth = cluster membership) and correlates its accuracy with the deterministic F1.

**Tech Stack:** TypeScript (tsx, vitest), the existing frame-extraction harness; Phase B adds `@anthropic-ai/sdk`.

**Spec:** [docs/superpowers/specs/2026-06-06-label-quality-signal-design.md](../specs/2026-06-06-label-quality-signal-design.md)

**Phasing:** Phase A (Tasks 1–6) is the deterministic metric — complete, testable, no new dependencies; this is the recommended first execution pass and an independently shippable deliverable. Phase B (Tasks 7–9) is the offline validator — adds `@anthropic-ai/sdk`, runs manually, never in CI.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/frame-extraction/label-quality.ts` | **New.** Pure: build corpus token index, score a label as a classifier (coverage/specificity/F1), score all clusters, aggregate. No I/O. | Create |
| `tests/frame-extraction/label-quality.test.ts` | **New.** Unit tests over synthetic blobs/clusters. | Create |
| `scripts/frame-extraction/eval-all.ts` | Read `blobs_path`, build index, score clusters, extend `RepoEvalRow` + log line. | Modify |
| `scripts/frame-extraction/intruder.ts` | **New (Phase B).** Pure: build intruder-detection trials from clusters + blobs (seedable). No I/O, no LLM. | Create |
| `tests/frame-extraction/intruder.test.ts` | **New (Phase B).** Unit tests for trial construction. | Create |
| `scripts/frame-extraction/validate-label-quality.ts` | **New (Phase B).** Offline orchestrator: build trials, call Claude, score accuracy, correlate with F1. | Create |
| `package.json` | Add `@anthropic-ai/sdk` + `eval:labels:validate` script alias (Phase B). | Modify |

`label-quality.ts` lives in `src/` (pure, unit-tested, may be reused beyond the eval); the orchestrators that do I/O / LLM calls stay in `scripts/`. This mirrors the existing `eval-labels.ts` (src) vs `eval-all.ts` (scripts) split.

---

## Reference contracts (already in the codebase — do not redefine)

```ts
// src/frame-extraction/types.ts
export interface FileBlob { path: string; text: string; }        // text = space-separated tokens (path + identifiers + structural)
export interface ClusterAssignment { cluster_id: number; member_paths: string[]; }  // cluster_id -1 = HDBSCAN noise

// src/frame-extraction/inject-frames.ts
export function pickFrameLabel(
  topTokens: readonly string[],
  memberPaths: readonly string[],
  clusterId?: number,
): string;
```

`runTfIdfHdbscan(...)` (in `src/frame-extraction/cluster-tfidf-hdbscan.ts`) returns
`{ result: ClusterResult, out_path: string, blobs_path: string }`. `blobs_path` is a
JSONL file, one `FileBlob` per line. `eval-all.ts` already extracts top tokens via
`(result.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>`.

---

# Phase A — Deterministic metric

## Task 1: Corpus index (`buildCorpusIndex`)

**Files:**
- Create: `src/frame-extraction/label-quality.ts`
- Test: `tests/frame-extraction/label-quality.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/frame-extraction/label-quality.test.ts`:

```ts
// tests/frame-extraction/label-quality.test.ts
import { describe, it, expect } from "vitest";
import { buildCorpusIndex } from "../../src/frame-extraction/label-quality.js";
import type { FileBlob } from "../../src/frame-extraction/types.js";

const blobs: FileBlob[] = [
  { path: "a/auth/login.ts", text: "a auth login authentication session" },
  { path: "a/auth/oauth.ts", text: "a auth oauth authentication token" },
  { path: "a/billing/invoice.ts", text: "a billing invoice payment" },
];

describe("buildCorpusIndex", () => {
  it("indexes lowercased tokens per path and single-term document frequency", () => {
    const idx = buildCorpusIndex(blobs);
    expect(idx.tokensByPath.get("a/auth/login.ts")?.has("authentication")).toBe(true);
    expect(idx.df.get("authentication")).toBe(2); // login.ts + oauth.ts
    expect(idx.df.get("a")).toBe(3);              // all three
    expect(idx.df.get("invoice")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t buildCorpusIndex`
Expected: FAIL — `buildCorpusIndex` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

`src/frame-extraction/label-quality.ts`:

```ts
// src/frame-extraction/label-quality.ts
/**
 * Independent, deterministic label-quality metric for the frame-extraction eval.
 *
 * Scores each cluster's label as a CLASSIFIER of the corpus, measured against
 * the full per-file token blob (path + content). Coverage (recall over members)
 * + specificity (precision over the whole repo) → F1. Specificity is the part
 * `pickFrameLabel` never optimizes for, so this is non-circular.
 *
 * PURE module: no file/DB/network I/O. Inputs in, scores out.
 */
import { pickFrameLabel } from "./inject-frames.js";
import type { ClusterAssignment, FileBlob } from "./types.js";

export interface CorpusIndex {
  /** Per-file token set, lowercased. */
  tokensByPath: Map<string, Set<string>>;
  /** Single-term document frequency (files containing the term). */
  df: Map<string, number>;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

export function buildCorpusIndex(blobs: readonly FileBlob[]): CorpusIndex {
  const tokensByPath = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const b of blobs) {
    const set = new Set(tokenize(b.text));
    tokensByPath.set(b.path, set);
    for (const term of set) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return { tokensByPath, df };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t buildCorpusIndex`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/label-quality.ts tests/frame-extraction/label-quality.test.ts
git commit -m "feat(frames): corpus token index for label-quality metric"
```

---

## Task 2: Score a label as a classifier (`scoreLabel`)

**Files:**
- Modify: `src/frame-extraction/label-quality.ts`
- Test: `tests/frame-extraction/label-quality.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/frame-extraction/label-quality.test.ts`:

```ts
import { scoreLabel } from "../../src/frame-extraction/label-quality.js";

describe("scoreLabel", () => {
  // Corpus: 3 auth files all contain "authentication"; nothing else does.
  const idx = buildCorpusIndex([
    { path: "auth/a.ts", text: "auth a authentication" },
    { path: "auth/b.ts", text: "auth b authentication" },
    { path: "auth/c.ts", text: "auth c authentication" },
    { path: "billing/x.ts", text: "billing x payment" },
    { path: "billing/y.ts", text: "billing y payment" },
  ]);

  it("scores a perfect, distinctive label 1.0", () => {
    const s = scoreLabel("authentication", ["auth/a.ts", "auth/b.ts", "auth/c.ts"], idx);
    expect(s.coverage).toBe(1);
    expect(s.specificity).toBe(1);
    expect(s.f1).toBe(1);
  });

  it("penalises a framework idiom (high coverage, low specificity)", () => {
    // "auth" is in all 3 members but the label is applied to a cluster of 2;
    // build a corpus where the term leaks everywhere.
    const leak = buildCorpusIndex([
      { path: "m/1.ts", text: "index one" },
      { path: "m/2.ts", text: "index two" },
      { path: "other/3.ts", text: "index three" },
      { path: "other/4.ts", text: "index four" },
    ]);
    const s = scoreLabel("index", ["m/1.ts", "m/2.ts"], leak);
    expect(s.coverage).toBe(1);        // both members have "index"
    expect(s.specificity).toBe(0.5);   // 2 of 4 corpus files with "index" are members
    expect(s.f1).toBeCloseTo(2 / 3, 5);
  });

  it("penalises a single-member label (low coverage)", () => {
    const s = scoreLabel("payment", ["billing/x.ts", "billing/y.ts", "auth/a.ts"], idx);
    // "payment" in 2 of 3 members, and only those 2 files in the whole corpus.
    expect(s.coverage).toBeCloseTo(2 / 3, 5);
    expect(s.specificity).toBe(1);
    expect(s.f1).toBeCloseTo(0.8, 5);
  });

  it("requires ALL words of a multi-word label (strict AND)", () => {
    const m = buildCorpusIndex([
      { path: "u/1.ts", text: "user model alpha" },
      { path: "u/2.ts", text: "user model beta" },
      { path: "u/3.ts", text: "user only" }, // has "user" but not "model"
    ]);
    const s = scoreLabel("user model", ["u/1.ts", "u/2.ts", "u/3.ts"], m);
    expect(s.coverage).toBeCloseTo(2 / 3, 5); // only 2 contain both words
    expect(s.specificity).toBe(1);
  });

  it("returns zeros when the label appears in no file", () => {
    const s = scoreLabel("nonexistent", ["auth/a.ts"], idx);
    expect(s.coverage).toBe(0);
    expect(s.specificity).toBe(0);
    expect(s.f1).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t scoreLabel`
Expected: FAIL — `scoreLabel` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/frame-extraction/label-quality.ts`:

```ts
export interface LabelScore {
  label: string;
  terms: string[];
  /** Recall over the cluster's members. */
  coverage: number;
  /** Precision over the whole repo. */
  specificity: number;
  f1: number;
}

function pathHasAllTerms(idx: CorpusIndex, path: string, terms: readonly string[]): boolean {
  const set = idx.tokensByPath.get(path);
  if (!set) return false;
  return terms.every((t) => set.has(t));
}

function countFilesWithAllTerms(idx: CorpusIndex, terms: readonly string[]): number {
  let n = 0;
  for (const set of idx.tokensByPath.values()) {
    if (terms.every((t) => set.has(t))) n++;
  }
  return n;
}

export function scoreLabel(
  label: string,
  memberPaths: readonly string[],
  idx: CorpusIndex,
): LabelScore {
  const terms = label.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const membersWith = memberPaths.filter((p) => pathHasAllTerms(idx, p, terms)).length;
  // Single-term fast path uses df; multi-word scans for co-occurrence.
  const filesWith =
    terms.length === 1 ? idx.df.get(terms[0]!) ?? 0 : countFilesWithAllTerms(idx, terms);

  const coverage = memberPaths.length > 0 ? membersWith / memberPaths.length : 0;
  const specificity = filesWith > 0 ? membersWith / filesWith : 0;
  const f1 =
    coverage + specificity > 0 ? (2 * coverage * specificity) / (coverage + specificity) : 0;
  return { label, terms, coverage, specificity, f1 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t scoreLabel`
Expected: PASS (all 5 cases)

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/label-quality.ts tests/frame-extraction/label-quality.test.ts
git commit -m "feat(frames): score a label as a corpus classifier (coverage x specificity)"
```

---

## Task 3: Score all clusters (`scoreClusters`)

**Files:**
- Modify: `src/frame-extraction/label-quality.ts`
- Test: `tests/frame-extraction/label-quality.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/frame-extraction/label-quality.test.ts`:

```ts
import { scoreClusters } from "../../src/frame-extraction/label-quality.js";
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

describe("scoreClusters", () => {
  const idx = buildCorpusIndex([
    { path: "infra/main.tf", text: "infra main tf infrastructure" },
    { path: "infra/net.tf", text: "infra net tf infrastructure" },
    { path: "app/index.ts", text: "app index ts" },
  ]);

  it("scores each non-noise cluster and skips noise (-1)", () => {
    const clusters: ClusterAssignment[] = [
      { cluster_id: 0, member_paths: ["infra/main.tf", "infra/net.tf"] },
      { cluster_id: -1, member_paths: ["app/index.ts"] },
    ];
    const topTokens: Record<string, string[]> = { "0": ["infrastructure"], "-1": ["index"] };
    const scores = scoreClusters(clusters, topTokens, idx);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.cluster_id).toBe(0);
    expect(scores[0]!.member_count).toBe(2);
    expect(scores[0]!.f1).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t scoreClusters`
Expected: FAIL — `scoreClusters` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/frame-extraction/label-quality.ts`:

```ts
export interface ClusterLabelScore extends LabelScore {
  cluster_id: number;
  member_count: number;
}

export function scoreClusters(
  clusters: readonly ClusterAssignment[],
  topTokensPerCluster: Record<string, string[]>,
  idx: CorpusIndex,
): ClusterLabelScore[] {
  const out: ClusterLabelScore[] = [];
  for (const c of clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokensPerCluster[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id);
    const s = scoreLabel(label, c.member_paths, idx);
    out.push({ ...s, cluster_id: c.cluster_id, member_count: c.member_paths.length });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t scoreClusters`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/label-quality.ts tests/frame-extraction/label-quality.test.ts
git commit -m "feat(frames): score every cluster's pickFrameLabel output"
```

---

## Task 4: Aggregate (`aggregateLabelQuality`)

**Files:**
- Modify: `src/frame-extraction/label-quality.ts`
- Test: `tests/frame-extraction/label-quality.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/frame-extraction/label-quality.test.ts`:

```ts
import { aggregateLabelQuality } from "../../src/frame-extraction/label-quality.js";
import type { ClusterLabelScore } from "../../src/frame-extraction/label-quality.js";

describe("aggregateLabelQuality", () => {
  const mk = (cluster_id: number, member_count: number, f1: number): ClusterLabelScore => ({
    label: `c${cluster_id}`, terms: [`c${cluster_id}`], coverage: f1, specificity: f1, f1,
    cluster_id, member_count,
  });

  it("computes mean, member-weighted mean, and below-floor count", () => {
    const scores = [mk(0, 1, 1.0), mk(1, 9, 0.0)]; // tiny great cluster, big bad one
    const agg = aggregateLabelQuality(scores, 0.5);
    expect(agg.f1_mean).toBeCloseTo(0.5, 5);          // (1 + 0) / 2
    expect(agg.f1_weighted).toBeCloseTo(0.1, 5);       // (1*1 + 0*9) / 10
    expect(agg.clusters_below).toBe(1);
    expect(agg.cluster_count).toBe(2);
  });

  it("returns zeros for an empty score list", () => {
    const agg = aggregateLabelQuality([], 0.5);
    expect(agg).toEqual({
      f1_mean: 0, f1_weighted: 0, coverage_mean: 0, specificity_mean: 0,
      clusters_below: 0, cluster_count: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t aggregateLabelQuality`
Expected: FAIL — `aggregateLabelQuality` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/frame-extraction/label-quality.ts`:

```ts
export interface LabelQualityAggregate {
  f1_mean: number;
  /** F1 weighted by cluster member count. */
  f1_weighted: number;
  coverage_mean: number;
  specificity_mean: number;
  /** Number of clusters with f1 below the floor. */
  clusters_below: number;
  cluster_count: number;
}

export const DEFAULT_F1_FLOOR = 0.5;

export function aggregateLabelQuality(
  scores: readonly ClusterLabelScore[],
  f1Floor: number = DEFAULT_F1_FLOOR,
): LabelQualityAggregate {
  const n = scores.length;
  if (n === 0) {
    return {
      f1_mean: 0, f1_weighted: 0, coverage_mean: 0, specificity_mean: 0,
      clusters_below: 0, cluster_count: 0,
    };
  }
  const mean = (sel: (s: ClusterLabelScore) => number) =>
    scores.reduce((acc, s) => acc + sel(s), 0) / n;
  const totalMembers = scores.reduce((acc, s) => acc + s.member_count, 0);
  const f1_weighted =
    totalMembers > 0
      ? scores.reduce((acc, s) => acc + s.f1 * s.member_count, 0) / totalMembers
      : 0;
  return {
    f1_mean: mean((s) => s.f1),
    f1_weighted,
    coverage_mean: mean((s) => s.coverage),
    specificity_mean: mean((s) => s.specificity),
    clusters_below: scores.filter((s) => s.f1 < f1Floor).length,
    cluster_count: n,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts -t aggregateLabelQuality`
Expected: PASS

- [ ] **Step 5: Run the full label-quality test file**

Run: `npx vitest run tests/frame-extraction/label-quality.test.ts`
Expected: PASS (all describe blocks)

- [ ] **Step 6: Commit**

```bash
git add src/frame-extraction/label-quality.ts tests/frame-extraction/label-quality.test.ts
git commit -m "feat(frames): aggregate per-cluster label F1 into corpus metrics"
```

---

## Task 5: Wire the metric into `eval-all.ts`

**Files:**
- Modify: `scripts/frame-extraction/eval-all.ts`

The current code (around lines 117–151) destructures only `result` from
`runTfIdfHdbscan` and builds a `RepoEvalRow`. Extend it to read the blobs JSONL and
add the aggregate fields.

- [ ] **Step 1: Add imports**

At the top of `scripts/frame-extraction/eval-all.ts`, add to the existing import group:

```ts
import { buildCorpusIndex, scoreClusters, aggregateLabelQuality } from "../../src/frame-extraction/label-quality.js";
import type { CorpusFile, RepoSpec, ImportEdge, FileBlob } from "../../src/frame-extraction/types.js";
```

(The `FileBlob` import is added to the existing `types.js` import line — do not create a duplicate import statement.)

- [ ] **Step 2: Extend the `RepoEvalRow` interface**

Add these optional fields to the `RepoEvalRow` interface (alongside `label_violations`):

```ts
  label_f1_mean?: number;
  label_f1_weighted?: number;
  label_coverage_mean?: number;
  label_specificity_mean?: number;
  label_clusters_below_f1?: number;
```

- [ ] **Step 3: Capture `blobs_path` and compute the aggregate**

Change the `runTfIdfHdbscan` call to also destructure `blobs_path`:

```ts
    const { result, blobs_path } = runTfIdfHdbscan({
      repo_path: clone.path,
      project_name: project,
      db_path: graphDbPath,
    });
```

Then, immediately after the existing `const violations = checkLabelQuality(...)` block,
add:

```ts
    const blobs = readFileSync(blobs_path, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FileBlob);
    const corpusIndex = buildCorpusIndex(blobs);
    const labelScores = scoreClusters(result.clusters, topTokens, corpusIndex);
    const labelAgg = aggregateLabelQuality(labelScores);
```

(`readFileSync` is already imported at the top of the file; `topTokens` is the existing
local from the `checkLabelQuality` block.)

- [ ] **Step 4: Add the fields to the returned row**

In the `return { slug: repo.slug, ok: true, ... }` object, add:

```ts
      label_f1_mean: labelAgg.f1_mean,
      label_f1_weighted: labelAgg.f1_weighted,
      label_coverage_mean: labelAgg.coverage_mean,
      label_specificity_mean: labelAgg.specificity_mean,
      label_clusters_below_f1: labelAgg.clusters_below,
```

- [ ] **Step 5: Extend the success log line**

Change the success `console.log` (the one ending with `labelViol=${row.label_violations}`) to append the new headline number:

```ts
      console.log(
        `[eval-all]   ✓ clusters=${row.cluster_count} ` +
          `noise=${row.noise_rate?.toFixed(3)} ` +
          `agree=${agree === null || agree === undefined ? "—" : agree.toFixed(3)} ` +
          `labelViol=${row.label_violations} ` +
          `labelF1=${row.label_f1_weighted?.toFixed(3)}`,
      );
```

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: `tsc` exits 0 (no type errors).

- [ ] **Step 7: Smoke-run against one local fixture**

Run: `npx tsx scripts/frame-extraction/eval-all.ts --only self --keep`
Expected: completes; the `✓` line for the `self/cortex` fixture includes a `labelF1=…`
value in `[0,1]`. (Requires the Python venv — if absent, run `cortex setup frames` first;
if the environment can't run it, note that and hand-verify before merge.)

- [ ] **Step 8: Commit**

```bash
git add scripts/frame-extraction/eval-all.ts
git commit -m "feat(frames): emit independent label-F1 metric in eval-all"
```

---

## Task 6: Regenerate and commit the corpus baseline

**Files:**
- Modify/Create: the committed eval baseline JSON (the snapshot `eval:frames` writes)

> The gate threshold itself is deferred per the spec — this task only records the
> baseline numbers so a future change can set a regression ε. Do not add fail-on-regression
> logic here.

- [ ] **Step 1: Run the corpus eval to the default output**

Run: `npm run eval:frames`
Expected: writes `.tmp/frame-extraction/eval-all.json` with `label_f1_*` fields populated
per repo. (Skips/records per-repo failures without aborting.)

- [ ] **Step 2: Copy the snapshot into the committed baselines directory**

Run:
```bash
cp .tmp/frame-extraction/eval-all.json scripts/frame-extraction/baselines/2026-06-06.json
```
(If `scripts/frame-extraction/baselines/` does not exist, create it: `mkdir -p scripts/frame-extraction/baselines`.)

- [ ] **Step 3: Eyeball the numbers**

Open `scripts/frame-extraction/baselines/2026-06-06.json` and confirm each `ok: true`
row has `label_f1_weighted` in `[0,1]` and the values are plausible (convention-heavy
repos should score high). Note any obviously-bad outliers in the commit message — they
are the candidates the Phase B validator will scrutinise.

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/baselines/2026-06-06.json
git commit -m "chore(frames): baseline snapshot with label-F1 metric"
```

---

# Phase B — Offline intruder-detection validator

> Adds `@anthropic-ai/sdk` and makes real LLM calls. Runs manually; never part of CI
> or the deterministic gate. Requires `ANTHROPIC_API_KEY` in the environment.

## Task 7: Pure intruder-trial construction (`buildIntruderTrials`)

**Files:**
- Create: `scripts/frame-extraction/intruder.ts`
- Test: `tests/frame-extraction/intruder.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/frame-extraction/intruder.test.ts`:

```ts
// tests/frame-extraction/intruder.test.ts
import { describe, it, expect } from "vitest";
import { buildIntruderTrials } from "../../scripts/frame-extraction/intruder.js";
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

const clusters: ClusterAssignment[] = [
  { cluster_id: 0, member_paths: ["auth/a.ts", "auth/b.ts", "auth/c.ts", "auth/d.ts"] },
  { cluster_id: 1, member_paths: ["billing/x.ts", "billing/y.ts", "billing/z.ts"] },
  { cluster_id: -1, member_paths: ["noise/n.ts"] },
];

// Deterministic picker: always take the first eligible index.
const pickFirst = (n: number): number => 0;

describe("buildIntruderTrials", () => {
  it("builds one trial per non-noise cluster with a known intruder from another cluster", () => {
    const trials = buildIntruderTrials(clusters, { membersPerTrial: 3, pick: pickFirst });
    expect(trials).toHaveLength(2); // skips noise
    const t0 = trials.find((t) => t.cluster_id === 0)!;
    expect(t0.member_sample).toHaveLength(3);
    expect(t0.member_sample.every((p) => p.startsWith("auth/"))).toBe(true);
    expect(t0.intruder_path.startsWith("auth/")).toBe(false); // from another cluster
    expect(t0.candidates).toContain(t0.intruder_path);
    expect(t0.candidates).toHaveLength(4); // 3 members + 1 intruder
  });

  it("skips a cluster that cannot supply enough members", () => {
    const tiny: ClusterAssignment[] = [
      { cluster_id: 0, member_paths: ["a.ts"] },
      { cluster_id: 1, member_paths: ["b.ts", "c.ts"] },
    ];
    const trials = buildIntruderTrials(tiny, { membersPerTrial: 3, pick: pickFirst });
    expect(trials.find((t) => t.cluster_id === 0)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/intruder.test.ts`
Expected: FAIL — module not found / `buildIntruderTrials` not exported.

- [ ] **Step 3: Write minimal implementation**

`scripts/frame-extraction/intruder.ts`:

```ts
// scripts/frame-extraction/intruder.ts
/**
 * Pure construction of intruder-detection trials for offline label validation.
 *
 * Ground truth is cluster MEMBERSHIP (which the clustering already produced), not
 * a correct label. Each trial: a sample of one cluster's members + one intruder
 * drawn from a different cluster. A good label lets a reader exclude the intruder.
 *
 * No I/O, no LLM. `pick` is injectable for deterministic tests.
 */
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

export interface IntruderTrial {
  cluster_id: number;
  /** Sampled member paths of this cluster. */
  member_sample: string[];
  /** A path from a DIFFERENT cluster — the known correct answer. */
  intruder_path: string;
  /** member_sample + intruder, in a fixed order (intruder appended). */
  candidates: string[];
}

export interface BuildIntruderOptions {
  membersPerTrial: number;
  /** Returns an index in [0, n). Defaults to Math.random-based. */
  pick?: (n: number) => number;
}

export function buildIntruderTrials(
  clusters: readonly ClusterAssignment[],
  opts: BuildIntruderOptions,
): IntruderTrial[] {
  const pick = opts.pick ?? ((n: number) => Math.floor(Math.random() * n));
  const real = clusters.filter((c) => c.cluster_id !== -1);
  const trials: IntruderTrial[] = [];
  for (const c of real) {
    if (c.member_paths.length < opts.membersPerTrial) continue;
    const others = real.filter((o) => o.cluster_id !== c.cluster_id);
    const intruderPool = others.flatMap((o) => o.member_paths);
    if (intruderPool.length === 0) continue;

    const member_sample = [...c.member_paths]
      .slice(0, opts.membersPerTrial) // stable base; pick selects within if randomised
      .map((p) => p);
    const intruder_path = intruderPool[pick(intruderPool.length)]!;
    trials.push({
      cluster_id: c.cluster_id,
      member_sample,
      intruder_path,
      candidates: [...member_sample, intruder_path],
    });
  }
  return trials;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/intruder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/intruder.ts tests/frame-extraction/intruder.test.ts
git commit -m "feat(frames): pure intruder-trial construction for label validation"
```

---

## Task 8: Add the Anthropic SDK dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: adds `@anthropic-ai/sdk` to `dependencies`; `package-lock.json` updates.

- [ ] **Step 2: Add a script alias**

In `package.json` `scripts`, add (after the `eval:frames` line):

```json
    "eval:labels:validate": "tsx scripts/frame-extraction/validate-label-quality.ts",
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @anthropic-ai/sdk for offline label validation"
```

---

## Task 9: Intruder-detection orchestrator (`validate-label-quality.ts`)

**Files:**
- Create: `scripts/frame-extraction/validate-label-quality.ts`

This script is offline and nondeterministic (real LLM calls); it has no unit test.
Verification is a manual run (Step 3). It reuses `buildIntruderTrials`,
`buildCorpusIndex`/`scoreClusters` for the F1 side, and the existing clone+index+cluster
harness pieces.

- [ ] **Step 1: Write the orchestrator**

`scripts/frame-extraction/validate-label-quality.ts`:

```ts
// scripts/frame-extraction/validate-label-quality.ts
/**
 * Offline label-quality validator (NOT in CI).
 *
 * For each non-noise cluster of a single repo: build an intruder-detection trial,
 * ask Claude which candidate file does NOT fit the generated label, and score the
 * answer against the known intruder (cluster membership = ground truth). Correlate
 * the intruder-detection accuracy with the deterministic label-F1 to confirm F1 is
 * a trustworthy proxy and to surface its blind spots.
 *
 * Usage: ANTHROPIC_API_KEY=… npx tsx scripts/frame-extraction/validate-label-quality.ts <repo-path> [--members 5] [--model claude-opus-4-8]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runTfIdfHdbscan, deriveProjectName } from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { pickFrameLabel } from "../../src/frame-extraction/inject-frames.js";
import { buildCorpusIndex, scoreClusters } from "../../src/frame-extraction/label-quality.js";
import { buildIntruderTrials } from "./intruder.js";
import { cachePathForProject } from "../../src/cli/context.js";
import type { FileBlob } from "../../src/frame-extraction/types.js";

const MODEL_DEFAULT = "claude-opus-4-8";
const SNIPPET_MAX_CHARS = 800;

function snippet(repoPath: string, relPath: string): string {
  const abs = join(repoPath, relPath);
  if (!existsSync(abs)) return "(file not found)";
  return readFileSync(abs, "utf-8").slice(0, SNIPPET_MAX_CHARS);
}

async function askIntruder(
  client: Anthropic,
  model: string,
  label: string,
  candidates: { path: string; body: string }[],
): Promise<string> {
  const list = candidates
    .map((c, i) => `[${i}] ${c.path}\n${c.body}`)
    .join("\n\n---\n\n");
  const msg = await client.messages.create({
    model,
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content:
          `A group of files is described by the label "${label}". ` +
          `Exactly one of the files below does NOT belong to that group. ` +
          `Reply with ONLY its bracket index (e.g. "2").\n\n${list}`,
      },
    ],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const m = text.match(/\d+/);
  return m ? candidates[Number(m[0])]?.path ?? "" : "";
}

async function main() {
  const argv = process.argv.slice(2);
  const repoPath = resolve(argv[0] ?? ".");
  const membersPerTrial = Number(argv[argv.indexOf("--members") + 1]) || 5;
  const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1]! : MODEL_DEFAULT;

  const project = deriveProjectName(repoPath);
  const graphDbPath = [
    cachePathForProject(project),
    join(repoPath, ".cortex", "db"),
  ].find((p) => existsSync(p));
  if (!graphDbPath) {
    console.error(`No graph DB for ${project}; index the repo first.`);
    process.exit(2);
  }

  const { result, blobs_path } = runTfIdfHdbscan({
    repo_path: repoPath,
    project_name: project,
    db_path: graphDbPath,
  });
  const topTokens = (result.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>;
  const blobs = readFileSync(blobs_path, "utf-8")
    .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as FileBlob);
  const idx = buildCorpusIndex(blobs);
  const f1ByCluster = new Map(
    scoreClusters(result.clusters, topTokens, idx).map((s) => [s.cluster_id, s.f1]),
  );

  const client = new Anthropic();
  const trials = buildIntruderTrials(result.clusters, { membersPerTrial });

  let correct = 0;
  const rows: { cluster_id: number; label: string; f1: number; ok: boolean }[] = [];
  for (const t of trials) {
    const cluster = result.clusters.find((c) => c.cluster_id === t.cluster_id)!;
    const label = pickFrameLabel(topTokens[String(t.cluster_id)] ?? [], cluster.member_paths, t.cluster_id);
    const candidates = t.candidates.map((p) => ({ path: p, body: snippet(repoPath, p) }));
    const chosen = await askIntruder(client, model, label, candidates);
    const ok = chosen === t.intruder_path;
    if (ok) correct++;
    rows.push({ cluster_id: t.cluster_id, label, f1: f1ByCluster.get(t.cluster_id) ?? 0, ok });
    console.log(`cluster=${t.cluster_id} label="${label}" f1=${(f1ByCluster.get(t.cluster_id) ?? 0).toFixed(3)} intruderFound=${ok}`);
  }

  const accuracy = trials.length > 0 ? correct / trials.length : 0;
  console.log(`\nintruder-detection accuracy = ${accuracy.toFixed(3)} over ${trials.length} clusters`);
  // Divergence: clusters with high F1 but the LLM could NOT find the intruder
  // (suspected layer-marker / non-discriminative labels).
  const divergent = rows.filter((r) => r.f1 >= 0.5 && !r.ok);
  if (divergent.length > 0) {
    console.log(`\nHigh-F1 but intruder-missed (blind-spot candidates):`);
    for (const r of divergent) console.log(`  cluster=${r.cluster_id} label="${r.label}" f1=${r.f1.toFixed(3)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Manual validation run**

Run: `ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY npm run eval:labels:validate -- $(pwd)`
Expected: prints a per-cluster line, an overall intruder-detection accuracy, and any
high-F1-but-missed blind-spot candidates. Sanity check: accuracy should be high on a
convention-heavy repo, and the blind-spot list should call out any layer-marker labels.
(If no API key / no network, state that and mark the task hand-verify-before-merge.)

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/validate-label-quality.ts
git commit -m "feat(frames): offline intruder-detection validator for labels"
```

---

## Self-Review

**Spec coverage:**
- Coverage/specificity/F1 label-as-classifier → Tasks 1–2. ✓
- Strict AND multi-word matching → Task 2 (multi-word test + `pathHasAllTerms`). ✓
- `df` fast path vs `tokensByPath` scan → Task 2 (`scoreLabel` branch). ✓
- `scoreClusters` skips noise, uses `pickFrameLabel` → Task 3. ✓
- Aggregate (`f1_mean`, `f1_weighted`, coverage/specificity means, `clusters_below`) → Task 4. ✓
- Wire into `eval-all.ts`, extend `RepoEvalRow`, read `blobs_path` → Task 5. ✓
- Baseline snapshot, threshold deferred → Task 6. ✓
- Intruder detection grounded in membership, content snippets, accuracy vs F1, blind-spot surfacing → Tasks 7 & 9. ✓
- Offline/isolated, not in CI, adds SDK → Tasks 8 & 9. ✓
- `checkLabelQuality` left in place (untouched) → no task removes it. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `CorpusIndex`, `LabelScore`, `ClusterLabelScore`, `LabelQualityAggregate`, `IntruderTrial` are defined once and referenced consistently. `scoreClusters(clusters, topTokensPerCluster, idx)` arg order matches its call in Tasks 5 & 9. `buildIntruderTrials(clusters, opts)` matches its test and orchestrator usage. ✓

---

## Execution Handoff

Phase A (Tasks 1–6) is the recommended first pass — it is complete, no new deps, and independently shippable. Phase B (Tasks 7–9) can follow once Phase A's baseline numbers exist.
