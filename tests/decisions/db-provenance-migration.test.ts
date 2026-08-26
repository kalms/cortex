import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-prov-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cols(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

const PROVENANCE = [
  "origin_branch", "origin_commit", "origin_thread",
  "last_touched_branch", "last_touched_commit", "last_touched_thread",
];

describe("provenance columns", () => {
  it("adds provenance + basis + reconciled columns to decisions", () => {
    const db = openDecisionsDb(join(tmp(), "decisions.db"));
    const c = cols(db, "decisions");
    for (const name of [...PROVENANCE, "basis_hash", "reconciled_branch", "reconciled_commit"]) {
      expect(c.has(name), `decisions.${name}`).toBe(true);
    }
    db.close();
  });

  it("adds provenance + basis_hash to todos, and NOT the reconciled columns", () => {
    const db = openDecisionsDb(join(tmp(), "decisions.db"));
    const c = cols(db, "todos");
    for (const name of [...PROVENANCE, "basis_hash"]) expect(c.has(name), `todos.${name}`).toBe(true);
    expect(c.has("reconciled_branch")).toBe(false);
    expect(c.has("reconciliation_verdict")).toBe(false);
    db.close();
  });

  it("adds provenance to stories, and NOT basis_hash", () => {
    const db = openDecisionsDb(join(tmp(), "decisions.db"));
    const c = cols(db, "stories");
    for (const name of PROVENANCE) expect(c.has(name), `stories.${name}`).toBe(true);
    expect(c.has("basis_hash")).toBe(false);
    db.close();
  });

  it("is idempotent across re-open and leaves pre-existing rows NULL", () => {
    const path = join(tmp(), "decisions.db");
    const first = openDecisionsDb(path);
    first.prepare(
      "INSERT INTO decisions (id,title,created_at,updated_at) VALUES ('D-old','old','2020-01-01','2020-01-01')",
    ).run();
    first.close();

    const second = openDecisionsDb(path);           // re-open must not throw
    const row = second.prepare("SELECT * FROM decisions WHERE id='D-old'").get() as Record<string, unknown>;
    expect(row.origin_branch).toBeNull();
    expect(row.origin_commit).toBeNull();
    expect(row.basis_hash).toBeNull();              // never fabricated
    expect(second.prepare("SELECT COUNT(*) n FROM decisions").get()).toEqual({ n: 1 });
    second.close();
  });

  // The test above re-opens a store the CURRENT code created, so it proves
  // idempotence but never exercises the UPGRADE path. Every existing user has
  // a store built by the pre-provenance schema, which is the risky half of a
  // schema change: the columns must be ADDED to populated tables without
  // touching the rows already there.
  describe("upgrading a store built by the pre-provenance schema", () => {
    // The decisions/todos/stories tables exactly as they were before this
    // branch — no origin_*, no last_touched_*, no basis_hash, no reconciled_*.
    const LEGACY_SCHEMA = `
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, seq INTEGER, title TEXT NOT NULL, description TEXT,
        rationale TEXT, problem TEXT, resolution TEXT, alternatives TEXT,
        tier TEXT, status TEXT, superseded_by TEXT, author TEXT, provenance TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        reconciliation_verdict TEXT, reconciled_at TEXT, reconciled_source_hash TEXT,
        reconciled_by TEXT, nonconformant_nodes TEXT, reconciliation_note TEXT
      );
      CREATE TABLE todos (
        id TEXT PRIMARY KEY, seq INTEGER, summary TEXT NOT NULL, description TEXT,
        state TEXT, state_reason TEXT, proposed_by TEXT, proposed_at TEXT,
        started_at TEXT, closed_at TEXT, assignee TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE stories (
        id TEXT PRIMARY KEY, seq INTEGER, title TEXT NOT NULL, description TEXT,
        status TEXT, created_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `;

    function legacyStore(): string {
      const path = join(tmp(), "decisions.db");
      const legacy = new Database(path);
      legacy.exec(LEGACY_SCHEMA);
      legacy.prepare(
        "INSERT INTO decisions (id,title,description,rationale,created_at,updated_at) " +
        "VALUES ('D-legacy','legacy decision','desc','why','2020-01-01','2020-01-01')",
      ).run();
      legacy.prepare(
        "INSERT INTO todos (id,summary,created_at,updated_at) VALUES ('T-legacy','legacy todo','2020-01-01','2020-01-01')",
      ).run();
      legacy.prepare(
        "INSERT INTO stories (id,title,created_at,updated_at) VALUES ('S-legacy','legacy story','2020-01-01','2020-01-01')",
      ).run();
      legacy.close();
      return path;
    }

    it("adds every column to already-populated tables without disturbing the rows", () => {
      const db = openDecisionsDb(legacyStore());
      try {
        const d = cols(db, "decisions");
        for (const n of [...PROVENANCE, "basis_hash", "reconciled_branch", "reconciled_commit"]) {
          expect(d.has(n), `decisions.${n}`).toBe(true);
        }
        // The asymmetry must survive the upgrade path too, not just a fresh DB.
        const t = cols(db, "todos");
        for (const n of [...PROVENANCE, "basis_hash"]) expect(t.has(n), `todos.${n}`).toBe(true);
        expect(t.has("reconciled_branch")).toBe(false);
        const s = cols(db, "stories");
        for (const n of PROVENANCE) expect(s.has(n), `stories.${n}`).toBe(true);
        expect(s.has("basis_hash")).toBe(false);

        // Rows survive, and every new column reads NULL — never fabricated.
        // A backfilled basis would silently certify this row as clean.
        const row = db.prepare("SELECT * FROM decisions WHERE id='D-legacy'").get() as Record<string, unknown>;
        expect(row.title).toBe("legacy decision");
        for (const n of [...PROVENANCE, "basis_hash", "reconciled_branch", "reconciled_commit"]) {
          expect(row[n], `decisions.${n} must be NULL`).toBeNull();
        }
        expect(db.prepare("SELECT COUNT(*) n FROM decisions").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT COUNT(*) n FROM todos").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT COUNT(*) n FROM stories").get()).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    });

    it("leaves FTS usable after upgrading a legacy store", () => {
      const path = legacyStore();
      const db = openDecisionsDb(path);
      try {
        // The legacy row predates the FTS table, so it is not indexed — what
        // matters is that the triggers work for rows written AFTER the upgrade.
        db.prepare(
          "INSERT INTO decisions (id,title,description,rationale,created_at,updated_at) " +
          "VALUES ('D-new','searchable zqxjv','d','r','2026-01-01','2026-01-01')",
        ).run();
        expect(
          db.prepare("SELECT COUNT(*) n FROM decisions_fts WHERE decisions_fts MATCH 'zqxjv'").get(),
        ).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    });

    it("is idempotent — re-opening an upgraded legacy store is a no-op", () => {
      const path = legacyStore();
      openDecisionsDb(path).close();
      const again = openDecisionsDb(path);
      try {
        expect(cols(again, "decisions").has("basis_hash")).toBe(true);
        expect(again.prepare("SELECT COUNT(*) n FROM decisions").get()).toEqual({ n: 1 });
      } finally {
        again.close();
      }
    });
  });
});
