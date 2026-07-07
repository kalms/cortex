import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCortexDbPath, resolveGraphDbForRead } from "../../src/db/resolve-path.js";

describe("resolve-path — worktree canonicalization", () => {
  let root: string;
  let wt: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-")));
    execSync(`git init -q "${root}"`);
    execSync(`git -C "${root}" commit -q --allow-empty -m init`);
    mkdirSync(join(root, ".cortex"));
    writeFileSync(join(root, ".cortex", "db"), ""); // openable (0-byte) SQLite
    wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-wt-")));
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
  });

  afterAll(() => {
    rmSync(wt, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("resolveCortexDbPath(worktree) points at the canonical root db", () => {
    expect(resolveCortexDbPath(wt)).toBe(join(root, ".cortex", "db"));
  });

  it("resolveCortexDbPath(subdir) points at the canonical root db", () => {
    const sub = join(root, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveCortexDbPath(sub)).toBe(join(root, ".cortex", "db"));
  });

  it("resolveGraphDbForRead(worktree) finds the canonical root db", () => {
    expect(resolveGraphDbForRead(wt)).toBe(join(root, ".cortex", "db"));
  });
});
