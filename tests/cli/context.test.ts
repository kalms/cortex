import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { detectProjectState, deriveProjectName, loadContext } from "../../src/cli/context.js";

describe("context — project state detection", () => {
  let tmp: string;

  // realpathSync: these fixtures build a bare ".git" stub (not a real repo),
  // so loadContext's graph-path resolution takes the non-git fallback, which
  // now realpaths (worktreeRoot → canonicalRepoPath) to converge write/read
  // path derivation for symlinked dirs (e.g. macOS /var → /private/var, per
  // D-b248's "genuinely non-git directory routes by its own realpath"). A raw
  // mkdtempSync() result would spuriously mismatch the resolved graphDbPath.
  beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), "cortex-ctx-"))); });
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

  it("detects 'indexed' when .cortex/graph.db exists alongside .git", () => {
    mkdirSync(join(tmp, ".git"));
    mkdirSync(join(tmp, ".cortex"));
    writeFileSync(join(tmp, ".cortex/graph.db"), ""); // empty file is enough — existsSync only
    const ctx = loadContext(tmp);
    expect(ctx.state).toBe("indexed");
    expect(ctx.graphDbPath).toBe(join(tmp, ".cortex/graph.db"));
  });

  // Regression: a repo indexed at the CANONICAL <repo>/.cortex/db (the norm
  // since D-2ke5) — no legacy graph.db, no CLI cache entry — was misreported
  // as "unindexed-repo" because the old inline resolver only probed the two
  // legacy locations. `cortex tour` then falsely told the user to index an
  // already-indexed repo (observed in ../cortex-indexer).
  it("detects 'indexed' from a populated canonical .cortex/db (no legacy graph.db)", () => {
    mkdirSync(join(tmp, ".git"));
    mkdirSync(join(tmp, ".cortex"));
    const store = new GraphStore(join(tmp, ".cortex", "db")); // populate canonical store
    store.createNode({ kind: "function", name: "fn", qualified_name: "t.fn", file_path: "x.ts" });
    const ctx = loadContext(tmp);
    expect(ctx.state).toBe("indexed");
    expect(ctx.graphDbPath).toBe(join(tmp, ".cortex/db"));
  });
});
