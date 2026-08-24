/**
 * Regression — finding 1(a): the server bootstrap's `ctx_projects` lookup must
 * key on the CHECKOUT axis, the same axis the bound store path is derived on.
 *
 * A linked worktree's own `.cortex/db` holds a `ctx_projects` row keyed by the
 * WORKTREE path. Looking it up with the identity axis (`canonicalRepoPath`,
 * i.e. the main checkout) never matches, and the server comes up with no bound
 * project at all: "(no projects)" in the viewer dropdown, a null
 * `/api/projects.active`, and an empty `hello.project_id`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { resolveBoundProject } from "../../src/mcp-server/bound-project.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] });

let base: string;
let main: string;
let wt: string;

/** Seed a checkout's own store with the `ctx_projects` row the indexer writes
 *  for it — keyed by that checkout's own root_path. */
function seedProject(root: string, name: string): void {
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const db = new BetterSqlite3(join(root, ".cortex", "db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS ctx_projects (name TEXT PRIMARY KEY, root_path TEXT, indexed_at TEXT)",
  );
  db.prepare("INSERT OR REPLACE INTO ctx_projects VALUES (?, ?, ?)").run(
    name,
    root,
    new Date().toISOString(),
  );
  db.close();
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-bound-")));
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
  seedProject(main, "main-project");
  seedProject(wt, "wt-project");
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("resolveBoundProject — checkout axis", () => {
  it("finds the WORKTREE's own project in the worktree's own store", () => {
    const store = new GraphStore(join(wt, ".cortex", "db"));
    try {
      const bound = resolveBoundProject(store, wt);
      expect(bound.root).toBe(wt);
      expect(bound.project).toBe("wt-project");
    } finally {
      store.close();
    }
  });

  it("still finds a main checkout's project", () => {
    const store = new GraphStore(join(main, ".cortex", "db"));
    try {
      const bound = resolveBoundProject(store, main);
      expect(bound.root).toBe(main);
      expect(bound.project).toBe("main-project");
    } finally {
      store.close();
    }
  });

  it("collapses a subdirectory onto its enclosing checkout (T-119 anti-orphan)", () => {
    const sub = join(main, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const store = new GraphStore(join(main, ".cortex", "db"));
    try {
      const bound = resolveBoundProject(store, sub);
      expect(bound.root).toBe(main);
      expect(bound.project).toBe("main-project");
    } finally {
      store.close();
    }
  });

  it("reports noIndexerState (not a throw) when ctx_projects does not exist yet", () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "cortex-bound-fresh-")));
    try {
      git(fresh, "init", "-b", "main");
      mkdirSync(join(fresh, ".cortex"), { recursive: true });
      const store = new GraphStore(join(fresh, ".cortex", "db"));
      try {
        const bound = resolveBoundProject(store, fresh);
        expect(bound.project).toBeNull();
        expect(bound.noIndexerState).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
