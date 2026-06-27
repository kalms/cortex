import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { migrateDecisionIdsToShortForm } from "../../src/decisions/id-migration.js";

function seedLegacy(): Database.Database {
  const db = openDecisionsDb(":memory:");
  // openDecisionsDb now runs the primitives migration runner on first open
  // (empty store → records id-short-form as done). Reset the migration
  // ledger + the schema_meta done flag so migrateDecisionIdsToShortForm can
  // be called directly as the unit under test, simulating a wild pre-runner store.
  db.exec("DROP TABLE IF EXISTS _cortex_migrations");
  db.prepare("DELETE FROM schema_meta WHERE key='decision_ids_shortform'").run();
  const A = "04c848f0-0000-0000-0000-000000000001";
  const B = "04c848f0-0000-0000-0000-000000000002";
  const ins = db.prepare(
    `INSERT INTO decisions (id, title, rationale, tier, status, superseded_by, created_at, updated_at)
     VALUES (?, ?, 'r', 'personal', ?, ?, ?, ?)`,
  );
  ins.run(A, "older", "active", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  ins.run(B, "newer", "active", null, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  // B supersedes A: A.superseded_by = B, A.status = superseded.
  db.prepare("UPDATE decisions SET superseded_by = ?, status = 'superseded' WHERE id = ?").run(B, A);
  const link = db.prepare(
    `INSERT INTO decision_links (decision_id, target_kind, target_ref, relation, created_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
  );
  link.run(A, "path", "src/foo.ts", "GOVERNS");
  link.run(B, "decision", A, "SUPERSEDES");
  return db;
}

describe("migrateDecisionIdsToShortForm", () => {
  it("rewrites ids, assigns seq by created_at, and remaps all references", () => {
    const db = seedLegacy();
    migrateDecisionIdsToShortForm(db);

    const rows = db.prepare("SELECT id, seq, superseded_by, created_at FROM decisions ORDER BY seq").all() as
      Array<{ id: string; seq: number; superseded_by: string | null; created_at: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(1);
    expect(rows[0].created_at).toBe("2026-01-01T00:00:00Z");
    expect(rows[0].id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(rows[1].seq).toBe(2);

    const older = rows[0]; // was A
    const newer = rows[1]; // was B
    expect(older.superseded_by).toBe(newer.id);

    const govern = db.prepare("SELECT decision_id FROM decision_links WHERE relation='GOVERNS'").get() as { decision_id: string };
    expect(govern.decision_id).toBe(older.id);
    const sup = db.prepare("SELECT decision_id, target_ref FROM decision_links WHERE relation='SUPERSEDES'").get() as { decision_id: string; target_ref: string };
    expect(sup.decision_id).toBe(newer.id);
    expect(sup.target_ref).toBe(older.id);

    const next = db.prepare("SELECT next_val FROM id_sequences WHERE entity_type='decision'").get() as { next_val: number };
    expect(next.next_val).toBe(3);
  });

  it("is idempotent: a second run is a no-op", () => {
    const db = seedLegacy();
    migrateDecisionIdsToShortForm(db);
    const before = db.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
    migrateDecisionIdsToShortForm(db);
    const after = db.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
    expect(after).toEqual(before);
  });

  it("leaves already-short ids untouched (skips D- rows)", () => {
    const db = openDecisionsDb(":memory:");
    db.prepare(
      `INSERT INTO decisions (id, seq, title, rationale, tier, status, created_at, updated_at)
       VALUES ('D-9m2x', 1, 't', 'r', 'personal', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    migrateDecisionIdsToShortForm(db);
    const row = db.prepare("SELECT id, seq FROM decisions").get() as { id: string; seq: number };
    expect(row.id).toBe("D-9m2x");
    expect(row.seq).toBe(1);
  });
});
