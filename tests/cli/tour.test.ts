import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { renderTour } from "../../src/cli/tour.js";
import type { ProjectContext } from "../../src/cli/context.js";

describe("tour", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-tour-"));
    dbPath = join(dir, "graph.db");
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("indexed state: starts at step 3 and uses a real function name", () => {
    const store = new GraphStore(dbPath);
    store.createNode({ kind: "function", name: "myRealFn", qualified_name: "test.src.myRealFn", file_path: "src/x.ts" });
    const ctx: ProjectContext = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: dbPath };
    const out = renderTour(ctx);
    expect(out).toContain("myRealFn");
    expect(out).not.toContain("Step 1 — index");
  });

  it("unindexed-repo state: starts at index step", () => {
    const ctx: ProjectContext = { state: "unindexed-repo", cwd: dir, projectName: "test", graphDbPath: null };
    const out = renderTour(ctx);
    expect(out).toContain("cortex index");
    expect(out).toContain("not indexed yet");
  });

  it("no-project state: hints to cd into a repo or list", () => {
    const ctx: ProjectContext = { state: "no-project", cwd: dir, projectName: null, graphDbPath: null };
    const out = renderTour(ctx);
    expect(out).toContain("cortex index list");
    expect(out).toContain("cd");
  });
});
