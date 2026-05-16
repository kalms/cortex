import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { migrateDecisionsFromGraphDb } from "../../src/decisions/migration.js";

describe("migrateDecisionsFromGraphDb", () => {
  let root: string;
  let graphPath: string;
  let decisionsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    graphPath = join(root, "graph.db");
    decisionsPath = join(root, "decisions.db");
    const g = new Database(graphPath);
    g.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, data TEXT, tier TEXT, created_at TEXT, updated_at TEXT,
        start_line INTEGER, end_line INTEGER, project TEXT
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, relation TEXT,
        data TEXT, created_at TEXT, project TEXT
      );
    `);
    g.prepare(
      `INSERT INTO nodes (id, kind, name, data, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "dec-1", "decision", "Use vitest",
      JSON.stringify({
        title: "Use vitest",
        description: "Standardize",
        rationale: "Speed",
        alternatives: [{ name: "jest", reason_rejected: "slow" }],
        status: "active", author: "claude", problem: null, resolution: null,
      }),
      "personal", "2026-05-14T10:00:00Z", "2026-05-14T10:00:00Z",
    );
    g.prepare(
      `INSERT INTO nodes (id, kind, name, file_path) VALUES (?, ?, ?, ?)`,
    ).run("path-1", "path", "foo.ts", "src/foo.ts");
    g.prepare(
      `INSERT INTO edges (id, source_id, target_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("e-1", "dec-1", "path-1", "GOVERNS", "2026-05-14T10:00:00Z");
    g.close();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("migrates decision nodes + GOVERNS edges into decisions.db", () => {
    const decDb = openDecisionsDb(decisionsPath);
    try {
      const moved = migrateDecisionsFromGraphDb(decDb, graphPath);
      expect(moved.decisions).toBe(1);
      expect(moved.links).toBe(1);

      const decisions = new DecisionsRepository(decDb);
      const got = decisions.get("dec-1");
      expect(got?.title).toBe("Use vitest");
      expect(got?.rationale).toBe("Speed");
      expect(got?.alternatives).toBe(
        JSON.stringify([{ name: "jest", reason_rejected: "slow" }]),
      );

      const links = new DecisionLinksRepository(decDb);
      const lk = links.findByDecision("dec-1");
      expect(lk).toHaveLength(1);
      expect(lk[0].target_kind).toBe("path");
      expect(lk[0].target_ref).toBe("src/foo.ts");
      expect(lk[0].relation).toBe("GOVERNS");
    } finally {
      decDb.close();
    }
  });

  it("is idempotent: second call moves 0 decisions when meta flag is set", () => {
    const decDb = openDecisionsDb(decisionsPath);
    try {
      migrateDecisionsFromGraphDb(decDb, graphPath);
      const second = migrateDecisionsFromGraphDb(decDb, graphPath);
      expect(second.decisions).toBe(0);
      expect(second.links).toBe(0);
    } finally {
      decDb.close();
    }
  });

  it("no-ops gracefully when the graph DB does not exist", () => {
    const decDb = openDecisionsDb(decisionsPath);
    try {
      const moved = migrateDecisionsFromGraphDb(decDb, join(root, "nope.db"));
      expect(moved.decisions).toBe(0);
      expect(moved.links).toBe(0);
    } finally {
      decDb.close();
    }
  });
});
