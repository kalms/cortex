import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepoContextResolver,
  RepoNotIndexedError,
  WorktreeIndexPendingError,
} from "../../src/mcp-server/repo-context.js";
import { GraphStore } from "../../src/graph/store.js";

let base: string, main: string, wt: string;
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] });

// Seed via GraphStore (not raw SQL) so the schema matches what
// GraphStore.migrate() expects — a hand-rolled minimal `nodes` table
// conflicts with the real CREATE_INDEXES (e.g. `idx_nodes_name`), same as
// the established pattern in repo-context-canonical.test.ts.
function seedDb(root: string) {
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const store = new GraphStore(join(root, ".cortex", "db"));
  store.createNode({ kind: "file", name: "a.txt" });
  store.close();
}

/**
 * Run `fn` with CORTEX_AUTO_INDEX disabled. resolve() on a checkout with no
 * store kicks a REAL detached `cortex index` (see kickBackgroundIndex in
 * repo-context.ts) unless this is set — tests that assert the thrown error
 * SHAPE (not the self-healing kick itself) must not spawn a real indexer
 * against a scratch fixture. The in-flight test below sidesteps this by
 * pre-seeding a fresh sentinel, which short-circuits before the spawn branch.
 */
function withAutoIndexDisabled<T>(fn: () => T): T {
  const prev = process.env.CORTEX_AUTO_INDEX;
  process.env.CORTEX_AUTO_INDEX = "0";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CORTEX_AUTO_INDEX;
    else process.env.CORTEX_AUTO_INDEX = prev;
  }
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-ckaxis-")));
  main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.email", "t@t.t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", "-A");
  git(main, "commit", "-m", "init");
  wt = join(base, "wt");
  git(main, "worktree", "add", "-b", "feature/x", wt);
  seedDb(main);
  seedDb(wt);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("resolve() on the checkout axis", () => {
  it("reports the WORKTREE as repoPath and reads its own store", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = r.resolve(wt);
    expect(ctx.repoPath).toBe(wt);
    expect(ctx.graphDbPath).toBe(join(wt, ".cortex", "db"));
    expect(ctx.worktreeOf).toBe(main);
  });

  it("does NOT share a pool entry between a worktree and its main checkout", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    expect(r.resolve(wt).graphDbPath).not.toBe(r.resolve(main).graphDbPath);
  });

  it("worktreeOf is null for a main checkout", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    expect(r.resolve(main).worktreeOf).toBeNull();
  });
});

/**
 * Strict reads: the Stage 1 cross-checkout fallback is gone. A checkout with
 * no store of its own is refused, never silently served from its canonical
 * repo's graph — even though `main` here is fully indexed. `RepoContext` no
 * longer carries a `servedFrom` field (it existed only to flag that now-
 * removed fallback firing); the refusal itself is the signal now.
 */
describe("resolve() refuses to serve canonical for an unindexed worktree", () => {
  it("refuses to serve canonical for an unindexed worktree", () => {
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    withAutoIndexDisabled(() => {
      const r = new RepoContextResolver({ poolCapacity: 4 });
      expect(() => r.resolve(wt)).toThrow(/not indexed/i);
    });
    seedDb(wt);
  });

  it("names the worktree, its branch, and its canonical parent in the error", () => {
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    withAutoIndexDisabled(() => {
      const r = new RepoContextResolver({ poolCapacity: 4 });
      try {
        r.resolve(wt);
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e).toBeInstanceOf(RepoNotIndexedError);
        expect(e.path).toBe(wt);
        expect(e.branch).toBe("feature/x");
        expect(e.canonical).toBe(main);
      }
    });
    seedDb(wt);
  });

  it("raises WorktreeIndexPendingError while a background index is in flight", () => {
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    mkdirSync(join(wt, ".cortex"), { recursive: true });
    writeFileSync(join(wt, ".cortex", ".auto-index-attempted"), "");
    const r = new RepoContextResolver({ poolCapacity: 4 });
    expect(() => r.resolve(wt)).toThrow(WorktreeIndexPendingError);
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    seedDb(wt);
  });
});

/**
 * Regression — finding 5 (historical): a PREFIX test on the canonical path
 * (`graphDbPath.startsWith(worktreeOf + "/")`) used to mislabel a worktree
 * living INSIDE its main checkout as `servedFrom: "canonical"` even when it
 * was serving its own store, because `/repo/wt/.cortex/db` starts with
 * `/repo/` regardless. That comparison — and the `servedFrom` field it fed —
 * is gone under strict reads; this suite now just confirms a nested worktree
 * still resolves to (and refuses to leave) its own checkout root.
 */
describe("strict reads with a worktree nested inside its main checkout", () => {
  let nestBase: string, nestMain: string, nestWt: string;

  beforeAll(() => {
    nestBase = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nested-")));
    nestMain = join(nestBase, "main");
    mkdirSync(nestMain);
    git(nestMain, "init", "-b", "main");
    git(nestMain, "config", "user.email", "t@t.t");
    git(nestMain, "config", "user.name", "t");
    writeFileSync(join(nestMain, "a.txt"), "a");
    git(nestMain, "add", "-A");
    git(nestMain, "commit", "-m", "init");
    nestWt = join(nestMain, "wt"); // INSIDE the main checkout
    git(nestMain, "worktree", "add", "-b", "feature/nested", nestWt);
    seedDb(nestMain);
    seedDb(nestWt);
  });

  afterAll(() => rmSync(nestBase, { recursive: true, force: true }));

  it("resolves to its own store when the nested worktree has an index", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = r.resolve(nestWt);
    expect(ctx.graphDbPath).toBe(join(nestWt, ".cortex", "db"));
    expect(ctx.worktreeOf).toBe(nestMain);
  });

  it("throws (never falls back to the canonical parent) when the nested worktree has no store", () => {
    rmSync(join(nestWt, ".cortex"), { recursive: true, force: true });
    withAutoIndexDisabled(() => {
      const r = new RepoContextResolver({ poolCapacity: 4 });
      expect(() => r.resolve(nestWt)).toThrow(RepoNotIndexedError);
    });
    seedDb(nestWt);
  });
});
