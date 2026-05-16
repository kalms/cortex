import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

  it("installs the FTS-sync triggers and stamps fts_version=2", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(triggers.map((t) => t.name)).toEqual(["decisions_ad", "decisions_ai", "decisions_au"]);
      const v = db
        .prepare("SELECT value FROM schema_meta WHERE key='fts_version'")
        .get() as { value: string } | undefined;
      expect(v?.value).toBe("2");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates a v1-shaped DB to v2: drops manual FTS, rebuilds index, attaches triggers", () => {
    // Regression for cortex#2: pre-fix DBs (no triggers, manual FTS sync from
    // repository) may have a corrupted FTS index AND no triggers. Opening
    // them with the new code must rebuild from the content table.
    const root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    try {
      const path = join(root, "decisions.db");

      // Construct a v1-shaped DB by hand.
      const v1 = new Database(path);
      v1.exec(`
        CREATE TABLE decisions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL,
          description TEXT, rationale TEXT, problem TEXT, resolution TEXT,
          alternatives TEXT,
          tier TEXT NOT NULL DEFAULT 'personal',
          status TEXT NOT NULL DEFAULT 'active',
          superseded_by TEXT, author TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE decisions_fts USING fts5(
          title, description, rationale, problem, resolution,
          content='decisions', content_rowid='rowid'
        );
      `);
      v1.prepare(
        `INSERT INTO decisions
         VALUES ('d1','Pre-migration row','desc text','rationale text',
                 'problem text','resolution text', NULL,
                 'personal','active', NULL, NULL, '2026-01-01', '2026-01-01')`,
      ).run();
      // Mimic the broken manual-sync (skipping it doesn't matter — the rebuild
      // will populate the index either way).
      v1.close();

      // Open with the new code — migration runs.
      const db = openDecisionsDb(path);

      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(triggers.map((t) => t.name)).toEqual(["decisions_ad", "decisions_ai", "decisions_au"]);

      // FTS search must now hit the pre-existing row. For external-content
      // FTS5, the id lives on the content table — join to verify the
      // migration's rebuild populated the index with the right rowid.
      const joined = db
        .prepare(`SELECT d.id FROM decisions_fts f
                  JOIN decisions d ON d.rowid = f.rowid
                  WHERE decisions_fts MATCH 'rationale'`)
        .all() as Array<{ id: string }>;
      expect(joined.map((r) => r.id)).toEqual(["d1"]);

      // And the trigger is wired: UPDATE must keep search working.
      db.prepare("UPDATE decisions SET problem = ? WHERE id = 'd1'").run(
        "this is now a longer problem statement after migration",
      );
      const postUpdate = db
        .prepare(`SELECT d.id FROM decisions_fts f
                  JOIN decisions d ON d.rowid = f.rowid
                  WHERE decisions_fts MATCH 'longer'`)
        .all() as Array<{ id: string }>;
      expect(postUpdate.map((r) => r.id)).toEqual(["d1"]);

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
