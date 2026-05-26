# Frame Extraction Auto-Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `frame_id` extraction run automatically after every successful `index_repository`, so the frames viewer works out of the box once Cortex is installed.

**Architecture:** A new shared TS helper `runFrameExtraction()` runs co-change → HDBSCAN cluster → inject in-process, reading the DB the index just wrote and updating `nodes.data`. It is called from both the CLI `index` command and the MCP `index_repository` tool, after a successful index. The C indexer is untouched. The Python venv moves to `~/.cache/cortex-indexer/python-venv/` and is created at install time. Spec: [docs/superpowers/specs/2026-05-26-frame-extraction-auto-integration-design.md](../specs/2026-05-26-frame-extraction-auto-integration-design.md).

**Tech Stack:** TypeScript (Node, `tsx`, `better-sqlite3`), Python venv (scikit-learn + hdbscan + numpy), vitest.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/frame-extraction/venv.ts` | Create | Resolve venv dir + python bin (with `CORTEX_VENV` override); `hasVenv()`; `setupVenv()` |
| `src/frame-extraction/run-frames.ts` | Create | `runFrameExtraction()` orchestrator + `FrameResult` type; gates; never throws |
| `scripts/frame-extraction/inject-frames.ts` | Modify | Extract exported `injectFrames({cluster, project, dbPath})` from `main()` |
| `scripts/frame-extraction/cluster-tfidf-hdbscan.ts` | Modify | Add `db_path` option; resolve python bin from venv module instead of hardcoded path |
| `scripts/frame-extraction/python/setup-venv.sh` | Modify | Target a caller-supplied venv dir (default: cache dir) |
| `src/cli/commands/index.ts` | Modify | Call `runFrameExtraction` after index; print one-line summary |
| `src/mcp-server/tools/code-tools.ts` | Modify | Call `runFrameExtraction` on both success paths; attach structured `frames` field |
| `src/cli/install.ts` | Modify | Call `setupVenv()` during `runInstall` (foreground, warn on missing python) |
| `tests/frame-extraction/venv.test.ts` | Create | Unit: venv path resolution + override + presence |
| `tests/frame-extraction/run-frames.test.ts` | Create | Unit: gating (disabled/venv_missing/no_files); integration (venv-gated) |
| `tests/frame-extraction/inject-frames.test.ts` | Create | Unit: `injectFrames` writes frame_id into a temp DB |

---

### Task 1: venv module — path resolution + presence

**Files:**
- Create: `src/frame-extraction/venv.ts`
- Test: `tests/frame-extraction/venv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/venv.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { venvDir, venvPythonBin, hasVenv } from "../../src/frame-extraction/venv.js";

describe("venv path resolution", () => {
  const orig = process.env.CORTEX_VENV;
  afterEach(() => {
    if (orig === undefined) delete process.env.CORTEX_VENV;
    else process.env.CORTEX_VENV = orig;
  });

  it("defaults to ~/.cache/cortex-indexer/python-venv", () => {
    delete process.env.CORTEX_VENV;
    expect(venvDir()).toBe(join(homedir(), ".cache", "cortex-indexer", "python-venv"));
  });

  it("honors CORTEX_VENV override", () => {
    process.env.CORTEX_VENV = "/tmp/custom-venv";
    expect(venvDir()).toBe("/tmp/custom-venv");
  });

  it("python bin is <venvDir>/bin/python", () => {
    process.env.CORTEX_VENV = "/tmp/custom-venv";
    expect(venvPythonBin()).toBe("/tmp/custom-venv/bin/python");
  });

  it("hasVenv is false when the python bin does not exist", () => {
    process.env.CORTEX_VENV = "/tmp/definitely-not-a-venv-12345";
    expect(hasVenv()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/venv.test.ts`
Expected: FAIL — `Cannot find module '../../src/frame-extraction/venv.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/frame-extraction/venv.ts
/**
 * Locates and provisions the Python venv used by frame extraction.
 *
 * The venv lives at ~/.cache/cortex-indexer/python-venv (a writable,
 * cross-cwd home — the same cache dir as the project DBs), NOT inside the
 * repo, so it survives plugin installs where the repo is read-only.
 * Override with CORTEX_VENV for tests / power users.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function venvDir(): string {
  const override = process.env.CORTEX_VENV;
  if (override) return override;
  return join(homedir(), ".cache", "cortex-indexer", "python-venv");
}

export function venvPythonBin(): string {
  return join(venvDir(), "bin", "python");
}

export function hasVenv(): boolean {
  return existsSync(venvPythonBin());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/venv.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/venv.ts tests/frame-extraction/venv.test.ts
git commit -m "feat(frames): venv path resolution module"
```

---

### Task 2: venv module — setupVenv()

**Files:**
- Modify: `src/frame-extraction/venv.ts`
- Test: `tests/frame-extraction/venv.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing describe block's file)

```ts
// tests/frame-extraction/venv.test.ts — add this describe block
import { setupVenv } from "../../src/frame-extraction/venv.js";

describe("setupVenv", () => {
  const origVenv = process.env.CORTEX_VENV;
  const origPath = process.env.PATH;
  afterEach(() => {
    if (origVenv === undefined) delete process.env.CORTEX_VENV; else process.env.CORTEX_VENV = origVenv;
    process.env.PATH = origPath;
  });

  it("returns python_missing when python3 is not on PATH", () => {
    process.env.PATH = "/nonexistent-dir-for-test";
    process.env.CORTEX_VENV = "/tmp/venv-should-not-be-created";
    const result = setupVenv({ quiet: true });
    expect(result.status).toBe("python_missing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/venv.test.ts -t setupVenv`
Expected: FAIL — `setupVenv is not a function`

- [ ] **Step 3: Add the implementation to `src/frame-extraction/venv.ts`**

```ts
// append to src/frame-extraction/venv.ts
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type SetupVenvResult =
  | { status: "ok" }
  | { status: "python_missing" }
  | { status: "failed"; reason: string };

function python3OnPath(): boolean {
  try {
    execSync("command -v python3", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create/refresh the venv by running setup-venv.sh, targeting venvDir().
 * Foreground; inherits stdio unless quiet. Never throws — returns a result.
 * Safe to call repeatedly (the script is idempotent).
 */
export function setupVenv(opts: { quiet?: boolean } = {}): SetupVenvResult {
  if (!python3OnPath()) return { status: "python_missing" };
  const here = fileURLToPath(new URL(".", import.meta.url));
  // src/frame-extraction → repo root → scripts/.../setup-venv.sh
  const script = resolve(here, "..", "..", "scripts", "frame-extraction", "python", "setup-venv.sh");
  try {
    execFileSync("bash", [script], {
      stdio: opts.quiet ? "ignore" : "inherit",
      env: { ...process.env, CORTEX_VENV: venvDir() },
    });
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/venv.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/venv.ts tests/frame-extraction/venv.test.ts
git commit -m "feat(frames): setupVenv() — idempotent venv provisioning, warns on missing python3"
```

---

### Task 3: setup-venv.sh — target a caller-supplied venv dir

**Files:**
- Modify: `scripts/frame-extraction/python/setup-venv.sh`

- [ ] **Step 1: Replace the script body**

The current script hardcodes `VENV="$ROOT/.venv"`. Make it honor `CORTEX_VENV`, defaulting to the cache dir. `REQ` stays repo-relative.

```bash
#!/usr/bin/env bash
# setup-venv.sh — Create the Python venv used by the frame-extraction
# scripts. Idempotent: re-running is a no-op if the venv already has
# the pinned versions installed.
#
# Venv location: $CORTEX_VENV if set, else ~/.cache/cortex-indexer/python-venv.
# (The default matches src/frame-extraction/venv.ts::venvDir().)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REQ="$ROOT/requirements.txt"
VENV="${CORTEX_VENV:-$HOME/.cache/cortex-indexer/python-venv}"

if [ ! -d "$VENV" ]; then
  echo "[setup-venv] creating venv at $VENV"
  mkdir -p "$(dirname "$VENV")"
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REQ"

"$VENV/bin/python" -c "import sklearn, numpy; from importlib.metadata import version; print(f'sklearn={sklearn.__version__} hdbscan={version(\"hdbscan\")} numpy={numpy.__version__}')"
echo "[setup-venv] ready at $VENV"
```

- [ ] **Step 2: Verify it targets the cache dir**

Run: `CORTEX_VENV=/tmp/venv-smoke bash scripts/frame-extraction/python/setup-venv.sh && /tmp/venv-smoke/bin/python -c "import hdbscan; print('ok')"`
Expected: prints the versions line and `ok`. (Takes ~60-170s first time.)

- [ ] **Step 3: Clean up the smoke venv**

Run: `rm -rf /tmp/venv-smoke`

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/python/setup-venv.sh
git commit -m "feat(frames): setup-venv.sh targets CORTEX_VENV (cache dir default)"
```

---

### Task 4: cluster script — accept `db_path` + resolve python from venv module

**Files:**
- Modify: `scripts/frame-extraction/cluster-tfidf-hdbscan.ts`

The cluster script currently (a) hardcodes `PYTHON_BIN` to the in-repo `.venv`, and (b) derives the graph DB from `<repo>/.cortex/db`. The integrated helper needs to point it at the cache venv and the exact DB the index wrote.

- [ ] **Step 1: Add the import and `db_path` option**

In `scripts/frame-extraction/cluster-tfidf-hdbscan.ts`, add to the imports near the top (after line 17):

```ts
import { venvPythonBin } from "../../src/frame-extraction/venv.js";
```

Add to the `RunOptions` interface (after the `repo_path` field, around line 30):

```ts
  /** Explicit graph DB path. When set, overrides the <repo>/.cortex/db
   *  lookup — the integrated post-index helper passes the exact DB the
   *  indexer just wrote (cache DB or .cortex/db). */
  db_path?: string;
```

- [ ] **Step 2: Resolve the python bin from the venv module**

Replace the hardcoded constant at line 20:

```ts
// DELETE:
const PYTHON_BIN = join(REPO_ROOT, "scripts", "frame-extraction", "python", ".venv", "bin", "python");
```

Inside `runTfIdfHdbscan`, replace the venv check at lines 59-64:

```ts
  const pythonBin = venvPythonBin();
  if (!existsSync(pythonBin)) {
    throw new Error(
      `Python venv not found at ${pythonBin}. Run \`cortex setup frames\` first.`,
    );
  }
```

And update the spawn call at line 132 to use `pythonBin` instead of `PYTHON_BIN`:

```ts
  const proc = spawnSync(pythonBin, args, { encoding: "utf-8" });
```

- [ ] **Step 3: Use `db_path` when provided**

Replace the db-candidate block at lines 68-78:

```ts
  // Explicit db_path wins; otherwise fall back to the in-repo .cortex DB
  // (keeps the standalone `tsx cluster-tfidf-hdbscan.ts <repo>` CLI working).
  let graphDbPath: string | undefined;
  if (opts.db_path) {
    graphDbPath = existsSync(opts.db_path) ? opts.db_path : undefined;
  } else {
    graphDbPath = [
      join(opts.repo_path, ".cortex", "db"),
      join(opts.repo_path, ".cortex", "graph.db"),
    ].find((p) => existsSync(p));
  }
  if (!graphDbPath) {
    throw new Error(
      `No graph DB found (db_path=${opts.db_path ?? "<repo>/.cortex/db"}). ` +
      `Index the repo with cortex-indexer first.`,
    );
  }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 5: Verify the standalone CLI still works against a linked cache DB**

```bash
BENCH=/tmp/clbench; rm -rf "$BENCH"; mkdir -p "$BENCH/.cortex"
ln -s ~/.cache/cortex-indexer/Users-rka-Development-cortex.db "$BENCH/.cortex/db"
npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts "$BENCH" --project Users-rka-Development-cortex --out /tmp/cl.json
```
Expected: `[tfidf-hdbscan] N files, M clusters, K noise` with N > 0 (requires venv present — run Task 3 smoke first, or `cortex setup frames`).

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/cluster-tfidf-hdbscan.ts
git commit -m "feat(frames): cluster script accepts db_path + resolves python from venv module"
```

---

### Task 5: inject script — extract exported `injectFrames()`

**Files:**
- Modify: `scripts/frame-extraction/inject-frames.ts`
- Test: `tests/frame-extraction/inject-frames.test.ts`

The DB UPDATE logic currently lives inside `main()`. Extract it so the helper can call it in-process.

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/inject-frames.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { injectFrames } from "../../scripts/frame-extraction/inject-frames.js";
import type { ClusterResult } from "../../scripts/frame-extraction/types.js";

describe("injectFrames", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inject-frames-"));
    dbPath = join(dir, "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT,
      qualified_name TEXT, file_path TEXT, data TEXT, project TEXT)`);
    db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?)`).run(
      "n1", "file", "a.ts", "p.a", "src/auth/a.ts", "{}", "P");
    db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?)`).run(
      "n2", "file", "b.ts", "p.b", "src/auth/b.ts", "{}", "P");
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes frame_id into matching file nodes", () => {
    const cluster: ClusterResult = {
      total_files: 2,
      noise_count: 0,
      clusters: [{ cluster_id: 3, member_paths: ["src/auth/a.ts", "src/auth/b.ts"] }],
      parameters: { top_tokens_per_cluster: { "3": ["auth"] } },
    } as unknown as ClusterResult;

    const assigned = injectFrames({ cluster, project: "P", dbPath });
    expect(assigned).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT json_extract(data,'$.frame_id') AS fid, json_extract(data,'$.frame_label') AS label FROM nodes WHERE kind='file'"
    ).all() as Array<{ fid: number | null; label: string | null }>;
    db.close();
    expect(rows.every((r) => r.fid === 3)).toBe(true);
    expect(rows.every((r) => r.label === "auth")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: FAIL — `injectFrames is not a function`

- [ ] **Step 3: Extract `injectFrames` in `scripts/frame-extraction/inject-frames.ts`**

Add this exported function above `main()` (after `buildFrameAssignments`, around line 165):

```ts
/** Apply a ClusterResult to the named project's file nodes in dbPath.
 *  Sets frame_id/frame_label/frame_confidence on clustered files and clears
 *  those keys on every other file node in the project. Idempotent.
 *  Returns the number of file assignments applied. */
export function injectFrames(args: { cluster: ClusterResult; project: string; dbPath: string }): number {
  const assignments = buildFrameAssignments(args.cluster);
  const db = new Database(args.dbPath);
  try {
    const applyOne = db.prepare(`
      UPDATE nodes
      SET data = json_set(
        json_set(
          json_set(COALESCE(data, '{}'), '$.frame_id', @frame_id),
          '$.frame_label', @frame_label
        ),
        '$.frame_confidence', @frame_confidence
      )
      WHERE project = @project AND kind = 'file' AND file_path = @file_path
    `);
    const clearStmt = db.prepare(`
      UPDATE nodes
      SET data = json_remove(
        json_remove(
          json_remove(COALESCE(data, '{}'), '$.frame_id'),
          '$.frame_label'
        ),
        '$.frame_confidence'
      )
      WHERE project = ? AND kind = 'file'
        AND file_path NOT IN (${assignments.map(() => "?").join(",") || "NULL"})
    `);
    const tx = db.transaction(() => {
      for (const a of assignments) applyOne.run({ ...a, project: args.project });
      if (assignments.length > 0) {
        clearStmt.run(args.project, ...assignments.map((a) => a.file_path));
      }
    });
    tx();
    return assignments.length;
  } finally {
    db.close();
  }
}
```

Then replace the body of `main()` (the block from `const cluster = JSON.parse(...)` through the `db.close()` in `finally`, lines 194-248) with a call to the new function:

```ts
  const cluster = JSON.parse(readFileSync(clusterPath, "utf-8")) as ClusterResult;
  const assigned = injectFrames({ cluster, project: args.project, dbPath });
  console.log(`[inject-frames] project=${args.project} assigned=${assigned}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "refactor(frames): extract exported injectFrames() from inject-frames main()"
```

---

### Task 6: run-frames.ts — the orchestrator

**Files:**
- Create: `src/frame-extraction/run-frames.ts`
- Test: `tests/frame-extraction/run-frames.test.ts`

- [ ] **Step 1: Write the failing test (gating logic — no venv/python needed)**

```ts
// tests/frame-extraction/run-frames.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { runFrameExtraction } from "../../src/frame-extraction/run-frames.js";

describe("runFrameExtraction gating", () => {
  const origFrames = process.env.CORTEX_FRAMES;
  const origVenv = process.env.CORTEX_VENV;
  afterEach(() => {
    if (origFrames === undefined) delete process.env.CORTEX_FRAMES; else process.env.CORTEX_FRAMES = origFrames;
    if (origVenv === undefined) delete process.env.CORTEX_VENV; else process.env.CORTEX_VENV = origVenv;
  });

  it("skips with reason 'disabled' when CORTEX_FRAMES=0", async () => {
    process.env.CORTEX_FRAMES = "0";
    const r = await runFrameExtraction({ repoPath: "/tmp", project: "P", dbPath: "/tmp/x.db" });
    expect(r).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("skips with reason 'venv_missing' when venv absent", async () => {
    delete process.env.CORTEX_FRAMES;
    process.env.CORTEX_VENV = "/tmp/no-venv-here-98765";
    const r = await runFrameExtraction({ repoPath: "/tmp", project: "P", dbPath: "/tmp/x.db" });
    expect(r).toEqual({ status: "skipped", reason: "venv_missing" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/run-frames.test.ts`
Expected: FAIL — `Cannot find module '../../src/frame-extraction/run-frames.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/frame-extraction/run-frames.ts
/**
 * Orchestrates the post-index frame-extraction pass in-process:
 *   co-change → HDBSCAN cluster → inject frame_id into nodes.data.
 *
 * Called from the CLI `index` command and the MCP `index_repository` tool
 * after a successful index. NEVER throws into the index path — always
 * returns a discriminated FrameResult the caller surfaces.
 *
 * Reclusters on every call (frames are a global property; see the design
 * doc). Gates: CORTEX_FRAMES≠0 and a present venv.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hasVenv } from "./venv.js";
import { collectCoChange, writeCoChangeJsonl } from "../../scripts/frame-extraction/co-change.js";
import { runTfIdfHdbscan } from "../../scripts/frame-extraction/cluster-tfidf-hdbscan.js";
import { injectFrames } from "../../scripts/frame-extraction/inject-frames.js";

export type FrameResult =
  | { status: "ok"; framesAssigned: number; clusters: number; elapsedMs: number }
  | { status: "skipped"; reason: "venv_missing" | "disabled" | "no_files" | "no_git" }
  | { status: "failed"; reason: string };

export interface RunFrameOptions {
  repoPath: string;
  project: string;
  dbPath: string;
}

function hasFileNodes(dbPath: string, project: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE project = ? AND kind = 'file'")
      .get(project) as { n: number };
    return row.n > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export async function runFrameExtraction(opts: RunFrameOptions): Promise<FrameResult> {
  if (process.env.CORTEX_FRAMES === "0") return { status: "skipped", reason: "disabled" };
  if (!hasVenv()) return { status: "skipped", reason: "venv_missing" };
  if (!hasFileNodes(opts.dbPath, opts.project)) return { status: "skipped", reason: "no_files" };

  const start = Date.now();
  const work = mkdtempSync(join(tmpdir(), "cortex-frames-"));
  try {
    // 1. co-change (best-effort — a repo with no git history yields no pairs).
    const ccPath = join(work, "co-change.jsonl");
    try {
      const pairs = collectCoChange({
        repo_path: opts.repoPath, since_days: 180, big_commit_threshold: 50, min_count: 2,
      });
      writeCoChangeJsonl(pairs, ccPath);
    } catch {
      // No git / git failure — proceed cold (pure topical clustering).
    }

    // 2. cluster (spawns the venv python; reads the exact DB the index wrote).
    const { result } = runTfIdfHdbscan({
      repo_path: opts.repoPath,
      project_name: opts.project,
      db_path: opts.dbPath,
      out_path: join(work, "cluster.json"),
      co_change_path: existsSync(ccPath) ? ccPath : null,
    });

    // 3. inject frame_id into the same DB.
    const framesAssigned = injectFrames({ cluster: result, project: opts.project, dbPath: opts.dbPath });
    const clusters = result.clusters.filter((c) => c.cluster_id !== -1).length;
    return { status: "ok", framesAssigned, clusters, elapsedMs: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "failed", reason: msg.split("\n")[0]!.slice(0, 200) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/run-frames.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the venv-gated integration test**

Append to `tests/frame-extraction/run-frames.test.ts`:

```ts
import { hasVenv } from "../../src/frame-extraction/venv.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync as mkd, cpSync, rmSync as rm } from "node:fs";
import { join as pj, resolve as rs } from "node:path";
import { tmpdir as td } from "node:os";

describe.skipIf(!hasVenv())("runFrameExtraction integration", () => {
  it("assigns frame_id to file nodes of a real index", async () => {
    const repoRoot = rs(pj(__dirname, "..", ".."));
    const bin = pj(repoRoot, "bin", "cortex-indexer");
    const work = mkd(pj(td(), "frames-int-"));
    const fixture = pj(work, "sample-project");
    cpSync(pj(repoRoot, "tests", "fixtures", "sample-project"), fixture, { recursive: true });
    const dbPath = pj(work, "graph.db");
    execFileSync(bin, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      env: { ...process.env, CORTEX_DB: dbPath }, stdio: "ignore",
    });
    // project name = deriveProjectName(fixture); query it back from the DB.
    const { default: DB } = await import("better-sqlite3");
    const conn = new DB(dbPath, { readonly: true });
    const project = (conn.prepare("SELECT name FROM ctx_projects LIMIT 1").get() as { name: string }).name;
    conn.close();

    const r = await runFrameExtraction({ repoPath: fixture, project, dbPath });
    rm(work, { recursive: true, force: true });
    expect(r.status).toBe("ok");
  }, 60_000);
});
```

- [ ] **Step 6: Run the full file (integration auto-skips without venv)**

Run: `npx vitest run tests/frame-extraction/run-frames.test.ts`
Expected: 2 PASS + 1 PASS-or-SKIP (skipped if no venv)

- [ ] **Step 7: Commit**

```bash
git add src/frame-extraction/run-frames.ts tests/frame-extraction/run-frames.test.ts
git commit -m "feat(frames): runFrameExtraction orchestrator (co-change → cluster → inject)"
```

---

### Task 7: wire into the CLI `index` command

**Files:**
- Modify: `src/cli/commands/index.ts:14-27`

- [ ] **Step 1: Add the import**

At the top of `src/cli/commands/index.ts`, after the existing imports (line 5):

```ts
import { runFrameExtraction } from "../../frame-extraction/run-frames.js";
import { cachePathForProject } from "../context.js"; // see Step 2 note
```

> **Step 2 note — DB path:** the CLI indexes to the cache DB (no `CORTEX_DB` env). The path is `~/.cache/cortex-indexer/<project>.db`. `src/cli/context.ts` already computes this (`const cachePath = join(homedir(), ".cache", "cortex-indexer", \`${projectName}.db\`)`, line 73). If it is not already exported, export a helper `cachePathForProject(projectName: string): string` from `context.ts` and import it here. If `ctx.projectName` is null (unindexed cwd), derive it the same way the indexer does — but after a successful index `ctx` may be stale, so read the project name back from the index output if available; otherwise fall back to `deriveProjectName(resolve(repoPath))` imported from `scripts/frame-extraction/cluster-tfidf-hdbscan.js`.

- [ ] **Step 2: Call the helper after a successful index**

Replace the no-subcommand branch (lines 16-27):

```ts
  if (cmd.command === null || cmd.command === undefined || cmd.command === ".") {
    const repoPath = cmd.positionals[0] ?? ctx.cwd;
    const raw = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify({ repo_path: repoPath })],
      { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] },
    );
    process.stdout.write(renderIndexerResult(unwrapIndexerResult(raw)) + "\n");

    // Auto frame extraction (additive; never blocks the index result).
    const project = deriveProjectName(resolve(repoPath));
    const dbPath = cachePathForProject(project);
    const frames = await runFrameExtraction({ repoPath: resolve(repoPath), project, dbPath });
    process.stdout.write(renderFramesLine(frames) + "\n");
    return;
  }
```

Add this helper at the bottom of the file:

```ts
import type { FrameResult } from "../../frame-extraction/run-frames.js";

function renderFramesLine(r: FrameResult): string {
  switch (r.status) {
    case "ok":
      return `frames: ${r.framesAssigned} assigned across ${r.clusters} clusters (${(r.elapsedMs / 1000).toFixed(1)}s)`;
    case "skipped":
      return r.reason === "venv_missing"
        ? "frames: skipped (python venv not set up — run 'cortex setup frames')"
        : `frames: skipped (${r.reason})`;
    case "failed":
      return `frames: failed (${r.reason})`;
  }
}
```

Also add the `deriveProjectName` + `resolve` imports at the top:

```ts
import { resolve } from "node:path";
import { deriveProjectName } from "../../../scripts/frame-extraction/cluster-tfidf-hdbscan.js";
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. (If `cachePathForProject` doesn't exist yet, add + export it in `context.ts` — see Step 1 note — then re-run.)

- [ ] **Step 4: Manual smoke (venv-gated)**

Run: `bin/cortex index . 2>&1 | tail -3`
Expected: the index summary followed by a `frames: …` line.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/index.ts src/cli/context.ts
git commit -m "feat(frames): CLI 'cortex index' runs frame extraction + prints summary"
```

---

### Task 8: wire into the MCP `index_repository` tool

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (cache-hit return ~line 181; indexer return ~line 208)

- [ ] **Step 1: Add the import**

Near the other imports at the top of `src/mcp-server/tools/code-tools.ts`:

```ts
import { runFrameExtraction, type FrameResult } from "../../frame-extraction/run-frames.js";
import { deriveProjectName } from "../../../scripts/frame-extraction/cluster-tfidf-hdbscan.js";
```

- [ ] **Step 2: Add a helper that runs frames and appends a structured field**

Add above `registerCodeTools` (after `formatNodes`, ~line 119):

```ts
/** Run frame extraction for an already-indexed repo and fold a structured
 *  `frames` field into the tool's text response. The MCP envelope is text;
 *  we append a machine-readable JSON line so agents can parse status. */
async function withFrames(
  baseText: string,
  repoPath: string,
  dbPath: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const project = deriveProjectName(repoPath);
  let frames: FrameResult;
  try {
    frames = await runFrameExtraction({ repoPath, project, dbPath });
  } catch (e) {
    frames = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
  return { content: [{ type: "text", text: `${baseText}\nframes: ${JSON.stringify(frames)}` }] };
}
```

- [ ] **Step 3: Wrap the cache-hit return (~line 181)**

Replace:

```ts
        return ok(`imported from cache key ${cacheKey.slice(0, 12)}…`);
```

with:

```ts
        return await withFrames(`imported from cache key ${cacheKey.slice(0, 12)}…`, repoPath, dbPath);
```

- [ ] **Step 4: Wrap the indexer-success return (~line 208)**

Replace the final `return result;` of the `index_repository` handler with:

```ts
      if (result.isError) return result;
      const baseText = result.content?.[0]?.text ?? "indexed";
      return await withFrames(baseText, repoPath, dbPath);
```

> Note: `resolveCortexDbPath(repoPath)` is already computed as `dbPath` at the top of the handler (line 130) — reuse it; do not re-resolve.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Run the MCP contract smoke test**

Run: `npx vitest run tests/mcp-contract/smoke.test.ts`
Expected: PASS (frames field is additive; existing assertions unaffected)

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat(frames): MCP index_repository runs frame extraction + structured frames field"
```

---

### Task 9: wire setupVenv into install + add `cortex setup frames`

**Files:**
- Modify: `src/cli/install.ts:35` (`runInstall`)
- Modify: `src/cli/main.ts` (route `setup frames`)

- [ ] **Step 1: Call setupVenv at the end of a (non-uninstall) install**

In `src/cli/install.ts`, add the import:

```ts
import { setupVenv } from "../frame-extraction/venv.js";
```

At the end of `runInstall`, before it returns, in the non-uninstall branch:

```ts
  if (!opts.uninstall) {
    if (!opts.quiet) process.stdout.write("setting up frame-extraction python venv (one-time, ~1-3 min)…\n");
    const venv = setupVenv({ quiet: opts.quiet });
    if (!opts.quiet) {
      if (venv.status === "ok") process.stdout.write("frame extraction ready.\n");
      else if (venv.status === "python_missing")
        process.stdout.write("frame extraction unavailable: python3 not found. Install python3, then run 'cortex setup frames'.\n");
      else process.stdout.write(`frame extraction venv setup failed (${venv.reason}). Run 'cortex setup frames' to retry.\n`);
    }
  }
```

- [ ] **Step 2: Add the `setup frames` route in `src/cli/main.ts`**

Add `"setup"` to `META_COMMANDS` (line 18) and handle it near the `install` branch (~line 59):

```ts
  if (argv.namespace === "setup" && argv.positionals[0] === "frames") {
    const venv = setupVenv({ quiet: argv.flags.quiet === true });
    process.stdout.write(
      venv.status === "ok" ? "frame extraction ready.\n"
      : venv.status === "python_missing" ? "python3 not found — install it first.\n"
      : `setup failed: ${venv.reason}\n`,
    );
    return;
  }
```

Add the import to `main.ts`:

```ts
import { setupVenv } from "../frame-extraction/venv.js";
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Smoke the new command (idempotent — fast if venv exists)**

Run: `bin/cortex setup frames`
Expected: `frame extraction ready.` (or the python-missing message on a machine without python3)

- [ ] **Step 5: Commit**

```bash
git add src/cli/install.ts src/cli/main.ts
git commit -m "feat(frames): venv setup at install + 'cortex setup frames' command"
```

---

### Task 10: docs + end-to-end verification

**Files:**
- Modify: `docs/architecture/frame-extraction.md:101-107` (venv location + "now automatic" note)

- [ ] **Step 1: Update the architecture doc**

Replace the venv-location paragraph (lines 101-107) with:

```markdown
The Python venv lives at `~/.cache/cortex-indexer/python-venv/` (override
with `CORTEX_VENV`). It is created at install time by `cortex install`
(or on demand via `cortex setup frames`), which calls
`scripts/frame-extraction/python/setup-venv.sh`. The TS orchestrator's
integration test in `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts`
is skipped when the venv is absent — keeps `npm test` runnable on machines
without Python configured.

**Automatic extraction.** As of 2026-05-26, frame extraction runs
automatically after every successful `index_repository` (CLI `cortex index`
and the MCP tool), via `src/frame-extraction/run-frames.ts`. It reclusters
on every index (frames are a global property). Opt out with `CORTEX_FRAMES=0`.
See [`../superpowers/specs/2026-05-26-frame-extraction-auto-integration-design.md`](../superpowers/specs/2026-05-26-frame-extraction-auto-integration-design.md).
```

- [ ] **Step 2: End-to-end verification on a real project**

```bash
# Ensure venv exists:
bin/cortex setup frames
# Re-index cortex itself via the cache path and confirm frames land:
bin/cortex index .
sqlite3 ~/.cache/cortex-indexer/Users-rka-Development-cortex.db \
  "SELECT COUNT(*) FROM nodes WHERE kind='file' AND data LIKE '%\"frame_id\":%'"
```
Expected: the `cortex index` output ends with `frames: N assigned across M clusters (…s)`, and the SQL count is > 0.

- [ ] **Step 3: Visual confirmation (Gate 0)**

Restart the dev server (`npm run dev`), open `http://localhost:3334/viewer`, select `Users-rka-Development-cortex`. Expected: frame boxes render in the main viewport (not just the bottom aggregate strip). Capture a screenshot to `.playwright-mcp/`.

- [ ] **Step 4: Full test suite**

Run: `npx vitest run`
Expected: all pass (the venv-gated integration tests skip cleanly if no venv on the CI machine).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/frame-extraction.md
git commit -m "docs(frames): document automatic post-index extraction + venv location"
```

---

## Self-Review

**Spec coverage:**
- Trigger (every successful index, default-on, `CORTEX_FRAMES=0`) → Tasks 6 (gate), 7 (CLI), 8 (MCP). ✓
- Layer = TS orchestration, C untouched → all tasks are TS/bash; no C touched. ✓
- Venv at install time, foreground, never fails install → Task 9 (warn on python_missing, never throws). ✓
- Integration shape A (shared in-process helper) → Task 6 `run-frames.ts`, imported (not spawned) by Tasks 7/8. ✓
- In-process stages (reclaim tsx startup) → Task 6 imports `collectCoChange`/`runTfIdfHdbscan`/`injectFrames`. ✓
- Venv location `~/.cache/cortex-indexer/python-venv` + `CORTEX_VENV` → Tasks 1, 3. ✓
- DB-path passed explicitly → Task 4 (`db_path` option), Tasks 7/8 pass it. ✓
- Degradation: structured for MCP, line for CLI; never throws → Task 6 (FrameResult), Task 7 (`renderFramesLine`), Task 8 (`withFrames` JSON line). ✓
- `cortex setup frames` repair command → Task 9. ✓
- Testing (unit gating, venv.ts, inject, venv-gated integration, no C tests) → Tasks 1,2,5,6. ✓
- Self-healing / always-recluster → Task 6 has no change-detection gate; runs whenever venv+files present. ✓

**Placeholder scan:** No TBD/TODO. The one "see Step 1 note" in Task 7 is an explicit conditional (export `cachePathForProject` if absent) with the exact code to add — resolved, not deferred.

**Type consistency:** `FrameResult` defined in Task 6 and imported verbatim in Tasks 7 (`renderFramesLine`) and 8 (`withFrames`). `runFrameExtraction({repoPath, project, dbPath})` signature matches across Tasks 6/7/8. `injectFrames({cluster, project, dbPath})` defined Task 5, called Task 6. `runTfIdfHdbscan` `db_path` option added Task 4, used Task 6. `venvDir`/`venvPythonBin`/`hasVenv`/`setupVenv` defined Tasks 1-2, used Tasks 3/4/6/9. Consistent.

**Open items (from spec, resolve during execution):** plugin postinstall hook vs SessionStart guard (Task 9 covers the CLI `cortex install` path; the plugin-marketplace hook is out of scope for this plan — flag for a follow-up); Python version pinning in `setup-venv.sh` (could add `python3 -c 'import sys; assert sys.version_info >= (3,9)'` — minor, add if it surfaces).
