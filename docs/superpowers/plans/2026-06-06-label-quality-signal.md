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
| `scripts/frame-extraction/eval-all.ts` | Phase A: read `blobs_path`, build index, score clusters, extend `RepoEvalRow` + log line. Phase B: add opt-in `--validate` / `--validate-sample` flags; per repo, build trials and call the lazy-loaded validator; aggregate corpus-wide at the end. | Modify |
| `scripts/frame-extraction/intruder.ts` | **New (Phase B).** Pure: build intruder-detection trials from clusters (seedable). No I/O, no LLM. | Create |
| `tests/frame-extraction/intruder.test.ts` | **New (Phase B).** Unit tests for trial construction. | Create |
| `scripts/frame-extraction/validate-labels.ts` | **New (Phase B).** Lazy-loaded LLM glue: given trials + labels + clone path, read snippets, call Claude, return per-trial intruder results. Holds the only Anthropic SDK import. | Create |
| `package.json` | Add `@anthropic-ai/sdk` (Phase B). No new script alias — validation is `eval:frames -- --validate`. | Modify |

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

# Phase B — Corpus-wide offline intruder-detection validator

> Runs **corpus-wide** as an opt-in `--validate` phase of the existing `eval:frames`
> runner — one clone+index+cluster pass, LLM step piggybacks per repo. Adds
> `@anthropic-ai/sdk`, lazy-loaded via dynamic `import()` so the default gate path never
> loads it. Internal-only, never per-user, never in CI. Requires `ANTHROPIC_API_KEY`.

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

> No new script alias. Validation is the existing `eval:frames` runner with a flag:
> `npm run eval:frames -- --validate`. The SDK is only ever loaded via a dynamic
> `import()` reached under that flag (Task 9), so the default `eval:frames` / gate
> path never imports it.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0. (The dependency is installed but not yet imported anywhere — that
is fine; Task 9 adds the lazy import.)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @anthropic-ai/sdk for offline label validation"
```

---

## Task 9: Corpus-wide `--validate` phase (lazy-loaded LLM glue)

The validator runs **corpus-wide as an opt-in phase of `eval-all.ts`**, reusing the
single clone+index+cluster pass the runner already does. The Anthropic SDK lives only
in `validate-labels.ts`, reached via a dynamic `import()` under `--validate`, so the
default `eval:frames` gate path never loads it. The LLM glue has no unit test
(nondeterministic); the pure trial-building is already covered by Task 7. Verification
is a manual run (Step 6).

**Files:**
- Create: `scripts/frame-extraction/validate-labels.ts`
- Modify: `scripts/frame-extraction/eval-all.ts`

- [ ] **Step 1: Create the lazy-loaded LLM glue**

`scripts/frame-extraction/validate-labels.ts`:

```ts
// scripts/frame-extraction/validate-labels.ts
/**
 * Lazy-loaded LLM glue for the eval-all `--validate` phase. Holds the ONLY Anthropic
 * SDK import in the eval — reached exclusively via dynamic import() under --validate,
 * so the default gate path never loads the SDK. Offline, internal-only, never per-user.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { IntruderTrial } from "./intruder.js";

const SNIPPET_MAX_CHARS = 800;

export interface TrialResult {
  cluster_id: number;
  label: string;
  f1: number;
  intruder_found: boolean;
}

export interface RunIntruderArgs {
  /** Clone path, for reading content snippets of candidate files. */
  repoPath: string;
  model: string;
  trials: IntruderTrial[];
  labelByCluster: Map<number, string>;
  f1ByCluster: Map<number, number>;
}

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
  const list = candidates.map((c, i) => `[${i}] ${c.path}\n${c.body}`).join("\n\n---\n\n");
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

/** Run one intruder trial per supplied trial; returns per-trial results. */
export async function runIntruderValidation(args: RunIntruderArgs): Promise<TrialResult[]> {
  const client = new Anthropic();
  const out: TrialResult[] = [];
  for (const t of args.trials) {
    const label = args.labelByCluster.get(t.cluster_id) ?? "";
    const candidates = t.candidates.map((p) => ({ path: p, body: snippet(args.repoPath, p) }));
    const chosen = await askIntruder(client, args.model, label, candidates);
    out.push({
      cluster_id: t.cluster_id,
      label,
      f1: args.f1ByCluster.get(t.cluster_id) ?? 0,
      intruder_found: chosen === t.intruder_path,
    });
  }
  return out;
}
```

- [ ] **Step 2: Extend `parseArgs` and `RepoEvalRow` in `eval-all.ts`**

Add the flags to the `CliArgs` interface and `parseArgs`:

```ts
interface CliArgs {
  out: string;
  only?: string;
  keep?: boolean;
  validate?: boolean;       // opt-in LLM intruder phase
  validateSample?: number;  // max trials per repo (default 15)
  model?: string;
}
```

In `parseArgs`, inside the arg loop, add:

```ts
    else if (argv[i] === "--validate") args.validate = true;
    else if (argv[i] === "--validate-sample") args.validateSample = Number(argv[++i]);
    else if (argv[i] === "--model") args.model = argv[++i];
```

Add the optional validation field to `RepoEvalRow`:

```ts
  validation?: {
    sampled: number;
    skipped_low_member: number;
    trials: { cluster_id: number; label: string; f1: number; intruder_found: boolean }[];
  };
```

- [ ] **Step 3: Make `evalRepo` async and add the lazy-loaded validate block**

Change the `evalRepo` signature to async and accept options:

```ts
async function evalRepo(repo: RepoSpec, opts: { validate: boolean; validateSample: number; model: string }): Promise<RepoEvalRow> {
```

Build the deterministic row as a mutable `const row` (instead of returning the object
literal directly) so the validate block can attach to it. Replace the existing
`return { slug: repo.slug, ok: true, ... }` with:

```ts
    const row: RepoEvalRow = {
      slug: repo.slug,
      ok: true,
      project,
      cluster_count: clusterCount(result.clusters),
      noise_rate: noiseRate(result.clusters),
      import_agreement_strict: importAgreementStrict,
      label_violations: violations.length,
      violation_rules: violationRules,
      label_f1_mean: labelAgg.f1_mean,
      label_f1_weighted: labelAgg.f1_weighted,
      label_coverage_mean: labelAgg.coverage_mean,
      label_specificity_mean: labelAgg.specificity_mean,
      label_clusters_below_f1: labelAgg.clusters_below,
    };

    if (opts.validate) {
      try {
        const { buildIntruderTrials } = await import("./intruder.js");
        const realClusterCount = result.clusters.filter((c) => c.cluster_id !== -1).length;
        const allTrials = buildIntruderTrials(result.clusters, { membersPerTrial: 5 });
        const trials = allTrials.slice(0, opts.validateSample);
        const labelByCluster = new Map(labelScores.map((s) => [s.cluster_id, s.label]));
        const f1ByCluster = new Map(labelScores.map((s) => [s.cluster_id, s.f1]));
        const { runIntruderValidation } = await import("./validate-labels.js");
        const results = await runIntruderValidation({
          repoPath: clone.path,
          model: opts.model,
          trials,
          labelByCluster,
          f1ByCluster,
        });
        row.validation = {
          sampled: trials.length,
          // clusters that yielded no trial: too-few-members or no intruder source, plus
          // any beyond the sample cap.
          skipped_low_member: realClusterCount - results.length,
          trials: results,
        };
        console.log(`[eval-all]   ⟳ validated ${results.length}/${realClusterCount} clusters (sample cap ${opts.validateSample})`);
      } catch (err) {
        console.log(`[eval-all]   ⚠ validation skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return row;
```

(`labelScores` is the `scoreClusters(...)` result from Task 5 — promote it to a `const`
in that block if it is not already named. `clone` and `project` are existing locals.)

- [ ] **Step 4: Make `main` async, await `evalRepo`, and aggregate corpus-wide**

Change `function main()` to `async function main()`, and the call site to
`const row = await evalRepo(repo, { validate: !!args.validate, validateSample: args.validateSample ?? 15, model: args.model ?? "claude-opus-4-8" });`.

After the write-file block and before teardown, add the corpus-wide report:

```ts
  if (args.validate) {
    const trials = rows.flatMap((r) => r.validation?.trials ?? []);
    if (trials.length > 0) {
      const acc = (xs: typeof trials) =>
        xs.length > 0 ? xs.filter((t) => t.intruder_found).length / xs.length : 0;
      const high = trials.filter((t) => t.f1 >= 0.5);
      const low = trials.filter((t) => t.f1 < 0.5);
      const blindSpots = trials.filter((t) => t.f1 >= 0.5 && !t.intruder_found);
      console.log(`\n[eval-all] intruder-detection (corpus-wide, ${trials.length} clusters):`);
      console.log(`[eval-all]   overall accuracy = ${acc(trials).toFixed(3)}`);
      console.log(`[eval-all]   accuracy | F1>=0.5 = ${acc(high).toFixed(3)} (n=${high.length})`);
      console.log(`[eval-all]   accuracy | F1<0.5  = ${acc(low).toFixed(3)} (n=${low.length})`);
      if (blindSpots.length > 0) {
        console.log(`[eval-all]   blind-spot candidates (high F1, intruder missed):`);
        for (const t of blindSpots) {
          console.log(`[eval-all]     cluster=${t.cluster_id} label="${t.label}" f1=${t.f1.toFixed(3)}`);
        }
      }
    }
  }
```

Update the bottom invocation to handle the promise: `if (isDirect) main().catch((e) => { console.error(e); process.exit(1); });`.

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Manual corpus/local validation run**

Run (single local fixture, cheap, exercises the path end-to-end):
```bash
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY npm run eval:frames -- --only self --keep --validate --validate-sample 8
```
Expected: the `self/cortex` run prints a `⟳ validated N/M clusters` line, then a
corpus-wide intruder-detection block with overall accuracy, the F1>=0.5 vs F1<0.5
accuracy split, and any blind-spot candidates. Sanity: the F1>=0.5 band should detect
intruders more often than the F1<0.5 band (F1 tracks discriminativeness). For the full
corpus, drop `--only self`. (If no API key / no network, state that and mark the task
hand-verify-before-merge.)

- [ ] **Step 7: Confirm the gate path still never loads the SDK**

Run: `npm run eval:frames -- --only self --keep`
Expected: completes with the Phase A `labelF1=…` line and **no** validation output;
the dynamic `import("@anthropic-ai/sdk")` is never reached without `--validate`.

- [ ] **Step 8: Commit**

```bash
git add scripts/frame-extraction/validate-labels.ts scripts/frame-extraction/eval-all.ts
git commit -m "feat(frames): corpus-wide --validate intruder-detection phase (lazy-loaded LLM)"
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
- Corpus-wide, opt-in `--validate`, lazy-loaded SDK (gate path never imports it) → Task 9 (Step 3 dynamic imports; Step 7 guard run). ✓
- Cost cap (`--validate-sample`, default 15) with no silent truncation (`skipped_low_member` logged) → Task 9 Steps 2–4. ✓
- Band-split correlation (F1≥0.5 vs F1<0.5 accuracy) + blind-spot list → Task 9 Step 4. ✓
- Internal-only / never-per-user → spec non-goal; no code path implements per-user validation (nothing to build). ✓
- Offline/isolated, not in CI, adds SDK → Tasks 8 & 9. ✓
- `checkLabelQuality` left in place (untouched) → no task removes it. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `CorpusIndex`, `LabelScore`, `ClusterLabelScore`, `LabelQualityAggregate`, `IntruderTrial`, `TrialResult`, `RunIntruderArgs` are defined once and referenced consistently. `scoreClusters(clusters, topTokensPerCluster, idx)` arg order matches its calls (Tasks 5, 9). `buildIntruderTrials(clusters, opts)` matches its test (Task 7) and use (Task 9). `runIntruderValidation(args)`'s `RunIntruderArgs` shape (`repoPath, model, trials, labelByCluster, f1ByCluster`) matches its call in Task 9 Step 3. The `labelScores` const from Task 5 Step 3 is reused in Task 9 Step 3 to build `labelByCluster`/`f1ByCluster`. ✓

---

## Execution Handoff

Phase A (Tasks 1–6) is the recommended first pass — it is complete, no new deps, and independently shippable; it lands the deterministic label-F1 metric and the baseline. Phase B (Tasks 7–9) adds the corpus-wide `--validate` intruder phase (`npm run eval:frames -- --validate`) and should follow once Phase A's baseline numbers exist, so the validator has real F1 values to correlate against.
