import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCortexDbPath, resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("resolveCortexDbPath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cortex-resolve-"));
    mkdirSync(join(tmp, ".git"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds .git from repo root", () => {
    expect(resolveCortexDbPath(tmp)).toBe(join(tmp, ".cortex", "db"));
  });

  it("walks up from a subdirectory", () => {
    const sub = join(tmp, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveCortexDbPath(sub)).toBe(join(tmp, ".cortex", "db"));
  });

  it("honors CORTEX_DB_PATH override", () => {
    process.env.CORTEX_DB_PATH = "/tmp/override.db";
    try {
      expect(resolveCortexDbPath(tmp)).toBe("/tmp/override.db");
    } finally {
      delete process.env.CORTEX_DB_PATH;
    }
  });

  it("falls back to startDir-relative when no .git found", () => {
    const noGit = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(resolveCortexDbPath(noGit)).toBe(join(noGit, ".cortex", "db"));
    rmSync(noGit, { recursive: true, force: true });
  });
});

describe("resolveDecisionsDbPath", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cortex-test-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("returns <repo>/.cortex/decisions.db for a git repo", () => {
    mkdirSync(join(root, ".git"));
    expect(resolveDecisionsDbPath(root)).toBe(join(root, ".cortex", "decisions.db"));
  });

  it("walks up to the git root from a subdirectory", () => {
    mkdirSync(join(root, ".git"));
    const sub = join(root, "src", "nested");
    mkdirSync(sub, { recursive: true });
    expect(resolveDecisionsDbPath(sub)).toBe(join(root, ".cortex", "decisions.db"));
  });

  it("honors $CORTEX_DECISIONS_DB env override", () => {
    const override = join(root, "custom", "decisions.db");
    process.env.CORTEX_DECISIONS_DB = override;
    try {
      expect(resolveDecisionsDbPath(root)).toBe(override);
    } finally {
      delete process.env.CORTEX_DECISIONS_DB;
    }
  });

  it("falls back to <startDir>/.cortex/decisions.db when no .git is found", () => {
    expect(resolveDecisionsDbPath(root)).toBe(join(root, ".cortex", "decisions.db"));
  });
});
