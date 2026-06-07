# Graph Freshness Signal + Out-of-Band Auto-Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Cortex graph read carry a trustworthy freshness signal (and make the degraded/stale-fallback case loud), then keep the graph fresh automatically at safe boundaries — so agents trust the graph instead of reaching for grep.

**Architecture:** All-TS. At index time, both index paths write a baseline (`indexed_commit`, `indexed_dirty_sig`, `indexed_at`) into a `cortex_index_meta` table in the graph DB. A pure classifier + a memoized per-repo wrapper compute a `Freshness` verdict; `registerTool` attaches it to read-tool results at the single resolution chokepoint. A `cortex freshness` CLI feeds the SessionStart banner. Out-of-band auto-refresh (SessionStart + post-commit) runs incremental reindex when stale — never inside a read.

**Tech Stack:** TypeScript, Node, `better-sqlite3`, `execFileSync` (git), vitest. Spec: `docs/superpowers/specs/2026-06-07-graph-freshness-and-auto-refresh-design.md`.

**Reference — verified facts about the codebase:**
- `RepoContext` (`src/mcp-server/repo-context.ts:21`) has `repoPath`, `graphDbPath`, `graphDb` (a `better-sqlite3` `Database`), `store` (`GraphStore`). It is built and frozen at `repo-context.ts:281` inside `RepoContextResolver.resolve`.
- `registerTool` (`src/mcp-server/repo-context.ts:402-439`) is the chokepoint; the indexed path is `const ctx = options.resolver.resolve(args.repo_path!); return handler(ctx, args);` (lines 436-437).
- Read-tool results use helpers from `src/mcp-server/response.ts`: `ok(text)`/`empty(q)`/`error(reason,detail)` all return `{ content: [{ type: "text", text }] }`.
- `resolveCortexDbPath(repoPath)` (`src/db/resolve-path.ts:32`) returns the canonical `<repo>/.cortex/db`. `resolveGraphDbForRead(repoPath)` (`:79`) returns whichever DB the resolver opened (may be a `graph.db` / cache fallback).
- Both index paths already run git + write post-index passes: MCP `index_repository` in `src/mcp-server/tools/code-tools.ts` (the `registerRepo()` / `withFrames(...)` tail), CLI `runIndexCommand` in `src/cli/commands/index.ts` (after `runFrameExtraction` / `runContractExtraction`).
- `src/db/cache.ts` already shells git via `execSync` for the cache key — mirror its style but prefer `execFileSync`.
- Regular app code MAY use `Date.now()` (the no-`Date.now` rule applies only to Workflow scripts).

**Environment gates:** `CORTEX_FRESHNESS=0` disables the whole feature (no baseline write, no attach, banner shows raw state); `CORTEX_AUTO_REFRESH=0` keeps the signal but disables auto-refresh.

---

## Phase 1 — The freshness signal (Tasks 1–8)

### Task 1: Git worktree-state helpers

**Files:**
- Create: `src/git/worktree-state.ts`
- Test: `tests/git/worktree-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitHead, gitDirtySig, gitCommitsBehind, isGitRepo } from "../../src/git/worktree-state.js";

const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

describe("worktree-state", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-wt-"));
    git(repo, ["init"]);
    writeFileSync(join(repo, "a.txt"), "one");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports HEAD, clean dirty-sig, and git-repo status", () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(gitHead(repo)).toMatch(/^[0-9a-f]{40}$/);
    const clean = gitDirtySig(repo);
    expect(gitDirtySig(repo)).toBe(clean); // stable when nothing changes
  });

  it("dirty-sig changes when the working tree changes", () => {
    const clean = gitDirtySig(repo);
    writeFileSync(join(repo, "a.txt"), "two");
    expect(gitDirtySig(repo)).not.toBe(clean);
  });

  it("counts commits ahead of a base commit", () => {
    const base = gitHead(repo)!;
    writeFileSync(join(repo, "b.txt"), "x");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "second"]);
    expect(gitCommitsBehind(repo, base)).toBe(1);
  });

  it("returns nulls / false outside a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(isGitRepo(notRepo)).toBe(false);
    expect(gitHead(notRepo)).toBeNull();
    expect(gitDirtySig(notRepo)).toBeNull();
    rmSync(notRepo, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git/worktree-state.test.ts`
Expected: FAIL — `Cannot find module '../../src/git/worktree-state.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/git/worktree-state.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** True when `repo` is inside a git work tree. */
export function isGitRepo(repo: string): boolean {
  return git(repo, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** Current HEAD commit SHA, or null when unavailable (non-git / no commits). */
export function gitHead(repo: string): string | null {
  const out = git(repo, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

/** sha1 of `git status --porcelain` — a stable signature of the working-tree
 *  state (tracked modifications + non-ignored untracked). null outside git.
 *  Empty/clean tree still yields a (constant) hash of the empty string. */
export function gitDirtySig(repo: string): string | null {
  const out = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (out === null) return null;
  return createHash("sha1").update(out).digest("hex");
}

/** Number of commits on HEAD since `base`, or null if uncomputable (e.g. base
 *  was rebased away). */
export function gitCommitsBehind(repo: string, base: string): number | null {
  const out = git(repo, ["rev-list", "--count", `${base}..HEAD`]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/git/worktree-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git/worktree-state.ts tests/git/worktree-state.test.ts
git commit -m "feat(git): worktree-state helpers (head, dirty-sig, commits-behind)"
```

---

### Task 2: `cortex_index_meta` baseline table

**Files:**
- Create: `src/graph/index-meta.ts`
- Test: `tests/graph/index-meta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { writeIndexMeta, readIndexMeta } from "../../src/graph/index-meta.js";

describe("index-meta", () => {
  let dir: string, dbPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-meta-")); dbPath = join(dir, "db"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when the table does not exist", () => {
    const db = new Database(dbPath);
    try { expect(readIndexMeta(db)).toBeNull(); } finally { db.close(); }
  });

  it("writes and reads back a baseline (idempotent upsert)", () => {
    writeIndexMeta(dbPath, { indexed_commit: "abc", indexed_dirty_sig: "sig1", indexed_at: "2026-06-07T00:00:00Z" });
    writeIndexMeta(dbPath, { indexed_commit: "def", indexed_dirty_sig: "sig2", indexed_at: "2026-06-07T01:00:00Z" });
    const db = new Database(dbPath);
    try {
      expect(readIndexMeta(db)).toEqual({ indexed_commit: "def", indexed_dirty_sig: "sig2", indexed_at: "2026-06-07T01:00:00Z" });
    } finally { db.close(); }
  });

  it("tolerates a null commit (non-git index)", () => {
    writeIndexMeta(dbPath, { indexed_commit: null, indexed_dirty_sig: null, indexed_at: "2026-06-07T00:00:00Z" });
    const db = new Database(dbPath);
    try {
      const m = readIndexMeta(db)!;
      expect(m.indexed_commit).toBeNull();
      expect(m.indexed_at).toBe("2026-06-07T00:00:00Z");
    } finally { db.close(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/index-meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/graph/index-meta.ts
import Database from "better-sqlite3";

export interface IndexMeta {
  indexed_commit: string | null;
  indexed_dirty_sig: string | null;
  indexed_at: string;
}

const KEYS = ["indexed_commit", "indexed_dirty_sig", "indexed_at"] as const;

function ensureTable(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS cortex_index_meta (key TEXT PRIMARY KEY, value TEXT)");
}

/** Idempotently write the freshness baseline into the graph DB at `dbPath`.
 *  Opens its own handle (mirrors inject-frames/inject style). Never throws into
 *  the index path — failures are swallowed (best-effort metadata). */
export function writeIndexMeta(dbPath: string, meta: IndexMeta): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    ensureTable(db);
    const up = db.prepare(
      "INSERT INTO cortex_index_meta (key, value) VALUES (@key, @value) " +
      "ON CONFLICT(key) DO UPDATE SET value = @value",
    );
    const tx = db.transaction(() => {
      up.run({ key: "indexed_commit", value: meta.indexed_commit });
      up.run({ key: "indexed_dirty_sig", value: meta.indexed_dirty_sig });
      up.run({ key: "indexed_at", value: meta.indexed_at });
    });
    tx();
  } catch {
    /* best-effort: never fail indexing over freshness metadata */
  } finally {
    db?.close();
  }
}

/** Read the baseline from an open graph DB handle. Returns null when the table
 *  is absent (pre-feature index) or incomplete. */
export function readIndexMeta(db: Database.Database): IndexMeta | null {
  try {
    const rows = db.prepare("SELECT key, value FROM cortex_index_meta").all() as Array<{ key: string; value: string | null }>;
    if (rows.length === 0) return null;
    const m: Record<string, string | null> = {};
    for (const r of rows) m[r.key] = r.value;
    if (!("indexed_at" in m) || m.indexed_at == null) return null;
    return {
      indexed_commit: m.indexed_commit ?? null,
      indexed_dirty_sig: m.indexed_dirty_sig ?? null,
      indexed_at: m.indexed_at,
    };
  } catch {
    return null; // table missing on a degraded/old DB
  }
}

void KEYS; // (KEYS documents the stored keys; referenced for clarity)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/index-meta.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/graph/index-meta.ts tests/graph/index-meta.test.ts
git commit -m "feat(graph): cortex_index_meta baseline read/write"
```

---

### Task 3: Write the baseline from both index paths

**Files:**
- Create: `src/graph/capture-index-meta.ts`
- Modify: `src/mcp-server/tools/code-tools.ts` (the `index_repository` success tail, after `registerRepo()` / before the final return of `withFrames`)
- Modify: `src/cli/commands/index.ts` (after `runContractExtraction`, before the WAL checkpoint)
- Test: `tests/graph/capture-index-meta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { captureIndexMeta } from "../../src/graph/capture-index-meta.js";
import { readIndexMeta } from "../../src/graph/index-meta.js";

const git = (repo: string, a: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });

describe("captureIndexMeta", () => {
  let repo: string, dbPath: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-cap-"));
    git(repo, ["init"]); writeFileSync(join(repo, "a.txt"), "x");
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "init"]);
    dbPath = join(repo, "db");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("captures HEAD + dirty-sig + timestamp into the DB", () => {
    captureIndexMeta(dbPath, repo);
    const db = new Database(dbPath);
    try {
      const m = readIndexMeta(db)!;
      expect(m.indexed_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(m.indexed_dirty_sig).toMatch(/^[0-9a-f]{40}$/);
      expect(m.indexed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally { db.close(); }
  });

  it("is a no-op when CORTEX_FRESHNESS=0", () => {
    const prev = process.env.CORTEX_FRESHNESS;
    process.env.CORTEX_FRESHNESS = "0";
    try {
      captureIndexMeta(dbPath, repo);
      const db = new Database(dbPath);
      try { expect(readIndexMeta(db)).toBeNull(); } finally { db.close(); }
    } finally { process.env.CORTEX_FRESHNESS = prev; }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/capture-index-meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/graph/capture-index-meta.ts
import { writeIndexMeta } from "./index-meta.js";
import { gitHead, gitDirtySig } from "../git/worktree-state.js";

/** Capture the freshness baseline for `repoPath` into the graph DB at `dbPath`.
 *  Called as a post-index step by both index paths. Best-effort + gated by
 *  CORTEX_FRESHNESS=0. Uses an injectable `now` for deterministic tests. */
export function captureIndexMeta(dbPath: string, repoPath: string, now: () => Date = () => new Date()): void {
  if (process.env.CORTEX_FRESHNESS === "0") return;
  writeIndexMeta(dbPath, {
    indexed_commit: gitHead(repoPath),
    indexed_dirty_sig: gitDirtySig(repoPath),
    indexed_at: now().toISOString(),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/capture-index-meta.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into the MCP `index_repository` path**

In `src/mcp-server/tools/code-tools.ts`, add the import near the other graph imports:

```ts
import { captureIndexMeta } from "../../graph/capture-index-meta.js";
```

Find the `index_repository` success tail — the lines that call `registerRepo()` and `return await withFrames(...)` (there are two such returns: the cache-hit path and the fresh-index path). Immediately BEFORE each `registerRepo();` call, add:

```ts
        captureIndexMeta(dbPath, repoPath);
```

(`dbPath` and `repoPath` are both already in scope in that handler.)

- [ ] **Step 6: Wire into the CLI `runIndexCommand` path**

In `src/cli/commands/index.ts`, add the import:

```ts
import { captureIndexMeta } from "../../graph/capture-index-meta.js";
```

After the `runContractExtraction(...)` call and its `process.stdout.write(renderContractsLine(...))`, before the WAL-checkpoint block, add:

```ts
    captureIndexMeta(dbPath, repoPath);
```

(`dbPath` and `repoPath` are in scope in the no-subcommand branch.)

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/graph/ tests/git/`
Expected: tsc clean; all green.

- [ ] **Step 8: Commit**

```bash
git add src/graph/capture-index-meta.ts tests/graph/capture-index-meta.test.ts src/mcp-server/tools/code-tools.ts src/cli/commands/index.ts
git commit -m "feat(graph): capture freshness baseline from both index paths"
```

---

### Task 4: Freshness classifier + memoized resolver

**Files:**
- Create: `src/mcp-server/freshness.ts`
- Test: `tests/mcp-server/freshness.test.ts`

- [ ] **Step 1: Write the failing test (pure classifier — all states)**

```ts
import { describe, it, expect } from "vitest";
import { classifyFreshness } from "../../src/mcp-server/freshness.js";

const base = {
  canonical: true,
  nodeCount: 100,
  meta: { indexed_commit: "AAA", indexed_dirty_sig: "sig", indexed_at: "2026-06-07T00:00:00Z" },
  isGit: true,
  curHead: "AAA",
  curDirtySig: "sig",
  commitsBehind: 0,
};

describe("classifyFreshness", () => {
  it("fresh when head + dirty-sig match the baseline", () => {
    expect(classifyFreshness(base).state).toBe("fresh");
  });
  it("stale:dirty when only the working tree changed", () => {
    expect(classifyFreshness({ ...base, curDirtySig: "other" }).state).toBe("stale:dirty");
  });
  it("stale:commits (with count) when HEAD moved", () => {
    const f = classifyFreshness({ ...base, curHead: "BBB", commitsBehind: 3 });
    expect(f.state).toBe("stale:commits");
    expect(f.commits_behind).toBe(3);
  });
  it("stale:both when head and dirty-sig differ", () => {
    expect(classifyFreshness({ ...base, curHead: "BBB", curDirtySig: "other" }).state).toBe("stale:both");
  });
  it("empty when not canonical (fallback DB)", () => {
    expect(classifyFreshness({ ...base, canonical: false }).state).toBe("empty");
  });
  it("empty when node count is zero", () => {
    expect(classifyFreshness({ ...base, nodeCount: 0 }).state).toBe("empty");
  });
  it("unknown when no baseline meta", () => {
    expect(classifyFreshness({ ...base, meta: null }).state).toBe("unknown");
  });
  it("unknown when not a git repo", () => {
    expect(classifyFreshness({ ...base, isGit: false }).state).toBe("unknown");
  });
  it("omits commits_behind when uncomputable after a rebase", () => {
    const f = classifyFreshness({ ...base, curHead: "BBB", commitsBehind: null });
    expect(f.state).toBe("stale:commits");
    expect(f.commits_behind).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/freshness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (classifier + memo + invalidate)**

```ts
// src/mcp-server/freshness.ts
import type Database from "better-sqlite3";
import { readIndexMeta, type IndexMeta } from "../graph/index-meta.js";
import { isGitRepo, gitHead, gitDirtySig, gitCommitsBehind } from "../git/worktree-state.js";

export type FreshnessState =
  | "fresh" | "stale:commits" | "stale:dirty" | "stale:both" | "empty" | "unknown";

export interface Freshness {
  state: FreshnessState;
  commits_behind?: number;
  dirty?: boolean;
  indexed_at?: string;
  note?: string;
}

export interface ClassifyInput {
  canonical: boolean;
  nodeCount: number;
  meta: IndexMeta | null;
  isGit: boolean;
  curHead: string | null;
  curDirtySig: string | null;
  commitsBehind: number | null;
}

/** Pure freshness classifier — no I/O. */
export function classifyFreshness(i: ClassifyInput): Freshness {
  if (!i.canonical || i.nodeCount === 0) {
    return { state: "empty", note: "graph DB empty or degraded — reindex needed (index_repository)" };
  }
  if (!i.isGit) {
    return { state: "unknown", note: "not a git repository — freshness not tracked" };
  }
  if (!i.meta || i.meta.indexed_commit == null) {
    return { state: "unknown", indexed_at: i.meta?.indexed_at, note: "indexed before freshness tracking — reindex to enable" };
  }
  const headMoved = i.curHead !== i.meta.indexed_commit;
  const dirtyChanged = i.curDirtySig !== i.meta.indexed_dirty_sig;
  if (!headMoved && !dirtyChanged) {
    return { state: "fresh", indexed_at: i.meta.indexed_at };
  }
  const state: FreshnessState = headMoved && dirtyChanged ? "stale:both" : headMoved ? "stale:commits" : "stale:dirty";
  const f: Freshness = { state, dirty: dirtyChanged, indexed_at: i.meta.indexed_at };
  if (headMoved && i.commitsBehind != null) f.commits_behind = i.commitsBehind;
  f.note = noteFor(f);
  return f;
}

function noteFor(f: Freshness): string {
  const bits: string[] = [];
  if (f.commits_behind != null) bits.push(`${f.commits_behind} commit(s) since index`);
  else if (f.state === "stale:commits" || f.state === "stale:both") bits.push("HEAD moved since index");
  if (f.dirty) bits.push("uncommitted changes present");
  return `${bits.join("; ")} — results may be stale, reindex to refresh`;
}

// ── Memoized per-repo wrapper ────────────────────────────────────────────────
interface MemoEntry { value: Freshness; expiresAt: number; }
const memo = new Map<string, MemoEntry>();
const TTL_MS = 2000;

/** Drop the memoized freshness for a repo (call after index / detect_changes). */
export function invalidateFreshness(repoPath: string): void {
  memo.delete(repoPath);
}

/** Gather inputs (git + DB) and classify, memoized 2s per repo. `ctx` supplies
 *  the resolved DB + canonicity. Disabled (always fresh, no note) under
 *  CORTEX_FRESHNESS=0 so the attach path becomes a no-op. */
export function freshnessForContext(ctx: {
  repoPath: string;
  graphDb: Database.Database;
  canonical: boolean;
}): Freshness {
  if (process.env.CORTEX_FRESHNESS === "0") return { state: "fresh" };
  const now = Date.now();
  const hit = memo.get(ctx.repoPath);
  if (hit && hit.expiresAt > now) return hit.value;

  let nodeCount = 0;
  try {
    const row = ctx.graphDb.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number } | undefined;
    nodeCount = row?.n ?? 0;
  } catch { nodeCount = 0; }

  const meta = readIndexMeta(ctx.graphDb);
  const isGit = isGitRepo(ctx.repoPath);
  const curHead = isGit ? gitHead(ctx.repoPath) : null;
  const curDirtySig = isGit ? gitDirtySig(ctx.repoPath) : null;
  const commitsBehind = isGit && meta?.indexed_commit ? gitCommitsBehind(ctx.repoPath, meta.indexed_commit) : null;

  const value = classifyFreshness({ canonical: ctx.canonical, nodeCount, meta, isGit, curHead, curDirtySig, commitsBehind });
  memo.set(ctx.repoPath, { value, expiresAt: now + TTL_MS });
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/freshness.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/freshness.ts tests/mcp-server/freshness.test.ts
git commit -m "feat(freshness): pure classifier + memoized per-repo resolver"
```

---

### Task 5: Resolver exposes `canonical`

**Files:**
- Modify: `src/mcp-server/repo-context.ts` (the `RepoContext` interface ~line 21-32, and the `ctx` construction ~line 281)
- Test: `tests/mcp-server/repo-context-canonical.test.ts` (or extend an existing repo-context test)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { resolveCortexDbPath } from "../../src/db/resolve-path.js";

const git = (r: string, a: string[]) =>
  execFileSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });

// Minimal populated .cortex/db so resolveGraphDbForRead picks the canonical file.
function seedCanonicalDb(repo: string) {
  const p = resolveCortexDbPath(repo);
  mkdirSync(join(repo, ".cortex"), { recursive: true });
  const db = new Database(p);
  db.exec("CREATE TABLE nodes (id TEXT, kind TEXT, project TEXT); CREATE TABLE edges (id TEXT);");
  db.prepare("INSERT INTO nodes (id, kind, project) VALUES ('n1','file','p')").run();
  db.close();
}

describe("RepoContext.canonical", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-canon-"));
    git(repo, ["init"]); writeFileSync(join(repo, "a.txt"), "x");
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "init"]);
    seedCanonicalDb(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports canonical=true when reading the .cortex/db", () => {
    const r = new RepoContextResolver();
    const ctx = r.resolve(repo);
    expect(ctx.graphDbPath).toBe(resolveCortexDbPath(repo));
    expect(ctx.canonical).toBe(true);
  });
});
```

> Note for the implementer: if constructing a real `GraphStore` in the test is too heavy or requires extra schema, simplify by asserting `canonical` equals `ctx.graphDbPath === resolveCortexDbPath(ctx.repoPath)` via a tiny unit on the computed field instead. The behavior under test is only the new `canonical` field.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-canonical.test.ts`
Expected: FAIL — `ctx.canonical` is `undefined` (property does not exist).

- [ ] **Step 3: Add `canonical` to the interface and construction**

In `src/mcp-server/repo-context.ts`, add to the `RepoContext` interface (after `graphDbPath`):

```ts
  /** True when graphDbPath is the canonical <repo>/.cortex/db; false when the
   *  resolver fell back to a legacy graph.db / cache slot (a degraded read). */
  readonly canonical: boolean;
```

Add the import near the other `resolve-path` imports:

```ts
import { resolveDecisionsDbPath, resolveGraphDbForRead, resolveCortexDbPath } from "../db/resolve-path.js";
```

(If `resolveCortexDbPath` is already imported elsewhere in the file, extend that import instead of adding a duplicate.)

In the `ctx` object literal (~line 281), add the field:

```ts
    const ctx: RepoContext = Object.freeze({
      repoPath: canonical,
      graphDbPath,
      canonical: graphDbPath === resolveCortexDbPath(canonical),
      graphDb,
      decisionsDb,
      store,
      decisionsRepo,
      decisionLinksRepo,
    });
```

> Naming caution: the local variable is also called `canonical` (the canonical *repo root*). The new field value is `graphDbPath === resolveCortexDbPath(canonical)`. Keep the field name `canonical` (DB canonicity) — the two are different concepts but the expression is correct: "is the resolved DB the canonical one for the canonical repo root."

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-canonical.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (the new required field must be set everywhere a RepoContext is built)**

Run: `npx tsc --noEmit`
Expected: clean. If tsc flags another `RepoContext` literal (e.g. a test helper), add `canonical` there too.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-canonical.test.ts
git commit -m "feat(repo-context): expose canonical (DB-is-.cortex/db) flag"
```

---

### Task 6: Attach freshness at the `registerTool` chokepoint

**Files:**
- Modify: `src/mcp-server/freshness.ts` (add `attachFreshness`)
- Modify: `src/mcp-server/repo-context.ts` (`registerTool` options + indexed-path attach)
- Modify: `src/mcp-server/tools/code-tools.ts` (set `freshnessAware: true` on read tools)
- Test: `tests/mcp-server/attach-freshness.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { attachFreshness } from "../../src/mcp-server/freshness.js";

const fresh = { state: "fresh" as const };
const stale = { state: "stale:dirty" as const, dirty: true, note: "uncommitted changes present — results may be stale, reindex to refresh" };

describe("attachFreshness", () => {
  it("returns the result unchanged when fresh", () => {
    const r = { content: [{ type: "text", text: "hello" }] };
    expect(attachFreshness(r, fresh)).toBe(r);
  });
  it("appends a freshness note to the first text block when stale", () => {
    const r = { content: [{ type: "text", text: "hello" }] };
    const out = attachFreshness(r, stale) as typeof r & { freshness?: unknown };
    expect(out.content[0].text).toContain("hello");
    expect(out.content[0].text).toContain("cortex freshness: stale:dirty");
    expect(out.freshness).toEqual(stale);
  });
  it("leaves a result with no text content structurally valid", () => {
    const r = { content: [] as Array<{ type: string; text: string }> };
    const out = attachFreshness(r, stale) as typeof r & { freshness?: unknown };
    expect(out.freshness).toEqual(stale);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/attach-freshness.test.ts`
Expected: FAIL — `attachFreshness` not exported.

- [ ] **Step 3: Implement `attachFreshness`**

Append to `src/mcp-server/freshness.ts`:

```ts
type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

/** Attach a freshness verdict to an MCP text result. Returns the result
 *  UNCHANGED when fresh. When stale/empty/unknown, appends a one-line note to
 *  the first text block (always visible to the agent) and adds a structured
 *  `freshness` field. Mutates and returns the same object for non-fresh. */
export function attachFreshness<T extends TextResult>(result: T, f: Freshness): T {
  if (f.state === "fresh") return result;
  const line = `\n\n⚠ cortex freshness: ${f.state}${f.note ? ` — ${f.note}` : ""}`;
  const first = result.content?.find((c) => c.type === "text");
  if (first) first.text += line;
  (result as TextResult).freshness = f;
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/attach-freshness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `registerTool`**

In `src/mcp-server/repo-context.ts`, add the import:

```ts
import { freshnessForContext, attachFreshness } from "./freshness.js";
```

Add `freshnessAware?: boolean` to the `options` type of BOTH `registerTool` overloads' `options` parameter and the implementation signature (the `{ resolver; crossRepo?; allowUnindexed? }` object). Then change the indexed-path tail (currently `const ctx = options.resolver.resolve(args.repo_path!); return handler(ctx, args);`) to:

```ts
    const ctx = options.resolver.resolve(args.repo_path!);
    const result = await handler(ctx, args);
    if (options.freshnessAware && result && typeof result === "object" && "content" in (result as object)) {
      const f = freshnessForContext({ repoPath: ctx.repoPath, graphDb: ctx.graphDb, canonical: ctx.canonical });
      return attachFreshness(result as any, f) as R;
    }
    return result;
```

> Only the default indexed path attaches freshness. The `crossRepo` and `allowUnindexed` early-returns are left unchanged (those tools either don't read a repo's graph or are the index/cross-repo tools).

- [ ] **Step 6: Opt the read tools in**

In `src/mcp-server/tools/code-tools.ts`, for each READ tool's `registerTool(..., { resolver })` options object, add `freshnessAware: true`. The read tools are: `search_graph`, `get_code_snippet`, `trace_path`, `query_graph`, `search_code`, `get_architecture`, `why_was_this_built`. Example (search_graph):

```ts
      { resolver, freshnessAware: true },
```

Do NOT add it to `index_repository`, `detect_changes`, `ingest_traces`, `index_status`, `list_projects`, `delete_project`, or any decision tool.

- [ ] **Step 7: Typecheck + targeted tests + a contract smoke**

Run: `npx tsc --noEmit && npx vitest run tests/mcp-server/ tests/mcp-contract/`
Expected: tsc clean; green. (If a read-routing test asserts exact result text, update it to tolerate an appended freshness note, OR ensure the test's repo is freshly indexed so `state==="fresh"` and nothing is appended.)

- [ ] **Step 8: Commit**

```bash
git add src/mcp-server/freshness.ts src/mcp-server/repo-context.ts src/mcp-server/tools/code-tools.ts tests/mcp-server/attach-freshness.test.ts
git commit -m "feat(freshness): attach freshness to read-tool results at the chokepoint"
```

---

### Task 7: Invalidate the memo after index / detect_changes

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (`index_repository` tail; `detect_changes` handler)
- Test: covered by Task 4's memo test; add one integration assertion here

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/freshness-invalidate.test.ts
import { describe, it, expect } from "vitest";
import { freshnessForContext, invalidateFreshness } from "../../src/mcp-server/freshness.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("invalidateFreshness", () => {
  it("forces recomputation rather than serving the 2s memo", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-inv-"));
    const db = new Database(join(dir, "db"));
    db.exec("CREATE TABLE nodes (id TEXT)");
    const ctx = { repoPath: dir, graphDb: db, canonical: true };
    const first = freshnessForContext(ctx);     // memoized (empty: 0 nodes, non-git)
    invalidateFreshness(dir);
    db.prepare("INSERT INTO nodes (id) VALUES ('x')").run();
    const second = freshnessForContext(ctx);    // recomputed: now 1 node
    expect(first.state).not.toBe(second.state); // empty -> unknown (non-git) proves recompute
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/freshness-invalidate.test.ts`
Expected: FAIL — without invalidation the memo would serve `first` again so the two states would be equal. (If it passes already because TTL elapsed, the test is still valid; the wiring steps below are what matter operationally.)

- [ ] **Step 3: Call `invalidateFreshness` from the index + detect paths**

In `src/mcp-server/tools/code-tools.ts`, ensure the import includes it:

```ts
import { invalidateFreshness } from "../freshness.js";
```

In the `index_repository` handler, immediately after `captureIndexMeta(dbPath, repoPath);` (both returns), add:

```ts
        invalidateFreshness(repoPath);
```

In the `detect_changes` handler, before the `return callIndexer("detect_changes", ...)`, add:

```ts
        invalidateFreshness(ctx.repoPath);
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/mcp-server/freshness-invalidate.test.ts`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/mcp-server/freshness-invalidate.test.ts
git commit -m "feat(freshness): invalidate memo after index and detect_changes"
```

---

### Task 8: `cortex freshness` CLI + SessionStart banner

**Files:**
- Create: `src/cli/commands/freshness.ts`
- Modify: `src/cli/router.ts` or the CLI dispatch that maps commands (wire `freshness`)
- Modify: `hooks/check-index.sh`
- Test: `tests/cli/freshness.test.ts`

- [ ] **Step 1: Write the failing test (pure render of a Freshness verdict)**

```ts
import { describe, it, expect } from "vitest";
import { renderFreshnessLine } from "../../src/cli/commands/freshness.js";

describe("renderFreshnessLine", () => {
  it("renders fresh", () => {
    expect(renderFreshnessLine({ state: "fresh" })).toBe("fresh");
  });
  it("renders stale with the note", () => {
    expect(renderFreshnessLine({ state: "stale:dirty", note: "uncommitted changes present — results may be stale, reindex to refresh" }))
      .toContain("stale:dirty");
  });
  it("renders degraded/empty as actionable", () => {
    expect(renderFreshnessLine({ state: "empty", note: "graph DB empty or degraded — reindex needed (index_repository)" }))
      .toContain("reindex");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/freshness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the CLI command**

```ts
// src/cli/commands/freshness.ts
import Database from "better-sqlite3";
import type { ProjectContext } from "../context.js";
import { resolveGraphDbForRead, resolveCortexDbPath } from "../../db/resolve-path.js";
import { freshnessForContext, type Freshness } from "../../mcp-server/freshness.js";

/** One-line human render of a Freshness verdict (also reused by the hook). */
export function renderFreshnessLine(f: Freshness): string {
  return f.state === "fresh" ? "fresh" : `${f.state}${f.note ? ` — ${f.note}` : ""}`;
}

/** `cortex freshness` — print the freshness verdict for the cwd repo. */
export function runFreshnessCommand(ctx: ProjectContext): void {
  const repoPath = ctx.gitRoot ?? ctx.cwd;
  const graphDbPath = resolveGraphDbForRead(repoPath);
  if (!graphDbPath) {
    process.stdout.write("not-indexed — run: cortex index\n");
    return;
  }
  const db = new Database(graphDbPath, { readonly: true });
  try {
    const f = freshnessForContext({
      repoPath,
      graphDb: db,
      canonical: graphDbPath === resolveCortexDbPath(repoPath),
    });
    process.stdout.write(renderFreshnessLine(f) + "\n");
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Wire the command into the CLI dispatch**

`freshness` is a meta command (like `tour`). In `src/cli/main.ts`:
1. Add `"freshness"` to the `META_COMMANDS` array (line 19): `const META_COMMANDS = ["tour", "help", "install", "setup", "freshness"];`
2. Add the import near the other command imports: `import { runFreshnessCommand } from "./commands/freshness.js";`
3. Add a meta-command block immediately after the `tour` block (which is `if (argv.namespace === "tour") { const ctx = loadContext(process.cwd()); ...; return; }`):

```ts
  if (argv.namespace === "freshness") {
    const ctx = loadContext(process.cwd());
    runFreshnessCommand(ctx);
    return;
  }
```

(`loadContext` is already imported and used by the neighboring meta commands.)

- [ ] **Step 5: Run test + manual smoke**

Run: `npx vitest run tests/cli/freshness.test.ts`
Expected: PASS.
Run: `./bin/cortex freshness`
Expected: prints `fresh` / `stale:…` / `not-indexed` for the cwd.

- [ ] **Step 6: Rewrite the hook's index detection + banner**

In `hooks/check-index.sh`: the current detection treats any existing `.cortex/db` file as `indexed` (a 0-byte file passes). Change the detection so a **0-byte** `.cortex/db` is NOT treated as indexed (e.g. `[ -s "$REPO/.cortex/db" ]` — `-s` = exists AND non-empty — instead of `[ -f ... ]`). Then, when indexed and `bin/cortex` is available, capture freshness and fold it into the banner line:

```sh
# After establishing INDEX_STATE=indexed and DB_PATH:
if command -v "$CORTEX_BIN" >/dev/null 2>&1; then
  FRESHNESS="$("$CORTEX_BIN" freshness 2>/dev/null | head -1)"
  if [ -n "$FRESHNESS" ] && [ "$FRESHNESS" != "fresh" ]; then
    INDEX_STATE="indexed ($FRESHNESS)"
  fi
fi
```

(Use the same `$CORTEX_BIN` / repo-detection variables the hook already defines. Keep it best-effort — any failure leaves the prior banner behavior.)

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/freshness.ts src/cli/main.ts hooks/check-index.sh tests/cli/freshness.test.ts
git commit -m "feat(cli): cortex freshness command + SessionStart banner (0-byte db no longer reads as indexed)"
```

---

## Phase 2 — Out-of-band auto-refresh (Tasks 9–10)

> **PLAN PREREQUISITE (do this before Task 9):** Confirm the incremental index pipeline updates `.cortex/db` **in place** and does NOT delete+recreate it (the full pipeline in `handle_index_repository` deletes+recreates). Inspect `internal/indexer/src/pipeline/pipeline_incremental.c` and how the CLI/MCP expose incremental indexing (search for an `incremental`/`detect_changes`-scoped index entry point). If in-place is NOT guaranteed, STOP and restrict auto-refresh to SessionStart-before-reads only (skip the post-commit in-session trigger in Task 10) and note it. Record the finding as a one-line decision.

### Task 9: SessionStart auto-refresh

**Files:**
- Modify: `hooks/check-index.sh`
- Test: manual + a shell-level assertion (document expected behavior; no unit harness for the hook)

- [ ] **Step 1: Gate + decide refresh kind from the freshness state**

In `hooks/check-index.sh`, after computing `FRESHNESS` (Task 8 step 6), and only when `CORTEX_AUTO_REFRESH != 0`:
- if state starts with `empty` or `unknown` → run a **full** index synchronously, printing a notice first (this runs before the agent reads):

```sh
if [ "${CORTEX_AUTO_REFRESH:-1}" != "0" ]; then
  case "$FRESHNESS" in
    empty*|unknown*)
      echo "Cortex: index missing/degraded — building (one-time)…" >&2
      "$CORTEX_BIN" index >/dev/null 2>&1 || true
      ;;
    stale:*)
      echo "Cortex: index stale — incremental refresh…" >&2
      "$CORTEX_BIN" index changes-refresh >/dev/null 2>&1 || true
      ;;
  esac
fi
```

> `cortex index changes-refresh` is the incremental entry point. If a distinct incremental CLI verb does not exist yet, add a thin one in `src/cli/commands/index.ts` that runs the incremental index for the cwd repo (reusing the indexer's incremental mode). If incremental is not safe/available per the prerequisite, fall back to NOT auto-refreshing on `stale:*` (leave the signal only) and note it.

- [ ] **Step 2: Manual verification**

```bash
# fresh repo
./bin/cortex index && ./bin/cortex freshness   # -> fresh
# make it stale
echo x >> README.md && ./bin/cortex freshness    # -> stale:dirty
# simulate SessionStart
bash hooks/check-index.sh                         # prints refresh notice; afterwards:
./bin/cortex freshness                            # -> fresh (if incremental wired) 
```

Expected: banner shows stale, refresh runs, freshness returns to `fresh` (or stays `stale:dirty` with signal-only fallback if incremental was gated off).

- [ ] **Step 3: Commit**

```bash
git add hooks/check-index.sh src/cli/commands/index.ts
git commit -m "feat(hook): SessionStart auto-refresh (full for empty/unknown, incremental for stale)"
```

---

### Task 10: Post-commit incremental trigger (PostToolUse hook)

**Files:**
- Create: `hooks/post-commit-refresh.sh`
- Modify: `hooks/hooks.json` (the existing `PostToolUse` → `Bash` matcher already has a `"if": "Bash(git commit*)"` hook running `suggest-capture.sh`; add a sibling hook with the same `if`)
- Test: manual

- [ ] **Step 1: Write the hook script**

The `"if": "Bash(git commit*)"` matcher (added in step 2) gates invocation, so the script does not need to re-parse the command — it just refreshes, best-effort, gated by the env switch:

```sh
#!/usr/bin/env bash
# PostToolUse hook (fires only on `git commit*` via the hooks.json `if`):
# refresh the index incrementally so the graph tracks the new HEAD.
set -u
[ "${CORTEX_AUTO_REFRESH:-1}" = "0" ] && exit 0
CORTEX_BIN="${CLAUDE_PLUGIN_ROOT:-.}/bin/cortex"
[ -x "$CORTEX_BIN" ] || CORTEX_BIN="$(command -v cortex || echo ./bin/cortex)"
"$CORTEX_BIN" index changes-refresh >/dev/null 2>&1 || true
exit 0
```

- [ ] **Step 2: Register the hook in `hooks/hooks.json`**

The `PostToolUse` → `Bash` matcher already exists with one hook (`suggest-capture.sh`, `"if": "Bash(git commit*)"`). Add a SECOND hook object to that same matcher's `hooks` array:

```json
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/post-commit-refresh.sh",
            "if": "Bash(git commit*)"
          }
```

So the `PostToolUse` → `Bash` → `hooks` array contains both `suggest-capture.sh` and `post-commit-refresh.sh`, each with `"if": "Bash(git commit*)"`.

- [ ] **Step 3: Manual verification**

```bash
chmod +x hooks/post-commit-refresh.sh
echo x >> README.md && git add -A && git commit -m "test commit"
# In a Claude Code session with the hook registered, the post-commit refresh runs;
./bin/cortex freshness   # -> fresh shortly after the commit
```

- [ ] **Step 4: Commit**

```bash
chmod +x hooks/post-commit-refresh.sh
git add hooks/post-commit-refresh.sh hooks/hooks.json
git commit -m "feat(hook): post-commit incremental index refresh (PostToolUse)"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — full suite green
- [ ] `npx vitest run tests/regression/contracts-rpc-seam.test.ts` — contract guard still green (allowlist empty)
- [ ] Manual end-to-end: index → `cortex freshness` = fresh; edit a file → `stale:dirty` + read tools append the note; commit → `stale:commits`; reindex → `fresh`.
- [ ] Capture a decision (`create_decision`) recording the freshness-signal architecture and the incremental-in-place finding from the Phase-2 prerequisite.
- [ ] Update `HANDOFF.md` and `CLAUDE.md` (the tool-routing table — add a line that read tools now carry a freshness signal; reinforce that a `stale`/`empty` signal is the cue to reindex rather than fall back to grep).

## Notes for the implementer

- **DRY:** `renderFreshnessLine` (CLI) and `attachFreshness`'s note both describe the same verdict; keep the human phrasing in `freshness.ts` (`note`) as the single source and have the CLI render from it (as written).
- **YAGNI:** no background file-watcher; the post-commit boundary is the only in-session trigger.
- **Safety invariants (from the spec, do not violate):** never trigger reindex from a read tool; never auto-run a destructive full reindex in-session; in-session refresh is incremental + in-place only.
- **Phase 1 is independently shippable** (Tasks 1–8 deliver the trust signal). Phase 2 (9–10) adds auto-refresh and depends on the incremental-in-place prerequisite.
