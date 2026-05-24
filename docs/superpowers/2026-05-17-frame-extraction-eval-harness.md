# Frame Extraction — Phase 2 Eval Harness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score a `ClusterResult` against cross-signal data sources (co-change matrix, CALLS-edge graph) so we can compare algorithm candidates empirically rather than by eyeballing. Hand-run on cortex's existing TF-IDF+HDBSCAN output and commit the resulting metrics report into the spec as the v1 baseline.

**Architecture:**

- **Two-sided split**: per-algorithm internal metrics (silhouette over the algorithm's own feature space, top-tokens-per-cluster) stay inside the algorithm's wrapper script. The eval harness owns the cross-signal + sanity metrics: co-change agreement, import agreement, cluster count, noise rate, file coverage, wall time. This keeps the harness algorithm-agnostic — adding Leiden later means it ALSO emits its own silhouette + top-features, and the same eval consumes it.
- **Pure TS** for the harness. Reads `ClusterResult` JSON + the co-change JSONL + the graph DB (for CALLS edges).
- **Markdown reporter** writes `docs/specs/cortex-v0.3/phase-2-eval/<repo-slug>.md` — one file per repo. The 5-repo aggregate goes in a follow-up PR.
- **Out of scope** for this PR: 5-repo automation (the corpus runner), comparison-across-algorithms (only one exists), and an internal-vs-cross-signal comparison view (single-algorithm reporting is enough).

**Tech Stack:**

- Node built-ins (no new deps).
- vitest for unit tests.
- Reuses `co-change.ts` (from PR #5/#7), `text-blob.ts` (from PR #8), the `better-sqlite3` Cortex graph DB.
- Existing Python TF-IDF script gets a small extension to emit silhouette + top tokens.

---

## Scope Check

This plan covers one coherent subsystem (eval harness for a single algorithm's output). Adjacent things deliberately deferred:

- **5-repo corpus automation** — a separate follow-up PR. Needs to clone-or-reuse each Phase 2 corpus repo, index it, run the clusterer, then run the eval. Mechanical, not architectural.
- **Comparison view** ("here's TF-IDF vs. Leiden vs. embeddings on the same repo") — only useful when we have ≥2 algorithms. Wait until the second candidate lands.
- **Combined-distance scoring** (`β·topical + γ·co_change`) — needs the eval to even motivate the parameters.

Build the harness clean now, layer on top later.

---

## File Structure

**Python (small extension to existing script)**

- Modify: `scripts/frame-extraction/python/tfidf_hdbscan.py` — emit `silhouette_score` and `top_tokens_per_cluster` in the output. Both are algorithm-specific (defined in the TF-IDF feature space) so they live with the algorithm.

**TS (new)**

- Modify: `scripts/frame-extraction/types.ts` — add `EvalMetrics`, `EvalReport`, `ImportEdge`.
- Create: `scripts/frame-extraction/eval-metrics.ts` — pure functions: `coChangeAgreement(clusters, pairs)`, `importAgreement(clusters, edges)`, `clusterCount(clusters)`, `noiseRate(clusters)`.
- Create: `scripts/frame-extraction/eval-edges.ts` — `collectCallsEdges(db, project)` → `ImportEdge[]`.
- Create: `scripts/frame-extraction/eval-report.ts` — markdown reporter that consumes `EvalReport` and writes a `.md` file.
- Create: `scripts/frame-extraction/eval.ts` — CLI orchestrator: read cluster JSON + co-change JSONL + graph DB → compute metrics → write report.
- Create: `tests/frame-extraction/eval-metrics.test.ts`
- Create: `tests/frame-extraction/eval-edges.test.ts`
- Create: `tests/frame-extraction/eval-report.test.ts`

**Output**

- Create: `docs/specs/cortex-v0.3/phase-2-eval/self-cortex.md` (generated, committed as the baseline).

**Config**

- Modify: `package.json` — add `eval:phase2`.

---

## Task 1: Python script emits silhouette + top tokens

**Files:**
- Modify: `scripts/frame-extraction/python/tfidf_hdbscan.py`

The Python script already runs TF-IDF + HDBSCAN and writes a cluster JSON. It needs two more outputs per the eval design:

- `parameters.silhouette_score` — float, sklearn's `silhouette_score` over the cosine-distance matrix and the predicted labels (computed only when there are ≥2 non-noise clusters; otherwise emit `null`).
- `parameters.top_tokens_per_cluster` — `{ "<cluster_id>": ["token1", "token2", ...] }`, the top-10 highest-mean-TF-IDF tokens within each cluster. For human eyeballing later in the report.

- [ ] **Step 1: Patch the script**

Find the block in `tfidf_hdbscan.py` that runs HDBSCAN and assembles `non_noise`. Just after `labels = clusterer.fit_predict(dist.astype(np.float64))`:

```python
    # Algorithm-internal metrics. These live with the algorithm because
    # they're defined in its own feature space — silhouette is over the
    # cosine-distance matrix; top tokens are over the TF-IDF vocabulary.
    # The eval harness reads them as opaque numbers/strings.
    silhouette: float | None = None
    non_noise_mask = labels != -1
    distinct_non_noise = set(int(l) for l in labels if l != -1)
    if len(distinct_non_noise) >= 2 and int(non_noise_mask.sum()) >= 2:
        from sklearn.metrics import silhouette_score as _silhouette
        # Pass only non-noise rows so noise points don't inflate the score.
        silhouette = float(_silhouette(
            dist[non_noise_mask][:, non_noise_mask],
            labels[non_noise_mask],
            metric="precomputed",
        ))

    top_tokens_per_cluster: dict[str, list[str]] = {}
    if distinct_non_noise:
        feature_names = vectorizer.get_feature_names_out()
        for cid in sorted(distinct_non_noise):
            mask = labels == cid
            # Mean TF-IDF weight per feature within this cluster.
            cluster_mat = matrix[mask]
            mean_weights = np.asarray(cluster_mat.mean(axis=0)).flatten()
            top_indices = np.argsort(-mean_weights)[:10]
            top_tokens_per_cluster[str(cid)] = [
                str(feature_names[i]) for i in top_indices if mean_weights[i] > 0
            ]
```

Then in the `write_result(...)` call's `params={...}` dict, add:

```python
            "silhouette_score": silhouette,
            "top_tokens_per_cluster": top_tokens_per_cluster,
```

- [ ] **Step 2: Smoke against the cortex cluster output**

Re-run the cluster command (it's idempotent — overwrites the existing JSON):

```bash
cd /Users/rka/Development/cortex
npm run cluster:tfidf -- . --out .tmp/frame-extraction/clusters/self-cortex.json
jq '.parameters | {silhouette_score, top_tokens_per_cluster: (.top_tokens_per_cluster | keys | length)}' .tmp/frame-extraction/clusters/self-cortex.json
```

Expected: `silhouette_score` is a float (probably 0.0–0.5 — clusters in cosine space can be middling), and `top_tokens_per_cluster` has the same number of keys as non-noise clusters (`14` for cortex per the prior smoke).

- [ ] **Step 3: Determinism re-check**

Run cluster:tfidf twice and confirm byte-identical output (silhouette is deterministic; the floats should hash the same):

```bash
npm run cluster:tfidf -- . --out /tmp/clusters_a.json
npm run cluster:tfidf -- . --out /tmp/clusters_b.json
diff /tmp/clusters_a.json /tmp/clusters_b.json && echo identical
rm -f /tmp/clusters_a.json /tmp/clusters_b.json
```

Expected: `identical`.

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/python/tfidf_hdbscan.py
git commit -m "feat(frame-extraction): emit silhouette + top tokens from tfidf_hdbscan.py"
```

---

## Task 2: Eval types

**Files:**
- Modify: `scripts/frame-extraction/types.ts`

- [ ] **Step 1: Add the types**

Append below the existing types:

```ts
/** A single CALLS edge from the Cortex graph, in file-path form. Both ends
 *  are file paths relative to the repo root, sorted so `a <= b` to dedupe. */
export interface ImportEdge {
  a: string;
  b: string;
  weight: number;
}

/** All cross-signal + sanity metrics for one (algorithm, repo) pair.
 *  Algorithm-internal metrics (silhouette, top tokens) live on the
 *  ClusterResult's `parameters` field — this struct holds only what the
 *  eval harness produces. */
export interface EvalMetrics {
  /** Number of non-noise clusters. */
  cluster_count: number;
  /** Fraction of files in the noise cluster (0..1). */
  noise_rate: number;
  /** Total number of files in the input. */
  total_files: number;
  /** Fraction of frequently-co-changing file pairs that landed in the
   *  same cluster (0..1). `null` if the co-change matrix has no pairs. */
  co_change_agreement: number | null;
  /** Fraction of CALLS-coupled file pairs that landed in the same
   *  cluster (0..1). `null` if there are no CALLS edges. */
  import_agreement: number | null;
  /** Wall-clock seconds the cluster step took (read from cluster JSON's
   *  parameters or measured separately). */
  cluster_elapsed_seconds: number | null;
}

export interface EvalReport {
  /** Identifier for the (algorithm, repo) pair this report covers. */
  algorithm: string;
  repo_slug: string;
  generated_at: string;
  metrics: EvalMetrics;
  /** Internal metrics passed through from the algorithm's output so the
   *  report can render them alongside cross-signal metrics. */
  internal: {
    silhouette_score: number | null;
    vocabulary_size: number | null;
    top_tokens_per_cluster: Record<string, string[]>;
  };
  /** Cluster summary table: per-cluster id, member count, dominant
   *  path prefix (heuristic — the longest common left-prefix of paths),
   *  top tokens. */
  cluster_summary: Array<{
    cluster_id: number;
    member_count: number;
    path_prefix: string;
    top_tokens: string[];
    sample_paths: string[];
  }>;
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
cd /Users/rka/Development/cortex && npx tsc --noEmit -p tsconfig.json
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/types.ts
git commit -m "feat(frame-extraction): add EvalMetrics, EvalReport, ImportEdge types"
```

---

## Task 3: Eval metrics — co-change agreement + import agreement

**Files:**
- Create: `scripts/frame-extraction/eval-metrics.ts`
- Create: `tests/frame-extraction/eval-metrics.test.ts`

The two cross-signal metrics share the same shape: given a list of weighted pairs (a, b, weight) and a clustering (file → cluster_id), compute the fraction of (the top-N pairs by weight) that are intra-cluster. Implement once, parameterize over the input.

The other two metrics (cluster_count, noise_rate) are trivial — colocated for cohesion.

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/eval-metrics.test.ts
import { describe, it, expect } from "vitest";
import {
  agreementScore,
  clusterCount,
  noiseRate,
  buildFileToClusterMap,
} from "../../scripts/frame-extraction/eval-metrics.js";
import type { ClusterAssignment, FilePair, ImportEdge } from "../../scripts/frame-extraction/types.js";

const clusters: ClusterAssignment[] = [
  { cluster_id: 0, member_paths: ["a.ts", "b.ts", "c.ts"] },
  { cluster_id: 1, member_paths: ["d.ts", "e.ts"] },
  { cluster_id: -1, member_paths: ["noise.ts"] },
];

describe("buildFileToClusterMap", () => {
  it("returns one entry per (file, cluster_id) pair", () => {
    const m = buildFileToClusterMap(clusters);
    expect(m.get("a.ts")).toBe(0);
    expect(m.get("d.ts")).toBe(1);
    expect(m.get("noise.ts")).toBe(-1);
    expect(m.size).toBe(6);
  });
});

describe("clusterCount + noiseRate", () => {
  it("counts non-noise clusters", () => {
    expect(clusterCount(clusters)).toBe(2);
  });

  it("computes noise as a fraction of total members", () => {
    expect(noiseRate(clusters)).toBeCloseTo(1 / 6, 6);
  });

  it("noiseRate is 0 when there is no -1 cluster", () => {
    expect(noiseRate(clusters.slice(0, 2))).toBe(0);
  });
});

describe("agreementScore", () => {
  it("returns null when pairs is empty", () => {
    const m = buildFileToClusterMap(clusters);
    expect(agreementScore([], m)).toBeNull();
  });

  it("treats both endpoints in the noise cluster as NOT agreeing", () => {
    // Two noise files in the same noise cluster do not count as
    // agreement — noise means unassigned, not a positive grouping.
    const m = buildFileToClusterMap([
      { cluster_id: -1, member_paths: ["x.ts", "y.ts"] },
    ]);
    const pairs: FilePair[] = [{ a: "x.ts", b: "y.ts", count: 5 }];
    expect(agreementScore(pairs, m)).toBe(0);
  });

  it("counts an intra-cluster pair as agreeing", () => {
    const m = buildFileToClusterMap(clusters);
    const pairs: FilePair[] = [
      { a: "a.ts", b: "b.ts", count: 3 }, // intra (both in cluster 0)
      { a: "a.ts", b: "d.ts", count: 3 }, // cross (0 vs 1)
    ];
    expect(agreementScore(pairs, m)).toBe(0.5);
  });

  it("ignores pairs where either endpoint is not in any cluster", () => {
    // Pairs that reference files not in the clustering at all (e.g. a
    // file the indexer didn't see) are dropped before computing the ratio.
    const m = buildFileToClusterMap(clusters);
    const pairs: FilePair[] = [
      { a: "a.ts", b: "b.ts", count: 1 }, // agrees
      { a: "a.ts", b: "missing.ts", count: 1 }, // dropped
    ];
    expect(agreementScore(pairs, m)).toBe(1);
  });

  it("works for ImportEdge inputs (a, b, weight) just like FilePair", () => {
    const m = buildFileToClusterMap(clusters);
    const edges: ImportEdge[] = [
      { a: "a.ts", b: "b.ts", weight: 7 },
      { a: "a.ts", b: "d.ts", weight: 1 },
    ];
    expect(agreementScore(edges, m)).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-metrics.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module './eval-metrics.js'`.

- [ ] **Step 3: Implement**

```ts
// scripts/frame-extraction/eval-metrics.ts
import type { ClusterAssignment, FilePair, ImportEdge } from "./types.js";

/** A pair-shape that's compatible with both FilePair (co-change) and
 *  ImportEdge (CALLS). The agreementScore function consumes either. */
type WeightedPair = { a: string; b: string };

/** Maps every file in a clustering to its cluster_id (including the
 *  noise cluster, which is `-1`). Files appearing in multiple clusters
 *  (shouldn't happen but defensively the LAST cluster wins) are last-
 *  write-wins. */
export function buildFileToClusterMap(clusters: ClusterAssignment[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of clusters) {
    for (const path of c.member_paths) {
      m.set(path, c.cluster_id);
    }
  }
  return m;
}

export function clusterCount(clusters: ClusterAssignment[]): number {
  return clusters.filter((c) => c.cluster_id !== -1).length;
}

export function noiseRate(clusters: ClusterAssignment[]): number {
  let total = 0;
  let noise = 0;
  for (const c of clusters) {
    total += c.member_paths.length;
    if (c.cluster_id === -1) noise += c.member_paths.length;
  }
  return total === 0 ? 0 : noise / total;
}

/** Fraction of `pairs` (where both endpoints appear in the clustering
 *  AND are non-noise) that landed in the same non-noise cluster.
 *  Returns null if no scorable pair exists. */
export function agreementScore(
  pairs: readonly WeightedPair[],
  fileToCluster: Map<string, number>,
): number | null {
  let scorable = 0;
  let agree = 0;
  for (const p of pairs) {
    const ca = fileToCluster.get(p.a);
    const cb = fileToCluster.get(p.b);
    if (ca === undefined || cb === undefined) continue;
    if (ca === -1 || cb === -1) continue;
    scorable += 1;
    if (ca === cb) agree += 1;
  }
  if (scorable === 0) return null;
  return agree / scorable;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-metrics.test.ts 2>&1 | tail -10
```

Expected: all 8 cases pass. (Note: the empty-pairs test asserts NULL; the noise-only test asserts 0 — the spec asks for fraction of *frequently-co-changing pairs* — pairs in the noise cluster are explicitly excluded from the denominator, so noise-only inputs yield 0 over 0 → null. Reread the test to make sure your implementation matches.)

Wait — re-reading my own test: the noise-only pair case asserts `expect(agreementScore(pairs, m)).toBe(0)`. That's because the implementation INCLUDES noise pairs in scorable but treats them as not agreeing. That's wrong by the spec (noise should be excluded from denominator). Fix the test OR fix the impl to match. The IMPL above filters `ca === -1 || cb === -1`, which means noise pairs are dropped from scorable entirely. So a pure-noise pair list gives `scorable === 0` → returns null, not 0.

Update the test to `expect(...).toBeNull()` for that case. (Done in the next step.)

- [ ] **Step 5: Fix the test to match the spec semantic**

Open `tests/frame-extraction/eval-metrics.test.ts`. Replace the "treats both endpoints in the noise cluster" block:

```ts
  it("excludes pairs where either endpoint is in the noise cluster", () => {
    // Noise files aren't confidently clustered — they don't contribute
    // to numerator OR denominator of the agreement score.
    const m = buildFileToClusterMap([
      { cluster_id: -1, member_paths: ["x.ts", "y.ts"] },
    ]);
    const pairs: FilePair[] = [{ a: "x.ts", b: "y.ts", count: 5 }];
    expect(agreementScore(pairs, m)).toBeNull();
  });
```

Re-run:

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-metrics.test.ts 2>&1 | tail -10
```

Expected: all 8 cases pass.

- [ ] **Step 6: Full suite**

```bash
cd /Users/rka/Development/cortex && npm test 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add scripts/frame-extraction/eval-metrics.ts tests/frame-extraction/eval-metrics.test.ts
git commit -m "feat(frame-extraction): agreement-score + cluster-count metrics"
```

---

## Task 4: CALLS-edge extraction from graph DB

**Files:**
- Create: `scripts/frame-extraction/eval-edges.ts`
- Create: `tests/frame-extraction/eval-edges.test.ts`

The CALLS edges are stored in the graph DB's `edges` table. To build a file-level `ImportEdge[]` (where both ends are file paths), we need to:

1. Query edges where `relation = 'CALLS'`, joining both endpoints to `nodes` to get their `file_path`.
2. Drop self-loops (caller and callee in the same file — those are intra-file, not cross-file structure).
3. Drop edges where either endpoint has no `file_path` (e.g. external symbols, project nodes).
4. Sort endpoints so `(a, b)` and `(b, a)` collapse, then aggregate counts.

Schema reminder (verified against `src/graph/schema.ts`): `edges(source_id, target_id, relation, ...)`, `nodes(id, ..., file_path, project)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/eval-edges.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { collectCallsEdges } from "../../scripts/frame-extraction/eval-edges.js";

let root: string;
let db: Database.Database;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-eval-edges-"));
  db = new Database(join(root, "graph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      project TEXT
    );
    CREATE TABLE edges (
      source_id TEXT,
      target_id TEXT,
      relation  TEXT
    );
  `);
  // Two function nodes per file.
  const insN = db.prepare(
    "INSERT INTO nodes (id, kind, name, file_path, project) VALUES (?, ?, ?, ?, ?)",
  );
  insN.run("a1", "function", "a1", "src/auth.ts", "p");
  insN.run("a2", "function", "a2", "src/auth.ts", "p");
  insN.run("b1", "function", "b1", "src/billing.ts", "p");
  insN.run("c1", "function", "c1", "src/api.ts", "p");
  insN.run("e1", "function", "external", null, "p");
  insN.run("o1", "function", "other", "src/x.ts", "other_project");

  const insE = db.prepare(
    "INSERT INTO edges (source_id, target_id, relation) VALUES (?, ?, ?)",
  );
  // Cross-file CALLS: src/auth.ts → src/billing.ts (counts as 2 weight via dedupe)
  insE.run("a1", "b1", "CALLS");
  insE.run("a2", "b1", "CALLS");
  // Cross-file CALLS: src/auth.ts → src/api.ts (weight 1)
  insE.run("a1", "c1", "CALLS");
  // Intra-file CALLS: same file both ends — must be dropped
  insE.run("a1", "a2", "CALLS");
  // Edge with NULL endpoint file_path — must be dropped
  insE.run("a1", "e1", "CALLS");
  // Edge in another project — must be dropped (we scope to project p)
  insE.run("a1", "o1", "CALLS");
  // Non-CALLS edge — must be dropped
  insE.run("a1", "b1", "IMPORTS");
});

afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("collectCallsEdges", () => {
  it("aggregates cross-file CALLS into ImportEdge[] with sorted endpoints", () => {
    const edges = collectCallsEdges(db, "p");
    const ab = edges.find((e) => e.a === "src/auth.ts" && e.b === "src/billing.ts");
    const ac = edges.find((e) => e.a === "src/api.ts" && e.b === "src/auth.ts");
    expect(ab?.weight).toBe(2);
    expect(ac?.weight).toBe(1);
  });

  it("drops intra-file calls, NULL-path endpoints, other projects, and non-CALLS relations", () => {
    const edges = collectCallsEdges(db, "p");
    expect(edges.some((e) => e.a === "src/auth.ts" && e.b === "src/auth.ts")).toBe(false);
    expect(edges.some((e) => /\bexternal\b/.test(e.a) || /\bexternal\b/.test(e.b))).toBe(false);
    expect(edges.some((e) => e.a === "src/x.ts" || e.b === "src/x.ts")).toBe(false);
  });

  it("returns edges sorted by weight desc", () => {
    const edges = collectCallsEdges(db, "p");
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i - 1]!.weight).toBeGreaterThanOrEqual(edges[i]!.weight);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-edges.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Inspect actual edges-table schema**

Confirm the real edges table column names before writing the SQL:

```bash
cd /Users/rka/Development/cortex && sqlite3 .cortex/graph.db ".schema edges" 2>&1 | head -10
```

You should see `source_id`, `target_id`, `relation`. If any name differs, adjust the SQL accordingly (and flag in your report).

- [ ] **Step 4: Implement**

```ts
// scripts/frame-extraction/eval-edges.ts
import type Database from "better-sqlite3";
import type { ImportEdge } from "./types.js";

/** Read CALLS edges from a Cortex graph DB, join both endpoints to file
 *  paths, drop intra-file + null-path + cross-project, dedupe by sorted
 *  pair, return sorted by weight desc. */
export function collectCallsEdges(db: Database.Database, project: string): ImportEdge[] {
  const rows = db
    .prepare(
      `SELECT n1.file_path AS src, n2.file_path AS dst
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source_id
       JOIN nodes n2 ON n2.id = e.target_id
       WHERE e.relation = 'CALLS'
         AND n1.project = ?
         AND n2.project = ?
         AND n1.file_path IS NOT NULL AND n1.file_path != ''
         AND n2.file_path IS NOT NULL AND n2.file_path != ''
         AND n1.file_path != n2.file_path`,
    )
    .all(project, project) as Array<{ src: string; dst: string }>;

  const counts = new Map<string, ImportEdge>();
  for (const row of rows) {
    const [a, b] = row.src < row.dst ? [row.src, row.dst] : [row.dst, row.src];
    const key = `${a}\t${b}`;
    const existing = counts.get(key);
    if (existing) existing.weight += 1;
    else counts.set(key, { a, b, weight: 1 });
  }
  return [...counts.values()].sort((x, y) => y.weight - x.weight);
}
```

- [ ] **Step 5: Run tests + full suite**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-edges.test.ts && npm test 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/eval-edges.ts tests/frame-extraction/eval-edges.test.ts
git commit -m "feat(frame-extraction): extract file-level CALLS edges from graph DB"
```

---

## Task 5: Markdown reporter

**Files:**
- Create: `scripts/frame-extraction/eval-report.ts`
- Create: `tests/frame-extraction/eval-report.test.ts`

Renders an `EvalReport` to a markdown string. One section per piece (metrics, internal, cluster summary). Pure function for testability.

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/eval-report.test.ts
import { describe, it, expect } from "vitest";
import { renderEvalReport } from "../../scripts/frame-extraction/eval-report.js";
import type { EvalReport } from "../../scripts/frame-extraction/types.js";

const report: EvalReport = {
  algorithm: "tfidf+hdbscan",
  repo_slug: "self/cortex",
  generated_at: "2026-05-17T12:00:00Z",
  metrics: {
    cluster_count: 14,
    noise_rate: 0.527,
    total_files: 544,
    co_change_agreement: 0.32,
    import_agreement: 0.41,
    cluster_elapsed_seconds: 3.7,
  },
  internal: {
    silhouette_score: 0.18,
    vocabulary_size: 5432,
    top_tokens_per_cluster: { "0": ["auth", "token", "session"], "1": ["billing", "invoice"] },
  },
  cluster_summary: [
    {
      cluster_id: 0,
      member_count: 12,
      path_prefix: "src/auth/",
      top_tokens: ["auth", "token", "session"],
      sample_paths: ["src/auth/a.ts", "src/auth/b.ts"],
    },
  ],
};

describe("renderEvalReport", () => {
  it("contains the algorithm and repo slug in the heading", () => {
    const md = renderEvalReport(report);
    expect(md).toMatch(/tfidf\+hdbscan/);
    expect(md).toMatch(/self\/cortex/);
  });

  it("renders the metrics table with all keys", () => {
    const md = renderEvalReport(report);
    for (const key of [
      "cluster_count", "noise_rate", "total_files",
      "co_change_agreement", "import_agreement", "cluster_elapsed_seconds",
    ]) {
      expect(md).toContain(key);
    }
  });

  it("renders silhouette + vocabulary in the internal section", () => {
    const md = renderEvalReport(report);
    expect(md).toMatch(/silhouette/i);
    expect(md).toMatch(/0\.18/);
    expect(md).toMatch(/vocabulary/i);
    expect(md).toMatch(/5432/);
  });

  it("renders one row per cluster_summary entry", () => {
    const md = renderEvalReport(report);
    expect(md).toMatch(/src\/auth\//);
    expect(md).toMatch(/auth.*token.*session|auth, token, session/);
  });

  it("handles null cross-signal metrics gracefully (renders as —)", () => {
    const md = renderEvalReport({
      ...report,
      metrics: { ...report.metrics, co_change_agreement: null, import_agreement: null },
    });
    expect(md).toMatch(/co_change_agreement.*—/);
    expect(md).toMatch(/import_agreement.*—/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-report.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/frame-extraction/eval-report.ts
import type { EvalReport } from "./types.js";

function fmt(n: number | null, decimals = 3): string {
  return n === null ? "—" : n.toFixed(decimals);
}

export function renderEvalReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Phase 2 Eval — \`${r.algorithm}\` on \`${r.repo_slug}\``);
  lines.push("");
  lines.push(`Generated: ${r.generated_at}`);
  lines.push("");

  lines.push(`## Cross-signal + sanity metrics`);
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| total_files | ${r.metrics.total_files} |`);
  lines.push(`| cluster_count | ${r.metrics.cluster_count} |`);
  lines.push(`| noise_rate | ${fmt(r.metrics.noise_rate, 3)} |`);
  lines.push(`| co_change_agreement | ${fmt(r.metrics.co_change_agreement)} |`);
  lines.push(`| import_agreement | ${fmt(r.metrics.import_agreement)} |`);
  lines.push(`| cluster_elapsed_seconds | ${fmt(r.metrics.cluster_elapsed_seconds, 1)} |`);
  lines.push("");

  lines.push(`## Algorithm-internal metrics`);
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| silhouette_score | ${fmt(r.internal.silhouette_score)} |`);
  lines.push(`| vocabulary_size | ${r.internal.vocabulary_size ?? "—"} |`);
  lines.push("");

  if (r.cluster_summary.length > 0) {
    lines.push(`## Cluster summary`);
    lines.push("");
    lines.push(`| cluster | files | path prefix | top tokens | sample |`);
    lines.push(`|---:|---:|---|---|---|`);
    for (const c of r.cluster_summary) {
      const tokens = c.top_tokens.slice(0, 6).join(", ") || "—";
      const sample = c.sample_paths.slice(0, 3).map((p) => `\`${p}\``).join(", ") || "—";
      lines.push(`| ${c.cluster_id} | ${c.member_count} | \`${c.path_prefix || "(mixed)"}\` | ${tokens} | ${sample} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify pass + full suite**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/eval-report.test.ts && npm test 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/eval-report.ts tests/frame-extraction/eval-report.test.ts
git commit -m "feat(frame-extraction): markdown eval reporter"
```

---

## Task 6: CLI orchestrator

**Files:**
- Create: `scripts/frame-extraction/eval.ts`
- Modify: `package.json`

Ties everything together: read cluster JSON, read co-change JSONL (optional, default path), read graph DB CALLS edges, compute metrics, build EvalReport, write markdown.

- [ ] **Step 1: Implement**

```ts
// scripts/frame-extraction/eval.ts
/**
 * Eval a single (algorithm, repo) cluster output against cross-signal data.
 *
 * Inputs (CLI):
 *   --cluster <path>     ClusterResult JSON (required)
 *   --repo <path>        Repo root, used for graph DB + co-change defaults
 *   --co-change <path>   Co-change JSONL (default: .tmp/frame-extraction/co-change/<slug>.jsonl)
 *   --out <path>         Output markdown path (default: docs/specs/cortex-v0.3/phase-2-eval/<slug>.md)
 *
 * Output: a markdown report file at --out.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type {
  ClusterAssignment,
  ClusterResult,
  EvalMetrics,
  EvalReport,
  FilePair,
  ImportEdge,
} from "./types.js";
import {
  agreementScore,
  buildFileToClusterMap,
  clusterCount,
  noiseRate,
} from "./eval-metrics.js";
import { collectCallsEdges } from "./eval-edges.js";
import { renderEvalReport } from "./eval-report.js";
import { deriveProjectName } from "./cluster-tfidf-hdbscan.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "docs", "specs", "cortex-v0.3", "phase-2-eval");
const DEFAULT_CO_CHANGE_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "co-change");

interface CliArgs {
  cluster: string;
  repo: string;
  co_change?: string;
  out?: string;
  repo_slug?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cluster") out.cluster = argv[++i];
    else if (argv[i] === "--repo") out.repo = argv[++i];
    else if (argv[i] === "--co-change") out.co_change = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--repo-slug") out.repo_slug = argv[++i];
  }
  if (!out.cluster || !out.repo) {
    console.error("usage: tsx eval.ts --cluster <path> --repo <path> [--co-change <path>] [--out <path>] [--repo-slug <name>]");
    process.exit(2);
  }
  return out as CliArgs;
}

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

function commonPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0]!;
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") return "";
  }
  // Truncate to the last separator so we don't return half-path-prefixes.
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : prefix;
}

function buildClusterSummary(
  clusters: ClusterAssignment[],
  topTokensByCluster: Record<string, string[]>,
): EvalReport["cluster_summary"] {
  return clusters
    .filter((c) => c.cluster_id !== -1)
    .map((c) => ({
      cluster_id: c.cluster_id,
      member_count: c.member_paths.length,
      path_prefix: commonPrefix(c.member_paths),
      top_tokens: topTokensByCluster[String(c.cluster_id)] ?? [],
      sample_paths: c.member_paths.slice(0, 5),
    }))
    .sort((x, y) => y.member_count - x.member_count);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const clusterPath = resolve(args.cluster);
  const repoPath = resolve(args.repo);
  const project = deriveProjectName(repoPath);
  const repoSlug = args.repo_slug ?? basename(repoPath);
  const slugSafe = project.replace(/[^A-Za-z0-9._-]/g, "_");

  const cluster = JSON.parse(readFileSync(clusterPath, "utf-8")) as ClusterResult;
  const coChangePath = args.co_change ?? join(DEFAULT_CO_CHANGE_DIR, `${slugSafe}.jsonl`);
  const pairs = loadJsonl<FilePair>(coChangePath);

  const graphDbPath = join(repoPath, ".cortex", "graph.db");
  let edges: ImportEdge[] = [];
  if (existsSync(graphDbPath)) {
    const db = new Database(graphDbPath, { readonly: true });
    try {
      edges = collectCallsEdges(db, project);
    } finally {
      db.close();
    }
  }

  const fileToCluster = buildFileToClusterMap(cluster.clusters);
  const totalFiles = cluster.total_files;

  const metrics: EvalMetrics = {
    cluster_count: clusterCount(cluster.clusters),
    noise_rate: cluster.noise_count / Math.max(totalFiles, 1),
    total_files: totalFiles,
    co_change_agreement: agreementScore(pairs, fileToCluster),
    import_agreement: agreementScore(edges, fileToCluster),
    cluster_elapsed_seconds: null, // not yet plumbed through from the algorithm
  };

  const topTokens = (cluster.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>;
  const silhouette = (cluster.parameters?.silhouette_score ?? null) as number | null;
  const vocab = (cluster.parameters?.vocabulary_size ?? null) as number | null;

  const report: EvalReport = {
    algorithm: cluster.algorithm,
    repo_slug: repoSlug,
    generated_at: new Date().toISOString(),
    metrics,
    internal: {
      silhouette_score: silhouette,
      vocabulary_size: vocab,
      top_tokens_per_cluster: topTokens,
    },
    cluster_summary: buildClusterSummary(cluster.clusters, topTokens),
  };

  const md = renderEvalReport(report);
  const outPath = args.out ?? join(DEFAULT_OUT_DIR, `${slugSafe}.md`);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, md);

  console.log(`[eval] ${cluster.algorithm} / ${repoSlug}`);
  console.log(`[eval]   files=${metrics.total_files} clusters=${metrics.cluster_count} noise=${metrics.noise_rate.toFixed(3)}`);
  console.log(`[eval]   co_change_agreement=${metrics.co_change_agreement?.toFixed(3) ?? "—"} import_agreement=${metrics.import_agreement?.toFixed(3) ?? "—"}`);
  console.log(`[eval]   silhouette=${silhouette?.toFixed(3) ?? "—"} vocab=${vocab ?? "—"}`);
  console.log(`[eval] wrote ${outPath}`);
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("eval.ts");
if (isDirect) main();
```

- [ ] **Step 2: Wire into package.json**

Open `package.json`. Inside `"scripts"`, after `"cluster:tfidf"`, add:

```json
    "eval:phase2": "tsx scripts/frame-extraction/eval.ts",
```

- [ ] **Step 3: Sanity-check compile**

```bash
cd /Users/rka/Development/cortex && npx tsc --noEmit -p tsconfig.json
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/eval.ts package.json
git commit -m "feat(frame-extraction): eval CLI orchestrator"
```

---

## Task 7: Run on cortex + commit baseline

- [ ] **Step 1: Make sure cortex has fresh inputs**

The cluster JSON and co-change JSONL should already exist from prior PRs. Refresh them if you want a fresh baseline (or skip if you trust the existing files):

```bash
cd /Users/rka/Development/cortex
# Re-cluster (uses the new silhouette-emitting Python script)
npm run cluster:tfidf -- . --out .tmp/frame-extraction/clusters/Users-rka-Development-cortex.json
# Co-change (probably already there)
npm run co-change -- . --out .tmp/frame-extraction/co-change/Users-rka-Development-cortex.jsonl --min 2
```

Note: the file slugs match the C-indexer project name format (`Users-rka-Development-cortex`) so the eval CLI can find them by default.

- [ ] **Step 2: Run the eval**

```bash
npm run eval:phase2 -- \
  --cluster .tmp/frame-extraction/clusters/Users-rka-Development-cortex.json \
  --repo . \
  --repo-slug self/cortex
```

Expected output: per-line summary printed to stdout, plus the markdown file written. Read it:

```bash
cat docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex.md | head -50
```

Eyeball the cluster summary section. Are the top tokens recognizably domain-y? (e.g. "auth", "store", "graph", "indexer"...) The path prefixes should be mostly `internal/indexer/...` or `src/...` for thematic clusters.

- [ ] **Step 3: Commit the baseline report**

```bash
git add docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex.md
git commit -m "docs(frame-extraction): Phase 2 eval baseline — TF-IDF+HDBSCAN on cortex"
```

- [ ] **Step 4: Full suite once more**

```bash
npm test 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 5: Code review**

Dispatch a code-reviewer subagent against the cumulative branch diff (base = current main). Address any critical findings before opening the PR.

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin feature/frame-extraction/phase-2-eval-harness
gh pr create --title "feat(frame-extraction): Phase 2 eval harness + cortex baseline" --body "$(cat <<'EOF'
First Phase 2 evaluation harness. Algorithm-agnostic: consumes any ClusterResult, scores it against the co-change matrix + CALLS-edge graph, emits a markdown report. Plus a cortex baseline run.

## Summary

- Python TF-IDF script now emits silhouette + top-tokens-per-cluster (algorithm-internal metrics live with the algorithm).
- TS eval harness computes the cross-signal + sanity metrics: co_change_agreement, import_agreement, cluster_count, noise_rate.
- Markdown reporter renders the EvalReport into a per-repo .md file.
- CLI: \`npm run eval:phase2 -- --cluster <json> --repo <path>\`.
- Cortex baseline committed at \`docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex.md\`.

## Baseline (cortex)

[fill in from Step 2 output — cluster_count, noise_rate, co_change_agreement, import_agreement, silhouette]

## Deferred

- 5-repo corpus automation (follow-up — clones + indexes + runs cluster + runs eval for all Phase 2 archetypes).
- Cross-algorithm comparison view (when the second candidate exists).
- Speed/memory measurement (placeholder \`null\` in the schema; needs plumbing from the cluster script).

## Test plan

- [x] \`npm test\` green
- [x] agreementScore pure-function tests cover empty pairs, noise pairs, intra/cross-cluster, missing files, and both FilePair and ImportEdge inputs
- [x] collectCallsEdges drops intra-file / NULL-path / cross-project / non-CALLS edges
- [x] Reporter renders all metric keys, handles null values as —
- [x] Cortex baseline run produces a coherent report (top tokens are domain-y, path prefixes match clusters)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:**
  - Silhouette: ✓ (Task 1 — algorithm-internal output).
  - Co-change agreement: ✓ (Task 3).
  - Import agreement: ✓ (Task 4, CALLS-only per the scoping decision).
  - Noise rate: ✓ (Task 3, trivial).
  - Cluster count: ✓ (Task 3, trivial).
  - Determinism: not a *metric* here — already locked in by the algorithm tests (PR #8). Eval is pure-function over deterministic inputs, so it inherits the property.
  - Speed + memory: placeholder `null` in `EvalMetrics`. Plumbing it through requires the cluster script to record wall time; that's a 2-line change but slightly out of scope for this PR. Flagged.
  - Eyeball check: ✓ (cluster_summary section of the report, with top tokens + path prefix + sample paths).
- **No placeholders.** Every step has complete code or exact commands.
- **Type consistency:** `EvalMetrics`, `EvalReport`, `ImportEdge` defined once in Task 2, used consistently across Tasks 3/4/5/6. `agreementScore` signature unchanged across uses.
- **Branch:** `feature/frame-extraction/phase-2-eval-harness` matches workflow.md.
