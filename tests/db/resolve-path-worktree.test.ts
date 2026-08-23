import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  resolveCortexDbPath,
  resolveDecisionsDbPath,
  resolveGraphDbForRead,
} from "../../src/db/resolve-path.js";

describe("resolve-path — checkout axis (worktree)", () => {
  let main: string;
  let wt: string;
  beforeAll(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-")));
    execSync(`git init -q "${main}"`);
    execSync(`git -C "${main}" commit -q --allow-empty -m init`);
    mkdirSync(join(main, ".cortex"));
    writeFileSync(join(main, ".cortex", "db"), ""); // openable (0-byte) SQLite
    wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-wt-")));
    execSync(`git -C "${main}" worktree add -q "${wt}"`);
  });

  afterAll(() => {
    rmSync(wt, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  });

  it("resolveCortexDbPath points a worktree at its OWN .cortex/db", () => {
    expect(resolveCortexDbPath(wt)).toBe(join(wt, ".cortex", "db"));
  });

  it("resolveCortexDbPath(subdir) points at the canonical root db", () => {
    const sub = join(main, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveCortexDbPath(sub)).toBe(join(main, ".cortex", "db"));
  });

  it("resolveDecisionsDbPath still collapses a worktree to the shared store", () => {
    expect(resolveDecisionsDbPath(wt)).toBe(resolveDecisionsDbPath(main));
  });

  it("resolveGraphDbForRead falls back to the canonical root db when the worktree has none (Stage 1)", () => {
    expect(resolveGraphDbForRead(wt)).toBe(join(main, ".cortex", "db"));
  });

  it("resolveGraphDbForRead prefers the worktree store when it exists", () => {
    mkdirSync(join(wt, ".cortex"), { recursive: true });
    new BetterSqlite3(join(wt, ".cortex", "db")).close();
    expect(resolveGraphDbForRead(wt)).toBe(join(wt, ".cortex", "db"));
  });

  it("resolveGraphDbForRead falls back to canonical again once the worktree store is removed (Stage 1)", () => {
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    mkdirSync(join(main, ".cortex"), { recursive: true });
    new BetterSqlite3(join(main, ".cortex", "db")).close();
    expect(resolveGraphDbForRead(wt)).toBe(join(main, ".cortex", "db"));
  });
});
