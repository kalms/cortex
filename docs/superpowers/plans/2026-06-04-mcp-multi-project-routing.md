# MCP Multi-Project Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cortex MCP server's startup-time, single-repo binding with a per-call resolver middleware so graph DB and decisions DB route per-call, eliminating the silent cross-repo mis-routing bug confirmed in `docs/superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md`.

**Architecture:** New `RepoContextResolver` in `src/mcp-server/repo-context.ts` validates a per-call `repo_path` and returns a pooled `RepoContext` (DB handles + scoped repositories). A `registerTool` wrapper threads context into every tool handler. Cross-repo tools (`list_projects`, `delete_project`) opt out via `crossRepo: true`. The old `createServer(repoPath)` startup binding is removed. A new CLI verb `cortex decision rehome` handles the manual re-home workflow for historical mis-routed decisions.

**Tech Stack:** TypeScript, better-sqlite3, Zod, vitest, @modelcontextprotocol/sdk

**Spec:** [`docs/superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md`](../specs/2026-06-03-mcp-multi-project-routing-design.md)

---

## File Structure

**New files:**
- `src/mcp-server/repo-context.ts` — `RepoContext` type, `RepoContextPool`, `RepoContextResolver`, `registerTool` helper, error classes.
- `src/cli/commands/decision-rehome.ts` — `cortex decision rehome` verb.
- `tests/mcp-server/repo-context-resolver.test.ts`
- `tests/mcp-server/repo-context-pool.test.ts`
- `tests/cli/commands/decision-rehome.test.ts`
- `tests/regression/decisions-cross-repo-isolation.test.ts`

**Modified files:**
- `src/mcp-server/server.ts` — drop startup `repoPath`, register tools through `registerTool`.
- `src/index.ts` — server entrypoint update.
- `src/mcp-server/tools/*.ts` — every tool module: add `repo_path` to schemas, switch to `(context, args)` signature.
- `src/cli/help.ts` — add `rehome` entry to the decision namespace.
- `src/cli/commands/decision.ts` — route `rehome` verb.
- `tests/mcp-contract/*.test.ts` — add `repo_path` to fixtures, add "rejects when missing" cases.
- `CLAUDE.md` — agent-facing routing docs section.
- `hooks/check-index.sh` — print repo absolute path in banner.
- `HANDOFF.md`, `HANDOFF_DECISIONS.md` — close out Gap 3 and partial Gap 4.

---

## Convention for migration tasks

Phases 2 and 3 migrate ~21 tools through the same mechanical pattern. **Task 2.1 (`create_decision`) is written out in full as the template.** Every subsequent tool migration task lists *only* the per-tool specifics (file paths, schema additions specific to that tool, test paths) and references back to Task 2.1's step structure by step number. The pattern itself does not change between tools; copy-paste the code from Task 2.1 and adapt the tool name / arg list per the specifics provided.

If you find yourself uncertain about what a step requires, re-read Task 2.1's full step text — the answer is there.

---

## Phase 1 — Infrastructure

Build the resolver, pool, error classes, and `registerTool` helper. No tool behavior changes. After this phase, the MCP server still binds `repoPath` at startup; phases 2–5 incrementally drain that binding.

---

### Task 1.1: `RepoContextPool` — store and retrieve

**Files:**
- Create: `src/mcp-server/repo-context.ts`
- Test: `tests/mcp-server/repo-context-pool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server/repo-context-pool.test.ts
import { describe, expect, it } from "vitest";
import { RepoContextPool } from "../../src/mcp-server/repo-context.js";
import type { RepoContext } from "../../src/mcp-server/repo-context.js";

function makeStubContext(path: string): RepoContext {
  // Minimal stub for pool tests — DB handles aren't exercised here.
  return {
    repoPath: path,
    graphDb: { close: () => {} } as any,
    decisionsDb: { close: () => {} } as any,
    store: {} as any,
    decisionsRepo: {} as any,
    decisionLinksRepo: {} as any,
  };
}

describe("RepoContextPool", () => {
  it("returns the stored context for a known path", () => {
    const pool = new RepoContextPool({ capacity: 8 });
    const ctx = makeStubContext("/repo/a");
    pool.set("/repo/a", ctx);
    expect(pool.get("/repo/a")).toBe(ctx);
  });

  it("returns undefined for an unknown path", () => {
    const pool = new RepoContextPool({ capacity: 8 });
    expect(pool.get("/repo/missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-pool.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp-server/repo-context.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/mcp-server/repo-context.ts
import type { Database } from "better-sqlite3";
import type { GraphStore } from "../graph/store.js";
import type { DecisionsRepository } from "../decisions/repository.js";
import type { DecisionLinksRepository } from "../decisions/links-repository.js";

/**
 * Everything a tool needs to act on one repo. Constructed by
 * {@link RepoContextResolver}; never instantiated by tool handlers directly.
 * DB handles are pooled — the same RepoContext is returned for repeated
 * calls against the same repo within one server lifetime.
 */
export interface RepoContext {
  readonly repoPath: string;
  readonly graphDb: Database;
  readonly decisionsDb: Database;
  readonly store: GraphStore;
  readonly decisionsRepo: DecisionsRepository;
  readonly decisionLinksRepo: DecisionLinksRepository;
}

/**
 * Internal LRU cache keyed by absolute repo path. Tool handlers do not see
 * this class directly — they go through {@link RepoContextResolver}.
 *
 * Capacity exists to bound DB handle leaks if an agent thrashes across
 * many repos; in normal use a session touches 1–2 repos. Eviction policy
 * is intentionally an internal detail and not pinned by contract tests.
 */
export class RepoContextPool {
  private readonly map = new Map<string, RepoContext>();
  private readonly capacity: number;

  constructor(options: { capacity: number }) {
    this.capacity = options.capacity;
  }

  get(repoPath: string): RepoContext | undefined {
    return this.map.get(repoPath);
  }

  set(repoPath: string, ctx: RepoContext): void {
    this.map.set(repoPath, ctx);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-pool.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-pool.test.ts
git commit -m "feat(mcp): RepoContextPool basic get/set"
```

---

### Task 1.2: `RepoContextPool` — capacity-bounded eviction (internal)

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Modify: `tests/mcp-server/repo-context-pool.test.ts`

The spec says eviction policy is not pinned by contract tests. We still need a basic test that the pool doesn't grow unbounded and that evicted contexts have their handles closed.

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/mcp-server/repo-context-pool.test.ts
it("does not grow unbounded; closes DB handles on eviction", () => {
  const closed: string[] = [];
  const make = (path: string): RepoContext => ({
    repoPath: path,
    graphDb: { close: () => closed.push(`${path}:graph`) } as any,
    decisionsDb: { close: () => closed.push(`${path}:decisions`) } as any,
    store: {} as any,
    decisionsRepo: {} as any,
    decisionLinksRepo: {} as any,
  });

  const pool = new RepoContextPool({ capacity: 2 });
  pool.set("/r/a", make("/r/a"));
  pool.set("/r/b", make("/r/b"));
  pool.set("/r/c", make("/r/c"));  // should evict /r/a

  expect(pool.get("/r/a")).toBeUndefined();
  expect(pool.get("/r/b")).toBeDefined();
  expect(pool.get("/r/c")).toBeDefined();
  expect(closed).toContain("/r/a:graph");
  expect(closed).toContain("/r/a:decisions");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-pool.test.ts`
Expected: FAIL — `/r/a` still returns a context.

- [ ] **Step 3: Update `RepoContextPool` with LRU eviction**

```typescript
// In src/mcp-server/repo-context.ts, replace the RepoContextPool class:
export class RepoContextPool {
  // Map preserves insertion order; we exploit that for LRU semantics:
  // delete-and-re-set on access promotes to most-recently-used.
  private readonly map = new Map<string, RepoContext>();
  private readonly capacity: number;

  constructor(options: { capacity: number }) {
    this.capacity = options.capacity;
  }

  get(repoPath: string): RepoContext | undefined {
    const ctx = this.map.get(repoPath);
    if (ctx) {
      this.map.delete(repoPath);
      this.map.set(repoPath, ctx);
    }
    return ctx;
  }

  set(repoPath: string, ctx: RepoContext): void {
    if (this.map.has(repoPath)) this.map.delete(repoPath);
    this.map.set(repoPath, ctx);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      evicted.graphDb.close();
      evicted.decisionsDb.close();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-pool.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-pool.test.ts
git commit -m "feat(mcp): RepoContextPool LRU eviction closes evicted handles"
```

---

### Task 1.3: `RepoContextPool.shutdown()` closes all handles

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Modify: `tests/mcp-server/repo-context-pool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/mcp-server/repo-context-pool.test.ts
it("shutdown() closes every remaining handle and empties the pool", () => {
  const closed: string[] = [];
  const make = (path: string): RepoContext => ({
    repoPath: path,
    graphDb: { close: () => closed.push(`${path}:graph`) } as any,
    decisionsDb: { close: () => closed.push(`${path}:decisions`) } as any,
    store: {} as any,
    decisionsRepo: {} as any,
    decisionLinksRepo: {} as any,
  });

  const pool = new RepoContextPool({ capacity: 4 });
  pool.set("/r/a", make("/r/a"));
  pool.set("/r/b", make("/r/b"));
  pool.shutdown();

  expect(closed).toEqual(expect.arrayContaining([
    "/r/a:graph", "/r/a:decisions", "/r/b:graph", "/r/b:decisions",
  ]));
  expect(pool.get("/r/a")).toBeUndefined();
  expect(pool.get("/r/b")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-pool.test.ts`
Expected: FAIL — `pool.shutdown is not a function`

- [ ] **Step 3: Add `shutdown` method**

```typescript
// Inside the RepoContextPool class, add:
/** Closes every pooled DB handle and empties the cache. Idempotent. */
shutdown(): void {
  for (const ctx of this.map.values()) {
    ctx.graphDb.close();
    ctx.decisionsDb.close();
  }
  this.map.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-pool.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-pool.test.ts
git commit -m "feat(mcp): RepoContextPool.shutdown() closes all pooled handles"
```

---

### Task 1.4: Resolver error classes

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Test: `tests/mcp-server/repo-context-resolver.test.ts`

The resolver needs four named error classes carrying the structured payload. Build them first so subsequent resolver tests can assert on instance type.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server/repo-context-resolver.test.ts
import { describe, expect, it } from "vitest";
import {
  MissingRepoPathError,
  PathNotFoundError,
  NotAGitRepoError,
  RepoNotIndexedError,
} from "../../src/mcp-server/repo-context.js";

describe("Resolver error classes", () => {
  it("MissingRepoPathError carries name, hint, available_projects", () => {
    const err = new MissingRepoPathError("create_decision", []);
    expect(err.name).toBe("MissingRepoPathError");
    expect(err.message).toContain("create_decision");
    expect(err.hint).toMatch(/list_projects/);
    expect(err.availableProjects).toEqual([]);
  });

  it("PathNotFoundError mentions the path", () => {
    const err = new PathNotFoundError("/no/such/path");
    expect(err.message).toContain("/no/such/path");
  });

  it("NotAGitRepoError carries inferred git_root when known", () => {
    const err = new NotAGitRepoError("/repo/subdir/file", "/repo");
    expect(err.message).toContain("/repo/subdir/file");
    expect(err.gitRoot).toBe("/repo");
  });

  it("RepoNotIndexedError carries available_projects", () => {
    const err = new RepoNotIndexedError("/repo/x", [
      { name: "p", path: "/repo/p", indexed: true },
    ]);
    expect(err.availableProjects).toHaveLength(1);
    expect(err.availableProjects[0].path).toBe("/repo/p");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: FAIL — error classes not exported.

- [ ] **Step 3: Add error classes to `repo-context.ts`**

```typescript
// Append to src/mcp-server/repo-context.ts
/**
 * Shape included in MissingRepoPathError and RepoNotIndexedError so an agent
 * that hit the wrong path can paste the right repo_path back without a
 * second tool call. `indexed: false` is for repos the resolver knows about
 * but whose `.cortex/graph.db` is missing — the Field Report's
 * "indexed-but-unreachable" case made explicit.
 */
export interface AvailableProject {
  readonly name: string;
  readonly path: string;
  readonly indexed: boolean;
}

/** Thrown when a non-crossRepo tool was called without `repo_path`. */
export class MissingRepoPathError extends Error {
  readonly hint: string;
  readonly availableProjects: AvailableProject[];
  constructor(toolName: string, availableProjects: AvailableProject[]) {
    super(`repo_path required for tool '${toolName}'`);
    this.name = "MissingRepoPathError";
    this.hint = "Pass an absolute path to an indexed git root. Use list_projects to discover indexed repos.";
    this.availableProjects = availableProjects;
  }
}

/** Thrown when the supplied path does not exist on disk. */
export class PathNotFoundError extends Error {
  constructor(path: string) {
    super(`repo_path '${path}' does not exist`);
    this.name = "PathNotFoundError";
  }
  readonly hint = "Check the path; was it just deleted or moved?";
}

/** Thrown when the supplied path is not a git root. */
export class NotAGitRepoError extends Error {
  readonly hint = "Pass the repository root, not a subdirectory or file.";
  constructor(path: string, readonly gitRoot?: string) {
    super(`repo_path '${path}' is not a git root`);
    this.name = "NotAGitRepoError";
  }
}

/** Thrown when the path is a git root but `.cortex/graph.db` is missing. */
export class RepoNotIndexedError extends Error {
  readonly hint: string;
  constructor(path: string, readonly availableProjects: AvailableProject[]) {
    super(`repo_path '${path}' has no .cortex/ — repo not indexed`);
    this.name = "RepoNotIndexedError";
    this.hint = `Run cortex index repository --path=${path} first.`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-resolver.test.ts
git commit -m "feat(mcp): resolver error classes with structured payloads"
```

---

### Task 1.5: `RepoContextResolver.resolve` — happy path

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Modify: `tests/mcp-server/repo-context-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/mcp-server/repo-context-resolver.test.ts
import { mkdtempSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";

function makeIndexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-repo-"));
  execSync(`git init -q "${root}"`);
  mkdirSync(join(root, ".cortex"));
  // Touch a graph.db so the resolver sees it as indexed. The DB doesn't need
  // a real schema for this test — opening it just needs to succeed.
  execSync(`touch "${join(root, ".cortex/graph.db")}"`);
  return root;
}

describe("RepoContextResolver.resolve — happy path", () => {
  it("returns a RepoContext for a valid indexed git root", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    const ctx = resolver.resolve(repo);
    expect(ctx.repoPath).toBe(repo);
    expect(ctx.graphDb).toBeDefined();
    expect(ctx.decisionsDb).toBeDefined();
  });

  it("returns the same context on repeated calls (pool hit)", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    expect(resolver.resolve(repo)).toBe(resolver.resolve(repo));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: FAIL — `RepoContextResolver` not exported.

- [ ] **Step 3: Implement `RepoContextResolver.resolve` happy path**

```typescript
// Append to src/mcp-server/repo-context.ts
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { resolveDecisionsDbPath, resolveCortexDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { GraphStore } from "../graph/store.js";
import BetterSqlite3 from "better-sqlite3";

/**
 * The only entry point tool handlers use to obtain a {@link RepoContext}.
 *
 * Per-call resolution replaces the previous startup-time `repoPath` binding
 * that pooled writes from all tool calls into the server's home repo
 * (decisions DB) and made non-cwd projects unreachable (graph DB). See
 * `docs/superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md`.
 *
 * Pool hits skip all I/O. Pool misses validate the path, open both DBs,
 * run the (idempotent) decisions migration, and cache the result.
 */
export class RepoContextResolver {
  private readonly pool: RepoContextPool;

  constructor(options: { poolCapacity: number }) {
    this.pool = new RepoContextPool({ capacity: options.poolCapacity });
  }

  /**
   * Resolve a repo by path. Throws one of:
   * {@link PathNotFoundError}, {@link NotAGitRepoError}, {@link RepoNotIndexedError}.
   */
  resolve(repoPath: string): RepoContext {
    const abs = resolvePath(repoPath);
    const cached = this.pool.get(abs);
    if (cached) return cached;

    if (!existsSync(abs)) throw new PathNotFoundError(abs);
    let gitRoot: string;
    try {
      gitRoot = execSync(`git -C "${abs}" rev-parse --show-toplevel`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new NotAGitRepoError(abs);
    }
    if (realpathSync(gitRoot) !== realpathSync(abs)) {
      throw new NotAGitRepoError(abs, gitRoot);
    }

    const graphDbPath = resolveCortexDbPath(abs);
    if (!existsSync(graphDbPath)) {
      throw new RepoNotIndexedError(abs, this.listKnownRepos());
    }
    const decisionsDbPath = resolveDecisionsDbPath(abs);

    const graphDb = new BetterSqlite3(graphDbPath);
    const decisionsDb = openDecisionsDb(decisionsDbPath);
    migrateDecisionsFromGraphDb(decisionsDb, graphDbPath);
    const store = new GraphStore(graphDb);
    const decisionsRepo = new DecisionsRepository(decisionsDb);
    const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);

    const ctx: RepoContext = Object.freeze({
      repoPath: abs,
      graphDb,
      decisionsDb,
      store,
      decisionsRepo,
      decisionLinksRepo,
    });
    this.pool.set(abs, ctx);
    return ctx;
  }

  /** Returns repos this resolver knows about. Stub for Task 1.7; expanded in Phase 4. */
  listKnownRepos(): AvailableProject[] {
    return [];
  }

  /** Closes all pooled DB handles. Call on server shutdown. */
  shutdown(): void {
    this.pool.shutdown();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: PASS — happy-path tests pass alongside the error-class tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-resolver.test.ts
git commit -m "feat(mcp): RepoContextResolver.resolve happy path with pool hit"
```

---

### Task 1.6: `RepoContextResolver.resolve` — error paths

**Files:**
- Modify: `tests/mcp-server/repo-context-resolver.test.ts`

The implementation already throws the right errors (Task 1.5). This task just adds the test coverage.

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/mcp-server/repo-context-resolver.test.ts
import { rmSync } from "node:fs";

describe("RepoContextResolver.resolve — error paths", () => {
  it("throws PathNotFoundError when path does not exist", () => {
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    expect(() => resolver.resolve("/nonexistent/path/abc")).toThrow(PathNotFoundError);
  });

  it("throws NotAGitRepoError when path is not a git root", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    expect(() => resolver.resolve(dir)).toThrow(NotAGitRepoError);
  });

  it("throws RepoNotIndexedError when .cortex/graph.db is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "unindexed-repo-"));
    execSync(`git init -q "${root}"`);
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      resolver.resolve(root);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RepoNotIndexedError);
      expect((e as RepoNotIndexedError).availableProjects).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes (implementation is already there)**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: PASS — all resolver tests green.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-server/repo-context-resolver.test.ts
git commit -m "test(mcp): RepoContextResolver error-path coverage"
```

---

### Task 1.7: `RepoContextResolver.listKnownRepos` — initial implementation

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Modify: `tests/mcp-server/repo-context-resolver.test.ts`

The full master-registry investigation is deferred to Phase 4 (an open question in the spec). For Phase 1, `listKnownRepos` returns the in-pool entries plus any repos visible via the existing `cortex index list_projects` path. Phase 4 replaces this with the authoritative registry read.

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/mcp-server/repo-context-resolver.test.ts
describe("RepoContextResolver.listKnownRepos", () => {
  it("returns pooled repos with indexed=true", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    resolver.resolve(repo);
    const list = resolver.listKnownRepos();
    const entry = list.find((p) => p.path === resolver.resolve(repo).repoPath);
    expect(entry).toBeDefined();
    expect(entry!.indexed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: FAIL — `listKnownRepos` returns `[]`.

- [ ] **Step 3: Update `listKnownRepos` to emit pooled repos**

```typescript
// Replace listKnownRepos in src/mcp-server/repo-context.ts:
/**
 * Returns repos this resolver knows about. Phase 1 only emits pooled
 * repos (those a tool call has touched in this server lifetime); Phase 4
 * extends this to read from the indexer's master project registry so
 * agents see every indexed repo, not just the active ones.
 */
listKnownRepos(): AvailableProject[] {
  const out: AvailableProject[] = [];
  for (const ctx of this.pool["map"].values()) {
    out.push({
      name: ctx.repoPath.replace(/^\//, "").replace(/\//g, "-"),
      path: ctx.repoPath,
      indexed: true,
    });
  }
  return out;
}
```

> Note: accessing `this.pool["map"]` is a temporary indexed access for Phase 1. Phase 4 redesigns this against the indexer's master registry and removes the access.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-resolver.test.ts
git commit -m "feat(mcp): listKnownRepos emits pooled repos (Phase 4 extends to master registry)"
```

---

### Task 1.8: `registerTool` — default mode

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Test: `tests/mcp-server/register-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server/register-tool.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerTool, MissingRepoPathError, RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeIndexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-repo-"));
  execSync(`git init -q "${root}"`);
  mkdirSync(join(root, ".cortex"));
  execSync(`touch "${join(root, ".cortex/graph.db")}"`);
  return root;
}

describe("registerTool — default (per-repo) mode", () => {
  const repo = makeIndexedRepo();
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  it("calls handler with (context, args) when repo_path is valid", async () => {
    const schema = z.object({ repo_path: z.string(), name: z.string() });
    let received: { ctxPath: string; name: string } | null = null;
    const wrapped = registerTool("noop_tool", schema, async (ctx, args) => {
      received = { ctxPath: ctx.repoPath, name: args.name };
      return { ok: true };
    }, { resolver });

    await wrapped({ repo_path: repo, name: "hello" });
    expect(received).toEqual({ ctxPath: repo, name: "hello" });
  });

  it("throws MissingRepoPathError when repo_path is absent", async () => {
    const schema = z.object({ repo_path: z.string(), name: z.string() });
    const wrapped = registerTool("noop_tool", schema, async () => ({ ok: true }), { resolver });
    await expect(wrapped({ name: "hello" } as any)).rejects.toThrow(MissingRepoPathError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/register-tool.test.ts`
Expected: FAIL — `registerTool` not exported.

- [ ] **Step 3: Implement `registerTool` default mode**

```typescript
// Append to src/mcp-server/repo-context.ts
import type { ZodSchema } from "zod";

/**
 * Wraps a tool handler so it receives a validated {@link RepoContext} instead
 * of doing its own per-call repo resolution. Two modes:
 *
 *   - Default (per-repo): handler signature `(ctx, args) => result`. The
 *     wrapper extracts `args.repo_path`, calls `resolver.resolve`, and
 *     passes `(ctx, args)` to the handler. If `repo_path` is missing,
 *     throws {@link MissingRepoPathError} before the handler runs.
 *
 *   - `crossRepo: true`: handler signature `(resolver, args) => result`.
 *     The wrapper skips resolution and hands the resolver to the handler
 *     for cross-repo work (list_projects, delete_project). Schemas for
 *     crossRepo tools should NOT include `repo_path`.
 *
 * If you're unsure which mode you want, the default is the right answer.
 *
 * @example default mode
 *   registerTool("create_decision", schema, async (ctx, args) => {
 *     return ctx.decisionsRepo.create(args);
 *   }, { resolver });
 *
 * @example crossRepo mode
 *   registerTool("list_projects", schema, async (resolver, _args) => {
 *     return resolver.listKnownRepos();
 *   }, { resolver, crossRepo: true });
 */
export function registerTool<A extends { repo_path?: string }>(
  name: string,
  schema: ZodSchema<A>,
  handler: (ctx: RepoContext, args: A) => Promise<unknown>,
  options: { resolver: RepoContextResolver; crossRepo?: false },
): (rawArgs: unknown) => Promise<unknown>;
export function registerTool<A>(
  name: string,
  schema: ZodSchema<A>,
  handler: (resolver: RepoContextResolver, args: A) => Promise<unknown>,
  options: { resolver: RepoContextResolver; crossRepo: true },
): (rawArgs: unknown) => Promise<unknown>;
export function registerTool<A>(
  name: string,
  schema: ZodSchema<A>,
  handler: any,
  options: { resolver: RepoContextResolver; crossRepo?: boolean },
): (rawArgs: unknown) => Promise<unknown> {
  return async (rawArgs: unknown) => {
    const args = schema.parse(rawArgs) as A & { repo_path?: string };
    if (options.crossRepo) {
      return handler(options.resolver, args);
    }
    if (!args.repo_path) {
      throw new MissingRepoPathError(name, options.resolver.listKnownRepos());
    }
    const ctx = options.resolver.resolve(args.repo_path);
    return handler(ctx, args);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/register-tool.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/register-tool.test.ts
git commit -m "feat(mcp): registerTool default per-repo wrapper"
```

---

### Task 1.9: `registerTool` — crossRepo mode

**Files:**
- Modify: `tests/mcp-server/register-tool.test.ts`

The implementation already supports crossRepo (Task 1.8). This task adds the contract test.

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/mcp-server/register-tool.test.ts
describe("registerTool — crossRepo mode", () => {
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  it("passes the resolver (not a context) to the handler and ignores repo_path", async () => {
    const schema = z.object({});
    let receivedResolver: RepoContextResolver | null = null;
    const wrapped = registerTool("list_projects", schema, async (r) => {
      receivedResolver = r;
      return [];
    }, { resolver, crossRepo: true });

    await wrapped({});
    expect(receivedResolver).toBe(resolver);
  });

  it("does NOT throw MissingRepoPathError when repo_path is absent", async () => {
    const schema = z.object({});
    const wrapped = registerTool("list_projects", schema, async () => [], { resolver, crossRepo: true });
    await expect(wrapped({})).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/register-tool.test.ts`
Expected: PASS — 4 tests total.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-server/register-tool.test.ts
git commit -m "test(mcp): registerTool crossRepo mode contract"
```

---

### Task 1.10: Phase 1 — server-level integration (no behavior change yet)

**Files:**
- Modify: `src/mcp-server/server.ts`

Add the resolver alongside the existing startup binding so both coexist. Tools haven't been migrated yet; the resolver exists but is unused. This task verifies the new code compiles into the server.

- [ ] **Step 1: Modify `createServer` to instantiate the resolver**

```typescript
// In src/mcp-server/server.ts, near the top of createServer, ADD (don't replace yet):
import { RepoContextResolver } from "./repo-context.js";

const resolver = new RepoContextResolver({ poolCapacity: 8 });
// Existing startup binding stays for now — phases 2-5 drain it.
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests still green; resolver is constructed but no tool uses it yet.

- [ ] **Step 3: Run tsc to confirm types**

Run: `npx tsc --noEmit -p .`
Expected: 0 errors related to repo-context.ts or server.ts.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/server.ts
git commit -m "feat(mcp): wire RepoContextResolver into createServer (unused this phase)"
```

---

## Phase 2 — Migrate decision tools

Migrate each decision tool to `registerTool`. **Task 2.1 (`create_decision`) is the full template.** Tasks 2.2–2.11 list per-tool specifics only.

---

### Task 2.1: Migrate `create_decision` (template)

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`
- Modify: `tests/mcp-contract/<create-decision contract test file>` (locate via `git grep create_decision tests/mcp-contract`)

- [ ] **Step 1: Locate the existing tool registration**

```bash
git grep -n 'create_decision' src/mcp-server/tools/decision-tools.ts
```
Note the function name (likely `createDecision` or `handleCreateDecision`) and how it currently constructs its DB handles. Today's pattern: receives `decisionsRepo` etc. via closure from `createServer`.

- [ ] **Step 2: Write the failing contract tests**

```typescript
// In the contract test file for create_decision, ADD two cases:
it("rejects when repo_path is missing", async () => {
  const result = await callTool("create_decision", {
    title: "x", description: "y", rationale: "z",
    // no repo_path
  });
  expect(result.isError).toBe(true);
  expect(result.error).toMatch(/repo_path required/);
});

it("routes to the passed repo_path, not the server's cwd", async () => {
  const repoA = makeIndexedRepoFixture();
  const repoB = makeIndexedRepoFixture();
  await callTool("create_decision", {
    repo_path: repoB,
    title: "scoped to B", description: "x", rationale: "y",
  });
  // Inspect both repos' decisions DBs:
  expect(countDecisions(repoA)).toBe(0);
  expect(countDecisions(repoB)).toBe(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/mcp-contract/<create-decision file>`
Expected: FAIL — current implementation ignores `repo_path` and uses the startup binding.

- [ ] **Step 4: Update the tool's schema to require `repo_path`**

```typescript
// In src/mcp-server/tools/decision-tools.ts, update the create_decision input schema:
const createDecisionSchema = z.object({
  repo_path: z.string().describe("Absolute path to the indexed git root this decision is about."),
  title: z.string(),
  description: z.string(),
  rationale: z.string(),
  // ... existing fields
});
```

- [ ] **Step 5: Update the handler to use `registerTool` and accept `(ctx, args)`**

```typescript
// Replace the existing registration call with:
server.tool(
  "create_decision",
  createDecisionSchema,
  registerTool(
    "create_decision",
    createDecisionSchema,
    async (ctx, args) => {
      // Body uses ctx.decisionsRepo / ctx.decisionLinksRepo instead of the
      // module-scope repos that were closed over before.
      const id = ctx.decisionsRepo.create({
        title: args.title,
        description: args.description,
        rationale: args.rationale,
        // ... preserve existing field mapping
      });
      // ... link writes use ctx.decisionLinksRepo
      return { id };
    },
    { resolver },
  ),
);
```

- [ ] **Step 6: Update the JSDoc on the handler**

```typescript
/**
 * Create a new decision in the repo addressed by `args.repo_path`.
 *
 * Migrated to receive a {@link RepoContext} from registerTool — the legacy
 * startup-bound module-scope repos are no longer used by this tool.
 */
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/mcp-contract/<create-decision file>`
Expected: PASS — both new cases + existing cases.

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — no other suite breaks.

- [ ] **Step 9: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts tests/mcp-contract/<file>
git commit -m "feat(mcp): migrate create_decision to per-call repo routing"
```

---

### Task 2.2: Migrate `propose_decision`

**Tool name:** `propose_decision`
**Schema additions:** `repo_path: z.string()` required.
**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`
- Modify: contract test file for propose_decision (locate via `git grep propose_decision tests/mcp-contract`)

Follow Task 2.1's steps 1–9 exactly, substituting `propose_decision` for `create_decision` and adapting the handler body to use `ctx.decisionsRepo.propose(...)` (the existing repository method).

Commit message: `feat(mcp): migrate propose_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9 with the substitutions above.

---

### Task 2.3: Migrate `supersede_decision`

**Tool name:** `supersede_decision`
**Schema additions:** `repo_path: z.string()` required.
**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`
- Modify: contract test file for supersede_decision.

Handler body uses `ctx.decisionsRepo.supersede(...)`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate supersede_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9 with the substitutions above.

---

### Task 2.4: Migrate `update_decision`

**Tool name:** `update_decision`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionsRepo.update(args.id, ...)`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate update_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.5: Migrate `delete_decision`

**Tool name:** `delete_decision`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionsRepo.delete(args.id)`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate delete_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.6: Migrate `get_decision`

**Tool name:** `get_decision`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionsRepo.get(args.id)` + `ctx.decisionLinksRepo.findByDecision(args.id)`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate get_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.7: Migrate `search_decisions`

**Tool name:** `search_decisions`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionsRepo.search(args.query, args.scope)`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate search_decisions to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.8: Migrate `why_was_this_built`

**Tool name:** `why_was_this_built`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionsRepo` + `ctx.decisionLinksRepo` to walk up file/qn hierarchy. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate why_was_this_built to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.9: Migrate `link_decision`

**Tool name:** `link_decision`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionLinksRepo.link(args.decision_id, args.target, args.relation)`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate link_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.10: Migrate `promote_decision`

**Tool name:** `promote_decision`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.decisionsRepo` (the MCP-side `DecisionPromotion` class). Note: the CLI `cortex decision promote` was deferred in a prior commit; this MCP migration is independent.

Commit message: `feat(mcp): migrate promote_decision to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

### Task 2.11: Migrate `decision_candidates`

**Tool name:** `decision_candidates`
**Schema additions:** `repo_path: z.string()` required.
Handler body calls the existing `frameCandidates({ repo_path: ctx.repoPath, ... })`. Note: this tool is already read-only and already takes `repo_path` conceptually — the migration just makes it pass through `registerTool` so the input is validated consistently.

Commit message: `feat(mcp): migrate decision_candidates to per-call repo routing`

- [ ] Complete Task 2.1's steps 1–9.

---

## Phase 3 — Migrate code/graph tools

Same template as Phase 2. Each task migrates one tool.

---

### Task 3.1: Migrate `search_graph`

**Tool name:** `search_graph`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.store` (the GraphStore scoped to this repo). Follow Task 2.1 steps 1–9, substituting "store" for "decisionsRepo" in step 5's example.

Commit message: `feat(mcp): migrate search_graph to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.2: Migrate `get_code_snippet`

**Tool name:** `get_code_snippet`
**Schema additions:** `repo_path: z.string()` required.
Handler body uses `ctx.store`. Follow Task 2.1 steps 1–9.

Commit message: `feat(mcp): migrate get_code_snippet to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.3: Migrate `trace_path`

**Tool name:** `trace_path`
**Schema additions:** `repo_path: z.string()` required.

Commit message: `feat(mcp): migrate trace_path to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.4: Migrate `search_code`

**Tool name:** `search_code`
**Schema additions:** `repo_path: z.string()` required.

This tool has additional importance: the Field Report observed it falling through to a plain `grep -rn .` when project resolution failed. After migration, the grep fallback should still resolve relative to `ctx.repoPath`, not `process.cwd()`. Verify in step 5 that the shell-out target uses `ctx.repoPath`.

Commit message: `feat(mcp): migrate search_code to per-call repo routing (fixes grep fallthrough cwd)`

- [ ] Complete the migration.

---

### Task 3.5: Migrate `query_graph`

**Tool name:** `query_graph`
**Schema additions:** `repo_path: z.string()` required.

This tool already accepts an optional `project` (project name) argument. Keep it. The `repo_path` is the routing signal (which graph.db to open); `project` is a filter inside that graph. Document this distinction in the JSDoc.

Commit message: `feat(mcp): migrate query_graph to per-call repo routing (project param retained)`

- [ ] Complete the migration.

---

### Task 3.6: Migrate `get_architecture`

**Tool name:** `get_architecture`
**Schema additions:** `repo_path: z.string()` required (replaces the existing `project` param semantics; keep `project` as a no-op alias if removing it would break callers — flag in PR for review).

Commit message: `feat(mcp): migrate get_architecture to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.7: Migrate `index_status`

**Tool name:** `index_status`
**Schema additions:** `repo_path: z.string()` required (replaces or supplements the existing `path` arg — flag for review).

Commit message: `feat(mcp): migrate index_status to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.8: Migrate `index_repository`

**Tool name:** `index_repository`
**Schema additions:** `repo_path: z.string()` required.

This tool is special: it CREATES the index. The resolver expects `.cortex/graph.db` to already exist; this tool is what makes that true. Add an `allowUnindexed: true` option to `registerTool` for this specific tool, OR have the tool's handler skip the resolver and read `args.repo_path` directly (an exception to the pattern, justified in the JSDoc).

Recommended: extend `registerTool` with an `allowUnindexed` option in this task (small change to repo-context.ts), then use it here.

Commit message: `feat(mcp): migrate index_repository with allowUnindexed bypass`

- [ ] Complete the migration plus the `allowUnindexed` extension.

---

### Task 3.9: Migrate `detect_changes`

**Tool name:** `detect_changes`
**Schema additions:** `repo_path: z.string()` required.

Commit message: `feat(mcp): migrate detect_changes to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.10: Migrate `get_graph_schema`

**Tool name:** `get_graph_schema`
**Schema additions:** `repo_path: z.string()` required.

Commit message: `feat(mcp): migrate get_graph_schema to per-call repo routing`

- [ ] Complete the migration.

---

### Task 3.11: Migrate `ingest_traces` and any remaining per-repo tools

**Tool name(s):** `ingest_traces`, plus any per-repo tools surfaced by `git grep 'server.tool(' src/mcp-server/`.

Per the deferred-tool list visible in this session there is also `add_pr_touch`, `get_pr`, `merge_pr`, `open_pr` — verify whether these are per-repo or cross-repo and apply Phase 2's template or Phase 4's pattern as appropriate.

Commit message: `feat(mcp): migrate ingest_traces (+ PR tools) to per-call repo routing`

- [ ] Audit remaining tools and complete migrations.

---

## Phase 4 — Cross-repo tools

These tools opt out of resolver routing via `crossRepo: true` and read from the indexer's master project registry.

---

### Task 4.1: Locate the indexer's master project registry

**Files:** investigation only; produce notes in a temporary doc.

This is the **open investigation #1** from the spec. The Field Report shows the indexer knows about 10 projects globally while `list_projects` returns only 1. Find where the master list lives.

- [ ] **Step 1: Search for known-project storage**

```bash
git grep -ln 'list_projects\|available_projects\|known_projects\|project_registry' src/
```

- [ ] **Step 2: Read each hit and identify the source of truth**

Possible candidates: (1) a manifest file under `~/.cache/cortex-indexer/`, (2) a column or table in the indexer's graph DB, (3) a CLI-managed registry. Read enough to confirm which.

- [ ] **Step 3: Document findings inline**

Write a short note at the top of `src/mcp-server/repo-context.ts` (JSDoc on `listKnownRepos`) describing where the master registry lives and the read interface. This unblocks Task 4.2.

- [ ] **Step 4: Commit the doc-only change**

```bash
git add src/mcp-server/repo-context.ts
git commit -m "docs(mcp): document master project registry source for crossRepo tools"
```

---

### Task 4.2: Implement `RepoContextResolver.listKnownRepos` against the master registry

**Files:**
- Modify: `src/mcp-server/repo-context.ts`
- Modify: `tests/mcp-server/repo-context-resolver.test.ts`

- [ ] **Step 1: Update the failing test from Task 1.7**

Modify the test to assert that `listKnownRepos` returns repos visible to the indexer's master registry, not just pooled ones.

- [ ] **Step 2: Replace the Phase-1 stub implementation**

Use the read interface documented in Task 4.1.

- [ ] **Step 3: Remove the `this.pool["map"]` temporary access from Task 1.7**

- [ ] **Step 4: Run resolver tests**

Run: `npx vitest run tests/mcp-server/repo-context-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/repo-context.ts tests/mcp-server/repo-context-resolver.test.ts
git commit -m "feat(mcp): listKnownRepos reads master project registry"
```

---

### Task 4.3: Migrate `list_projects` to crossRepo mode

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (or wherever list_projects lives — locate via `git grep`)
- Modify: contract test for list_projects

- [ ] **Step 1: Write the failing test**

```typescript
it("returns EVERY indexed repo, not just the server's cwd", async () => {
  const repoA = makeIndexedRepoFixture();
  const repoB = makeIndexedRepoFixture();
  // Register both in the master registry (use the read/write path discovered in 4.1).
  const result = await callTool("list_projects", {});
  const paths = result.map((p: any) => p.path);
  expect(paths).toContain(repoA);
  expect(paths).toContain(repoB);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Migrate `list_projects` via `registerTool` with `crossRepo: true`**

```typescript
server.tool(
  "list_projects",
  listProjectsSchema,
  registerTool(
    "list_projects",
    listProjectsSchema,
    async (resolver, _args) => resolver.listKnownRepos(),
    { resolver, crossRepo: true },
  ),
);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS — list_projects now returns all indexed repos.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/<file>.ts tests/mcp-contract/<file>
git commit -m "feat(mcp): list_projects returns every indexed repo (closes Field Report rec #1)"
```

---

### Task 4.4: Migrate `delete_project` to crossRepo mode

**Tool name:** `delete_project`
**Cross-repo rationale:** the target repo may already be gone from disk; routing by `repo_path` (which the resolver would validate as a live git root) doesn't fit. Keep `project` as the identifier.

- [ ] Migrate via `registerTool` with `crossRepo: true`. Handler reads from the master registry, executes the delete, returns confirmation. Add the cross-repo contract test. Commit.

---

## Phase 5 — Remove the startup binding

After every per-repo tool routes through `registerTool` and every cross-repo tool opts out, the old `createServer(repoPath)` parameter has no remaining readers. Remove it.

---

### Task 5.1: Add the regression test (must fail against current main, pass after this phase)

**Files:**
- Test: `tests/regression/decisions-cross-repo-isolation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp-server/server.js";
// ... fixture helpers

describe("regression: decisions don't leak across repos", () => {
  it("create_decision({ repo_path: B }) writes to B, never to A", async () => {
    const repoA = makeIndexedRepoFixture();
    const repoB = makeIndexedRepoFixture();

    // Construct an MCP server with no cwd binding (post-Phase-5 signature).
    const server = createServer();
    // Drive a create_decision call against repoB through the tool dispatcher.
    await dispatchTool(server, "create_decision", {
      repo_path: repoB,
      title: "scoped to B",
      description: "x",
      rationale: "y",
    });

    expect(countDecisions(repoA)).toBe(0);
    expect(countDecisions(repoB)).toBe(1);
  });
});
```

- [ ] **Step 2: Run on current `main` to confirm it FAILS**

Run: `git stash; git checkout main; npx vitest run tests/regression/decisions-cross-repo-isolation.test.ts; git checkout -; git stash pop`
Expected: FAIL — proves the regression test catches the bug.

- [ ] **Step 3: Run on the branch to confirm it PASSES**

Run: `npx vitest run tests/regression/decisions-cross-repo-isolation.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/regression/decisions-cross-repo-isolation.test.ts
git commit -m "test(regression): decisions don't leak across repos in MCP"
```

---

### Task 5.2: Remove the `repoPath` parameter from `createServer`

**Files:**
- Modify: `src/mcp-server/server.ts`
- Modify: `src/index.ts` (server entrypoint)

- [ ] **Step 1: Remove `repoPath` from the createServer signature and its body**

```typescript
// src/mcp-server/server.ts
export function createServer(bus?: EventBus, options?: ServerOptions): McpServer {
  // No more decisionsDbPath / graphDbPath / decisionsDb at module scope.
  const resolver = new RepoContextResolver({ poolCapacity: 8 });
  // All tool registrations use registerTool(..., { resolver }).
  // Cross-repo tools use crossRepo: true.
  // ... existing tool registration logic, now resolver-driven.
}
```

- [ ] **Step 2: Update `src/index.ts` to drop the `process.cwd()` argument**

```typescript
// src/index.ts (or wherever createServer is invoked)
const server = createServer(bus);
```

- [ ] **Step 3: Update any other callers**

Run `git grep 'createServer(' src tests` and update each call site to the new signature.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS — every test green, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/server.ts src/index.ts
git commit -m "feat(mcp): remove startup repoPath binding — per-call routing is the only path"
```

---

## Phase 6 — `cortex decision rehome` CLI verb

---

### Task 6.1: Failing test — happy path

**Files:**
- Test: `tests/cli/commands/decision-rehome.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Use whatever fixture helpers existing CLI tests use for indexed-repo setup.

describe("cortex decision rehome — happy path", () => {
  it("moves a decision from source repo to target repo, preserving id and links", () => {
    const source = makeIndexedRepoFixture();
    const target = makeIndexedRepoFixture();
    const id = createDecisionInRepo(source, { title: "x", description: "y", rationale: "z" });
    linkDecision(source, id, "src/auth.ts", "GOVERNS");

    execSync(`cd "${source}" && cortex decision rehome ${id} --to=${target}`);

    expect(getDecisionFromRepo(source, id)).toBeUndefined();
    const moved = getDecisionFromRepo(target, id);
    expect(moved).toBeDefined();
    expect(moved!.title).toBe("x");
    expect(getDecisionLinks(target, id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/commands/decision-rehome.test.ts`
Expected: FAIL — verb doesn't exist.

---

### Task 6.2: Implement the `rehome` command

**Files:**
- Create: `src/cli/commands/decision-rehome.ts`
- Modify: `src/cli/commands/decision.ts` (route the `rehome` verb)
- Modify: `src/cli/help.ts` (add `rehome` row to the decision namespace)

- [ ] **Step 1: Implement `decision-rehome.ts`**

```typescript
// src/cli/commands/decision-rehome.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDecisionsDbPath } from "../../db/resolve-path.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { UsageError, EnvironmentError } from "../errors.js";
import type { DecisionCommand, ProjectContext } from "../types.js";

/**
 * Move a single decision (row + all decision_links) from the source repo
 * (current cwd's git root) into the target repo (--to=<repo_path>).
 *
 * No cross-file transaction is possible — two separate SQLite files. We
 * insert into target first, verify, then delete from source. If insert
 * fails, source is untouched. If delete fails after insert succeeded, the
 * decision exists in both DBs and we surface a RehomePartialError with the
 * exact DELETE the user can re-run.
 *
 * Cross-decision references (related_decisions, depends_on, superseded_by)
 * pointing to the moved id from other decisions in the source DB are left
 * dangling and emitted as a non-blocking warning. Fixing them is out of
 * scope; the warning is the contract.
 *
 * See docs/superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md
 * for the design rationale.
 */
export function cmdRehome(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  const targetPath = typeof cmd.flags["to"] === "string" ? cmd.flags["to"] : undefined;
  const dryRun = cmd.flags["dry-run"] === true;

  if (!id) throw new UsageError("rehome requires a decision id", "cortex decision rehome <id> --to=<repo_path>");
  if (!targetPath) throw new UsageError("rehome requires --to=<repo_path>", "Example: cortex decision rehome abc --to=/path/to/repo");

  // Source resolution: current cwd → git root → decisions DB.
  if (ctx.state === "no-project") {
    throw new EnvironmentError("rehome requires a git repository", "cd into the source repo first");
  }
  const sourceDbPath = resolveDecisionsDbPath(ctx.gitRoot ?? ctx.cwd);
  const sourceDb = openDecisionsDb(sourceDbPath);
  const sourceRepo = new DecisionsRepository(sourceDb);
  const sourceLinks = new DecisionLinksRepository(sourceDb);

  const decision = sourceRepo.get(id);
  if (!decision) {
    throw new UsageError(
      `no decision '${id}' in source repo (${ctx.gitRoot ?? ctx.cwd})`,
      "Check with: cortex decision list",
    );
  }
  const links = sourceLinks.findByDecision(id);

  // Target resolution + validation.
  const targetGraphDb = join(targetPath, ".cortex/graph.db");
  if (!existsSync(targetGraphDb)) {
    throw new EnvironmentError(
      `target '${targetPath}' isn't indexed; no .cortex/graph.db found`,
      `Run: cortex index repository --path=${targetPath}`,
    );
  }
  const targetDbPath = resolveDecisionsDbPath(targetPath);
  const targetDb = openDecisionsDb(targetDbPath);
  const targetRepo = new DecisionsRepository(targetDb);

  if (targetRepo.get(id)) {
    throw new UsageError(
      `'${id}' already exists in target repo`,
      "Use 'cortex decision update' there if you want to modify it.",
    );
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      would_move: { id, title: decision.title, link_count: links.length },
      from: ctx.gitRoot ?? ctx.cwd,
      to: targetPath,
    }, null, 2) + "\n");
    return;
  }

  // Insert into target in a transaction.
  const targetLinks = new DecisionLinksRepository(targetDb);
  targetDb.transaction(() => {
    targetRepo.insertRaw(decision);
    for (const link of links) targetLinks.insertRaw(link);
  })();
  // Verify.
  if (!targetRepo.get(id)) {
    throw new Error(`rehome: insert into target succeeded but verification failed`);
  }

  // Delete from source. If this fails after insert succeeded, the partial-state
  // is the user's to clean up — we surface the exact DELETE.
  try {
    sourceDb.transaction(() => {
      sourceLinks.deleteByDecision(id);
      sourceRepo.delete(id);
    })();
  } catch (e) {
    throw new Error(
      `rehome: target insert OK but source delete FAILED for ${id}.\n` +
      `Run manually in the source repo: sqlite3 ${sourceDbPath} "DELETE FROM decision_links WHERE decision_id='${id}'; DELETE FROM decisions WHERE id='${id}';"\n` +
      `Underlying error: ${(e as Error).message}`,
    );
  }

  // Dangling-reference warning (non-blocking).
  const dangling = sourceLinks.findReferencesTo(id);
  if (dangling.length > 0) {
    process.stderr.write(`WARNING: ${dangling.length} cross-decision reference(s) in source DB now dangle: ${dangling.map(d => d.decision_id).join(", ")}\n`);
  }

  process.stdout.write(`Moved ${id} from ${ctx.gitRoot ?? ctx.cwd} → ${targetPath} (${links.length} links).\n`);
}
```

- [ ] **Step 2: Wire `rehome` into the decision command router**

```typescript
// In src/cli/commands/decision.ts, in the switch statement (near case "promote"):
import { cmdRehome } from "./decision-rehome.js";

// ...
case "rehome":    return cmdRehome(cmd, ctx);
```

- [ ] **Step 3: Add the help entry**

```typescript
// In src/cli/help.ts, decision namespace:
rehome: {
  usage: "cortex decision rehome <id> --to=<repo_path> [--dry-run]",
  description: "Move a decision (row + links) to another repo's .cortex/decisions.db.",
  examples: ["cortex decision rehome abc-123 --to=/Users/rka/Development/anthill-cloud-sales"],
},
```

- [ ] **Step 4: Confirm the `insertRaw` / `deleteByDecision` / `findReferencesTo` methods exist on the repositories**

```bash
git grep -n 'insertRaw\|deleteByDecision\|findReferencesTo' src/decisions/
```

If any are missing, add them (with TDD: failing test for each, then implementation). They are minimal helpers — `insertRaw` takes a decision row and writes it verbatim preserving `id`/timestamps; `deleteByDecision(id)` removes all `decision_links` rows for an id; `findReferencesTo(id)` returns links pointing at the id from other decisions.

- [ ] **Step 5: Run the rehome test**

Run: `npx vitest run tests/cli/commands/decision-rehome.test.ts`
Expected: PASS — the happy path from Task 6.1.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/decision-rehome.ts src/cli/commands/decision.ts src/cli/help.ts tests/cli/commands/decision-rehome.test.ts
git commit -m "feat(cli): cortex decision rehome <id> --to=<repo_path>"
```

---

### Task 6.3: Error-path tests for `rehome`

**Files:**
- Modify: `tests/cli/commands/decision-rehome.test.ts`

- [ ] **Step 1: Add tests for each error condition**

```typescript
it("errors when id is not in source repo", () => {
  const source = makeIndexedRepoFixture();
  const target = makeIndexedRepoFixture();
  expect(() => execSync(`cd "${source}" && cortex decision rehome nonexistent-id --to=${target}`))
    .toThrow(/no decision 'nonexistent-id'/);
});

it("errors when id already exists in target repo", () => {
  const source = makeIndexedRepoFixture();
  const target = makeIndexedRepoFixture();
  const id = createDecisionInRepo(source, { title: "x", description: "y", rationale: "z" });
  createDecisionInRepo(target, { title: "preexisting", description: "y", rationale: "z" }, { id });
  expect(() => execSync(`cd "${source}" && cortex decision rehome ${id} --to=${target}`))
    .toThrow(/already exists in target/);
});

it("errors when target repo is not indexed", () => {
  const source = makeIndexedRepoFixture();
  const unindexed = mkdtempSync(join(tmpdir(), "unindexed-"));
  execSync(`git init -q "${unindexed}"`);
  const id = createDecisionInRepo(source, { title: "x", description: "y", rationale: "z" });
  expect(() => execSync(`cd "${source}" && cortex decision rehome ${id} --to=${unindexed}`))
    .toThrow(/isn't indexed/);
});

it("--dry-run prints the move plan without modifying either DB", () => {
  const source = makeIndexedRepoFixture();
  const target = makeIndexedRepoFixture();
  const id = createDecisionInRepo(source, { title: "x", description: "y", rationale: "z" });
  execSync(`cd "${source}" && cortex decision rehome ${id} --to=${target} --dry-run`);
  expect(getDecisionFromRepo(source, id)).toBeDefined();
  expect(getDecisionFromRepo(target, id)).toBeUndefined();
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/cli/commands/decision-rehome.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 3: Commit**

```bash
git add tests/cli/commands/decision-rehome.test.ts
git commit -m "test(cli): error-path coverage for decision rehome"
```

---

## Phase 7 — Agent-facing docs

---

### Task 7.1: Update CLAUDE.md with the routing contract

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a new section after "Tool routing"**

Add a section titled `## MCP tool routing — always pass repo_path` that:
- States the contract: every cortex MCP tool except `list_projects` / `delete_project` requires `repo_path` (absolute git root).
- Shows the SessionStart banner field that holds the current repo path.
- Notes that for multi-repo work, the agent should pass the explicit path of the repo the call is about — *not* always the cwd repo.
- Shows the error shape (`MissingRepoPath` / `RepoNotIndexed`) and the `available_projects` payload agents can use to recover.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: agent-facing MCP routing contract"
```

---

### Task 7.2: Update the SessionStart hook to print the repo absolute path

**Files:**
- Modify: `hooks/check-index.sh`

- [ ] **Step 1: Add the repo absolute path to the banner**

The banner today prints `Repo: <project-name>`. Update it to also print the absolute path on its own line so the agent has it ready to paste into `repo_path`.

```bash
# Inside hooks/check-index.sh, near the "=== Cortex routing for this session ===" header:
echo "Repo path: $(git rev-parse --show-toplevel 2>/dev/null || echo unknown)"
```

- [ ] **Step 2: Commit**

```bash
git add hooks/check-index.sh
git commit -m "feat(hooks): print repo absolute path in SessionStart banner"
```

---

## Phase 8 — Close out HANDOFF entries

---

### Task 8.1: Strike Gap 3 from HANDOFF_DECISIONS.md and update Gap 4

**Files:**
- Modify: `HANDOFF_DECISIONS.md`

- [ ] **Step 1: Mark Gap 2 (the original framing of the routing bug) as resolved**

Replace the Gap 2 section with a one-paragraph "RESOLVED 2026-06-XX (this branch)" note pointing at the spec, the plan, and the regression test.

- [ ] **Step 2: Update Gap 1 status if appropriate**

If the rehome verb partially addresses the broader "wire promote" question (it doesn't, but related cleanup did), note that. Otherwise leave Gap 1 alone.

- [ ] **Step 3: Update Question 4 (migration / hygiene)**

Note that the `cortex decision rehome` verb is the canonical mechanism for re-homing the 14+ historical mis-routed decisions, and that the spot-check workflow remains a human task.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF_DECISIONS.md
git commit -m "docs: close HANDOFF_DECISIONS Gap 2; document rehome workflow in Q4"
```

---

### Task 8.2: Final integration sanity

**Files:** none.

- [ ] **Step 1: Run the full test suite from a clean state**

Run: `npx vitest run`
Expected: PASS — all suites green, including the regression test.

- [ ] **Step 2: Run tsc**

Run: `npx tsc --noEmit -p .`
Expected: 0 errors.

- [ ] **Step 3: Confirm the CLI still works**

Run: `cortex decision --help`
Expected: shows the `rehome` row; does NOT show the previously-removed `promote` row.

Run: `cortex index status`
Expected: standard output, no errors.

- [ ] **Step 4: Final commit (if any cleanup needed; otherwise this task is complete without a commit)**

---

## Self-review checklist (run before handing off)

- Every spec section maps to at least one task above. Phases 1–8 cover Components, Data flow, Error taxonomy, Testing, CLI rehome, Migration phases, Open investigations.
- No placeholders: `git grep -n 'TBD\|TODO\|implement later' docs/superpowers/plans/2026-06-04-mcp-multi-project-routing.md` returns nothing.
- Type names referenced in later tasks match earlier definitions: `RepoContext`, `RepoContextResolver`, `RepoContextPool`, `registerTool`, `MissingRepoPathError`, `PathNotFoundError`, `NotAGitRepoError`, `RepoNotIndexedError`, `AvailableProject`.
- Spec's three Open Investigations are surfaced where the plan needs them: master registry (Task 4.1), GraphStore repo-scoping (Task 1.5 introduces per-context construction), lazy-migration race (already idempotent per `schema_meta`; flagged in Task 1.5 JSDoc).
