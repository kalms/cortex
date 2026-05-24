# Frame Extraction — Co-change Distance Combination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add co-change as a second distance signal to the TF-IDF + HDBSCAN clustering candidate, per [frame-extraction.md §Co-change as semantic signal](../specs/cortex-v0.3/frame-extraction.md). The combined distance is `(1 − γ) · topical_distance + γ · co_change_distance`. Phase 2 eval on cortex showed `lenient co_change_agreement = 0.108` — most pairs of frequently-co-changing files do not cluster together. This change directly addresses that.

**Architecture:** Extend the existing Python script (`scripts/frame-extraction/python/tfidf_hdbscan.py`) with a pure helper `build_co_change_distance(paths, pairs)` that produces an aligned `(n, n)` distance matrix in `[0, 1]` (default `1.0` for unobserved pairs; log-scaled corpus-relative similarity for observed pairs). The HDBSCAN call switches from running over the cosine distance alone to running over the convex combination of the cosine distance and the co-change distance, weighted by `γ`. Existing pure-topical behavior is preserved when no `--co-change` argument is passed (cold-start case).

**Tech Stack:** TypeScript (orchestration), Python 3 (`numpy`, `sklearn`, `hdbscan`), `vitest` for tests, `better-sqlite3` to read the graph DB (unchanged). No new dependencies.

**Out of scope:** Per-file commit counts (true Jaccard normalization), γ tuning on the rest of the corpus, batched runs across all repos. This plan ships the mechanism + comparison on cortex. Tuning across the broader corpus is a follow-up chunk.

---

## File Structure

- Modify: [scripts/frame-extraction/python/tfidf_hdbscan.py](../../scripts/frame-extraction/python/tfidf_hdbscan.py) — add `build_co_change_distance` helper, `--co-change`/`--gamma` CLI args, combined-distance assembly
- Modify: [scripts/frame-extraction/cluster-tfidf-hdbscan.ts](../../scripts/frame-extraction/cluster-tfidf-hdbscan.ts) — accept `co_change_path` + `gamma` options, default `co_change_path` to `.tmp/frame-extraction/co-change/<slug>.jsonl` when that file exists, pass through to Python subprocess
- Modify: [tests/frame-extraction/cluster-tfidf-hdbscan.test.ts](../../tests/frame-extraction/cluster-tfidf-hdbscan.test.ts) — add co-change pull case (cross-domain pair gets pulled together when γ is high)
- Create: [docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex-cochange.md](../specs/cortex-v0.3/phase-2-eval/) — comparison report at γ ∈ {0.0, 0.3, 0.5, 0.7}

The Python helper is testable in isolation through the existing TS integration test pattern — the test feeds the orchestrator a synthetic graph DB + a synthetic co-change JSONL and asserts behavior. We do not introduce pytest.

---

## Design notes (read once before starting)

**Normalisation choice.** Co-change observations are heavy-tailed (a handful of pairs co-change in dozens of commits; most pairs that ever co-change do so once or twice). A linear normalization (`count / max_count`) lets the hottest pair flatten everything else into near-zero. Log-scaled normalization handles this:

```
sim(a, b) = log(1 + count_ab) / log(1 + max_count)        # in [0, 1]
dist(a, b) = 1 - sim(a, b)                                # in [0, 1]
```

**Default (unobserved pairs).** A pair with no co-change observation has `distance = 1.0`. Interpretation: "no evidence these files belong together by this signal" — maximum distance.

**Convex combination.** We expose only `--gamma γ`, and let `β = 1 − γ`. This keeps the combined distance in `[0, 1]`, which HDBSCAN's density estimation is well-behaved over. The spec leaves the door open to unconstrained `β, γ`; the simpler form is sufficient for the eval comparison and easier to interpret.

**Cold start.** No co-change file → `γ = 0` implicitly → identical to the previous behavior. Tested explicitly in Task 3.

**Why log + corpus-relative, not Jaccard.** Jaccard `(count_ab) / (commits_touching_a + commits_touching_b − count_ab)` is the principled choice but needs per-file commit counts, which the current co-change JSONL doesn't carry. Adding that is a 1-line change to `co-change.ts` but doubles the cardinality of "the co-change artifact." We can revisit if the log version doesn't deliver — but this plan keeps the existing file format unchanged.

---

### Task 1: Pure Python helper `build_co_change_distance`

**Files:**
- Modify: `scripts/frame-extraction/python/tfidf_hdbscan.py`
- Test indirectly via the next task's integration test (no pytest in repo)

Extract a top-level pure function. The caller (Task 2) will combine it with the topical distance. Function shape:

```python
def build_co_change_distance(
    paths: list[str], pairs: list[dict]
) -> np.ndarray:
    """Build an (n, n) symmetric co-change DISTANCE matrix.

    `paths` is the row order — must match the order rows appear in the
    topical distance matrix. `pairs` is the co-change JSONL list-of-dicts
    [{"a": ..., "b": ..., "count": ...}, ...].

    Distance for an observed pair (a, b):
        sim = log(1 + count) / log(1 + max_count)
        dist = 1 - sim       (in [0, 1])
    Unobserved pair: dist = 1.0
    Diagonal: 0.0

    Pairs referencing paths not in `paths` are silently dropped — they
    can't influence clustering. Symmetric: storing (a, b) implies (b, a).
    """
```

**Key behaviors to lock in via the tests in Task 2:**
- Empty `pairs` → returns `(n, n)` matrix that is `1.0` off-diagonal and `0.0` on the diagonal.
- A pair where neither path is in `paths` is silently dropped.
- Single observation (only one pair, count=1) → that pair's distance is `0.0` (since `log(1+1) / log(1+max=1) = 1`), every other off-diagonal entry is `1.0`.
- Symmetry: `M[i, j] == M[j, i]` for all `i, j`.

- [ ] **Step 1: Write the failing test (deferred — it lives in Task 2's integration test). Skip directly to implementation.**

Reason for skipping a test-first step here: the function is internal to the Python script. We test it through the orchestrator (Task 2's integration test) because that's the contract callers actually use. Adding pytest just for this would be over-engineering.

- [ ] **Step 2: Implement `build_co_change_distance`**

Open `scripts/frame-extraction/python/tfidf_hdbscan.py` and add this function ABOVE `main()`:

```python
def build_co_change_distance(
    paths: list[str], pairs: list[dict]
) -> np.ndarray:
    """Build an (n, n) symmetric co-change DISTANCE matrix.

    Aligned with `paths` row order. Observed pair distance:
        sim = log(1 + count) / log(1 + max_count_in_corpus)
        dist = 1 - sim
    Unobserved pair: dist = 1.0. Diagonal: 0.0.
    Pairs whose endpoints aren't in `paths` are dropped silently.
    """
    import math
    n = len(paths)
    # 1.0 off-diagonal; zero out the diagonal at the end.
    dist = np.ones((n, n), dtype=np.float64)
    np.fill_diagonal(dist, 0.0)
    if not pairs:
        return dist

    path_to_idx = {p: i for i, p in enumerate(paths)}
    # First pass: filter to in-corpus pairs and find max_count.
    filtered: list[tuple[int, int, int]] = []
    max_count = 0
    for p in pairs:
        a = p.get("a")
        b = p.get("b")
        count = p.get("count", 0)
        if a is None or b is None or count <= 0:
            continue
        ia = path_to_idx.get(a)
        ib = path_to_idx.get(b)
        if ia is None or ib is None or ia == ib:
            continue
        filtered.append((ia, ib, int(count)))
        if count > max_count:
            max_count = count

    if max_count == 0:
        return dist  # no usable observations

    denom = math.log1p(max_count)  # log(1 + max_count); > 0 since max_count >= 1
    for ia, ib, count in filtered:
        sim = math.log1p(count) / denom
        d = 1.0 - sim
        dist[ia, ib] = d
        dist[ib, ia] = d
    return dist
```

- [ ] **Step 3: Quick smoke-check the math in the Python REPL**

This is a sanity check, not a permanent test. Run from the project root:

```bash
scripts/frame-extraction/python/.venv/bin/python -c "
import sys
sys.path.insert(0, 'scripts/frame-extraction/python')
from tfidf_hdbscan import build_co_change_distance
import numpy as np

# Three files, one pair observed
paths = ['a.ts', 'b.ts', 'c.ts']
pairs = [{'a': 'a.ts', 'b': 'b.ts', 'count': 1}]
d = build_co_change_distance(paths, pairs)
print('Single-pair distance matrix:')
print(d)
assert d[0, 1] == 0.0 and d[1, 0] == 0.0   # the one observation pulled to zero
assert d[0, 2] == 1.0 and d[1, 2] == 1.0   # no obs -> max distance
assert d[0, 0] == 0.0                       # diagonal zero
print('OK')
"
```

Expected output: matrix `[[0,0,1],[0,0,1],[1,1,0]]` and `OK`. If anything else, debug before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/python/tfidf_hdbscan.py
git commit -m "$(cat <<'EOF'
feat(frame-extraction): add build_co_change_distance helper

Pure function: takes (paths, pairs) and returns an (n, n) symmetric
co-change distance matrix in [0, 1]. Log-scaled corpus-relative
normalisation; unobserved pairs default to distance 1.0. Caller
(coming in next commit) will weight this against the topical
distance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Combined distance + CLI args in Python

**Files:**
- Modify: `scripts/frame-extraction/python/tfidf_hdbscan.py`
- Test: covered by Task 3's TS integration tests (which feed the orchestrator)

Adds `--co-change PATH` and `--gamma FLOAT` to the argparse setup. If `--co-change` is provided, the script loads its JSONL, calls `build_co_change_distance`, then forms `combined = (1 - gamma) * topical_dist + gamma * cochange_dist` and runs HDBSCAN over `combined`. If `--co-change` is absent, behavior is unchanged (gamma is ignored). Echoes `gamma` and `co_change_pairs` count into the result `params` block.

- [ ] **Step 1: Add CLI args to argparse**

In `tfidf_hdbscan.py`, find the `parser = argparse.ArgumentParser()` block and add these arguments after the existing ones (keep them grouped at the end so existing CLI invocations still work):

```python
parser.add_argument("--co-change", dest="co_change", type=Path, default=None,
                    help="Optional co-change JSONL (pair_count records). "
                         "When provided, combined with topical distance via --gamma.")
parser.add_argument("--gamma", type=float, default=0.0,
                    help="Weight on co-change distance in [0, 1]. "
                         "Combined distance = (1-γ)·topical + γ·co_change. "
                         "Ignored when --co-change is not provided.")
```

- [ ] **Step 2: Load pairs + compute combined distance**

In `main()`, locate this block (currently the only place `dist` is built):

```python
    dense = matrix.toarray()
    norms = np.linalg.norm(dense, axis=1, keepdims=True)
    norms[norms == 0] = 1.0  # avoid div by zero for empty docs
    normed = dense / norms
    sim = normed @ normed.T
    dist = 1.0 - sim
    np.clip(dist, 0.0, 2.0, out=dist)
```

Replace it with:

```python
    dense = matrix.toarray()
    norms = np.linalg.norm(dense, axis=1, keepdims=True)
    norms[norms == 0] = 1.0  # avoid div by zero for empty docs
    normed = dense / norms
    sim = normed @ normed.T
    topical_dist = 1.0 - sim
    np.clip(topical_dist, 0.0, 2.0, out=topical_dist)

    # Optional co-change distance term. Cold-start (no --co-change) means
    # gamma is effectively 0 — the pipeline is identical to pure topical.
    co_change_pairs_loaded = 0
    if args.co_change is not None and args.gamma > 0:
        pairs = []
        if args.co_change.exists():
            with args.co_change.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    pairs.append(json.loads(line))
        co_change_pairs_loaded = len(pairs)
        co_change_dist = build_co_change_distance(paths, pairs)
        dist = (1.0 - args.gamma) * topical_dist + args.gamma * co_change_dist
    else:
        dist = topical_dist
    np.clip(dist, 0.0, 2.0, out=dist)
```

- [ ] **Step 3: Echo gamma + co-change stats into params**

Find the `params={ ... }` block inside `write_result(...)` (the main code path, not the short-circuit early-return one) and add two keys:

```python
        params={
            "min_df": args.min_df,
            "max_df": args.max_df,
            "min_cluster_size": args.min_cluster_size,
            "vocabulary_size": len(vectorizer.vocabulary_),
            "silhouette_score": silhouette,
            "top_tokens_per_cluster": top_tokens_per_cluster,
            "gamma": args.gamma,
            "co_change_pairs_loaded": co_change_pairs_loaded,
        },
```

- [ ] **Step 4: Smoke-test the Python script directly with synthetic input**

Build a tiny blob + co-change input and run the script.

```bash
mkdir -p .tmp/cc-smoke
cat > .tmp/cc-smoke/blobs.jsonl <<'EOF'
{"path":"a.ts","text":"alpha beta one two"}
{"path":"b.ts","text":"alpha beta one two"}
{"path":"c.ts","text":"gamma delta three four"}
{"path":"d.ts","text":"gamma delta three four"}
{"path":"e.ts","text":"alpha beta one two"}
{"path":"f.ts","text":"gamma delta three four"}
EOF
cat > .tmp/cc-smoke/cochange.jsonl <<'EOF'
{"a":"a.ts","b":"c.ts","count":50}
EOF

scripts/frame-extraction/python/.venv/bin/python scripts/frame-extraction/python/tfidf_hdbscan.py \
  --in .tmp/cc-smoke/blobs.jsonl \
  --out .tmp/cc-smoke/result.json \
  --co-change .tmp/cc-smoke/cochange.jsonl \
  --gamma 0.5 \
  --min-cluster-size 2

cat .tmp/cc-smoke/result.json | head -20
```

Expected: `params.gamma == 0.5`, `params.co_change_pairs_loaded == 1`, the script runs without error. Cluster assignment may or may not move `a.ts` and `c.ts` together depending on topical weight — what we're verifying here is that the plumbing works end-to-end. Clean up: `rm -rf .tmp/cc-smoke`.

- [ ] **Step 5: Verify the pure-topical path is unchanged**

Run the script WITHOUT `--co-change`:

```bash
scripts/frame-extraction/python/.venv/bin/python scripts/frame-extraction/python/tfidf_hdbscan.py \
  --in /tmp/cc-smoke/blobs.jsonl \
  --out /tmp/cc-smoke/baseline.json \
  --min-cluster-size 2 || true

# Skip this if the file from Step 4 was cleaned up — the assertion is
# that the call succeeds with no co-change args.
```

If you already cleaned up `.tmp/cc-smoke`, re-run the input-creation block from Step 4 first. The key assertion: the script runs and `params.gamma == 0.0` and `params.co_change_pairs_loaded == 0` (because the default for the latter is 0 when `--co-change` isn't provided).

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/python/tfidf_hdbscan.py
git commit -m "$(cat <<'EOF'
feat(frame-extraction): combined topical+co-change distance in Python

Adds --co-change PATH and --gamma FLOAT CLI args to the TF-IDF +
HDBSCAN script. When both are provided, the HDBSCAN distance matrix
becomes (1 - γ)·topical + γ·co_change, where co_change is the
log-scaled corpus-relative distance from Task 1. When --co-change
is absent the pipeline is identical to the previous pure-topical
behavior (cold-start case). Gamma + co-change pair count are
echoed into the result params for traceability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: TS wrapper — accept and pass through co-change + gamma

**Files:**
- Modify: `scripts/frame-extraction/cluster-tfidf-hdbscan.ts`
- Modify: `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts`

The TS orchestrator gains two `RunOptions` fields and a default-path lookup so that running on a repo with co-change already extracted "just works". A new integration test asserts that the co-change term changes cluster assignments in the way we expect (high γ pulls together files that wouldn't cluster on topical similarity alone).

- [ ] **Step 1: Write the failing test**

Open `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts`. Add the following test inside the `describe.skipIf(!PYTHON_AVAILABLE)("runTfIdfHdbscan ...")` block, after the existing tests:

```typescript
  it("co-change pulls cross-domain files together when gamma is high", () => {
    // Use a fresh corpus that's deliberately topically split: 4 auth + 4
    // billing files. Without co-change, they cluster cleanly by domain.
    // With a heavy co-change signal saying ONE specific auth file and ONE
    // specific billing file co-change together a lot, γ should pull them
    // into the same cluster (or at minimum, change the assignment so that
    // they are no longer split cleanly by directory).
    const baseline = runTfIdfHdbscan({
      repo_path: root,
      min_cluster_size: 3,
      gamma: 0,
    });
    // Confirm baseline split.
    const baselineForA = baseline.result.clusters.find((c) =>
      c.member_paths.includes("src/auth/middleware_0.ts"),
    );
    const baselineForI = baseline.result.clusters.find((c) =>
      c.member_paths.includes("src/billing/invoice_0.ts"),
    );
    expect(baselineForA).toBeTruthy();
    expect(baselineForI).toBeTruthy();
    expect(baselineForA!.cluster_id).not.toBe(baselineForI!.cluster_id);

    // Now make a one-off co-change file linking one auth file and one
    // billing file with a very heavy co-occurrence count.
    const ccPath = join(root, ".cortex", "test-cochange.jsonl");
    writeFileSync(
      ccPath,
      JSON.stringify({
        a: "src/auth/middleware_0.ts",
        b: "src/billing/invoice_0.ts",
        count: 999,
      }) + "\n",
    );

    const pulled = runTfIdfHdbscan({
      repo_path: root,
      min_cluster_size: 3,
      co_change_path: ccPath,
      gamma: 0.9, // heavy weight: dominate topical signal
    });

    // The result should have gamma and co_change_pairs_loaded in
    // parameters for traceability.
    expect(pulled.result.parameters.gamma).toBe(0.9);
    expect(pulled.result.parameters.co_change_pairs_loaded).toBe(1);

    // And the assignments differ from the gamma=0 case. We don't assert
    // exact same-cluster (HDBSCAN density semantics can make a forced
    // pair noise or split) but we assert membership *shifted* somewhere.
    const baselineMembers = new Set(
      baseline.result.clusters.flatMap((c) =>
        c.member_paths.map((p) => `${c.cluster_id}:${p}`),
      ),
    );
    const pulledMembers = new Set(
      pulled.result.clusters.flatMap((c) =>
        c.member_paths.map((p) => `${c.cluster_id}:${p}`),
      ),
    );
    // Distance between the two assignments — at least one file moved.
    let diff = 0;
    for (const m of baselineMembers) if (!pulledMembers.has(m)) diff += 1;
    expect(diff).toBeGreaterThan(0);
  });
```

Also add `writeFileSync` to the imports at the top of the file:

```typescript
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/frame-extraction/cluster-tfidf-hdbscan.test.ts -t "co-change pulls"
```

Expected: FAIL — `co_change_path` and `gamma` are not in `RunOptions` yet, so this is a TypeScript compile error. The test file should report a type error for the unknown options. (vitest will surface this as a compile failure.)

- [ ] **Step 3: Extend `RunOptions` and pass args through**

Open `scripts/frame-extraction/cluster-tfidf-hdbscan.ts`. Locate the `RunOptions` interface and add the two new fields:

```typescript
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
  /** Path to a co-change JSONL ({a, b, count} per line). If undefined,
   *  the orchestrator looks under .tmp/frame-extraction/co-change/<slug>.jsonl
   *  and uses that if it exists. Pass explicit null to opt out of the
   *  default lookup. */
  co_change_path?: string | null;
  /** Weight on co-change distance in [0, 1]. Default 0 (pure topical).
   *  Ignored when no co-change file is found. */
  gamma?: number;
}
```

Locate the `DEFAULT_OUT_DIR` constant near the top:

```typescript
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "clusters");
const BLOBS_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "blobs");
```

Add a sibling constant for the co-change default lookup directory:

```typescript
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "clusters");
const BLOBS_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "blobs");
const DEFAULT_CO_CHANGE_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "co-change");
```

Inside `runTfIdfHdbscan`, locate the block that builds the spawn args:

```typescript
  // 4. Spawn Python.
  const args = [
    PYTHON_SCRIPT,
    "--in", blobsPath,
    "--out", outPath,
    "--min-df", String(opts.min_df ?? 2),
    "--max-df", String(opts.max_df ?? 0.8),
    "--min-cluster-size", String(opts.min_cluster_size ?? 5),
  ];
```

Replace it with:

```typescript
  // 4. Resolve co-change path. Undefined → look for default; explicit
  //    null → opt out; explicit string → use it. Empty/missing file at
  //    the resolved path means cold-start (γ effectively 0).
  let resolvedCoChange: string | null = null;
  if (opts.co_change_path === undefined) {
    const guess = join(DEFAULT_CO_CHANGE_DIR, `${slug}.jsonl`);
    if (existsSync(guess)) resolvedCoChange = guess;
  } else if (opts.co_change_path !== null) {
    resolvedCoChange = opts.co_change_path;
  }
  const gamma = opts.gamma ?? 0;

  // 5. Spawn Python.
  const args = [
    PYTHON_SCRIPT,
    "--in", blobsPath,
    "--out", outPath,
    "--min-df", String(opts.min_df ?? 2),
    "--max-df", String(opts.max_df ?? 0.8),
    "--min-cluster-size", String(opts.min_cluster_size ?? 5),
    "--gamma", String(gamma),
  ];
  if (resolvedCoChange !== null) {
    args.push("--co-change", resolvedCoChange);
  }
```

Update the trailing comment "5. Parse output." in the same function to "6. Parse output." to keep the step-numbering consistent.

Now extend CLI parsing in `main()` so the dev CLI accepts these too. Locate:

```typescript
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") opts.out_path = args[++i]!;
    else if (args[i] === "--project") opts.project_name = args[++i]!;
    else if (args[i] === "--min-df") opts.min_df = Number(args[++i]);
    else if (args[i] === "--max-df") opts.max_df = Number(args[++i]);
    else if (args[i] === "--min-cluster-size") opts.min_cluster_size = Number(args[++i]);
  }
```

Replace with:

```typescript
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") opts.out_path = args[++i]!;
    else if (args[i] === "--project") opts.project_name = args[++i]!;
    else if (args[i] === "--min-df") opts.min_df = Number(args[++i]);
    else if (args[i] === "--max-df") opts.max_df = Number(args[++i]);
    else if (args[i] === "--min-cluster-size") opts.min_cluster_size = Number(args[++i]);
    else if (args[i] === "--co-change") opts.co_change_path = args[++i]!;
    else if (args[i] === "--no-co-change") opts.co_change_path = null;
    else if (args[i] === "--gamma") opts.gamma = Number(args[++i]);
  }
```

Update the usage string at the top of `main()` accordingly:

```typescript
    console.error("usage: tsx cluster-tfidf-hdbscan.ts <repo-path> [--out <path>] [--project <name>] [--min-df N] [--max-df F] [--min-cluster-size N] [--co-change <path> | --no-co-change] [--gamma F]");
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/frame-extraction/cluster-tfidf-hdbscan.test.ts
```

Expected: PASS — including the new test and both existing tests (the existing tests pass `gamma: undefined` implicitly, which becomes `0`, and they don't put a default co-change file at the looked-up location, so behavior is unchanged for them).

If the new test reports "co_change_pairs_loaded is 0 not 1" — confirm that the test wrote the JSONL with `writeFileSync` (no missing newline at end). If the new test reports "assignments are identical" — the topical signal is too strong even at γ=0.9. Bump the test's co-change pair `count` to a higher value, or reduce the corpus's topical distinctiveness.

- [ ] **Step 5: Run the full vitest suite to confirm no regressions**

```bash
npm test 2>&1 | tail -30
```

Expected: all previously-passing tests still pass. Should show "+1 test" relative to the previous run.

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/cluster-tfidf-hdbscan.ts tests/frame-extraction/cluster-tfidf-hdbscan.test.ts
git commit -m "$(cat <<'EOF'
feat(frame-extraction): wire co-change distance through TS orchestrator

Adds co_change_path + gamma to RunOptions on runTfIdfHdbscan. When
co_change_path is undefined (the common case), the orchestrator auto-
discovers .tmp/frame-extraction/co-change/<slug>.jsonl and uses it if
present — matching how the eval harness already locates that file.
Pass explicit null to force the cold-start path even when the file
exists. Integration test confirms a heavy co-change pull moves at
least one file across the topical cluster boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Gamma sweep + comparison report on cortex

**Files:**
- Create: `docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex-cochange.md`
- (Optionally) intermediate cluster + eval artifacts under `.tmp/frame-extraction/clusters/` (gitignored)

This task produces the eval comparison that justifies merging Tasks 1–3. We sweep `γ ∈ {0.0, 0.3, 0.5, 0.7}` on cortex and document the metrics side-by-side. The headline metric is `co_change_agreement_lenient` (currently 0.108 on cortex per the merged baseline); we want to see what γ moves it the most and at what cost (silhouette, cluster count, noise rate).

**Prereqs:**
- Co-change JSONL for cortex exists at `.tmp/frame-extraction/co-change/Users-rka-Development-cortex.jsonl`. Already there from prior work; confirm with `ls .tmp/frame-extraction/co-change/`.
- Cortex graph DB exists at `.cortex/graph.db`. Already there; confirm with `ls .cortex/graph.db`.

- [ ] **Step 1: Run the gamma sweep**

For each γ value, run the orchestrator with an explicit `--out` so outputs don't clobber each other, then run the eval CLI with an explicit `--out` so the report names don't clobber each other.

```bash
mkdir -p .tmp/frame-extraction/clusters/sweep
mkdir -p .tmp/frame-extraction/eval-sweep

for gamma in 0.0 0.3 0.5 0.7; do
  echo "=== gamma=$gamma ==="
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

Each call prints a one-line summary including `co_change strict=… lenient=…`. Take note of the lenient values across the four γ.

- [ ] **Step 2: Collect the metrics into a single comparison report**

Read each of `.tmp/frame-extraction/eval-sweep/cortex-g*.md` to get the exact numbers. Then write the comparison file at `docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex-cochange.md` using this template (fill in the FIXME values from your sweep output — do NOT leave FIXMEs in the committed report):

```markdown
# Phase 2 Eval — Co-change Distance Combination on `self/cortex`

Sweep over the co-change weight γ in the TF-IDF + HDBSCAN combined
distance: `dist(a, b) = (1 − γ) · topical + γ · co_change`. Baseline
report (γ = 0) is the previously-committed
[Users-rka-Development-cortex.md](./Users-rka-Development-cortex.md).
All runs used the same blobs (entity names + path tokens) and the same
180-day co-change window already on disk at
`.tmp/frame-extraction/co-change/Users-rka-Development-cortex.jsonl`.

Generated: <ISO timestamp>

## Headline

`co_change_agreement_lenient` (the spec's primary signal-quality metric)
moved from <FIXME:γ=0> at γ = 0 to <FIXME:peak> at γ = <FIXME:γ_at_peak>.
<FIXME 1–2 sentences: what tradeoff did silhouette / noise / cluster count make>.

## Metrics by γ

| metric | γ = 0.0 | γ = 0.3 | γ = 0.5 | γ = 0.7 |
|---|---:|---:|---:|---:|
| total_files | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| cluster_count | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| noise_rate | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| co_change_agreement_strict | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| co_change_agreement_lenient | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| import_agreement_strict | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| import_agreement_lenient | <FIXME> | <FIXME> | <FIXME> | <FIXME> |
| silhouette_score (algorithm-internal) | <FIXME> | <FIXME> | <FIXME> | <FIXME> |

## Interpretation

<FIXME 3–6 sentences. What you should cover:
- Does lenient co_change_agreement rise monotonically with γ, or does it
  peak and fall?
- What happens to silhouette? (Expected: drops as γ rises, because
  silhouette is measured over the TF-IDF feature space, and the cluster
  shapes are no longer optimal in that space.)
- What happens to noise_rate? Co-change can either reduce noise (by
  bridging topical sparse areas) or increase noise (by destabilising
  marginal clusters). State what you observed.
- What happens to import_agreement? CALLS edges and co-change correlate;
  expect both to rise or both to fall together.
- A defensible default-γ recommendation for the next chunk.>

## Method

- Cluster: `npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts <repo> --out ... --gamma <γ>`
- Eval: `npx tsx scripts/frame-extraction/eval.ts --cluster ... --repo <repo> --out ...`
- Co-change source: `.tmp/frame-extraction/co-change/Users-rka-Development-cortex.jsonl`
  (180-day window, big-commit threshold 50, min count 2)
- Determinism: cluster JSON is byte-identical across reruns at the same γ
  (verified by re-running γ = 0 and `diff`ing the result against the
  baseline report's underlying cluster JSON).

## Per-γ reports

Full per-γ eval reports are not committed (they're large and largely
redundant). Reproduce on demand by re-running the sweep above and
inspecting `.tmp/frame-extraction/eval-sweep/cortex-g<γ>.md`.
```

- [ ] **Step 3: Sanity-check the comparison report**

Confirm that:
- Every FIXME has been replaced with a real value or sentence.
- The "Headline" sentence is consistent with the table (no claim that γ=0.5 was best if the table shows γ=0.3 was best).
- The "Interpretation" block actually explains the data — not generic boilerplate.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/cortex-v0.3/phase-2-eval/Users-rka-Development-cortex-cochange.md
git commit -m "$(cat <<'EOF'
docs(frame-extraction): co-change weight sweep on cortex (γ ∈ {0, 0.3, 0.5, 0.7})

Companion to the merged baseline report. Documents how the combined
distance from this PR moves the spec's primary signal-quality metric
(co_change_agreement_lenient) and what it costs in topical coherence
(silhouette).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Spec asks for `dist(a, b) = β · topical_distance + γ · co_change_distance` → Task 2 implements this as a convex combination with `β = 1 − γ` and one CLI knob `γ`. Documented in the plan's Design notes.
- Spec asks for cold-start handling (no history → γ = 0) → Tasks 2 + 3 implement this: no `--co-change` flag means the script behaves identically to the pre-change pipeline.
- Spec asks for γ-tuning on the corpus → Task 4 is the cortex sweep. Tuning across the rest of the corpus is explicitly out of scope (next chunk).

**Placeholder scan:** All placeholders inside Task 4's template are inside `<FIXME ...>` markers that Step 3 explicitly enforces resolving. There are no "TODO" or "implement later" markers elsewhere in the plan.

**Type consistency:**
- `RunOptions.co_change_path` and `RunOptions.gamma` are referenced in both Task 3 (definition) and the test (use). Names match.
- Python: `--co-change` (CLI), `args.co_change` (argparse-converted name), `co_change_pairs_loaded` (params key) — argparse maps `--co-change` to `args.co_change` automatically. Task 2 Step 1 uses `dest="co_change"` to make this explicit and protect against future Python versions changing the default mapping.
- `--no-co-change` is a CLI-only convenience, not a programmatic option; programmatic callers pass `co_change_path: null` instead.

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

The user has consistently chosen Subagent-Driven for prior chunks; default to it unless the user changes their mind.
