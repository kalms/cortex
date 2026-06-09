import { describe, it, expect, afterEach } from "vitest";
import { stagingDbPath, cleanupStagingDb } from "../../src/db/staging-path.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("stagingDbPath", () => {
  it("is a sibling of .cortex/db, pid-scoped, under .cortex/", () => {
    const p = stagingDbPath("/repo", 4242);
    expect(p).toBe(join("/repo", ".cortex", "db.stage-4242"));
  });
  it("defaults to the current pid", () => {
    const p = stagingDbPath("/repo");
    expect(p.startsWith(join("/repo", ".cortex", "db.stage-"))).toBe(true);
  });
});

describe("cleanupStagingDb", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("removes the staging DB and its -wal/-shm sidecars", () => {
    dir = mkdtempSync(join(tmpdir(), "stage-clean-"));
    const stage = join(dir, "db.stage-1");
    for (const ext of ["", "-wal", "-shm"]) writeFileSync(stage + ext, "x");
    cleanupStagingDb(stage);
    for (const ext of ["", "-wal", "-shm"]) expect(existsSync(stage + ext)).toBe(false);
  });

  it("is a no-op (no throw) when the files don't exist", () => {
    dir = mkdtempSync(join(tmpdir(), "stage-clean-"));
    expect(() => cleanupStagingDb(join(dir, "db.stage-absent"))).not.toThrow();
  });
});
