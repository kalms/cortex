import { describe, it, expect } from "vitest";
import { freshnessForContext, invalidateFreshness } from "../../src/mcp-server/freshness.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("invalidateFreshness", () => {
  it("forces recomputation rather than serving the 2s memo", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-inv-"));
    const db = new Database(join(dir, "db"));
    db.exec("CREATE TABLE nodes (id TEXT)");
    const ctx = { repoPath: dir, graphDb: db, canonical: true };
    const first = freshnessForContext(ctx);     // memoized (empty: 0 nodes, non-git)
    invalidateFreshness(dir);
    db.prepare("INSERT INTO nodes (id) VALUES ('x')").run();
    const second = freshnessForContext(ctx);    // recomputed: now 1 node
    expect(first.state).not.toBe(second.state); // empty -> unknown (non-git) proves recompute
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});
