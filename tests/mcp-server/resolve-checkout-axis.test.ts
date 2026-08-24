import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
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
    expect(ctx.servedFrom).toBe("checkout");
  });

  it("does NOT share a pool entry between a worktree and its main checkout", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    expect(r.resolve(wt).graphDbPath).not.toBe(r.resolve(main).graphDbPath);
  });

  it("worktreeOf is null for a main checkout", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    expect(r.resolve(main).worktreeOf).toBeNull();
  });

  it("marks servedFrom=canonical when the worktree has no store of its own", () => {
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    const r = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = r.resolve(wt);
    expect(ctx.graphDbPath).toBe(join(main, ".cortex", "db"));
    expect(ctx.servedFrom).toBe("canonical");
    seedDb(wt);
  });
});

/**
 * Regression — finding 5: `servedFrom` must not mislabel a worktree that lives
 * INSIDE its main checkout. A prefix test (`graphDbPath.startsWith(worktreeOf
 * + "/")`) is true for `/repo/wt/.cortex/db` simply because the parent's path
 * is a prefix, so a nested worktree serving its OWN store was reported as
 * `servedFrom: "canonical"` — telling the caller the answer describes another
 * branch when it does not.
 */
describe("servedFrom with a worktree nested inside its main checkout", () => {
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

  it("reports servedFrom=checkout when the nested worktree serves its own store", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = r.resolve(nestWt);
    expect(ctx.graphDbPath).toBe(join(nestWt, ".cortex", "db"));
    expect(ctx.worktreeOf).toBe(nestMain);
    expect(ctx.servedFrom).toBe("checkout");
  });

  it("still reports servedFrom=canonical when the nested worktree has no store", () => {
    rmSync(join(nestWt, ".cortex"), { recursive: true, force: true });
    const r = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = r.resolve(nestWt);
    expect(ctx.graphDbPath).toBe(join(nestMain, ".cortex", "db"));
    expect(ctx.servedFrom).toBe("canonical");
    seedDb(nestWt);
  });
});
