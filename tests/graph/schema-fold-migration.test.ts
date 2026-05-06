import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "cortex-indexer");

describe("schema fold migration: cbm_* → nodes/edges + ctx_*", () => {
  let workDir: string;
  let cortexDbPath: string;

  beforeAll(() => {
    if (!existsSync(BINARY)) {
      throw new Error("bin/cortex-indexer not found — run npm install first");
    }
    workDir = mkdtempSync(join(tmpdir(), "cortex-schema-fold-"));
    const fixture = join(workDir, "sample-project");
    cpSync(FIXTURE_SRC, fixture, { recursive: true });

    cortexDbPath = resolve(join(workDir, "cortex.db"));

    // Run the indexer to populate cbm_* tables (the pre-Phase-4 shape).
    execFileSync(BINARY, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, CORTEX_DB: cortexDbPath },
    });
  }, 60_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("opening GraphStore on a cbm_* populated DB runs the migration", () => {
    // Pre-state: cbm_nodes and cbm_edges exist with rows.
    const pre = new Database(cortexDbPath, { readonly: true });
    const cbmNodeCount = (pre.prepare("SELECT COUNT(*) AS c FROM cbm_nodes").get() as { c: number }).c;
    const cbmEdgeCount = (pre.prepare("SELECT COUNT(*) AS c FROM cbm_edges").get() as { c: number }).c;
    pre.close();
    expect(cbmNodeCount).toBeGreaterThan(0);
    expect(cbmEdgeCount).toBeGreaterThan(0);

    // Trigger migration by opening GraphStore.
    const store = new GraphStore(cortexDbPath);

    // Post-state: cbm_nodes / cbm_edges are gone; data lives in nodes / edges.
    const tables = store.listTables();
    expect(tables).not.toContain("cbm_nodes");
    expect(tables).not.toContain("cbm_edges");

    // Bookkeeping tables renamed.
    expect(tables).toContain("ctx_projects");
    expect(tables).toContain("ctx_file_hashes");
    expect(tables).toContain("ctx_project_summaries");
    expect(tables).not.toContain("cbm_projects");
    expect(tables).not.toContain("cbm_file_hashes");
    expect(tables).not.toContain("cbm_project_summaries");

    // Migrated rows have ctx- prefix and live in nodes/edges.
    const migratedNodes = store
      .queryRaw<{ c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'")[0].c;
    const migratedEdges = store
      .queryRaw<{ c: number }>("SELECT COUNT(*) AS c FROM edges WHERE id LIKE 'ctx-e%'")[0].c;

    expect(migratedNodes).toBe(cbmNodeCount);
    expect(migratedEdges).toBe(cbmEdgeCount);

    // Migrated nodes have lowercase kinds (no uppercase Class/Function/etc.).
    const kinds = store.queryRaw<{ kind: string }>(
      "SELECT DISTINCT kind FROM nodes WHERE id LIKE 'ctx-%'"
    );
    for (const row of kinds) {
      expect(row.kind).toBe(row.kind.toLowerCase());
    }

    // Code rows have non-null project.
    const nullProjectCount = store.queryRaw<{ c: number }>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%' AND project IS NULL"
    )[0].c;
    expect(nullProjectCount).toBe(0);

    store.close();
  });

  it("opening GraphStore again is a no-op (idempotent)", () => {
    // Already migrated above. Open again; should not throw or change row counts.
    const store1 = new GraphStore(cortexDbPath);
    const before = store1.queryRaw<{ c: number }>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'"
    )[0].c;
    store1.close();

    const store2 = new GraphStore(cortexDbPath);
    const after = store2.queryRaw<{ c: number }>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'"
    )[0].c;
    store2.close();

    expect(after).toBe(before);
  });
});
