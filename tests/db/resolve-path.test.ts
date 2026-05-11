import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCortexDbPath } from "../../src/db/resolve-path.js";

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
