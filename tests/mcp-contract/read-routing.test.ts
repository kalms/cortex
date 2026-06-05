// tests/mcp-contract/read-routing.test.ts
//
// Regression guard for the read-path divergence bug: the resolver chose the
// populated store, but read tools re-derived `<repo>/.cortex/db` independently
// and read 0 nodes when the real data lived in `.cortex/graph.db` (or the
// cache). This exercises the actual divergent layout the unit tests and the
// pinned-DB harness never reproduce: an EMPTY `.cortex/db` alongside a
// POPULATED `.cortex/graph.db`. RepoContext.graphDbPath must resolve to the
// populated store, and ctx.graphDb must read it.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";

const BINARY_MISSING = process.env.CORTEX_CONTRACT_BINARY_MISSING === "1";

describe.skipIf(BINARY_MISSING)("read-path routing: populated store wins over empty .cortex/db", () => {
  it("RepoContext.graphDbPath resolves to the populated .cortex/graph.db, not the empty .cortex/db", () => {
    const fixtureDb = process.env.CORTEX_CONTRACT_CORTEX_DB;
    if (!fixtureDb) throw new Error("CORTEX_CONTRACT_CORTEX_DB not set by globalSetup");

    const root = mkdtempSync(join(tmpdir(), "cortex-readroute-"));
    execSync(`git init -q "${root}"`, { stdio: "ignore" });
    mkdirSync(join(root, ".cortex"));
    // Empty (invalid) .cortex/db — exists but has no nodes; must be skipped.
    writeFileSync(join(root, ".cortex", "db"), "");
    // Populated store under the legacy graph.db name.
    const graphDb = join(root, ".cortex", "graph.db");
    copyFileSync(fixtureDb, graphDb);

    const resolver = new RepoContextResolver({ poolCapacity: 2 });
    try {
      const ctx = resolver.resolve(root);
      // realpath both sides: the resolver normalizes through symlinks
      // (macOS /tmp → /private/tmp).
      expect(ctx.graphDbPath).toBe(realpathSync(graphDb));
      const n = (ctx.graphDb.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
      expect(n).toBeGreaterThan(0);
    } finally {
      resolver.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
