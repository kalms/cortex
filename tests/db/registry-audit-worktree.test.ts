import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOrphanEntry } from "../../src/db/registry-audit.js";

// fixture: main checkout + linked worktree, as Task 1

let base: string, main: string, wt: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-aud-wt-")));
  main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.email", "t@t.t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", "-A");
  git(main, "commit", "-m", "init");
  wt = join(base, "wt");
  git(main, "worktree", "add", "-b", "feature/carve-out", wt);
});

afterAll(() => {
  try {
    git(main, "worktree", "remove", "--force", wt);
  } catch {
    // best-effort — fall through to the raw rmSync sweep below regardless
  }
  rmSync(base, { recursive: true, force: true });
});

describe("orphan carve-out for checkout entries", () => {
  it("a worktree row WITH its own store is not an orphan", () => {
    mkdirSync(join(wt, ".cortex"), { recursive: true });
    writeFileSync(join(wt, ".cortex", "db"), "x");
    expect(isOrphanEntry({ name: "w", root_path: wt, worktree_of: main })).toBe(false);
  });

  it("a worktree row WITHOUT its own store is still an orphan", () => {
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    expect(isOrphanEntry({ name: "w", root_path: wt, worktree_of: main })).toBe(true);
  });

  it("a subdirectory row is still an orphan even with a stray .cortex/db", () => {
    const sub = join(main, "src");
    mkdirSync(join(sub, ".cortex"), { recursive: true });
    writeFileSync(join(sub, ".cortex", "db"), "x");
    expect(isOrphanEntry({ name: "s", root_path: sub, worktree_of: null })).toBe(true);
  });
});
