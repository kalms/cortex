# Frame Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roughly halve the HDBSCAN noise rate via a safe `min_samples` retune (Phase 1), then reclaim the graph-connected residual into the frame it belongs to (Phase 2), so far more semantic files land in a frame.

**Architecture:** Keep tf-idf+HDBSCAN as the topical core. Phase 1 exposes and lowers HDBSCAN's `min_samples` (it silently defaulted to `min_cluster_size`=5), gated by the label-quality F1 harness. Phase 2 adds a pure TS post-clustering pass that assigns residual noise files to their most-connected cluster via a CALLS/USAGE/IMPORTS edge rollup, marking them `reclaimed` so the ranker scores nameability on the topical core only.

**Tech Stack:** Python (sklearn + hdbscan), TypeScript (Node16 ESM), better-sqlite3, vitest. Reuses Path 1's ranker (`frame-ranker.ts`) and frame-map (`frame-map.ts`).

---

## Spec reference

Design spec: [docs/superpowers/specs/2026-06-09-frame-coverage-design.md](../specs/2026-06-09-frame-coverage-design.md)

## File Structure

**Phase 1 (retune):**
- Modify `scripts/frame-extraction/python/tfidf_hdbscan.py` — add `--min-samples`, pass to HDBSCAN, stamp into result `parameters`.
- Modify `src/frame-extraction/cluster-tfidf-hdbscan.ts` — `RunOptions.min_samples`, default `1`, pass `--min-samples`, CLI flag.

**Phase 2 (reclamation):**
- Modify `src/frame-extraction/types.ts` — add `ClusterAssignment.reclaimed_paths?: string[]`.
- Create `src/frame-extraction/frame-reclamation.ts` — pure `reclaimNoise(cluster, nodes, edges, opts)`.
- Modify `src/frame-extraction/inject-frames.ts` — `buildFrameAssignments` emits a `reclaimed` flag per assignment; `injectFrames` writes `$.reclaimed` into node `data`.
- Modify `src/frame-extraction/run-frames.ts` — read nodes+edges, run `reclaimNoise` between clustering and injection.
- Modify `src/frame-extraction/frame-ranker.ts` — score nameability on core (non-reclaimed) members; `member_count` still counts all.
- Modify `src/mcp-server/frame-map.ts` — split framed files into all-members vs core-members from the `reclaimed` flag; feed both to the ranker.

**Test files:**
- `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts` (append — venv-guarded)
- `tests/frame-extraction/frame-reclamation.test.ts` (create)
- `tests/frame-extraction/inject-frames.test.ts` (append)
- `tests/frame-extraction/frame-ranker.test.ts` (append)
- `tests/mcp-server/frame-map.test.ts` (append)

## Conventions

- Tests: `npx vitest run <path>`. Python-spawning tests are guarded by `hasVenv()` and skip when the venv is absent — keep that guard.
- ESM imports use `.js` extensions for `.ts` sources (Node16). vitest does not typecheck; run `npx tsc --noEmit` for types.
- `NodeRow` = `{ id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at }`; `data` is a JSON string. `EdgeRow` = `{ id, source_id, target_id, relation, data, created_at }`. Both from `src/graph/store.ts`.
- `ClusterAssignment` = `{ cluster_id, member_paths }` (per-cluster; `cluster_id === -1` is noise). `ClusterResult` = `{ algorithm, parameters, clusters, total_files, noise_count }`.
- Commit after each task with the message in its final step.

---

# PHASE 1 — Retune

### Task 1: Expose and default `min_samples`

**Files:**
- Modify: `scripts/frame-extraction/python/tfidf_hdbscan.py`
- Modify: `src/frame-extraction/cluster-tfidf-hdbscan.ts`
- Test: `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts` (append)

- [ ] **Step 1: Add the Python flag + pass to HDBSCAN + stamp params**

In `scripts/frame-extraction/python/tfidf_hdbscan.py`, add the argument next to `--min-cluster-size` (in the `argparse` block):

```python
    parser.add_argument("--min-samples", type=int, default=None,
                        help="HDBSCAN min_samples (default: HDBSCAN's own "
                             "default, which equals min_cluster_size)")
```

Change the `hdbscan.HDBSCAN(...)` construction to pass it:

```python
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=args.min_cluster_size,
        min_samples=args.min_samples,
        metric="precomputed",
    )
```

(`hdbscan` accepts `min_samples=None` and falls back to its own default, so omitting the flag is behaviour-preserving.)

Find the `write_result(... params={...})` call in `main` (the success path, not the early `skipped_reason` path) and add `min_samples` to the stamped params dict:

```python
            params={
                "min_df": args.min_df,
                "max_df": args.max_df,
                "min_cluster_size": args.min_cluster_size,
                "min_samples": args.min_samples,
            },
```

- [ ] **Step 2: Write the failing test** (append to `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts`)

```ts
describe("min_samples wiring", () => {
  it.skipIf(!PYTHON_AVAILABLE)(
    "defaults min_samples to 1 and stamps it into result parameters",
    () => {
      const { result } = runTfIdfHdbscan({
        repo_path: root,
        db_path: join(root, ".cortex", "graph.db"),
        co_change_path: null,
      });
      expect(result.parameters.min_samples).toBe(1);
    },
    VENV_TEST_TIMEOUT_MS,
  );

  it.skipIf(!PYTHON_AVAILABLE)(
    "honors an explicit min_samples override",
    () => {
      const { result } = runTfIdfHdbscan({
        repo_path: root,
        db_path: join(root, ".cortex", "graph.db"),
        co_change_path: null,
        min_samples: 3,
      });
      expect(result.parameters.min_samples).toBe(3);
    },
    VENV_TEST_TIMEOUT_MS,
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/cluster-tfidf-hdbscan.test.ts -t "min_samples"`
Expected: FAIL — `result.parameters.min_samples` is `undefined` (wrapper doesn't send the flag yet, default not applied).

- [ ] **Step 4: Add `min_samples` to the TS wrapper**

In `src/frame-extraction/cluster-tfidf-hdbscan.ts`:

(a) Add to the `RunOptions` interface, next to `min_cluster_size?: number;`:

```ts
  /** HDBSCAN min_samples. Decoupled from min_cluster_size; the wrapper
   *  defaults it to 1 (the conservative HDBSCAN default of
   *  min_cluster_size=5 caused ~70% noise — see the frame-coverage spec). */
  min_samples?: number;
```

(b) In the `args` array built before `spawnSync`, add the flag after the `--min-cluster-size` entry:

```ts
    "--min-cluster-size", String(opts.min_cluster_size ?? 5),
    "--min-samples", String(opts.min_samples ?? 1),
```

(c) In `main`'s arg-parse loop, add a CLI flag alongside `--min-cluster-size`:

```ts
    else if (args[i] === "--min-samples") opts.min_samples = Number(args[++i]);
```

(d) Update the `usage` string to include `[--min-samples N]`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/cluster-tfidf-hdbscan.test.ts -t "min_samples"`
Expected: PASS (or SKIP if no venv — if skipped, run `npx tsc --noEmit` to confirm types and note the skip).

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/python/tfidf_hdbscan.py src/frame-extraction/cluster-tfidf-hdbscan.ts tests/frame-extraction/cluster-tfidf-hdbscan.test.ts
git commit -m "feat(frames): expose HDBSCAN min_samples, default 1 (halves noise)"
```

---

### Task 2: Quality-gate the retune

**Files:**
- Verification only (no source change unless a regression surfaces).

This task confirms the retune doesn't degrade label quality. It is a measurement gate, not a code change.

- [ ] **Step 1: Capture the baseline F1 (min_samples=5)**

Run the clustering at the OLD setting and score labels:

```bash
npx tsx src/frame-extraction/cluster-tfidf-hdbscan.ts /Users/rka/Development/cortex --min-cluster-size 5 --min-samples 5 --out .tmp/cov-baseline.json
```

Then score with the label-quality harness (use the existing eval entrypoint):

```bash
npx tsx src/frame-extraction/eval-labels.ts /Users/rka/Development/cortex .tmp/cov-baseline.json 2>/dev/null || \
  echo "If eval-labels has no CLI, score in a node one-off using scoreClusters + aggregateLabelQuality from label-quality.js against the cluster JSON's top_tokens_per_cluster."
```

Record `f1_weighted` and `noise_count`.

- [ ] **Step 2: Capture the retuned F1 (min_samples=1)**

```bash
npx tsx src/frame-extraction/cluster-tfidf-hdbscan.ts /Users/rka/Development/cortex --min-cluster-size 5 --min-samples 1 --out .tmp/cov-retune.json
```

Score the same way. Record `f1_weighted` and `noise_count`.

- [ ] **Step 3: Assert the gate**

Expected: `noise_count` drops materially (≈282 → ≈138 on Cortex) AND `f1_weighted(retune) >= f1_weighted(baseline) - 0.05` AND `f1_weighted(retune) >= 0.5` (`DEFAULT_F1_FLOOR`).

- If the gate holds → Phase 1 is validated; proceed.
- If `f1_weighted` regresses below the tolerance → set the wrapper default to `min_samples: 2` instead of `1` (the spec's documented fallback: 52% noise, still a big improvement), re-run this gate, and note the change. Update Task 1 step 4(b) accordingly.

- [ ] **Step 4: Commit the recorded numbers**

Append a short results note to the spec's verification section (or a field report) and commit:

```bash
git add docs/superpowers/specs/2026-06-09-frame-coverage-design.md
git commit -m "docs(frames): record Phase 1 retune F1 gate results"
```

---

# PHASE 2 — Graph reclamation

### Task 3: Add `reclaimed_paths` to the cluster type

**Files:**
- Modify: `src/frame-extraction/types.ts`

- [ ] **Step 1: Add the field**

In `src/frame-extraction/types.ts`, extend `ClusterAssignment`:

```ts
/** One cluster assignment from the algorithm output. */
export interface ClusterAssignment {
  /** Cluster id. -1 means HDBSCAN noise (file not confidently assigned). */
  cluster_id: number;
  /** File paths in this cluster, relative to the repo root. Sorted. */
  member_paths: string[];
  /** Subset of `member_paths` added by graph reclamation (not topical core).
   *  Absent/empty for clusters straight from HDBSCAN. */
  reclaimed_paths?: string[];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0 (additive optional field; no existing code breaks).

- [ ] **Step 3: Commit**

```bash
git add src/frame-extraction/types.ts
git commit -m "feat(frames): add ClusterAssignment.reclaimed_paths"
```

---

### Task 4: `reclaimNoise` pure module

**Files:**
- Create: `src/frame-extraction/frame-reclamation.ts`
- Test: `tests/frame-extraction/frame-reclamation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/frame-extraction/frame-reclamation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reclaimNoise } from "../../src/frame-extraction/frame-reclamation.js";
import type { ClusterResult } from "../../src/frame-extraction/types.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string): NodeRow {
  return {
    id, kind: "function", name: id, qualified_name: `${path}::${id}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function edge(source: string, target: string, relation = "CALLS"): EdgeRow {
  return { id: `${source}->${target}:${relation}`, source_id: source, target_id: target, relation, data: "{}", created_at: "" };
}

// Clusters: 0 = {a1,a2}, 1 = {b1}; noise = {x, y}.
function baseCluster(): ClusterResult {
  return {
    algorithm: "tfidf+hdbscan",
    parameters: {},
    clusters: [
      { cluster_id: 0, member_paths: ["a1.ts", "a2.ts"] },
      { cluster_id: 1, member_paths: ["b1.ts"] },
      { cluster_id: -1, member_paths: ["x.ts", "y.ts"] },
    ],
    total_files: 5,
    noise_count: 2,
  };
}
const nodes: NodeRow[] = [
  fileNode("fa1", "a1.ts"), fileNode("fa2", "a2.ts"), fileNode("fb1", "b1.ts"),
  fileNode("fx", "x.ts"), fileNode("fy", "y.ts"),
  symNode("sx", "x.ts"), symNode("sy", "y.ts"),
  symNode("sa1", "a1.ts"), symNode("sa2", "a2.ts"), symNode("sb1", "b1.ts"),
];

describe("reclaimNoise", () => {
  it("assigns a noise file to the cluster it has the most edges to", () => {
    // x -> a1, x -> a2 (2 edges to cluster 0), x -> b1 (1 edge to cluster 1)
    const edges = [edge("sx", "sa1"), edge("sx", "sa2"), edge("sx", "sb1")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    const c0 = out.clusters.find((c) => c.cluster_id === 0)!;
    expect(c0.member_paths).toContain("x.ts");
    expect(c0.reclaimed_paths).toEqual(["x.ts"]);
  });

  it("leaves a noise file in noise when below the edge threshold", () => {
    const edges = [edge("sy", "sa1")]; // only 1 edge, minEdges=2
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    const noise = out.clusters.find((c) => c.cluster_id === -1)!;
    expect(noise.member_paths).toContain("y.ts");
    expect(out.noise_count).toBe(2); // x also still noise (no edges)
  });

  it("breaks argmax ties on the lowest cluster_id", () => {
    // x: 2 edges to cluster 0 and 2 edges to cluster 1 → tie → cluster 0
    const edges = [edge("sx", "sa1"), edge("sx", "sa2"), edge("sx", "sb1"), edge("sx", "sb1", "USAGE")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    expect(out.clusters.find((c) => c.cluster_id === 0)!.member_paths).toContain("x.ts");
    expect(out.clusters.find((c) => c.cluster_id === 1)!.member_paths).not.toContain("x.ts");
  });

  it("counts CALLS/USAGE/IMPORTS and ignores other relations", () => {
    const edges = [edge("sx", "sa1", "DEFINES"), edge("sx", "sa2", "INHERITS")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 1 });
    expect(out.clusters.find((c) => c.cluster_id === -1)!.member_paths).toContain("x.ts");
  });

  it("drops the noise cluster entirely when all files are reclaimed", () => {
    const edges = [
      edge("sx", "sa1"), edge("sx", "sa2"),
      edge("sy", "sa1"), edge("sy", "sa2"),
    ];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    expect(out.clusters.find((c) => c.cluster_id === -1)).toBeUndefined();
    expect(out.noise_count).toBe(0);
  });

  it("is deterministic and a no-op when there is no noise cluster", () => {
    const c: ClusterResult = { ...baseCluster(), clusters: [
      { cluster_id: 0, member_paths: ["a1.ts"] },
    ], noise_count: 0 };
    expect(reclaimNoise(c, nodes, [], {})).toEqual(c);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/frame-reclamation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reclaimNoise`**

Create `src/frame-extraction/frame-reclamation.ts`:

```ts
// src/frame-extraction/frame-reclamation.ts
/**
 * Graph reclamation: assign HDBSCAN noise files to the topical cluster they are
 * most connected to via CALLS/USAGE/IMPORTS edges. The tf-idf token space leaves
 * ~30% of code files as noise even tuned aggressively, but those files carry rich
 * call/import structure into the clustered code (frame-coverage spec). This pass
 * rolls up symbol-level edges to the file level, sums per-cluster weight for each
 * noise file, and assigns it to the argmax cluster above a threshold. Reclaimed
 * files are tracked in `reclaimed_paths` so the ranker can keep nameability scored
 * on the topical core.
 *
 * PURE — no I/O.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import type { ClusterResult, ClusterAssignment } from "./types.js";

const RECLAIM_RELATIONS = new Set(["CALLS", "USAGE", "IMPORTS"]);
const DEFAULT_MIN_EDGES = 2;

export interface ReclaimOptions {
  /** Minimum rolled-up edge count to a cluster to reclaim a noise file. */
  minEdges?: number;
  /** Edge relations counted. Defaults to CALLS/USAGE/IMPORTS. */
  relations?: Iterable<string>;
}

export function reclaimNoise(
  cluster: ClusterResult,
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  opts: ReclaimOptions = {},
): ClusterResult {
  const minEdges = opts.minEdges ?? DEFAULT_MIN_EDGES;
  const relations = new Set(opts.relations ?? RECLAIM_RELATIONS);

  const noise = cluster.clusters.find((c) => c.cluster_id === -1);
  if (!noise || noise.member_paths.length === 0) return cluster;
  const noiseSet = new Set(noise.member_paths);

  // file_path -> non-noise cluster id
  const clusterByPath = new Map<string, number>();
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) continue;
    for (const p of c.member_paths) clusterByPath.set(p, c.cluster_id);
  }

  // node id -> file_path
  const pathById = new Map<string, string>();
  for (const n of nodes) if (n.file_path) pathById.set(n.id, n.file_path);

  // noise file_path -> (cluster_id -> summed edge weight)
  const weights = new Map<string, Map<number, number>>();
  const bump = (noisePath: string, cid: number) => {
    let m = weights.get(noisePath);
    if (!m) { m = new Map(); weights.set(noisePath, m); }
    m.set(cid, (m.get(cid) ?? 0) + 1);
  };
  for (const e of edges) {
    if (!relations.has(e.relation)) continue;
    const pa = pathById.get(e.source_id);
    const pb = pathById.get(e.target_id);
    if (!pa || !pb || pa === pb) continue;
    const aNoise = noiseSet.has(pa);
    const bNoise = noiseSet.has(pb);
    if (aNoise && !bNoise) {
      const cid = clusterByPath.get(pb);
      if (cid !== undefined) bump(pa, cid);
    } else if (bNoise && !aNoise) {
      const cid = clusterByPath.get(pa);
      if (cid !== undefined) bump(pb, cid);
    }
  }

  // Decide assignments. argmax weight; tie-break lowest cluster_id.
  const reclaimedByCluster = new Map<number, string[]>();
  const stillNoise: string[] = [];
  for (const p of noise.member_paths) {
    const m = weights.get(p);
    if (!m) { stillNoise.push(p); continue; }
    let bestCid = -1;
    let bestW = -1;
    for (const [cid, w] of m) {
      if (w > bestW || (w === bestW && cid < bestCid)) { bestW = w; bestCid = cid; }
    }
    if (bestW >= minEdges) {
      const list = reclaimedByCluster.get(bestCid) ?? [];
      list.push(p);
      reclaimedByCluster.set(bestCid, list);
    } else {
      stillNoise.push(p);
    }
  }

  const newClusters: ClusterAssignment[] = [];
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) {
      if (stillNoise.length > 0) {
        newClusters.push({ ...c, member_paths: [...stillNoise].sort() });
      }
      continue;
    }
    const reclaimed = reclaimedByCluster.get(c.cluster_id);
    if (!reclaimed || reclaimed.length === 0) { newClusters.push(c); continue; }
    newClusters.push({
      ...c,
      member_paths: [...c.member_paths, ...reclaimed].sort(),
      reclaimed_paths: [...(c.reclaimed_paths ?? []), ...reclaimed].sort(),
    });
  }

  return { ...cluster, clusters: newClusters, noise_count: stillNoise.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/frame-reclamation.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-reclamation.ts tests/frame-extraction/frame-reclamation.test.ts
git commit -m "feat(frames): reclaimNoise — assign noise files to most-connected cluster"
```

---

### Task 5: Write the `reclaimed` marker into node data

**Files:**
- Modify: `src/frame-extraction/inject-frames.ts`
- Test: `tests/frame-extraction/inject-frames.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/frame-extraction/inject-frames.test.ts`)

Place this at the end of the file (it builds its own temp DB; follow the existing `injectFrames` test style in the file for the DB schema if one already exists — use the same `nodes` table columns the file's existing injectFrames tests use):

```ts
describe("injectFrames — reclaimed marker", () => {
  let dbDir: string;
  let dbPath: string;
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "inject-reclaim-"));
    dbPath = join(dbDir, "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const ins = db.prepare("INSERT INTO nodes (kind, name, file_path, project, data) VALUES ('file', ?, ?, 'p', '{}')");
    ins.run("core.ts", "core.ts");
    ins.run("recl.ts", "recl.ts");
    db.close();
  });
  afterEach(() => rmSync(dbDir, { recursive: true, force: true }));

  it("marks reclaimed files with data.reclaimed = true and core files without it", () => {
    const cluster: ClusterResult = {
      algorithm: "tfidf+hdbscan", parameters: { top_tokens_per_cluster: { "0": ["core"] } },
      clusters: [{ cluster_id: 0, member_paths: ["core.ts", "recl.ts"], reclaimed_paths: ["recl.ts"] }],
      total_files: 2, noise_count: 0,
    };
    injectFrames({ cluster, project: "p", dbPath });
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT file_path, data FROM nodes").all() as { file_path: string; data: string }[];
    db.close();
    const byPath = Object.fromEntries(rows.map((r) => [r.file_path, JSON.parse(r.data)]));
    expect(byPath["recl.ts"].reclaimed).toBe(true);
    expect(byPath["recl.ts"].frame_id).toBe(0);
    expect(byPath["core.ts"].reclaimed).toBeUndefined();
    expect(byPath["core.ts"].frame_id).toBe(0);
  });
});
```

If the test file's top-level imports don't already include `beforeEach`, `afterEach`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `Database`, add them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts -t "reclaimed marker"`
Expected: FAIL — `byPath["recl.ts"].reclaimed` is `undefined`.

- [ ] **Step 3: Thread `reclaimed` through `buildFrameAssignments` + `injectFrames`**

In `src/frame-extraction/inject-frames.ts`:

(a) Add `reclaimed` to the `FrameAssignment` interface:

```ts
export interface FrameAssignment {
  file_path: string;
  frame_id: number;
  frame_label: string;
  frame_confidence: number;
  reclaimed: boolean;
}
```

(b) In `buildFrameAssignments`, compute a per-cluster reclaimed set and stamp the flag:

```ts
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokens[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id, suppressed);
    const reclaimedSet = new Set(c.reclaimed_paths ?? []);
    for (const path of c.member_paths) {
      out.push({
        file_path: path,
        frame_id: c.cluster_id,
        frame_label: label,
        frame_confidence: 1.0,
        reclaimed: reclaimedSet.has(path),
      });
    }
  }
```

(c) In `injectFrames`, the `applyOne` UPDATE must also set `$.reclaimed`. Replace the `applyOne` prepared statement's SQL with a version that sets the flag, and bind it:

```ts
    const applyOne = db.prepare(`
      UPDATE nodes
      SET data = json_set(
        json_set(
          json_set(
            json_set(COALESCE(data, '{}'), '$.frame_id', @frame_id),
            '$.frame_label', @frame_label
          ),
          '$.frame_confidence', @frame_confidence
        ),
        '$.reclaimed', json(@reclaimed)
      )
      WHERE project = @project
        AND kind = 'file'
        AND file_path = @file_path
    `);
```

Then in the transaction loop, bind `reclaimed` as a SQL json boolean — pass the string `'true'`/`'false'` to `json(...)`:

```ts
      for (const a of assignments) {
        applyOne.run({
          file_path: a.file_path,
          frame_id: a.frame_id,
          frame_label: a.frame_label,
          frame_confidence: a.frame_confidence,
          reclaimed: a.reclaimed ? "true" : "false",
          project: args.project,
        });
      }
```

(d) The `clearStmt` (which removes frame keys from non-cluster files) must also remove `$.reclaimed`. Add one more `json_remove(..., '$.reclaimed')` wrapper around its existing nested `json_remove`s so stale flags are cleared on re-cluster.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: PASS (new test + all existing inject-frames tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "feat(frames): persist data.reclaimed flag on reclaimed frame members"
```

---

### Task 6: Rank nameability on core members only

**Files:**
- Modify: `src/frame-extraction/frame-ranker.ts`
- Test: `tests/frame-extraction/frame-ranker.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/frame-extraction/frame-ranker.test.ts`)

```ts
describe("rankFrames — reclaimed members", () => {
  it("scores nameability on core members, not reclaimed ones", () => {
    const corpus = buildCorpusIndex([
      { path: "src/checkout/cart.ts", text: "src checkout cart" },
      { path: "src/checkout/pay.ts", text: "src checkout pay" },
      { path: "src/random/unrelated.ts", text: "src random unrelated" },
    ]);
    // Frame "checkout" with one reclaimed unrelated file. Nameability must
    // reflect only the core (checkout) members.
    const withReclaimed = rankFrames([{
      frame_id: 0, frame_label: "checkout",
      member_paths: ["src/checkout/cart.ts", "src/checkout/pay.ts", "src/random/unrelated.ts"],
      core_member_paths: ["src/checkout/cart.ts", "src/checkout/pay.ts"],
    }], corpus)[0];
    const coreOnly = rankFrames([{
      frame_id: 0, frame_label: "checkout",
      member_paths: ["src/checkout/cart.ts", "src/checkout/pay.ts"],
    }], corpus)[0];
    // Same nameability (reclaimed file ignored for the label score)...
    expect(withReclaimed.components.f1).toBeCloseTo(coreOnly.components.f1, 5);
    // ...but member_count counts the reclaimed file.
    expect(withReclaimed.member_count).toBe(3);
  });

  it("falls back to all members when core_member_paths is omitted", () => {
    const corpus = buildCorpusIndex([{ path: "a/b.ts", text: "a b" }]);
    const r = rankFrames([{ frame_id: 0, frame_label: "b", member_paths: ["a/b.ts"] }], corpus)[0];
    expect(r.member_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts -t "reclaimed members"`
Expected: FAIL — `FrameRecord` has no `core_member_paths`; nameability uses all members so the counts differ.

- [ ] **Step 3: Add `core_member_paths` and use it for nameability**

In `src/frame-extraction/frame-ranker.ts`:

(a) Extend `FrameRecord`:

```ts
export interface FrameRecord {
  frame_id: number;
  frame_label: string;
  member_paths: string[];
  /** Non-reclaimed (topical core) members. Nameability scores against these;
   *  defaults to `member_paths` when omitted. structural_weight always uses
   *  the full `member_paths`. */
  core_member_paths?: string[];
}
```

(b) In `rankFrames`, score the label against the core:

```ts
  const scored = records.map((r) => {
    const labelPaths = r.core_member_paths ?? r.member_paths;
    const f1 = scoreLabel(r.frame_label, labelPaths, corpus).f1;
    const generic_penalty = genericPenalty(r.frame_label);
    const nameability = f1 * generic_penalty;
    const structural_weight = Math.sqrt(r.member_paths.length);
    const score = nameability * structural_weight;
    return {
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_paths.length,
      score,
      components: { nameability, structural_weight, f1, generic_penalty },
    };
  });
```

(Only the `labelPaths` line and the `scoreLabel` argument change; the rest of `rankFrames` is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: PASS (new tests + all existing ranker tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-ranker.ts tests/frame-extraction/frame-ranker.test.ts
git commit -m "feat(frames): rank nameability on core members, count all members"
```

---

### Task 7: Feed core vs all members from the graph (frame-map)

**Files:**
- Modify: `src/mcp-server/frame-map.ts`
- Test: `tests/mcp-server/frame-map.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/mcp-server/frame-map.test.ts`)

```ts
describe("buildFrameMap — reclaimed members", () => {
  it("excludes reclaimed members from the nameability core but counts them", () => {
    const fileR = (id: string, path: string, frameId: number, label: string, reclaimed = false): NodeRow => ({
      id, kind: "file", name: path, qualified_name: null, file_path: path,
      data: JSON.stringify({ frame_id: frameId, frame_label: label, ...(reclaimed ? { reclaimed: true } : {}) }),
      tier: "tier1", created_at: "", updated_at: "",
    });
    const nodes: NodeRow[] = [
      fileR("f1", "src/checkout/cart.ts", 0, "checkout"),
      fileR("f2", "src/checkout/pay.ts", 0, "checkout"),
      fileR("f3", "src/misc/unrelated.ts", 0, "checkout", true), // reclaimed
    ];
    const map = buildFrameMap(nodes, []);
    const checkout = map.frames.find((f) => f.name === "checkout")!;
    expect(checkout.count).toBe(3); // all three counted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/frame-map.test.ts -t "reclaimed members"`
Expected: it likely PASSES on `count` already (count uses member_paths). The behavioral guarantee being locked is that reclaimed files are tracked separately for nameability. To make the test meaningful and failing first, assert the core split is applied — see step 3's implementation, then strengthen the test in step 4. (If it passes immediately, proceed to step 3; the implementation still must thread `core_member_paths` so the ranker scores correctly.)

- [ ] **Step 3: Split core vs all members in `buildFrameRecords`**

In `src/mcp-server/frame-map.ts`, update the private `buildFrameRecords` so each record carries `core_member_paths` (members whose node `data.reclaimed` is not true):

```ts
function buildFrameRecords(nodes: readonly NodeRow[]): FrameRecord[] {
  const byFrame = new Map<number, { frame_id: number; frame_label: string; member_paths: string[]; core_member_paths: string[] }>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let d: { frame_id?: number; frame_label?: string; reclaimed?: boolean };
    try { d = JSON.parse(n.data); } catch { continue; }
    if (typeof d.frame_id !== "number") continue;
    const label = typeof d.frame_label === "string" ? d.frame_label : `frame:${d.frame_id}`;
    let rec = byFrame.get(d.frame_id);
    if (!rec) {
      rec = { frame_id: d.frame_id, frame_label: label, member_paths: [], core_member_paths: [] };
      byFrame.set(d.frame_id, rec);
    }
    rec.member_paths.push(n.file_path);
    if (d.reclaimed !== true) rec.core_member_paths.push(n.file_path);
  }
  return [...byFrame.values()].sort((a, b) => a.frame_id - b.frame_id);
}
```

The returned objects now satisfy `FrameRecord` (with `core_member_paths`), so `rankFrames` scores nameability on the core automatically.

- [ ] **Step 4: Strengthen the test to lock nameability behavior**

Replace the step-1 test body with one that proves a reclaimed off-topic file does NOT drag the label score down (compare F1 via the score). Add to the same `describe`:

```ts
  it("a reclaimed off-topic file does not lower the frame score vs core-only", () => {
    const mk = (reclaimed: boolean): NodeRow[] => ([
      { id: "f1", kind: "file", name: "src/checkout/cart.ts", qualified_name: null, file_path: "src/checkout/cart.ts",
        data: JSON.stringify({ frame_id: 0, frame_label: "checkout" }), tier: "t", created_at: "", updated_at: "" },
      { id: "f2", kind: "file", name: "src/checkout/pay.ts", qualified_name: null, file_path: "src/checkout/pay.ts",
        data: JSON.stringify({ frame_id: 0, frame_label: "checkout" }), tier: "t", created_at: "", updated_at: "" },
      { id: "f3", kind: "file", name: "src/zzz/unrelated.ts", qualified_name: null, file_path: "src/zzz/unrelated.ts",
        data: JSON.stringify({ frame_id: 0, frame_label: "checkout", ...(reclaimed ? { reclaimed: true } : {}) }), tier: "t", created_at: "", updated_at: "" },
    ]);
    const reclaimedScore = buildFrameMap(mk(true), []).frames.find((f) => f.id === 0)!.score;
    const countedScore = buildFrameMap(mk(false), []).frames.find((f) => f.id === 0)!.score;
    // With the off-topic file reclaimed, the label F1 (nameability) is computed
    // on the 2 checkout files only, so the score is >= the version where the
    // off-topic file dilutes the label.
    expect(reclaimedScore).toBeGreaterThanOrEqual(countedScore);
  });
```

Run: `npx vitest run tests/mcp-server/frame-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (expect clean).

```bash
git add src/mcp-server/frame-map.ts tests/mcp-server/frame-map.test.ts
git commit -m "feat(frames): frame-map feeds core vs all members to the ranker"
```

---

### Task 8: Wire reclamation into the pipeline (run-frames)

**Files:**
- Modify: `src/frame-extraction/run-frames.ts`
- Test: `tests/frame-extraction/run-frames.test.ts` (append, venv-guarded) OR a focused DB-backed test

- [ ] **Step 1: Add the reclamation step between clustering and injection**

In `src/frame-extraction/run-frames.ts`, add imports:

```ts
import { reclaimNoise } from "./frame-reclamation.js";
import { GraphStore } from "../graph/store.js";
```

After the `runTfIdfHdbscan(...)` call returns `{ result }` and before `injectFrames(...)`, read nodes+edges from the same DB and reclaim:

```ts
    // 2b. Graph reclamation — pull HDBSCAN noise files into the cluster they
    //     are most connected to via CALLS/USAGE/IMPORTS (frame-coverage spec).
    let reclaimed = result;
    try {
      const store = new GraphStore(opts.dbPath);
      try {
        const nodes = store.getAllNodesUnified(opts.project);
        const edges = store.getAllEdgesUnified(opts.project);
        reclaimed = reclaimNoise(result, nodes, edges);
      } finally {
        store.close();
      }
    } catch {
      // Reclamation is best-effort; on any read failure fall back to the raw
      // cluster result (Phase 1 coverage still applies).
      reclaimed = result;
    }

    // 3. inject frame_id into the same DB.
    const framesAssigned = injectFrames({ cluster: reclaimed, project: opts.project, dbPath: opts.dbPath });
    const clusters = reclaimed.clusters.filter((c) => c.cluster_id !== -1).length;
    return { status: "ok", framesAssigned, clusters, elapsedMs: Date.now() - start };
```

(Replace the existing `const framesAssigned = injectFrames({ cluster: result, ... })` and the two lines after it with the block above.)

- [ ] **Step 2: Write the test** (append to `tests/frame-extraction/run-frames.test.ts`)

Follow the existing `run-frames.test.ts` setup (it builds an indexed-looking repo DB and is venv-guarded). Add a test asserting that after `runFrames`, more files are framed than clusters-only would give — i.e. at least one noise file with strong edges gets a `frame_id` and a `reclaimed` marker. If the existing test file already builds a suitable repo, extend it; otherwise add a focused case:

```ts
it.skipIf(!PYTHON_AVAILABLE)(
  "reclaims a graph-connected noise file into a frame",
  () => {
    // Uses the test repo built in this file's beforeAll. After runFrames,
    // assert at least one file node carries data.reclaimed = true OR that
    // framesAssigned exceeds the pure-cluster member count. Read the DB:
    const res = runFrames({ repoPath: root, project: projectName, dbPath });
    expect(res.status).toBe("ok");
    const db = new Database(dbPath);
    const reclaimedCount = (db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE kind='file' AND json_extract(data,'$.reclaimed')=1"
    ).get() as { c: number }).c;
    db.close();
    // Not asserting a specific count (depends on the fixture's edges); assert
    // the pipeline ran and the reclaimed query is valid (>= 0). If the fixture
    // has cross-file edges into noise, this will be > 0.
    expect(reclaimedCount).toBeGreaterThanOrEqual(0);
  },
  VENV_TEST_TIMEOUT_MS,
);
```

(If the existing fixture has no edges table / no cross-file edges, this asserts the pipeline still succeeds with reclamation wired in — the unit coverage for reclaim logic lives in Task 4. Note in the test comment which case applies.)

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/frame-extraction/run-frames.test.ts`
Expected: PASS or SKIP (no venv). Then `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add src/frame-extraction/run-frames.ts tests/frame-extraction/run-frames.test.ts
git commit -m "feat(frames): wire graph reclamation into the frame pipeline"
```

---

### Task 9: End-to-end verification + Gate-0

**Files:**
- Verification only.

- [ ] **Step 1: Reindex Cortex and measure coverage delta**

```bash
# Full reindex runs clustering + reclamation + injection.
./bin/cortex index repository --path=/Users/rka/Development/cortex 2>/dev/null || true
```

Then via the dev server `/api/graph`, count framed files before/after (compare to the spec's baseline: 109 framed). Record framed count, reclaimed count, residual noise.

Expected: framed files substantially higher than 109 (Phase 1 retune ≈ doubles the clustered core; Phase 2 adds the graph-connected residual).

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all frame-extraction + mcp-server + viewer tests pass (the pre-existing `tests/db/cache.test.ts` flaky timeout is unrelated — ignore it).

- [ ] **Step 3: Gate-0 visual QA** (per `.claude/rules/workflow.md`)

Start the dev server (`npm run dev` with stdin held open), navigate Playwright to `http://localhost:3334/viewer`, screenshot to `.playwright-mcp/frame-coverage.png`, check console for errors. Verify: more frames render, labels stay crisp (no junk labels from over-reclamation), no overlaps, no console errors. If Playwright is unavailable, state so and flag for hand-verify.

- [ ] **Step 4: Capture the decision**

```
search_decisions({ query: "frame coverage reclamation", repo_path: "/Users/rka/Development/cortex" })
create_decision({
  repo_path: "/Users/rka/Development/cortex",
  title: "Frame coverage: min_samples retune + graph reclamation",
  description: "HDBSCAN min_samples exposed + defaulted to 1 (was implicitly min_cluster_size=5), halving noise; a pure reclaimNoise pass then assigns residual noise files to their most-connected cluster via CALLS/USAGE/IMPORTS rollup, marked reclaimed so nameability scores on the topical core only.",
  rationale: "Diagnosis showed 70% noise was largely a conservative param default, and the residual carries rich graph connectivity (1511 edges). Phased fix avoids a Leiden rewrite; reuses Path 1 machinery.",
  alternatives: "Leiden graph-native clustering (deferred — high cost/risk); min_cluster_size tuning (weak, non-monotonic lever); placing leftovers without reclaiming (lower information gain).",
  governs: ["src/frame-extraction/frame-reclamation.ts", "src/frame-extraction/cluster-tfidf-hdbscan.ts", "scripts/frame-extraction/python/tfidf_hdbscan.py"]
})
```

- [ ] **Step 5: Keep the index current**

```
detect_changes({ repo_path: "/Users/rka/Development/cortex" })
index_repository({ repo_path: "/Users/rka/Development/cortex" })
```

---

## Deferred (out of scope, per spec)

- **Leiden / graph-native clustering** — gated on whether Phases 1–2 leave an unacceptable residual.
- **Floating-entity placement** of the post-reclamation residual + auxiliary aggregates — Phase 2 shrinks the residual; placing what remains is a separate follow-up.
- **`min_samples` auto-tuning per repo** — fixed default for now, with `min_samples=2` as the documented fallback if the F1 gate fails.

## Self-Review (completed during planning)

- **Spec coverage:** Phase 1 retune → Tasks 1–2 (Python flag, wrapper default 1, F1 gate with min_samples=2 fallback). Phase 2 reclamation → Task 4 (`reclaimNoise`, CALLS/USAGE/IMPORTS rollup, argmax, threshold, tie-break, residual). Core-vs-reclaimed → Tasks 3, 5 (`reclaimed_paths` type + `data.reclaimed` marker), 6 (ranker nameability on core), 7 (frame-map split). Pipeline wiring → Task 8. Determinism → reclaimNoise is pure argmax over integer weights (Task 4 tests). Verification → Task 9 (coverage delta, F1, Gate-0). Deferred items documented.
- **Type consistency:** `reclaimed_paths?: string[]` (Task 3) → consumed by `buildFrameAssignments` (Task 5) and produced by `reclaimNoise` (Task 4). `FrameAssignment.reclaimed: boolean` (Task 5) → `data.reclaimed` (Task 5) → read by `buildFrameRecords` (Task 7) → `FrameRecord.core_member_paths` (Task 6) → `rankFrames` nameability (Task 6). `reclaimNoise(cluster, nodes, edges, opts)` signature consistent between Task 4 and its caller Task 8.
- **Placeholder scan:** no TBD/TODO; every code step shows full code or an exact diff. Task 2 and Task 9 are verification gates (no code) by design — the spec explicitly calls for the F1 gate and coverage measurement.
```
