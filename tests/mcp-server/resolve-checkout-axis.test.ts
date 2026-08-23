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
