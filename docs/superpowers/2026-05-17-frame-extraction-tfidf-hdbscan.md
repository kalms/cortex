# TF-IDF + HDBSCAN Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end vertical slice of the first Phase 2 clustering candidate from `docs/specs/cortex-v0.3/frame-extraction.md` §Topical similarity — TF-IDF + HDBSCAN. Input: an indexed Cortex repo. Output: a JSON file with cluster assignments per file. No formal eval metrics yet, just enough to inspect the clusters.

**Architecture:**

- **Language boundary** (confirmed direction with user): Python for ML, TS for orchestration. Python venv lives under `scripts/frame-extraction/python/`, pinned by `requirements.txt`.
- **Data flow** (JSON files on disk, not stdin/stdout — easier to debug + cache):
  ```
  index repo (existing)
        ↓
  text-blob.ts: per-file text blob (path tokens + symbol identifiers from CBM graph)
        ↓
  .tmp/frame-extraction/blobs/<repo-slug>.jsonl  (one line per file)
        ↓
  tfidf_hdbscan.py: sklearn TF-IDF + hdbscan, cosine distance
        ↓
  .tmp/frame-extraction/clusters/<repo-slug>.json  (cluster assignments + parameters)
  ```
- **Scope limit:** topical-only clustering. The spec's combined distance `β · topical_distance + γ · co_change_distance` is **deferred to a separate plan** so this one stays bounded. Same for eval metrics (silhouette, co-change agreement, etc.) — out of scope here, picked up in the eval-harness plan.
- **Tests:** TS-side fully tested. Python script tested via the orchestrator's integration test (skipped if Python venv not present) — keeps unit-test runtime fast for everyone, deeper testing happens when the venv is set up.

**Tech Stack:**

- Python 3.9+ (host has 3.9.6), with a venv pinned by `requirements.txt`:
  - `scikit-learn~=1.4` (TF-IDF)
  - `hdbscan~=0.8` (HDBSCAN, supports `metric='cosine'` via precomputed)
  - `numpy~=1.26`
- TS: orchestrator via `child_process.spawnSync`. Reuse existing `path-tokenize.ts` from PR #5, existing `indexer.ts` envelope wrapper from Phase 1.
- No new npm deps.

---

## Scope Check

This plan covers a single coherent subsystem (run TF-IDF + HDBSCAN over one repo, output clusters). Adjacent things deliberately deferred:

- **Co-change distance integration** — separate plan, easier to reason about once we see what the topical-only baseline produces.
- **Eval harness + 8-metric reporter** — separate plan; needs to apply uniformly across all 3 algorithm candidates, so building it now would couple it to TF-IDF specifics.
- **Leiden + embedding candidates** — each gets its own plan; structure of THIS plan (Python boundary, blob format, output shape) becomes the template they slot into.

Build this one cleanly, then carry the patterns forward.

---

## File Structure

**Python**

- `scripts/frame-extraction/python/requirements.txt` — pinned deps.
- `scripts/frame-extraction/python/setup-venv.sh` — bootstrap script (one-shot creation of the venv + install). Idempotent.
- `scripts/frame-extraction/python/tfidf_hdbscan.py` — main script. Reads input JSONL, writes output JSON. Pure CLI: no library API. Tested via the orchestrator's integration test.
- `scripts/frame-extraction/python/__init__.py` — empty marker so future Python modules can be co-located.

**TS**

- `scripts/frame-extraction/types.ts` (modify) — add `FileBlob`, `ClusterAssignment`, `ClusterResult` types.
- `scripts/frame-extraction/text-blob.ts` (new) — given an indexed repo, query the Cortex graph for entity names per file, combine with path tokens, emit `FileBlob[]`.
- `scripts/frame-extraction/cluster-tfidf-hdbscan.ts` (new) — orchestrator. Writes blob JSONL, spawns Python, parses output, returns `ClusterResult`. CLI entry point.
- `tests/frame-extraction/text-blob.test.ts` (new) — unit tests against a synthetic fixture.
- `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts` (new) — integration test that runs the full pipeline against a tiny fixture repo; **skipped** when Python venv isn't present, so the suite stays runnable everywhere.

**Config**

- `package.json` (modify) — add `cluster:tfidf` script.
- `.gitignore` (modify) — already covers `.tmp/**` from PR #4; verify `scripts/frame-extraction/python/.venv/` is also excluded (or add an explicit entry).

---

## Task 1: Python venv setup

**Files:**
- Create: `scripts/frame-extraction/python/requirements.txt`
- Create: `scripts/frame-extraction/python/setup-venv.sh`
- Create: `scripts/frame-extraction/python/__init__.py` (empty)
- Modify: `.gitignore`

- [ ] **Step 1: Write requirements.txt**

```text
# Pinned for reproducibility — sklearn API has had subtle changes across
# 1.x releases, and hdbscan's API is small but particular.
scikit-learn==1.4.2
hdbscan==0.8.40
numpy==1.26.4
```

- [ ] **Step 2: Write the bootstrap script**

```bash
#!/usr/bin/env bash
# setup-venv.sh — Create the Python venv used by the frame-extraction
# scripts. Idempotent: re-running is a no-op if the venv already has
# the pinned versions installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$ROOT/.venv"
REQ="$ROOT/requirements.txt"

if [ ! -d "$VENV" ]; then
  echo "[setup-venv] creating venv at $VENV"
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REQ"

# Print versions so the user can sanity-check.
"$VENV/bin/python" -c "import sklearn, hdbscan, numpy; print(f'sklearn={sklearn.__version__} hdbscan={hdbscan.__version__} numpy={numpy.__version__}')"
echo "[setup-venv] ready"
```

- [ ] **Step 3: Mark the venv as gitignored**

Read the current `.gitignore`:
```bash
cat .gitignore
```

If `scripts/frame-extraction/python/.venv/` (or just `.venv/`) is not already covered, append:
```
scripts/frame-extraction/python/.venv/
```

- [ ] **Step 4: Make the script executable and run it**

```bash
chmod +x scripts/frame-extraction/python/setup-venv.sh
bash scripts/frame-extraction/python/setup-venv.sh
```

Expected: prints `[setup-venv] creating venv at ...`, then a version line like `sklearn=1.4.2 hdbscan=0.8.40 numpy=1.26.4`, then `[setup-venv] ready`. Total time: under 60 seconds on a typical laptop.

If `pip install hdbscan` fails to build (it has a C extension), the most common cause is a missing system Cython — `pip install cython` first, then retry the setup-venv script. Don't change the pin without flagging.

- [ ] **Step 5: Touch the package marker**

```bash
touch scripts/frame-extraction/python/__init__.py
```

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/python/requirements.txt \
        scripts/frame-extraction/python/setup-venv.sh \
        scripts/frame-extraction/python/__init__.py \
        .gitignore
git commit -m "feat(frame-extraction): pin Python venv for clustering candidates"
```

(Don't commit the `.venv/` itself.)

---

## Task 2: Shared TS types

**Files:**
- Modify: `scripts/frame-extraction/types.ts`

- [ ] **Step 1: Add the types**

Append below the existing types (after `CoChangeOptions`):

```ts
/** Per-file text blob handed to a clustering algorithm. `path` is the
 *  file's path relative to the repo root. `text` is a single string
 *  with path tokens + symbol identifiers, space-separated. Used directly
 *  as input to TF-IDF / embedding pipelines. */
export interface FileBlob {
  path: string;
  text: string;
}

/** One cluster assignment from the algorithm output. */
export interface ClusterAssignment {
  /** Cluster id. -1 means HDBSCAN noise (file not confidently assigned). */
  cluster_id: number;
  /** File paths in this cluster, relative to the repo root. Sorted. */
  member_paths: string[];
}

/** Output of one clustering run. Algorithm name + parameters are stamped
 *  for reproducibility — re-running with the same input + parameters must
 *  produce byte-identical output (determinism is required per the spec). */
export interface ClusterResult {
  algorithm: "tfidf+hdbscan" | "embedding+hdbscan" | "leiden";
  parameters: Record<string, string | number>;
  /** All clusters, sorted by member_count desc then by cluster_id asc.
   *  The noise cluster (cluster_id = -1) is included if non-empty. */
  clusters: ClusterAssignment[];
  /** Total file count = sum of all clusters' member counts. */
  total_files: number;
  /** Number of files in the noise cluster (HDBSCAN-specific; 0 for
   *  algorithms that don't produce noise). */
  noise_count: number;
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
git commit -m "feat(frame-extraction): add FileBlob + ClusterResult types"
```

---

## Task 3: Text-blob extraction

**Files:**
- Create: `scripts/frame-extraction/text-blob.ts`
- Create: `tests/frame-extraction/text-blob.test.ts`

The blob for each file is: tokenized path + identifiers of every function/class/method/interface/type/variable defined in that file. We query the Cortex graph DB directly via `better-sqlite3` (already a project dep) — much faster than per-file MCP calls when iterating over a 1000-file repo.

The Cortex graph DB lives at `<repo>/.cortex/graph.db`. Schema (from `src/graph/store.ts`): a `nodes` table with `kind`, `name`, `file_path`, `project_name` columns. We grab everything for the active project, group by `file_path`, and join with path tokens.

- [ ] **Step 1: Inspect the graph DB schema you'll be querying against**

Run this to confirm the column names you'll use:
```bash
cd /Users/rka/Development/cortex && sqlite3 .cortex/graph.db ".schema nodes" 2>&1 | head -20
```

You should see a column for `kind`, one for `name`, one for `file_path`, and one for the project identifier. The exact column names matter; if any differ from `kind` / `name` / `file_path` / `project_name`, adjust the implementation accordingly and note it.

- [ ] **Step 2: Write the failing test**

```ts
// tests/frame-extraction/text-blob.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { collectBlobsFromGraph } from "../../scripts/frame-extraction/text-blob.js";

let root: string;
let db: Database.Database;

const ENTITY_KINDS = ["function", "class", "method", "interface", "type", "variable"];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-text-blob-"));
  db = new Database(join(root, "graph.db"));
  // Minimal schema covering only the columns we read. Real Cortex graph
  // DBs have more columns — we explicitly do NOT depend on those.
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      project_name TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO nodes (kind, name, file_path, project_name) VALUES (?, ?, ?, ?)",
  );
  // src/auth/middleware.ts: 2 functions
  insert.run("function", "authMiddleware", "src/auth/middleware.ts", "p");
  insert.run("function", "extractToken", "src/auth/middleware.ts", "p");
  // src/billing/invoice.ts: 1 class + 1 function
  insert.run("class", "InvoiceList", "src/billing/invoice.ts", "p");
  insert.run("function", "computeTotal", "src/billing/invoice.ts", "p");
  // node with no file_path (e.g. project node) — must be ignored
  insert.run("project", "p", null, "p");
  // wrong project — must be ignored
  insert.run("function", "ignored", "src/x.ts", "other_project");
  // wrong kind — must be ignored
  insert.run("section", "## intro", "README.md", "p");
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("collectBlobsFromGraph", () => {
  it("groups entity names per file_path, scoped to the project", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    const middleware = blobs.find((b) => b.path === "src/auth/middleware.ts");
    const invoice = blobs.find((b) => b.path === "src/billing/invoice.ts");

    // Path tokens come from tokenizePath; symbol words are derived from
    // each identifier via the same word-splitting rules. We expect both
    // sets to appear in the blob text (order-stable join).
    expect(middleware?.text).toMatch(/\bauth\b/);
    expect(middleware?.text).toMatch(/\bmiddleware\b/);
    expect(middleware?.text).toMatch(/\bauthmiddleware\b|\bauth middleware\b/i);
    expect(middleware?.text).toMatch(/\bextract\b/);
    expect(middleware?.text).toMatch(/\btoken\b/);

    expect(invoice?.text).toMatch(/\bbilling\b/);
    expect(invoice?.text).toMatch(/\binvoice\b/);
    expect(invoice?.text).toMatch(/\bcompute\b/);
    expect(invoice?.text).toMatch(/\btotal\b/);
  });

  it("excludes other projects' nodes", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    expect(blobs.find((b) => b.path === "src/x.ts")).toBeUndefined();
  });

  it("excludes non-entity node kinds", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    expect(blobs.find((b) => b.path === "README.md")).toBeUndefined();
  });

  it("excludes rows with NULL file_path", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    // The project node had file_path = null. No blob for null path.
    expect(blobs.every((b) => b.path !== "" && b.path !== null && b.path !== undefined)).toBe(true);
  });

  it("returns deterministic ordering (paths sorted, tokens deduped)", () => {
    const a = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    const b = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    expect(a).toEqual(b);
    // Paths sorted lexically.
    const paths = a.map((b) => b.path);
    expect([...paths]).toEqual([...paths].sort());
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/text-blob.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module './text-blob.js'`.

- [ ] **Step 4: Implement the module**

```ts
// scripts/frame-extraction/text-blob.ts
import type Database from "better-sqlite3";
import { tokenizePath } from "./path-tokenize.js";
import type { FileBlob } from "./types.js";

/** Default set of node kinds treated as "entities" for blob construction.
 *  Matches the spec's "entity_count" definition + variable (which the
 *  Cortex indexer also emits for top-level consts/lets). */
export const DEFAULT_ENTITY_KINDS = [
  "function", "class", "method", "interface", "type", "variable",
];

/** Reads the project's entity nodes from a Cortex graph DB and emits one
 *  `FileBlob` per file, with the blob text being a single space-separated
 *  string of (path_tokens ∪ symbol words). Deterministic: blob ordering
 *  by file path (asc), token ordering by first-occurrence (Set semantics).
 *
 *  Performance: one SQL query for the entire project, grouped in memory.
 *  Tested against a synthetic fixture so it does not require a real
 *  indexed repo to run. */
export function collectBlobsFromGraph(
  db: Database.Database,
  project_name: string,
  entity_kinds: readonly string[] = DEFAULT_ENTITY_KINDS,
): FileBlob[] {
  const placeholders = entity_kinds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT file_path, name FROM nodes
       WHERE project_name = ?
         AND file_path IS NOT NULL
         AND file_path != ''
         AND kind IN (${placeholders})
       ORDER BY file_path, name`,
    )
    .all(project_name, ...entity_kinds) as Array<{ file_path: string; name: string }>;

  const byFile = new Map<string, Set<string>>();
  for (const row of rows) {
    let tokens = byFile.get(row.file_path);
    if (!tokens) {
      tokens = new Set<string>();
      // Seed with path tokens (deterministic order from tokenizePath).
      const { path_tokens } = tokenizePath(row.file_path);
      for (const t of path_tokens) tokens.add(t);
      byFile.set(row.file_path, tokens);
    }
    // Add the name itself (lowercased — TF-IDF tokenization will see it
    // as one token unless we split, which is what we want for things like
    // 'authMiddleware' staying together as a co-occurrence signal).
    const lowered = row.name.toLowerCase();
    if (lowered) tokens.add(lowered);
    // Also add the split words so 'authMiddleware' contributes both
    // the joined form AND the parts (auth, middleware). The compiler-
    // level Set guarantees dedupe.
    const { symbol_tokens } = tokenizePath(row.name);
    for (const t of symbol_tokens) tokens.add(t);
  }

  // Emit in path-sorted order. Token order within each blob is insertion
  // order from the Set, which gives a stable cross-run result.
  const out: FileBlob[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const tokens = byFile.get(path)!;
    out.push({ path, text: [...tokens].join(" ") });
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/text-blob.test.ts 2>&1 | tail -10
```

Expected: all 5 tests pass.

- [ ] **Step 6: Run the full suite**

```bash
cd /Users/rka/Development/cortex && npm test 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add scripts/frame-extraction/text-blob.ts tests/frame-extraction/text-blob.test.ts
git commit -m "feat(frame-extraction): extract per-file text blobs from graph DB"
```

---

## Task 4: Python TF-IDF + HDBSCAN script

**Files:**
- Create: `scripts/frame-extraction/python/tfidf_hdbscan.py`

This is the algorithm. Reads JSONL (one FileBlob per line) from a path passed as `--in`, writes a ClusterResult JSON to `--out`. Determinism is required: re-running with the same input must produce byte-identical output. HDBSCAN's `min_cluster_size`, `metric`, and the random seed are stamped into the output for reproducibility.

The TF-IDF parameters come from the spec's §Topical similarity: `min_df=2`, `max_df=0.8`, `ngram_range=(1,2)`. HDBSCAN's `min_cluster_size=5` is a starter; the spec calls this out as a tunable.

- [ ] **Step 1: Implement the script**

```python
#!/usr/bin/env python3
# scripts/frame-extraction/python/tfidf_hdbscan.py
"""
TF-IDF + HDBSCAN clustering candidate for Cortex frame extraction Phase 2.

Reads a JSONL file of {"path", "text"} per line and writes a ClusterResult
JSON: {"algorithm", "parameters", "clusters", "total_files", "noise_count"}.

Determinism: TF-IDF is deterministic by construction. HDBSCAN is deterministic
given a fixed input ordering and library version — no random initialisation
in its default mode. We sort input rows by path on read so the input order
is stable, then sort cluster members by path on write.

CLI:
    python tfidf_hdbscan.py --in BLOBS_JSONL --out RESULT_JSON \
        [--min-df INT] [--max-df FLOAT] [--min-cluster-size INT]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
import hdbscan


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="inp", required=True, type=Path)
    parser.add_argument("--out", dest="outp", required=True, type=Path)
    parser.add_argument("--min-df", type=int, default=2,
                        help="TF-IDF min document frequency")
    parser.add_argument("--max-df", type=float, default=0.8,
                        help="TF-IDF max document frequency")
    parser.add_argument("--min-cluster-size", type=int, default=5,
                        help="HDBSCAN min_cluster_size")
    args = parser.parse_args()

    # Read blobs. Sort by path for determinism — JSONL writers may not
    # guarantee order across runs.
    blobs = []
    with args.inp.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            blobs.append(json.loads(line))
    blobs.sort(key=lambda b: b["path"])

    if len(blobs) < args.min_cluster_size:
        # Not enough files to cluster. Emit a single noise cluster.
        write_result(
            outp=args.outp,
            clusters=[],
            total_files=len(blobs),
            noise_count=len(blobs),
            noise_paths=[b["path"] for b in blobs],
            params={
                "min_df": args.min_df,
                "max_df": args.max_df,
                "min_cluster_size": args.min_cluster_size,
                "skipped_reason": "fewer_files_than_min_cluster_size",
            },
        )
        return 0

    texts = [b["text"] for b in blobs]
    paths = [b["path"] for b in blobs]

    # TF-IDF over the corpus. Token pattern accepts identifiers including
    # digits and underscores; n-gram range 1..2 catches short phrases.
    vectorizer = TfidfVectorizer(
        min_df=args.min_df,
        max_df=args.max_df,
        ngram_range=(1, 2),
        token_pattern=r"(?u)\b[a-zA-Z_][a-zA-Z0-9_]+\b",
        lowercase=True,
    )
    matrix = vectorizer.fit_transform(texts)

    # HDBSCAN on cosine distance. Convert sparse TF-IDF → dense cosine
    # distance matrix; for the corpus sizes we care about (≤ ~10k files)
    # this is manageable memory-wise.
    # cosine_distance(a, b) = 1 - cosine_similarity(a, b), clipped to [0, 2].
    dense = matrix.toarray()
    norms = np.linalg.norm(dense, axis=1, keepdims=True)
    norms[norms == 0] = 1.0  # avoid div by zero for empty docs
    normed = dense / norms
    sim = normed @ normed.T
    dist = 1.0 - sim
    np.clip(dist, 0.0, 2.0, out=dist)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=args.min_cluster_size,
        metric="precomputed",
    )
    labels = clusterer.fit_predict(dist.astype(np.float64))

    # Build clusters dict: id → [paths]. HDBSCAN returns -1 for noise.
    clusters_by_id: dict[int, list[str]] = {}
    for path, label in zip(paths, labels):
        clusters_by_id.setdefault(int(label), []).append(path)

    # Build the output. Noise is reported as a single cluster with id -1.
    noise_paths = sorted(clusters_by_id.pop(-1, []))
    non_noise = []
    for cid, members in clusters_by_id.items():
        non_noise.append({
            "cluster_id": cid,
            "member_paths": sorted(members),
        })
    # Sort by member count desc, then cluster_id asc.
    non_noise.sort(key=lambda c: (-len(c["member_paths"]), c["cluster_id"]))

    write_result(
        outp=args.outp,
        clusters=non_noise,
        total_files=len(blobs),
        noise_count=len(noise_paths),
        noise_paths=noise_paths,
        params={
            "min_df": args.min_df,
            "max_df": args.max_df,
            "min_cluster_size": args.min_cluster_size,
            "vocabulary_size": len(vectorizer.vocabulary_),
        },
    )
    return 0


def write_result(*, outp, clusters, total_files, noise_count, noise_paths, params):
    """Write the ClusterResult JSON. Includes the noise cluster (-1) when
    non-empty so the output shape always reflects the full file set."""
    out_clusters = list(clusters)
    if noise_count > 0:
        out_clusters.append({
            "cluster_id": -1,
            "member_paths": noise_paths,
        })
    result = {
        "algorithm": "tfidf+hdbscan",
        "parameters": params,
        "clusters": out_clusters,
        "total_files": total_files,
        "noise_count": noise_count,
    }
    outp.parent.mkdir(parents=True, exist_ok=True)
    with outp.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, sort_keys=False)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Quick standalone smoke test**

Write a 3-file fixture, run the script, eyeball the output.

```bash
cat > /tmp/blobs.jsonl <<'EOF'
{"path":"src/auth/middleware.ts","text":"auth middleware token verify session"}
{"path":"src/auth/handlers.ts","text":"auth handler login logout session"}
{"path":"src/auth/store.ts","text":"auth store session token persist"}
{"path":"src/billing/invoice.ts","text":"billing invoice total tax"}
{"path":"src/billing/payment.ts","text":"billing payment process refund"}
{"path":"src/billing/subscription.ts","text":"billing subscription tier plan"}
EOF

scripts/frame-extraction/python/.venv/bin/python \
  scripts/frame-extraction/python/tfidf_hdbscan.py \
  --in /tmp/blobs.jsonl \
  --out /tmp/clusters.json \
  --min-cluster-size 2

cat /tmp/clusters.json
```

Expected: a JSON file with `algorithm: "tfidf+hdbscan"`, `total_files: 6`, and ideally two clusters (auth + billing). With min_cluster_size=2 and 6 obviously-clustered documents the algorithm should produce a clean split. If everything lands in the noise cluster, the TF-IDF parameters or HDBSCAN's min_cluster_size are too strict for this tiny corpus — that's expected; the real corpora are much bigger. Verify the output is well-formed JSON regardless.

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/python/tfidf_hdbscan.py
git commit -m "feat(frame-extraction): TF-IDF + HDBSCAN Python clustering script"
```

---

## Task 5: TS orchestrator + CLI

**Files:**
- Create: `scripts/frame-extraction/cluster-tfidf-hdbscan.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement the orchestrator**

```ts
// scripts/frame-extraction/cluster-tfidf-hdbscan.ts
/**
 * TF-IDF + HDBSCAN clustering candidate for Cortex frame extraction Phase 2.
 *
 * Flow: open the repo's `.cortex/graph.db`, extract per-file blobs via
 * text-blob.ts, write JSONL to .tmp/frame-extraction/blobs/, spawn the
 * Python script, parse the resulting JSON.
 *
 * CLI: tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts <repo-path> [--out <path>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { collectBlobsFromGraph } from "./text-blob.js";
import type { ClusterResult, FileBlob } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PYTHON_BIN = join(REPO_ROOT, "scripts", "frame-extraction", "python", ".venv", "bin", "python");
const PYTHON_SCRIPT = join(REPO_ROOT, "scripts", "frame-extraction", "python", "tfidf_hdbscan.py");
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "clusters");
const BLOBS_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "blobs");

export interface RunOptions {
  /** Absolute path to a repo containing .cortex/graph.db. */
  repo_path: string;
  /** Project name (matches what cortex-indexer stored — usually derived
   *  from the repo path). If null, defaults to the directory basename. */
  project_name?: string | null;
  /** Where to write the cluster JSON. If null, default path under
   *  .tmp/frame-extraction/clusters/<slug>.json is used. */
  out_path?: string | null;
  min_df?: number;
  max_df?: number;
  min_cluster_size?: number;
}

export interface RunResult {
  result: ClusterResult;
  /** Absolute path to the written cluster JSON. */
  out_path: string;
  /** Absolute path to the intermediate blob JSONL (kept for debugging). */
  blobs_path: string;
}

/** Run the full pipeline: extract blobs, spawn Python, parse output.
 *  Throws on failure with a descriptive message. */
export function runTfIdfHdbscan(opts: RunOptions): RunResult {
  if (!existsSync(PYTHON_BIN)) {
    throw new Error(
      `Python venv not found at ${PYTHON_BIN}. ` +
      `Run scripts/frame-extraction/python/setup-venv.sh first.`,
    );
  }
  const graphDbPath = join(opts.repo_path, ".cortex", "graph.db");
  if (!existsSync(graphDbPath)) {
    throw new Error(
      `No graph DB at ${graphDbPath}. ` +
      `Index the repo with cortex-indexer first.`,
    );
  }
  const project = opts.project_name ?? deriveProjectName(opts.repo_path);
  const slug = project.replace(/[^A-Za-z0-9._-]/g, "_");

  // 1. Extract blobs from the graph DB.
  const db = new Database(graphDbPath, { readonly: true });
  let blobs: FileBlob[];
  try {
    blobs = collectBlobsFromGraph(db, project);
  } finally {
    db.close();
  }

  // 2. Write blob JSONL.
  mkdirSync(BLOBS_DIR, { recursive: true });
  const blobsPath = join(BLOBS_DIR, `${slug}.jsonl`);
  writeFileSync(
    blobsPath,
    blobs.map((b) => JSON.stringify(b)).join("\n") + "\n",
  );

  // 3. Resolve output path.
  mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  const outPath = opts.out_path ?? join(DEFAULT_OUT_DIR, `${slug}.json`);

  // 4. Spawn Python.
  const args = [
    PYTHON_SCRIPT,
    "--in", blobsPath,
    "--out", outPath,
    "--min-df", String(opts.min_df ?? 2),
    "--max-df", String(opts.max_df ?? 0.8),
    "--min-cluster-size", String(opts.min_cluster_size ?? 5),
  ];
  const proc = spawnSync(PYTHON_BIN, args, { encoding: "utf-8" });
  if (proc.error) {
    throw new Error(`Python spawn failed: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(
      `Python script exited with status ${proc.status}\n` +
      `STDOUT: ${proc.stdout?.slice(0, 1000)}\n` +
      `STDERR: ${proc.stderr?.slice(0, 1000)}`,
    );
  }

  // 5. Parse output.
  const result = JSON.parse(readFileSync(outPath, "utf-8")) as ClusterResult;
  return { result, out_path: outPath, blobs_path: blobsPath };
}

function deriveProjectName(repoPath: string): string {
  // Match the indexer's convention: directory basename, with separators
  // replaced (see ctx_project_name_from_path in the C indexer). For most
  // repos this gives the repo dir name.
  return basename(resolve(repoPath));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: tsx cluster-tfidf-hdbscan.ts <repo-path> [--out <path>] [--project <name>] [--min-df N] [--max-df F] [--min-cluster-size N]");
    process.exit(2);
  }
  const opts: RunOptions = { repo_path: resolve(args[0]!) };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") opts.out_path = args[++i]!;
    else if (args[i] === "--project") opts.project_name = args[++i]!;
    else if (args[i] === "--min-df") opts.min_df = Number(args[++i]);
    else if (args[i] === "--max-df") opts.max_df = Number(args[++i]);
    else if (args[i] === "--min-cluster-size") opts.min_cluster_size = Number(args[++i]);
  }
  const { result, out_path } = runTfIdfHdbscan(opts);
  console.log(`[tfidf-hdbscan] ${result.total_files} files, ${result.clusters.length - (result.noise_count > 0 ? 1 : 0)} clusters, ${result.noise_count} noise`);
  console.log(`[tfidf-hdbscan] wrote ${out_path}`);
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("cluster-tfidf-hdbscan.ts");
if (isDirect) main();
```

- [ ] **Step 2: Wire into package.json**

Open `package.json`. Inside `"scripts"`, after `"co-change"`, add:

```json
    "cluster:tfidf": "tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts",
    "setup-python": "bash scripts/frame-extraction/python/setup-venv.sh"
```

- [ ] **Step 3: Sanity-check it compiles**

```bash
cd /Users/rka/Development/cortex && npx tsc --noEmit -p tsconfig.json
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/cluster-tfidf-hdbscan.ts package.json
git commit -m "feat(frame-extraction): TS orchestrator for TF-IDF+HDBSCAN candidate"
```

---

## Task 6: Integration test (skipped without Python)

**Files:**
- Create: `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts`

We can't make every developer install Python + sklearn + hdbscan to run `npm test`. The integration test detects the venv at suite-load time and skips if absent. Anyone who's run `npm run setup-python` gets coverage of the end-to-end flow.

- [ ] **Step 1: Implement the test**

```ts
// tests/frame-extraction/cluster-tfidf-hdbscan.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { runTfIdfHdbscan } from "../../scripts/frame-extraction/cluster-tfidf-hdbscan.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PYTHON_BIN = join(REPO_ROOT, "scripts", "frame-extraction", "python", ".venv", "bin", "python");
const PYTHON_AVAILABLE = existsSync(PYTHON_BIN);

let root: string;

beforeAll(() => {
  if (!PYTHON_AVAILABLE) return;
  // Build a minimal cortex-indexed-looking repo: just the graph DB in
  // .cortex/, populated with two obvious clusters of files (auth + billing).
  root = mkdtempSync(join(tmpdir(), "cortex-cluster-test-"));
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const db = new Database(join(root, ".cortex", "graph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      project_name TEXT
    );
  `);
  const ins = db.prepare(
    "INSERT INTO nodes (kind, name, file_path, project_name) VALUES (?, ?, ?, ?)",
  );
  const project = "cortex_cluster_test";
  // 6 auth files
  for (let i = 0; i < 6; i++) {
    ins.run("function", `authMiddleware${i}`, `src/auth/middleware_${i}.ts`, project);
    ins.run("function", `validateToken${i}`, `src/auth/middleware_${i}.ts`, project);
    ins.run("class", `SessionStore${i}`, `src/auth/middleware_${i}.ts`, project);
  }
  // 6 billing files
  for (let i = 0; i < 6; i++) {
    ins.run("class", `InvoiceList${i}`, `src/billing/invoice_${i}.ts`, project);
    ins.run("function", `computeTotal${i}`, `src/billing/invoice_${i}.ts`, project);
    ins.run("function", `processPayment${i}`, `src/billing/invoice_${i}.ts`, project);
  }
  db.close();

  // Rename the repo dir so deriveProjectName matches what we used in inserts.
  const target = join(tmpdir(), `cortex_cluster_test_${Date.now()}`);
  rmSync(target, { recursive: true, force: true });
  require("node:fs").renameSync(root, target);
  root = target;
});

afterAll(() => {
  if (PYTHON_AVAILABLE && root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!PYTHON_AVAILABLE)("runTfIdfHdbscan (requires Python venv)", () => {
  it("clusters auth files and billing files separately", () => {
    const { result } = runTfIdfHdbscan({
      repo_path: root,
      min_cluster_size: 3,
    });

    expect(result.algorithm).toBe("tfidf+hdbscan");
    expect(result.total_files).toBe(12);

    // Expect 2 non-noise clusters. (HDBSCAN's stability can vary; the
    // assertion is loose: at least 2 clusters AND the auth + billing
    // files don't co-mingle.)
    const nonNoise = result.clusters.filter((c) => c.cluster_id !== -1);
    expect(nonNoise.length).toBeGreaterThanOrEqual(2);

    // For every non-noise cluster, all members must share the same
    // top-level directory (src/auth/* or src/billing/*) — i.e. no
    // cluster mixes the two domains.
    for (const cluster of nonNoise) {
      const topDirs = new Set(
        cluster.member_paths.map((p) => p.split("/").slice(0, 2).join("/")),
      );
      expect(topDirs.size).toBe(1);
    }
  });

  it("is deterministic across runs", () => {
    const a = runTfIdfHdbscan({ repo_path: root, min_cluster_size: 3 });
    const b = runTfIdfHdbscan({ repo_path: root, min_cluster_size: 3 });
    // Drop the file paths (which are absolute and per-run unique).
    const stripPaths = (r: typeof a) => ({
      ...r.result,
      // remove paths that aren't reproducible (parameters.vocabulary_size etc. are deterministic)
    });
    expect(stripPaths(a)).toEqual(stripPaths(b));
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/rka/Development/cortex && npx vitest run tests/frame-extraction/cluster-tfidf-hdbscan.test.ts 2>&1 | tail -10
```

Expected (with Python venv present): 2 passed.
Expected (without venv): `2 skipped, 0 failed` (whole suite skipped via `describe.skipIf`).

The test deliberately uses synthetic data where the domains are obvious to TF-IDF (auth tokens vs billing tokens). Real-world results on cortex/peft/etc. will be messier — that's a Phase 2 eval concern, not this test's.

- [ ] **Step 3: Run the full suite**

```bash
cd /Users/rka/Development/cortex && npm test 2>&1 | tail -5
```

Expected: all green. Whether the new tests run or skip depends on whether the user has run `npm run setup-python`.

- [ ] **Step 4: Commit**

```bash
git add tests/frame-extraction/cluster-tfidf-hdbscan.test.ts
git commit -m "test(frame-extraction): integration test for TF-IDF+HDBSCAN orchestrator"
```

---

## Task 7: Smoke against cortex + push + PR

- [ ] **Step 1: Run the candidate against cortex itself**

```bash
cd /Users/rka/Development/cortex
# Make sure cortex is indexed (the .cortex/graph.db exists from prior work).
ls -la .cortex/graph.db
# Run the candidate.
npm run cluster:tfidf -- . --out .tmp/frame-extraction/clusters/self-cortex.json
```

Expected output:
```
[tfidf-hdbscan] N files, K clusters, M noise
[tfidf-hdbscan] wrote /Users/rka/Development/cortex/.tmp/frame-extraction/clusters/self-cortex.json
```

For cortex (~760 files): K should land in the 4-15 range per the spec's expected "cluster_count — should land in 4–15 range; runaway counts (>30) or collapse (<3) are failure signals". Noise should be a meaningful fraction (10-40%) for a midsize TS codebase.

If `K > 30` or `K < 3`, or noise > 60%, that's a signal the parameters need tuning OR the input blob is too sparse. Don't panic; report the numbers and move on. Phase 2 tuning is a separate plan.

- [ ] **Step 2: Eyeball-check a couple of clusters**

```bash
jq '.clusters[0:3] | .[] | {cluster_id, count: (.member_paths | length), sample: .member_paths[0:5]}' .tmp/frame-extraction/clusters/self-cortex.json
```

Read the sample. Do the 5 paths in each cluster look like they belong together (share a domain word, an obvious topic)? If two of the top-3 clusters are clearly thematic (e.g. "all decisions/*" + "all graph/*"), the algorithm is doing something useful even before tuning. If they look random, that's also useful data — flag in the PR description.

- [ ] **Step 3: Run the full suite once more**

```bash
npm test 2>&1 | tail -5
```

Expected: green. The integration test should now actually run (since the venv is in place from Task 1) and pass — if it doesn't, fix before continuing.

- [ ] **Step 4: Final code-review pass**

Dispatch a code-reviewer subagent against the cumulative branch diff. Address any critical findings.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feature/frame-extraction/tfidf-hdbscan
gh pr create --title "feat(frame-extraction): TF-IDF + HDBSCAN clustering candidate" --body "$(cat <<'EOF'
First Phase 2 clustering candidate, end-to-end vertical slice.

## Summary

- **Python venv** at `scripts/frame-extraction/python/.venv/` pinned to `scikit-learn==1.4.2`, `hdbscan==0.8.40`, `numpy==1.26.4`. Bootstrap: `npm run setup-python`.
- **Per-file text blob** extracted from a Cortex-indexed repo's graph DB: path tokens (framework-stripped) + entity identifiers (functions, classes, methods, interfaces, types, variables) split into words. Deterministic ordering.
- **TF-IDF** with `min_df=2`, `max_df=0.8`, `ngram_range=(1,2)` (spec defaults).
- **HDBSCAN** with `metric='precomputed'` over cosine distance, `min_cluster_size=5`.
- **TS orchestrator** wires it together: extract blobs → JSONL → spawn Python → parse cluster JSON.
- **CLI:** `npm run cluster:tfidf -- <repo-path>`.

## Deferred to separate plans

- Co-change distance combination (`β·topical + γ·co_change`). This PR is topical-only.
- Eval metrics (silhouette, co-change agreement, etc.).
- The other two Phase 2 candidates (Leiden, pinned embeddings).

## Smoke result on cortex

[Fill in the exact numbers from Step 1.]

## Test plan

- [x] `npm test` — green (integration test runs when venv present, skipped otherwise; unit tests always run)
- [x] Text-blob unit tests: graph-DB queries respect project scope, entity-kind filter, NULL file_path, deterministic ordering
- [x] Integration test: synthetic auth+billing fixture clusters cleanly, deterministic across runs
- [x] CLI smoke against cortex (numbers above)
- [x] Code review pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:**
  - §Topical similarity §TF-IDF — covered (Task 4 implements sklearn TF-IDF with the spec's parameters).
  - §HDBSCAN integration — covered (Task 4 runs HDBSCAN on a precomputed cosine-distance matrix).
  - §Determinism property — covered (sorted input, sorted output, library versions pinned, no random state).
  - §Combined distance with co-change — **deliberately deferred** (separate plan).
  - §Eval metrics — **deliberately deferred** (separate plan).
- **No placeholders.** Every code block is complete. Every command has expected output. The PR-body's "Fill in the exact numbers" is the one allowed placeholder — it's a runtime measurement, not a static plan gap.
- **Type/file consistency:** `FileBlob`, `ClusterAssignment`, `ClusterResult` defined once in Task 2, used in Tasks 3/5/6 with matching shape. `collectBlobsFromGraph(db, project_name, kinds?)` signature unchanged across uses.
- **Determinism check on review:** the integration test in Task 6 explicitly compares two runs. A future PR adding embeddings or other randomized stages will need to update that test or add per-algorithm equivalents.
- **Graph DB schema assumption:** Task 3 Step 1 asks the implementer to verify column names. If they differ from `kind`/`name`/`file_path`/`project_name`, the SQL in Task 3 Step 4 needs adjusting — don't proceed blindly.
- **Branch:** `feature/frame-extraction/tfidf-hdbscan` matches workflow.md.
- **Gates:** Gate 0 N/A (no UI). Gate 1 (code review) in Task 7 Step 4. Gate 2 (QA) — research tooling; `npm test` passing is the meaningful signal.
