# Class-Hierarchy Affinity Frame Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic class-hierarchy affinity signal to frame clustering — files whose classes share an in-repo (domain) base are pulled together — blended like the existing co-change γ term.

**Architecture:** A pure TS module reads `base_classes` (already stored in node JSON) from class nodes, resolves domain vs external bases, and emits "files sharing a domain base" pairs. The Python clusterer gains a `--hierarchy`/`--hier-gamma` distance term composed after co-change. `run-frames.ts` extracts the pairs and passes them, gated by `CORTEX_FRAME_HIERARCHY`.

**Tech Stack:** TypeScript (Node, better-sqlite3, vitest), Python (sklearn TfidfVectorizer + hdbscan), spawned via venv.

## Global Constraints

- Determinism is mandatory: sorted input/output ordering everywhere; no randomness.
- The signal is **purely additive** — with γ=0 or no pairs, cluster output must be byte-identical to today's baseline.
- Default γ = `0.3`; env gate `CORTEX_FRAME_HIERARCHY` (≠`0` = on, default on), override `CORTEX_FRAME_HIERARCHY_GAMMA`.
- External bases (no matching in-repo class) are dropped; per-base clique capped at 60 files.
- Pure modules do no I/O except the explicit `write*Jsonl` helper.
- Follow existing patterns in `co-change.ts` / `cluster-tfidf-hdbscan.ts`.

---

### Task 1: `hierarchy-affinity.ts` pure module

**Files:**
- Create: `src/frame-extraction/hierarchy-affinity.ts`
- Test: `tests/frame-extraction/hierarchy-affinity.test.ts`

**Interfaces:**
- Produces: `parseBaseNames(raw: unknown): string[]`, `interface HierarchyPair { a: string; b: string; count: number }`, `collectHierarchyPairs(db: Database.Database, project: string): HierarchyPair[]`, `writeHierarchyJsonl(pairs: HierarchyPair[], outPath: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/hierarchy-affinity.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { parseBaseNames, collectHierarchyPairs } from "../../src/frame-extraction/hierarchy-affinity.js";

describe("parseBaseNames", () => {
  it("normalizes parens, dotted paths, comma lists, generics", () => {
    expect(parseBaseNames(["(nn.Module)"])).toEqual(["module"]);
    expect(parseBaseNames(["torch.nn.Module, LoraLayer"])).toEqual(["module", "loralayer"]);
    expect(parseBaseNames(["BaseTuner<T>"])).toEqual(["basetuner"]);
    expect(parseBaseNames(null)).toEqual([]);
  });
});

describe("collectHierarchyPairs", () => {
  function seed(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const ins = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('class',?,?,'p',?)");
    // Two subclasses of in-repo BaseTuner → one pair. nn.Module is external → dropped.
    ins.run("BaseTuner", "src/tuners/base.ts", JSON.stringify({}));
    ins.run("LoraTuner", "src/tuners/lora.ts", JSON.stringify({ base_classes: ["BaseTuner"] }));
    ins.run("OftTuner", "src/tuners/oft.ts", JSON.stringify({ base_classes: ["BaseTuner"] }));
    ins.run("Net", "src/models/net.ts", JSON.stringify({ base_classes: ["(nn.Module)"] }));
    return db;
  }
  it("pairs files sharing an in-repo base; drops external bases", () => {
    const pairs = collectHierarchyPairs(seed(), "p");
    expect(pairs).toEqual([{ a: "src/tuners/lora.ts", b: "src/tuners/oft.ts", count: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/hierarchy-affinity.test.ts`
Expected: FAIL — `hierarchy-affinity.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/frame-extraction/hierarchy-affinity.ts
/**
 * Class-hierarchy affinity signal for frame clustering. Files whose classes
 * share an IN-REPO (domain) base class are topically related. External bases
 * (no matching in-repo class — nn.Module, TestCase, …) are dropped: measured to
 * be cross-topic hubs that dilute the signal. Pure except writeHierarchyJsonl.
 */
import { writeFileSync } from "node:fs";
import type Database from "better-sqlite3";

export interface HierarchyPair { a: string; b: string; count: number }

/** Max files sharing one base before it is treated as too broad to be topical. */
const MAX_CLIQUE = 60;

/** Normalize a stored base token → candidate base names (lowercased). Handles
 *  "(nn.Module)", comma lists, dotted paths (last segment), and generics. */
export function parseBaseNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    for (const part of entry.replace(/[()]/g, " ").split(",")) {
      const name = (part.trim().split(/[<[]/)[0] ?? "").trim();
      if (!name) continue;
      const segs = name.split(".");
      const base = (segs[segs.length - 1] ?? "").trim().toLowerCase();
      if (base) out.push(base);
    }
  }
  return out;
}

export function collectHierarchyPairs(db: Database.Database, project: string): HierarchyPair[] {
  const rows = db.prepare(
    `SELECT file_path, name, json_extract(data,'$.base_classes') AS bases
       FROM nodes
      WHERE project = ? AND kind = 'class'
        AND file_path IS NOT NULL AND file_path != ''`,
  ).all(project) as Array<{ file_path: string; name: string | null; bases: string | null }>;

  const inRepo = new Set<string>();
  for (const r of rows) if (r.name) inRepo.add(r.name.toLowerCase());

  const baseToFiles = new Map<string, Set<string>>();
  for (const r of rows) {
    let parsed: string[] = [];
    if (r.bases) { try { parsed = parseBaseNames(JSON.parse(r.bases)); } catch { parsed = []; } }
    const self = r.name ? r.name.toLowerCase() : "";
    for (const b of parsed) {
      if (!inRepo.has(b) || b === self) continue;
      let s = baseToFiles.get(b);
      if (!s) { s = new Set(); baseToFiles.set(b, s); }
      s.add(r.file_path);
    }
  }

  const counts = new Map<string, number>();
  for (const files of baseToFiles.values()) {
    const arr = [...files].sort();
    if (arr.length < 2 || arr.length > MAX_CLIQUE) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}\t${arr[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: HierarchyPair[] = [];
  for (const [k, count] of counts) { const [a, b] = k.split("\t"); pairs.push({ a: a!, b: b!, count }); }
  pairs.sort((x, y) => (x.a === y.a ? x.b.localeCompare(y.b) : x.a.localeCompare(y.a)));
  return pairs;
}

export function writeHierarchyJsonl(pairs: HierarchyPair[], outPath: string): void {
  writeFileSync(outPath, pairs.map((p) => JSON.stringify(p)).join("\n") + (pairs.length ? "\n" : ""));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/hierarchy-affinity.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/hierarchy-affinity.ts tests/frame-extraction/hierarchy-affinity.test.ts
git commit -m "feat(frames): hierarchy-affinity pure module (domain-base pairs)"
```

---

### Task 2: Python `--hierarchy` / `--hier-gamma` distance term

**Files:**
- Modify: `scripts/frame-extraction/python/tfidf_hdbscan.py`
- Test: `tests/frame-extraction/hierarchy-cluster.test.ts` (integration, via the TS runner — added in Task 3; this task's verification is the manual Python run below)

**Interfaces:**
- Produces (CLI): `--hierarchy <pairs.jsonl>` (co-change-shaped `{a,b,count}` records) and `--hier-gamma <float in [0,1]>` (default 1.0). Composes after co-change: `dist = (1-hg)·dist + hg·hier_dist`.

- [ ] **Step 1: Add `build_hierarchy_distance` (mirror of `build_co_change_distance`)**

In `tfidf_hdbscan.py`, just after `build_co_change_distance`, add:

```python
def build_hierarchy_distance(
    paths: list[str], pairs: list[dict]
) -> np.ndarray:
    """Cosine-like DISTANCE matrix from shared-base pairs. Identical shape and
    saturation to the co-change matrix: observed pair → 1 - log1p(count)/log1p(max),
    unobserved → 1.0, diagonal 0.0. Endpoints not in `paths` are dropped."""
    return build_co_change_distance(paths, pairs)
```

- [ ] **Step 2: Add CLI args**

After the `--gamma` argument block:

```python
    parser.add_argument("--hierarchy", dest="hierarchy", type=Path, default=None,
                        help="Per-pair JSONL ({a,b,count}) of files sharing a "
                             "domain base class. Blended via --hier-gamma.")
    parser.add_argument("--hier-gamma", dest="hier_gamma", type=float, default=1.0,
                        help="Weight on hierarchy distance in [0,1] (default 1.0). "
                             "Combined = (1-hg)·dist + hg·hierarchy. Ignored when "
                             "--hierarchy is not provided.")
```

And in the validation block (after the `--gamma` range check):

```python
    if not 0.0 <= args.hier_gamma <= 1.0:
        parser.error(f"--hier-gamma must be in [0, 1], got {args.hier_gamma}")
    if args.hierarchy is not None and not args.hierarchy.exists():
        parser.error(f"--hierarchy path does not exist: {args.hierarchy}")
```

- [ ] **Step 3: Compose the term after the co-change/embedding branch**

Immediately after the `dist = topical_dist` / co-change / embedding blend (after the
existing `else: dist = topical_dist`), add:

```python
    hier_pairs_loaded = 0
    if args.hierarchy is not None and args.hier_gamma > 0:
        hpairs = []
        with args.hierarchy.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                hpairs.append(json.loads(line))
        hier_pairs_loaded = len(hpairs)
        hier_dist = build_hierarchy_distance(paths, hpairs)
        dist = (1.0 - args.hier_gamma) * dist + args.hier_gamma * hier_dist
        np.clip(dist, 0.0, 2.0, out=dist)
```

And add to the `params` dict in the final `write_result(...)` call:

```python
            "hier_gamma": args.hier_gamma if args.hierarchy is not None else None,
            "hier_pairs_loaded": hier_pairs_loaded,
```

- [ ] **Step 4: Verify the Python runs end-to-end with a hierarchy file**

Run:
```bash
printf '{"a":"x.ts","b":"y.ts","count":1}\n' > /tmp/h.jsonl
printf '{"path":"x.ts","text":"alpha beta"}\n{"path":"y.ts","text":"gamma delta"}\n{"path":"z.ts","text":"alpha beta"}\n' > /tmp/b.jsonl
"$HOME/.cache/cortex-indexer/python-venv/bin/python" scripts/frame-extraction/python/tfidf_hdbscan.py --in /tmp/b.jsonl --out /tmp/o.json --min-cluster-size 2 --hierarchy /tmp/h.jsonl --hier-gamma 1.0
python3 -c "import json;d=json.load(open('/tmp/o.json'));print(d['parameters']['hier_pairs_loaded'], d['parameters']['hier_gamma'])"
```
Expected: prints `1 1.0` (no Python error; param recorded).

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/python/tfidf_hdbscan.py
git commit -m "feat(frames): --hierarchy/--hier-gamma distance term in clusterer"
```

---

### Task 3: `RunOptions` hierarchy plumbing + integration test

**Files:**
- Modify: `src/frame-extraction/cluster-tfidf-hdbscan.ts` (RunOptions + arg push)
- Test: `tests/frame-extraction/hierarchy-cluster.test.ts`

**Interfaces:**
- Consumes: `collectHierarchyPairs`/`writeHierarchyJsonl` (Task 1), `--hierarchy`/`--hier-gamma` (Task 2).
- Produces: `RunOptions.hierarchy_path?: string | null`, `RunOptions.hier_gamma?: number`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/frame-extraction/hierarchy-cluster.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runTfIdfHdbscan } from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { collectHierarchyPairs, writeHierarchyJsonl } from "../../src/frame-extraction/hierarchy-affinity.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";

const RUN = hasVenv() ? describe : describe.skip;
RUN("hierarchy clustering integration", () => {
  let root: string; let project: string; let dbPath: string; let hierPath: string;
  beforeAll(() => {
    root = join(tmpdir(), `cortex_hier_${Date.now()}`);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    project = root.replace(/[/:]/g, "-").replace(/-+/g, "-").replace(/^-+/, "");
    mkdirSync(join(root, ".cortex"), { recursive: true });
    dbPath = join(root, ".cortex", "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const f = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('file',?,?,?,NULL)");
    const c = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('class',?,?,?,?)");
    // 4 files with disjoint vocab so TF-IDF alone would NOT group them; two share base Foo.
    for (const [name, fp] of [["a","src/a.ts"],["b","src/b.ts"],["c","src/c.ts"],["d","src/d.ts"]] as const) f.run(name, fp, project);
    c.run("Foo", "src/foo.ts", project, JSON.stringify({}));
    c.run("A", "src/a.ts", project, JSON.stringify({ base_classes: ["Foo"] }));
    c.run("B", "src/b.ts", project, JSON.stringify({ base_classes: ["Foo"] }));
    db.close();
    hierPath = join(root, "h.jsonl");
    const rdb = new Database(dbPath, { readonly: true });
    writeHierarchyJsonl(collectHierarchyPairs(rdb, project), hierPath);
    rdb.close();
  });

  it("emits a hierarchy pair for the two Foo subclasses", () => {
    const rdb = new Database(dbPath, { readonly: true });
    const pairs = collectHierarchyPairs(rdb, project);
    rdb.close();
    expect(pairs).toEqual([{ a: "src/a.ts", b: "src/b.ts", count: 1 }]);
  });

  it("γ=0 is inert (passing a hierarchy file with hier_gamma 0 matches no-hierarchy)", () => {
    const base = runTfIdfHdbscan({ repo_path: root, project_name: project, db_path: dbPath, co_change_path: null, out_path: join(root, "base.json") });
    const inert = runTfIdfHdbscan({ repo_path: root, project_name: project, db_path: dbPath, co_change_path: null, hierarchy_path: hierPath, hier_gamma: 0, out_path: join(root, "inert.json") });
    expect(inert.result.parameters?.hier_pairs_loaded).toBeDefined();
    expect(JSON.stringify(inert.result.clusters)).toEqual(JSON.stringify(base.result.clusters));
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/hierarchy-cluster.test.ts`
Expected: FAIL — `hierarchy_path` is not a known `RunOptions` field (type error / ignored arg).

- [ ] **Step 3: Add the RunOptions fields + arg passing**

In `src/frame-extraction/cluster-tfidf-hdbscan.ts`, add to the `RunOptions` interface (after `gamma`):

```ts
  /** Path to a hierarchy-affinity pairs JSONL ({a,b,count}); blended via hier_gamma. */
  hierarchy_path?: string | null;
  /** Weight on hierarchy distance in [0,1]; default 1.0. Ignored if no hierarchy_path. */
  hier_gamma?: number;
```

And in `runTfIdfHdbscan`, after the co-change/embeddings arg block (before `spawnSync`):

```ts
  if (opts.hierarchy_path) {
    args.push("--hierarchy", opts.hierarchy_path);
    args.push("--hier-gamma", String(opts.hier_gamma ?? 1.0));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/hierarchy-cluster.test.ts`
Expected: PASS (both `it` blocks; γ=0 produces byte-identical clusters).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/cluster-tfidf-hdbscan.ts tests/frame-extraction/hierarchy-cluster.test.ts
git commit -m "feat(frames): RunOptions hierarchy_path/hier_gamma plumbing"
```

---

### Task 4: Wire into `run-frames.ts` (gated, default γ=0.3)

**Files:**
- Modify: `src/frame-extraction/run-frames.ts`
- Test: `tests/frame-extraction/run-frames-hierarchy.test.ts`

**Interfaces:**
- Consumes: `collectHierarchyPairs`/`writeHierarchyJsonl` (Task 1), `RunOptions.hierarchy_path`/`hier_gamma` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/run-frames-hierarchy.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runFrameExtraction } from "../../src/frame-extraction/run-frames.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";

const RUN = hasVenv() ? describe : describe.skip;
RUN("run-frames hierarchy gate", () => {
  let root: string; let project: string; let dbPath: string;
  beforeEach(() => {
    root = join(tmpdir(), `cortex_rfh_${Date.now()}`);
    project = root.replace(/[/:]/g, "-").replace(/-+/g, "-").replace(/^-+/, "");
    mkdirSync(join(root, ".cortex"), { recursive: true });
    dbPath = join(root, ".cortex", "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const f = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('file',?,?,?,NULL)");
    for (let i = 0; i < 8; i++) f.run(`f${i}`, `src/f${i}.ts`, project);
    db.close();
  });
  afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

  it("CORTEX_FRAME_HIERARCHY=0 disables the term (runs without error)", async () => {
    const prev = process.env.CORTEX_FRAME_HIERARCHY;
    process.env.CORTEX_FRAME_HIERARCHY = "0";
    try {
      const r = await runFrameExtraction({ repoPath: root, project, dbPath });
      expect(r.status === "ok" || r.status === "skipped").toBe(true);
    } finally { process.env.CORTEX_FRAME_HIERARCHY = prev; }
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/run-frames-hierarchy.test.ts`
Expected: FAIL — `run-frames.ts` does not yet read `CORTEX_FRAME_HIERARCHY` / import the module (test passes only after wiring exists; if it already passes, confirm the import is absent first).

(Note: this test asserts the gate path runs cleanly. The substantive effect is covered by Task 3's integration test; this guards the wiring.)

- [ ] **Step 3: Wire the hierarchy term into `runFrameExtraction`**

Add the import near the other frame imports:

```ts
import { collectHierarchyPairs, writeHierarchyJsonl } from "./hierarchy-affinity.js";
```

After the co-change block and before the `runTfIdfHdbscan` call, add:

```ts
    // 1b. hierarchy affinity (best-effort; inert when the repo has no class
    //     hierarchy — e.g. functional codebases). Gated; default on at γ=0.3.
    let hierPath: string | null = null;
    let hierGamma = 0;
    if (process.env.CORTEX_FRAME_HIERARCHY !== "0") {
      try {
        const hdb = new Database(opts.dbPath, { readonly: true });
        let pairs;
        try { pairs = collectHierarchyPairs(hdb, opts.project); } finally { hdb.close(); }
        if (pairs.length > 0) {
          hierPath = join(work, "hierarchy.jsonl");
          writeHierarchyJsonl(pairs, hierPath);
          const g = Number(process.env.CORTEX_FRAME_HIERARCHY_GAMMA);
          hierGamma = Number.isFinite(g) && g >= 0 && g <= 1 ? g : 0.3;
        }
      } catch {
        // Best-effort: a read failure just skips the hierarchy term.
        hierPath = null;
      }
    }
```

Then update the `runTfIdfHdbscan` call to pass the term:

```ts
    const { result } = runTfIdfHdbscan({
      repo_path: opts.repoPath,
      project_name: opts.project,
      db_path: opts.dbPath,
      out_path: join(work, "cluster.json"),
      co_change_path: existsSync(ccPath) ? ccPath : null,
      hierarchy_path: hierPath,
      hier_gamma: hierGamma,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/run-frames-hierarchy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/run-frames.ts tests/frame-extraction/run-frames-hierarchy.test.ts
git commit -m "feat(frames): wire hierarchy affinity into run-frames (gated, γ=0.3)"
```

---

### Task 5: Docs, full suite, eval baseline, decision revision

**Files:**
- Modify: `docs/architecture/frame-extraction.md` (document the signal + gates)
- Modify: `scripts/frame-extraction/baselines/` (add a dated baseline if the corpus eval is re-run)

- [ ] **Step 1: Run the full frame-extraction test suite**

Run: `npx vitest run tests/frame-extraction/`
Expected: PASS (all existing tests green + the 3 new files). Investigate any regression before proceeding.

- [ ] **Step 2: Document the signal**

In `docs/architecture/frame-extraction.md`, add a subsection under the clustering/signals area:

```markdown
### Class-hierarchy affinity (OO repos)

Files whose classes share an **in-repo (domain) base class** are pulled together
during clustering, via a distance term blended at γ=0.3 (parallel to co-change).
The base list comes from `base_classes` already stored on class nodes;
`hierarchy-affinity.ts` resolves domain vs external bases (external — `nn.Module`,
`TestCase` — are dropped as cross-topic hubs; measured to add no value) and caps
each base's clique at 60 files. Deterministic. Inert on functional codebases
(no class hierarchy). A modest frame-quality lift on OO repos (label-F1 ↑,
clusters-below-floor ↓); not a `cluster:N` fix in itself. Gates:
`CORTEX_FRAME_HIERARCHY=0` disables; `CORTEX_FRAME_HIERARCHY_GAMMA` overrides γ.
```

- [ ] **Step 3: Commit docs + run the version-bump/merge protocol prep**

```bash
git add docs/architecture/frame-extraction.md
git commit -m "docs(frames): document class-hierarchy affinity signal"
```

- [ ] **Step 4: Revise decision D-0j21 (via MCP decision tool, not a code edit)**

Update `D-0j21` so its claim reads: *TF-IDF is the best standalone signal; a domain
class-hierarchy affinity term is a deterministic, modest quality lift on OO repos
(available cortex-side from stored `base_classes`). External-base / indexer-side
gains measured ~0; Go `IMPLEMENTS` is the only net-new indexer signal, deferred.*
Link it to this plan and the hierarchy design doc.

- [ ] **Step 5: Gate 0/1/2 + merge protocol**

This is a code change → release. Per `.claude/rules/workflow.md`: run `/review` on
the diff (Gate 1), invoke the `qa` agent (Gate 2), bump all three version fields +
CHANGELOG (patch), open a PR to `main`, let the "CI gate" pass, then merge. Remove
the worktree afterward.

---

## Self-Review

**Spec coverage:** module (T1) ✓, Python term (T2) ✓, plumbing (T3) ✓, gated wiring + default γ + env overrides (T4) ✓, determinism/additive-inert assertions (T3 γ=0 test) ✓, external-base drop + clique cap (T1) ✓, docs + decision revision + follow-ups (T5) ✓. The Go-`IMPLEMENTS` TODO and `T-sy2d` narrowing are recorded as follow-ups in the design doc (not code tasks).

**Placeholder scan:** no TBDs; all code/test steps carry full code and exact commands.

**Type consistency:** `HierarchyPair {a,b,count}` (T1) matches the JSONL the Python reads (T2) and the `{a,b,count}` co-change shape; `hierarchy_path`/`hier_gamma` names consistent across T3/T4; `collectHierarchyPairs`/`writeHierarchyJsonl` signatures stable across T1/T3/T4.
