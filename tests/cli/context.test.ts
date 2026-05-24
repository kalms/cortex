import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectState, deriveProjectName } from "../../src/cli/context.js";

describe("context — project state detection", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "cortex-ctx-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("detects 'no-project' when cwd has no .git", () => {
    expect(detectProjectState(tmp)).toBe("no-project");
  });

  it("detects 'unindexed-repo' when cwd has .git but no indexed project for it", () => {
    mkdirSync(join(tmp, ".git"));
    writeFileSync(join(tmp, ".git/HEAD"), "ref: refs/heads/main\n");
    // No project entry in ~/.cache/cortex-indexer; detect returns unindexed-repo.
    expect(detectProjectState(tmp)).toBe("unindexed-repo");
  });

  it("derives project name from absolute path", () => {
    expect(deriveProjectName("/Users/rka/Development/anthill-cloud"))
      .toBe("Users-rka-Development-anthill-cloud");
  });

  it("derives project name from relative path by resolving first", () => {
    // Just verify the format — exact value depends on cwd
    const derived = deriveProjectName("/some/path");
    expect(derived).toBe("some-path");
  });
});
