// tests/mcp-contract/read-routing.test.ts
//
// Regression guard for read-path CONVERGENCE: the resolver and the read handle
// (RepoContext.graphDbPath / ctx.graphDb) must always agree on the same store,
// so read tools never re-derive a different path and read 0 nodes against the
// wrong file.
//
// Contract (see resolveGraphDbForRead + decision f1950d3): the canonical
// `<repo>/.cortex/db` wins whenever it is an openable SQLite file — populated,
// valid-empty, or a 0-byte drift. An empty canonical store must surface as
// empty (→ freshness flags `empty` → reindex), NOT be shadowed by a stale
// sibling `.cortex/graph.db`. The legacy `graph.db` is consulted only when the
// canonical store is absent (un-migrated repos).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";

const BINARY_MISSING = process.env.CORTEX_CONTRACT_BINARY_MISSING === "1";

describe.skipIf(BINARY_MISSING)("read-path routing: canonical .cortex/db wins; resolver and read handle agree", () => {
  it("an openable-but-empty .cortex/db wins over a populated legacy graph.db (canonical wins; no stale shadow)", () => {
    const fixtureDb = process.env.CORTEX_CONTRACT_CORTEX_DB;
    if (!fixtureDb) throw new Error("CORTEX_CONTRACT_CORTEX_DB not set by globalSetup");

    const root = mkdtempSync(join(tmpdir(), "cortex-readroute-"));
    execSync(`git init -q "${root}"`, { stdio: "ignore" });
    mkdirSync(join(root, ".cortex"));
    // A 0-byte (empty but openable) .cortex/db — the drift case. It must win.
    writeFileSync(join(root, ".cortex", "db"), "");
    // A populated store under the legacy graph.db name — must NOT shadow canonical.
    copyFileSync(fixtureDb, join(root, ".cortex", "graph.db"));

    const resolver = new RepoContextResolver({ poolCapacity: 2 });
    try {
      const ctx = resolver.resolve(root);
      // Resolver picks the canonical store, and the read handle opens that SAME
      // path — they converge. The canonical store is empty, so it reads 0 nodes
      // (the cue to reindex), rather than serving the stale graph.db.
      expect(ctx.graphDbPath).toBe(realpathSync(join(root, ".cortex", "db")));
      const n = (ctx.graphDb.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
      expect(n).toBe(0);
    } finally {
      resolver.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to a populated graph.db only when .cortex/db is absent (resolver + read handle agree)", () => {
    const fixtureDb = process.env.CORTEX_CONTRACT_CORTEX_DB;
    if (!fixtureDb) throw new Error("CORTEX_CONTRACT_CORTEX_DB not set by globalSetup");

    const root = mkdtempSync(join(tmpdir(), "cortex-readroute-"));
    execSync(`git init -q "${root}"`, { stdio: "ignore" });
    mkdirSync(join(root, ".cortex"));
    // No .cortex/db at all — only the legacy populated graph.db (un-migrated repo).
    const graphDb = join(root, ".cortex", "graph.db");
    copyFileSync(fixtureDb, graphDb);

    const resolver = new RepoContextResolver({ poolCapacity: 2 });
    try {
      const ctx = resolver.resolve(root);
      expect(ctx.graphDbPath).toBe(realpathSync(graphDb));
      const n = (ctx.graphDb.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
      expect(n).toBeGreaterThan(0);
    } finally {
      resolver.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
