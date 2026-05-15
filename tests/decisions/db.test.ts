import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

describe("openDecisionsDb", () => {
  it("creates schema on first open and is idempotent on second open", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    try {
      const path = join(root, "decisions.db");

      const db1 = openDecisionsDb(path);
      const tables = db1
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("decisions");
      expect(tableNames).toContain("decision_links");
      expect(tableNames).toContain("schema_meta");
      db1.close();

      // Re-open: schema setup should not throw.
      const db2 = openDecisionsDb(path);
      const count = (db2.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number }).c;
      expect(count).toBe(0);
      db2.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the decisions_fts virtual table", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("decisions_fts");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
