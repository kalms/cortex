# Native Indexer Storage Retarget (TS-side) Implementation Plan — Plan 3b

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete spec §3 Step 3 by replacing Cortex's SQLite ATTACH-based queries against per-project CBM files with direct unified queries against the `cbm_*` tables now living in `cortex.db` (which the indexer writes via `CORTEX_DB`).

**Architecture:** After Phase 3a, the indexer (`bin/cortex-indexer`) honors `CORTEX_DB` and writes `cbm_*`-prefixed tables. Plan 3b flips Cortex's TypeScript over: `cbm-queries.ts` (renamed `code-queries.ts`) drops the `cbm.` schema prefix and queries `cbm_nodes` / `cbm_edges` directly. `store.ts` loses `attachCbm()`. `index.ts` stops calling `discoverCbmDb()` at startup and instead passes `CORTEX_DB=<cortex.db path>` to the indexer subprocess. The 16 mcp-contract tests currently failing post-3a return to green.

**Tech Stack:** TypeScript (Node 20+), better-sqlite3, vitest, MCP SDK. No C-side changes — Plan 3a finished the indexer.

---

## Spec reference

`docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md` §3 Step 3 paragraph 3 ("Cortex's TS read layer queries `cbm_nodes` / `cbm_edges` for now") + the validation criterion ("Cortex's TS query layer points at the same file and `tests/mcp-contract/` passes against it").

After Plan 3b lands, **spec §3 Step 3 is fully complete**. Phase 4 (schema fold of `cbm_*` into Cortex's `nodes`/`edges`) is the next plan, then Phase 5 (v0.2 migration), Phase 6 (strip CBM MCP shell), Phase 7 (repo-root cortex.db + cache), Phase 8 (final cleanup).

## Branch

Continues on `feature/api/native-indexer`. The branch already has Phase 1, Phase 2, Phase 3a tagged. Each task in this plan ends in a commit. After all tasks land, tag `phase-3b-ts-side`.

## Current state at `phase-3a-storage-retarget` tag

| Surface | State |
|---|---|
| `bin/cortex-indexer` | Writes `cbm_*`-prefixed tables; honors `CORTEX_DB` env var |
| `cortex.db` location | `<cwd>/.cortex/graph.db` (Cortex's existing path; Phase 7 moves to `<repo>/.cortex/db`) |
| `~/.cache/codebase-memory-mcp/<project>.db` | Still where indexer falls back when `CORTEX_DB` unset; old caches persist |
| `src/graph/cbm-queries.ts` | Queries `FROM cbm.nodes` (ATTACH-prefixed, NOT cbm_-table-prefixed) — broken |
| `src/graph/store.ts` | Has `attachCbm()` / `isCbmAttached()` / `getAllNodesUnified` / `getAllEdgesUnified` querying `cbm.nodes` — broken |
| `src/graph/cbm-discovery.ts` | Updated to query `cbm_projects` (Phase 3a infra fix) |
| `src/index.ts` | Calls `discoverCbmDb()` + `attachCbm()` at startup, sets `cbmProject` from `cbm.projects` |
| `src/mcp-server/tools/code-tools.ts` | Spawns indexer via `execFile(INDEXER_BINARY, ['cli', tool, json])` — does NOT pass `CORTEX_DB` env var; indexer falls back to `~/.cache/...` |
| `tests/mcp-contract/globalSetup.ts` | Updated to query `cbm_projects` / `cbm_nodes` (Phase 3a infra fix) |
| `tests/mcp-contract/harness.ts` | Calls `store.attachCbm(cbmDbPath)` — will be removed |
| `tests/graph/cbm-attach.test.ts` | Tests the ATTACH path — will be replaced |
| Cortex test count | **357 passed / 16 failed / 1 skipped** — 16 failures all in `tests/mcp-contract/` code-tools, all from `cbm.nodes` schema-prefix |

## File structure (post-Plan-3b)

```
cortex/
├── src/
│   ├── graph/
│   │   ├── code-queries.ts       ← renamed from cbm-queries.ts; queries cbm_nodes, no schema prefix
│   │   ├── store.ts              ← attachCbm() removed; getAllNodesUnified simplified
│   │   ├── cbm-discovery.ts      ← KEPT for Phase 5 v0.2 migration shim; not called from startup
│   │   └── schema.ts             ← unchanged
│   ├── index.ts                  ← discoverCbmDb call removed; project name resolved differently
│   └── mcp-server/tools/
│       └── code-tools.ts         ← passes CORTEX_DB env to subprocess
└── tests/
    ├── mcp-contract/
    │   ├── globalSetup.ts        ← passes CORTEX_DB=<cortex.db> to indexer; no .cache discovery
    │   └── harness.ts            ← attachCbm call removed; opens cortex.db directly
    └── graph/
        └── code-queries.test.ts  ← replaces cbm-attach.test.ts; tests unified-storage queries
```

---

## Task 3b.1 — Rename and rewrite `cbm-queries.ts`

**Files:**
- Rename `src/graph/cbm-queries.ts` → `src/graph/code-queries.ts`
- Modify the renamed file (drop `cbm.` schema prefix, use `cbm_` table prefix)
- Modify `src/mcp-server/tools/code-tools.ts` (update import path)
- Modify `tests/graph/cbm-attach.test.ts` (update import path — the actual test rewrite is Task 3b.6)

### Step 1: Read the current state

```bash
cd /Users/rka/Development/cortex
cat src/graph/cbm-queries.ts | head -120
```

Note all SQL strings that say `FROM cbm.nodes`, `FROM cbm.edges`, `FROM cbm.projects`. There are roughly 8 of them.

### Step 2: Rename the file

```bash
git mv src/graph/cbm-queries.ts src/graph/code-queries.ts
```

### Step 3: Apply the SQL rewrites

Inside `src/graph/code-queries.ts`, change every occurrence of:

| Old | New |
|---|---|
| `FROM cbm.projects` | `FROM cbm_projects` |
| `FROM cbm.nodes` | `FROM cbm_nodes` |
| `FROM cbm.edges` | `FROM cbm_edges` |
| `cbm.nodes n` (alias context) | `cbm_nodes n` |
| `cbm.edges e` (alias context) | `cbm_edges e` |

Use the Edit tool with `replace_all: true` for each unique pattern, but verify each change is in an SQL string literal. Run a final grep to confirm zero `cbm\.` patterns remain inside SQL strings (excluding error messages or comments):

```bash
grep -nE "cbm\.\w+" src/graph/code-queries.ts
```

Expected: no matches.

### Step 4: Update the import in code-tools.ts

```bash
grep -n "cbm-queries" src/mcp-server/tools/code-tools.ts
```

Edit `src/mcp-server/tools/code-tools.ts` line 14 (or wherever the import is):

```typescript
} from "../../graph/cbm-queries.js";
```

To:

```typescript
} from "../../graph/code-queries.js";
```

### Step 5: Update import in tests/graph/cbm-attach.test.ts

```bash
grep -n "cbm-queries" tests/graph/cbm-attach.test.ts
```

Update the import path in the same way. The test itself is broken (it tests ATTACH which we're removing) — Task 3b.6 replaces it. For now, just keep imports valid so typecheck passes.

### Step 6: Type-check

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean. If errors, the renamed file's exports likely changed signature in a way the importer doesn't expect — verify the imports match the exports.

### Step 7: Don't run tests yet

Tests will still fail because `store.ts` still ATTACHes the wrong DB; `index.ts` still calls `discoverCbmDb` from a stale cache. Tasks 3b.2 and 3b.3 fix these.

### Step 8: Commit

```bash
git add src/graph/code-queries.ts src/graph/cbm-queries.ts src/mcp-server/tools/code-tools.ts tests/graph/cbm-attach.test.ts
git commit -m "refactor(graph): rename cbm-queries → code-queries; query cbm_-prefixed tables

After Plan 3a, CBM tables are prefixed cbm_*. Cortex's TS query layer
must drop the 'cbm.' ATTACH schema prefix (we're not ATTACHing anymore)
and use the table prefix instead:

  FROM cbm.nodes  →  FROM cbm_nodes
  FROM cbm.edges  →  FROM cbm_edges
  FROM cbm.projects → FROM cbm_projects

File renamed cbm-queries.ts → code-queries.ts to match the post-absorption
naming. Importers in code-tools.ts and tests/graph/ updated.

Tests still fail at this commit — store.ts still ATTACHes the wrong DB
and index.ts still wires discoverCbmDb. Tasks 3b.2, 3b.3 fix the rest.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b.2 — Remove ATTACH from `store.ts`

**Files:**
- Modify: `src/graph/store.ts`

### Step 1: Read the current ATTACH-related code

```bash
sed -n '320,420p' src/graph/store.ts
```

Note the methods: `isCbmAttached()`, `attachCbm()`, `getAllNodesUnified()`, `getAllEdgesUnified()`. They reference `this.cbmAttached` and query `cbm.nodes` / `cbm.edges` / `cbm.projects`.

### Step 2: Remove `attachCbm()` and `isCbmAttached()`

Use Edit tool. Delete the method `attachCbm(dbPath: string): void` and the method `isCbmAttached(): boolean`. Also delete the `cbmAttached` private field on the class (search for it — likely a `private cbmAttached = false;` near the class top).

### Step 3: Simplify `getAllNodesUnified` and `getAllEdgesUnified`

Replace `getAllNodesUnified(cbmProject?: string): NodeRow[]` body with:

```typescript
getAllNodesUnified(cbmProject?: string): NodeRow[] {
  const cortexNodes = this.db
    .prepare("SELECT id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at FROM nodes")
    .all() as NodeRow[];
  if (!cbmProject) return cortexNodes;
  const cbmNodes = this.db
    .prepare(
      `SELECT
          ('cbm-' || id) AS id,
          label AS kind,
          name,
          qualified_name,
          file_path,
          properties AS data,
          'shared' AS tier,
          (SELECT indexed_at FROM cbm_projects WHERE name = ?) AS created_at,
          (SELECT indexed_at FROM cbm_projects WHERE name = ?) AS updated_at
        FROM cbm_nodes WHERE project = ?`
    )
    .all(cbmProject, cbmProject, cbmProject) as NodeRow[];
  return [...cortexNodes, ...cbmNodes];
}
```

Apply the same shape to `getAllEdgesUnified`. The change is mechanical: drop the `cbm.` prefix, drop the `if (!this.cbmAttached || !cbmProject)` guard (keep only the `!cbmProject` check), and the rest stays the same.

The `'cbm-' || id` ID prefixing prevents ID collisions between Cortex's own ULID-keyed nodes and CBM's integer-keyed nodes. (CBM IDs are integers; Cortex IDs are ULIDs. They wouldn't collide naturally, but the prefix makes the source visually obvious in dumps.)

### Step 4: Type-check

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean. If errors mention `attachCbm` or `isCbmAttached` callers elsewhere, those callers are in `index.ts` and are removed in Task 3b.3 — they will fail typecheck until then. If that's the only error class, proceed; otherwise fix.

### Step 5: Don't run tests

`index.ts` still calls `attachCbm()` — would now fail at runtime. Move to commit.

### Step 6: Commit

```bash
git add src/graph/store.ts
git commit -m "refactor(graph): remove attachCbm; getAllNodesUnified queries cbm_ tables in same file

After Plan 3a + 3b.1, the indexer's cbm_* tables live in the same SQLite
file as Cortex's own tables. SQLite ATTACH is no longer needed:

- attachCbm() / isCbmAttached() / cbmAttached field — deleted
- getAllNodesUnified() simplified: drops cbm. schema prefix, queries
  cbm_nodes / cbm_projects directly. Same logic, one fewer indirection.
- getAllEdgesUnified() — same pattern.

Index.ts still calls attachCbm at this commit; typecheck flags it.
Task 3b.3 removes that call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b.3 — Update `index.ts`: remove ATTACH wiring, resolve project name from cbm_projects

**Files:**
- Modify: `src/index.ts`

### Step 1: Read the current startup wiring

```bash
sed -n '1,40p' src/index.ts
```

Currently lines 10, 22–34 wire `discoverCbmDb` + `attachCbm` and resolve `cbmProject`. We replace this with a direct query against the local `cortex.db`'s `cbm_projects` table (which gets populated by the indexer the first time `index_repository` runs).

### Step 2: Remove discoverCbmDb / attachCbm wiring

Delete these lines (verify exact line numbers in your read):

```typescript
import { discoverCbmDb } from "./graph/cbm-discovery.js";
```

```typescript
// Discover and attach CBM database
const cwd = process.cwd();
const cbmDbPath = discoverCbmDb(cwd, undefined, process.env.CBM_DB_PATH);
let cbmProject: string | null = null;

if (cbmDbPath) {
  store.attachCbm(cbmDbPath);
  if (store.isCbmAttached()) {
    const projects = store.queryRaw<{ name: string }>(
      "SELECT name FROM cbm.projects WHERE root_path = ?",
      [cwd],
    );
    cbmProject = projects[0]?.name ?? null;
    process.stderr.write(`Cortex: attached CBM database (project: ${cbmProject})\n`);
  }
}
```

### Step 3: Add a direct project-name resolution

Replace with:

```typescript
const cwd = process.cwd();
let cbmProject: string | null = null;

// Resolve the indexed project for this repo. The indexer (bin/cortex-indexer)
// writes to the same cortex.db file when CORTEX_DB env var is set; once it has
// run at least once for this repo, cbm_projects has a row keyed by absolute
// repo path. Until then, cbmProject is null and code-tools surface a clear
// "not indexed" error.
try {
  const row = store
    .queryRaw<{ name: string }>(
      "SELECT name FROM cbm_projects WHERE root_path = ? LIMIT 1",
      [cwd]
    )[0];
  if (row) {
    cbmProject = row.name;
    process.stderr.write(`Cortex: indexed project '${cbmProject}' (root: ${cwd})\n`);
  } else {
    process.stderr.write(`Cortex: no indexed project for ${cwd} — run index_repository\n`);
  }
} catch (e) {
  // cbm_projects table doesn't exist yet — first run, indexer hasn't created it.
  // That's fine: index_repository will create it on first call.
  if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
  process.stderr.write(`Cortex: no indexer state in cortex.db — run index_repository\n`);
}
```

### Step 4: Verify the rest of `index.ts` doesn't break

```bash
grep -n "cbmProject\|cbmDbPath\|attachCbm\|isCbmAttached\|discoverCbmDb" src/index.ts
```

Expected: only `cbmProject` references remain (it's still passed to `createServer`, `startViewerServer`, etc.). No remaining references to `attachCbm`, `discoverCbmDb`, `cbmDbPath`.

### Step 5: Type-check

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean. If `cbm-discovery.js` import is unused but not removed, you missed it. Re-verify.

### Step 6: Don't run tests yet

Indexer subprocess still doesn't get `CORTEX_DB` — tests will still fail with the indexer writing to `~/.cache/...` rather than cortex.db. Task 3b.4 fixes that.

### Step 7: Commit

```bash
git add src/index.ts
git commit -m "refactor(index): resolve cbmProject from cortex.db directly; drop ATTACH wiring

After 3b.2, store.ts no longer supports ATTACH. index.ts:
- Removes discoverCbmDb + attachCbm calls
- Resolves cbmProject by querying cbm_projects in the local cortex.db
  (indexer populates this on first index_repository call)
- Tolerates 'no such table: cbm_projects' on first run before any index

The cbm-discovery.ts file is preserved for Phase 5 v0.2 migration shim;
not called from startup anymore.

Tests still fail — code-tools.ts doesn't yet pass CORTEX_DB to the
subprocess. Task 3b.4 fixes that.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b.4 — Pass `CORTEX_DB` to the indexer subprocess

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts`

### Step 1: Read the current execFile invocations

```bash
grep -nE "execFileAsync|callCbm" src/mcp-server/tools/code-tools.ts | head -20
```

The `callCbm` helper around line 28–47 invokes `execFileAsync(INDEXER_BINARY, ["cli", tool, JSON.stringify(args)], { timeout: 120_000 })`. We need to add an `env` option that includes `CORTEX_DB` pointing at the same cortex.db file Cortex's TS opened.

### Step 2: Determine the cortex.db path

`code-tools.ts` doesn't currently have access to the cortex.db path — it's a module-level helper. The path was set in `src/index.ts:14` as `process.env.CORTEX_DB_PATH || ".cortex/graph.db"`.

Two options:
- **A. Read the env var directly inside callCbm** (simplest): re-read `CORTEX_DB_PATH` in callCbm and pass to subprocess as `CORTEX_DB`.
- **B. Pass cortex.db path through to registerCodeTools** as a parameter, store in closure.

Lean: A. The env var is already the source of truth for both Cortex's TS and the subprocess. Less plumbing.

### Step 3: Update `callCbm`

Replace the current `callCbm` body (around lines 28–47):

```typescript
async function callCbm(tool: string, args: Record<string, unknown>) {
  try {
    const { stdout } = await execFileAsync(INDEXER_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
    });
    // ... rest unchanged
```

With:

```typescript
async function callCbm(tool: string, args: Record<string, unknown>) {
  // Make the indexer write to the same SQLite file Cortex uses. Without this
  // the indexer falls back to ~/.cache/codebase-memory-mcp/<project>.db and
  // Cortex would never see the data.
  const cortexDb = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
  const subprocEnv = { ...process.env, CORTEX_DB: cortexDb };
  try {
    const { stdout } = await execFileAsync(INDEXER_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
      env: subprocEnv,
    });
    // ... rest unchanged
```

The `process.env` spread is important — the subprocess needs PATH and other vars, not just CORTEX_DB.

Note: `cortexDb` as written is a relative path (`.cortex/graph.db`). The indexer subprocess inherits the parent's cwd by default, so the relative path resolves correctly. If we ever change cwd before spawning, this would break — but we don't, so it's fine. (To be defensive, we could `path.resolve(cortexDb)` here. Optional.)

Add the `path.resolve` for safety:

```typescript
import { resolve as pathResolve } from "node:path";
// ... at the top with other imports

// Inside callCbm:
const cortexDb = pathResolve(process.env.CORTEX_DB_PATH || ".cortex/graph.db");
```

### Step 4: Type-check

```bash
npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

### Step 5: Smoke-test manually

```bash
rm -f .cortex/graph.db .cortex/graph.db-wal .cortex/graph.db-shm
mkdir -p .cortex
# Build cortex.db schema (npm test does this in fixtures; we can also just run a small script)
# Quick path: invoke the indexer through the TS code via npm run dev briefly is heavy.
# Easier: invoke callCbm-equivalent via a one-off node command:
node --input-type=module -e "
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const execFileAsync = promisify(execFile);
const cortexDb = resolve('.cortex/graph.db');
const r = await execFileAsync('bin/cortex-indexer', ['cli', 'index_repository', JSON.stringify({ repo_path: process.cwd() })], {
  env: { ...process.env, CORTEX_DB: cortexDb }, timeout: 60_000
});
console.log(r.stdout.slice(0, 200));
"
sqlite3 .cortex/graph.db "SELECT name FROM cbm_projects;"
```

Expected: `cbm_projects` exists in `.cortex/graph.db` with a row whose name maps to the cortex repo. If the file doesn't exist or the table is missing, the env var didn't propagate.

### Step 6: Run Cortex's full test suite

```bash
npm test 2>&1 | tail -10
```

Expected: most or all of the 16 failing contract tests now pass. Some may still fail if the harness doesn't yet propagate CORTEX_DB to its own indexer invocation (Task 3b.5 covers that).

### Step 7: Commit

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat(mcp): pass CORTEX_DB env to indexer subprocess

callCbm now sets CORTEX_DB=<absolute cortex.db path> on the subprocess
env. Without this the indexer would fall back to ~/.cache/<project>.db
and Cortex would never see the data through code-queries.

Source path: process.env.CORTEX_DB_PATH || '.cortex/graph.db' (matches
src/index.ts:14). path.resolve gives an absolute path so the subprocess'
cwd doesn't matter.

After this commit, runtime end-to-end works: Cortex queries cbm_nodes
in the unified cortex.db. Test harness still uses its own pre-Phase-3a
flow — Task 3b.5 fixes that.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b.5 — Update test harness to use CORTEX_DB flow

**Files:**
- Modify: `tests/mcp-contract/globalSetup.ts`
- Modify: `tests/mcp-contract/harness.ts`

### Step 1: Read the current setup flow

```bash
cat tests/mcp-contract/globalSetup.ts
echo "---"
sed -n '20,80p' tests/mcp-contract/harness.ts
```

Today: globalSetup runs the indexer (writes to `~/.cache/...`), then `discoverCbmDb` finds that file, then harness ATTACHes it. Plan 3b removes ATTACH; the harness needs to open the unified file (the cortex.db it specified to the indexer via CORTEX_DB) and query unprefixed.

### Step 2: Replace globalSetup.ts

Rewrite globalSetup.ts so that:
- It creates a temp `cortex.db` path
- Sets `CORTEX_DB=<that path>` in the indexer subprocess environment
- After indexing, opens that file directly to verify schema and resolve project name
- Exposes the path via `CORTEX_CONTRACT_CORTEX_DB` env var (replaces `CORTEX_CONTRACT_CBM_DB`)

```typescript
import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "cortex-indexer");

export async function setup() {
  if (!existsSync(BINARY)) {
    process.env.CORTEX_CONTRACT_BINARY_MISSING = "1";
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "cortex-mcp-contract-"));
  const fixtureCopy = join(workDir, "sample-project");
  cpSync(FIXTURE_SRC, fixtureCopy, { recursive: true });

  // Use a fresh cortex.db inside the work dir so each test run is isolated.
  const cortexDbPath = resolve(join(workDir, "cortex.db"));

  const indexResult = execFileSync(
    BINARY,
    ["cli", "index_repository", JSON.stringify({ repo_path: fixtureCopy })],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      encoding: "utf8",
      env: { ...process.env, CORTEX_DB: cortexDbPath },
    }
  );

  let parsed: { content?: Array<{ text?: string }>; isError?: boolean };
  try {
    parsed = JSON.parse(indexResult);
  } catch {
    throw new Error(
      `globalSetup: index_repository produced non-JSON output: ${indexResult.slice(0, 500)}`
    );
  }
  if (parsed.isError) {
    throw new Error(
      `globalSetup: index_repository failed: ${parsed.content?.[0]?.text ?? indexResult}`
    );
  }

  // Open the cortex.db the indexer just wrote to.
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(cortexDbPath, { readonly: true });
  const row = db
    .prepare("SELECT name FROM cbm_projects WHERE root_path = ?")
    .get(fixtureCopy) as { name: string } | undefined;

  if (!row) {
    db.close();
    throw new Error(`globalSetup: no cbm_projects row found in ${cortexDbPath} for ${fixtureCopy}`);
  }

  const nodeCount = db
    .prepare("SELECT COUNT(*) AS c FROM cbm_nodes WHERE project = ?")
    .get(row.name) as { c: number };
  db.close();

  if (nodeCount.c === 0) {
    throw new Error(
      `globalSetup: indexing completed but 0 nodes found for project ${row.name}.`
    );
  }

  process.env.CORTEX_CONTRACT_FIXTURE_DIR = fixtureCopy;
  process.env.CORTEX_CONTRACT_PROJECT = row.name;
  process.env.CORTEX_CONTRACT_CORTEX_DB = cortexDbPath;
  // Keep the legacy var name briefly so harness.ts can read either during the
  // transition. Will be removed in 3b.6 cleanup.
  process.env.CORTEX_CONTRACT_CBM_DB = cortexDbPath;
}

export async function teardown() {
  const fixtureCopy = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
  if (fixtureCopy) {
    const workDir = dirname(fixtureCopy);
    try { rmSync(workDir, { recursive: true }); } catch { /* ignore */ }
  }
}
```

### Step 3: Update harness.ts

Replace the section in `tests/mcp-contract/harness.ts` (around lines 33–46) that does:

```typescript
const fixtureDir = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
const project = process.env.CORTEX_CONTRACT_PROJECT;
const cbmDbPath = process.env.CORTEX_CONTRACT_CBM_DB;
if (!fixtureDir || !project || !cbmDbPath) {
  throw new Error("Harness: globalSetup did not populate env vars (did it run?).");
}

// Each test gets its own Cortex graph.db (decision storage) to avoid cross-test pollution.
const cortexDbDir = mkdtempSync(join(tmpdir(), "cortex-harness-"));
const cortexDbPath = join(cortexDbDir, "graph.db");
const store = new GraphStore(cortexDbPath);
store.attachCbm(cbmDbPath);
```

With:

```typescript
const fixtureDir = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
const project = process.env.CORTEX_CONTRACT_PROJECT;
const cortexDbPath = process.env.CORTEX_CONTRACT_CORTEX_DB ?? process.env.CORTEX_CONTRACT_CBM_DB;
if (!fixtureDir || !project || !cortexDbPath) {
  throw new Error("Harness: globalSetup did not populate env vars (did it run?).");
}

// Open the unified cortex.db produced by globalSetup. Cortex's tables coexist
// with the indexer's cbm_* tables in this file; no ATTACH needed.
const store = new GraphStore(cortexDbPath);
```

Also: remove the `cortexDbDir` / `mkdtempSync` lines and the corresponding `rmSync` in `close()`. The fixture dir is cleaned up by globalSetup.teardown().

### Step 4: Type-check

```bash
npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

### Step 5: Run the test suite

```bash
npm test 2>&1 | tail -15
```

Expected: all 374 tests pass (or 373 + 1 skipped, matching the prior pre-Phase-3a state). The 16 contract failures from before should now be green.

If failures remain, read each one carefully. Likely causes:
- A query in code-queries.ts still has a stray `cbm.` schema prefix (Task 3b.1 missed)
- A test file references the deleted `attachCbm` directly
- The harness's `close()` still tries to clean up a dir it didn't create

### Step 6: Commit

```bash
git add tests/mcp-contract/globalSetup.ts tests/mcp-contract/harness.ts
git commit -m "test(mcp-contract): use CORTEX_DB unified-file flow; drop ATTACH

globalSetup now creates a fresh cortex.db inside the work dir and runs
the indexer with CORTEX_DB pointing at it. Project / node counts are
verified directly against cbm_projects / cbm_nodes in that file.

Harness opens the same cortex.db without ATTACH (Cortex's own tables
coexist with the indexer's cbm_* tables in one file).

CORTEX_CONTRACT_CBM_DB env var aliased to CORTEX_CONTRACT_CORTEX_DB for
the transition; will be removed in the next cleanup pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b.6 — Replace `tests/graph/cbm-attach.test.ts` with `code-queries.test.ts`

**Files:**
- Delete: `tests/graph/cbm-attach.test.ts`
- Create: `tests/graph/code-queries.test.ts`

### Step 1: Read the existing test to understand what was being verified

```bash
cat tests/graph/cbm-attach.test.ts
```

The existing tests cover:
- ATTACH succeeds for a valid CBM file
- isCbmAttached() returns true after attach
- searchGraph / tracePath / getGraphSchema / listProjects / indexStatus work against attached data

After Plan 3b, the validations to preserve:
- The query helpers in code-queries.ts return correct results against `cbm_*` tables
- The unified-file approach actually works end-to-end (indexer writes, queries read)

### Step 2: Author the new test

Create `tests/graph/code-queries.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../../src/graph/store.js";
import { searchGraph, tracePath, getGraphSchema, listProjects, indexStatus } from "../../src/graph/code-queries.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "cortex-indexer");

describe("code-queries against unified cortex.db", () => {
  let workDir: string;
  let store: GraphStore;
  let project: string;

  beforeAll(() => {
    if (!existsSync(BINARY)) {
      throw new Error(`bin/cortex-indexer not found — run npm install first`);
    }
    workDir = mkdtempSync(join(tmpdir(), "cortex-code-queries-"));
    const fixture = join(workDir, "sample-project");
    cpSync(FIXTURE_SRC, fixture, { recursive: true });

    const cortexDbPath = resolve(join(workDir, "cortex.db"));
    execFileSync(BINARY, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, CORTEX_DB: cortexDbPath },
    });

    store = new GraphStore(cortexDbPath);
    const row = store.queryRaw<{ name: string }>(
      "SELECT name FROM cbm_projects WHERE root_path = ?",
      [fixture]
    )[0];
    if (!row) throw new Error("no cbm_projects row");
    project = row.name;
  });

  afterAll(() => {
    store?.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("searchGraph returns matches by name pattern", () => {
    const results = searchGraph(store, project, { name_pattern: "handleRequest" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toContain("handleRequest");
  });

  it("getGraphSchema returns label and edge type counts", () => {
    const schema = getGraphSchema(store, project);
    expect(schema.labels.length).toBeGreaterThan(0);
    expect(schema.edgeTypes.length).toBeGreaterThan(0);
  });

  it("tracePath returns reachable nodes for a known function", () => {
    const trace = tracePath(store, project, { function_name: "handleRequest", mode: "calls" });
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0]).toHaveProperty("depth");
  });

  it("listProjects returns the indexed project", () => {
    const projects = listProjects(store);
    expect(projects.find((p) => p.name === project)).toBeDefined();
  });

  it("indexStatus returns the project for the fixture root", () => {
    const all = listProjects(store);
    const proj = all.find((p) => p.name === project);
    expect(proj).toBeDefined();
    const status = indexStatus(store, proj!.root_path);
    expect(status).not.toBeNull();
    expect(status!.name).toBe(project);
  });

  it("getAllNodesUnified returns merged Cortex + indexer rows", () => {
    const all = store.getAllNodesUnified(project);
    // The fixture has both indexed code entities and (potentially) decisions.
    // We just verify both kinds appear when expected.
    const hasIndexerRows = all.some((n) => n.id.startsWith("cbm-"));
    expect(hasIndexerRows).toBe(true);
  });
});
```

Note: this test takes longer than the unit tests (it actually runs the indexer ~5–10s). That's by design — it's the integration check that the whole 3a+3b flow works. If vitest's default 5s test timeout is an issue, wrap each `it()` with `{ timeout: 60_000 }` or hoist the indexing into `beforeAll` (already done) with a longer timeout.

### Step 3: Delete the old test

```bash
git rm tests/graph/cbm-attach.test.ts
```

### Step 4: Run the new test

```bash
npm test -- tests/graph/code-queries.test.ts 2>&1 | tail -10
```

Expected: all assertions pass. If anything fails, read the message and adjust.

### Step 5: Run the full suite

```bash
npm test 2>&1 | tail -10
```

Expected: 374 passed (or +1 from the new tests if Cortex's baseline was 373; verify exact count).

### Step 6: Commit

```bash
git add tests/graph/code-queries.test.ts tests/graph/cbm-attach.test.ts
git commit -m "test(graph): replace cbm-attach with code-queries for unified storage

Old test exercised SQLite ATTACH against a CBM cache file. After Phase 3a/3b
we don't ATTACH anymore — the indexer writes directly into cortex.db.

New test runs a real index against tests/fixtures/sample-project,
opens the resulting cortex.db, and exercises the same five query helpers
(searchGraph, getGraphSchema, tracePath, listProjects, indexStatus) plus
getAllNodesUnified. Slower than a unit test (it runs the indexer ~5–10s)
but it's the integration gate Phase 3 actually needs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b.7 — Final cleanup + tag

**Files:**
- Modify: `tests/mcp-contract/globalSetup.ts` (drop the legacy `CORTEX_CONTRACT_CBM_DB` alias)
- Modify: `tests/mcp-contract/harness.ts` (remove the `?? process.env.CORTEX_CONTRACT_CBM_DB` fallback)

### Step 1: Drop the legacy env var alias

In `globalSetup.ts`, remove:
```typescript
process.env.CORTEX_CONTRACT_CBM_DB = cortexDbPath;
```

In `harness.ts`, change:
```typescript
const cortexDbPath = process.env.CORTEX_CONTRACT_CORTEX_DB ?? process.env.CORTEX_CONTRACT_CBM_DB;
```

To:
```typescript
const cortexDbPath = process.env.CORTEX_CONTRACT_CORTEX_DB;
```

### Step 2: Run the test suite once more

```bash
npm test 2>&1 | tail -10
```

Expected: still 374 passed.

### Step 3: Run typecheck once more

```bash
npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

### Step 4: Self-review the diff against main

```bash
git diff main --stat
```

This is large (Phase 1+2+3a+3b together). Just look for surprises — unintended `internal/cbm/` changes, stray `cbm.` schema references, etc.

### Step 5: Commit cleanup

```bash
git add tests/mcp-contract/globalSetup.ts tests/mcp-contract/harness.ts
git commit -m "test(mcp-contract): drop legacy CORTEX_CONTRACT_CBM_DB alias

3b.5 kept the alias for transition. 3b.6 made the new code-queries test
the integration gate. Time to stop carrying the alias.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Step 6: Tag Phase 3b

```bash
git tag -a phase-3b-ts-side -m "Phase 3b: Cortex TS queries cbm_* in unified cortex.db; ATTACH removed.

State at this tag:
- CBM full test suite: 2740 passed
- Cortex TS tests: 374 passed (was 373 pre-Phase-3 with 1 skipped; +1 from new code-queries.test.ts)

What's working end-to-end:
- 'npm install' builds bin/cortex-indexer locally (Phase 1 + 2)
- Indexer respects CORTEX_DB and writes cbm_* tables (Phase 3a)
- Cortex spawns the indexer with CORTEX_DB=<cortex.db>; queries cbm_nodes
  directly without ATTACH (Phase 3b)

Spec §3 Step 3 (Indexer storage retarget) fully complete. Phase 4 (schema
fold into Cortex's nodes/edges) is the next plan."

git tag -l 'phase-*'
```

---

## Self-review checklist

- [ ] Spec §3 Step 3 paragraph 3 ("Cortex's TS read layer queries `cbm_nodes` / `cbm_edges`") — done in 3b.1
- [ ] Spec §3 Step 3 validation ("Cortex's TS query layer points at the same file and `tests/mcp-contract/` passes") — verified in 3b.5 + 3b.6
- [ ] G2 (code entities live in cortex.db's `nodes`/`edges` alongside decisions) — **partially**. Phase 3b lands them in cortex.db but in `cbm_*` tables, NOT yet folded into `nodes`/`edges`. Phase 4 closes this.
- [ ] No new attach() introduced; SQLite single-file architecture intact
- [ ] `cbm-discovery.ts` preserved for Phase 5 v0.2 migration; no startup callers

## Out of scope (deferred to later phases)

- **Phase 4: Schema fold.** `cbm_*` tables → Cortex's `nodes`/`edges` with `kind` discriminator. This is the actual unification spec G2 promises. Plan 4 will need to handle:
  - `ALTER TABLE nodes ADD COLUMN start_line INTEGER, end_line INTEGER, project TEXT`
  - Migration: copy `cbm_nodes` → `nodes` with `kind` mapping (function/class/method/file/symbol)
  - Indexer's storage layer retargeted to write directly into `nodes` / `edges` (no `cbm_` prefix)
  - All Cortex query code re-paths to the unified tables
- **Phase 5: v0.2 migration shim.** Detect old `~/.cache/codebase-memory-mcp/<project>.db` files; one-time copy into the local cortex.db (with the schema fold from Phase 4); mark migration done.
- **Phase 6: Strip CBM's MCP shell + bridge query_graph/get_architecture/ingest_traces.**
- **Phase 7: Repo-root cortex.db + per-machine cache.** Move `<install>/.cortex/graph.db` to `<repo>/.cortex/db`.
- **Phase 8: Final cleanup.** Rename remaining `cbm`-prefixed TS symbols; delete `cbm-discovery.ts` after Phase 5 migration is no longer needed for fresh installs.

## Risks

| Risk | Mitigation |
|---|---|
| Cortex's `cortex.db` and indexer's `cbm_*` tables coexist in one SQLite file. Concurrent writes (Cortex writing decisions while indexer is running) could deadlock or corrupt. | SQLite WAL mode handles multi-writer reasonably. CBM uses WAL by default; verify Cortex's `GraphStore` does too — `PRAGMA journal_mode=WAL`. If not, add it as a small companion task in 3b.4 or 3b.5. |
| First-run experience: a fresh Cortex install on a never-indexed repo. cortex.db doesn't exist; cbm_projects doesn't exist; index.ts must tolerate the "no such table" error from the project-name lookup. | Step 3 of Task 3b.3 wraps the lookup in try/catch and only swallows `no such table` errors — other errors still propagate. |
| Subprocess env propagation across platforms. On Windows, env vars sometimes need uppercase normalization. | Smoke test in 3b.4 verifies macOS; CI catches Linux + Windows. Worst case: explicit `path.resolve` and explicit env name documented. |
| `getAllNodesUnified` returns rows from BOTH Cortex's `nodes` and indexer's `cbm_nodes`. The new ID-prefix (`'cbm-' || id`) is a soft-discriminator. If any caller does `node.id === '5'` it'll silently miss. | Grep callers; the prefix already existed in the old `getAllNodesUnified` so this is preserved behavior, not new. Test in 3b.6 verifies the merge shape. |
| `code-queries.test.ts` runs the real indexer (~5–10s). If CI is slow this might timeout. | Vitest's default timeout is 5s per test; the `beforeAll` will need an explicit `{ timeout: 60_000 }` or similar. Add to the test if needed. |
