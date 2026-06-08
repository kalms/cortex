import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mintId } from "../../src/ids/allocator.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE id_sequences (entity_type TEXT PRIMARY KEY, next_val INTEGER NOT NULL);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, seq INTEGER);
  `);
  return db;
}

describe("mintId", () => {
  it("hands out monotonic seq starting at 1", () => {
    const db = freshDb();
    const exists = (id: string) =>
      db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(id) != null;
    const a = mintId(db, "decision", exists);
    const b = mintId(db, "decision", exists);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("throws when it cannot find a free canonical id (forced collisions)", () => {
    const db = freshDb();
    db.prepare("INSERT INTO decisions (id, seq) VALUES ('D-9m2x', 1)").run();
    const exists = (id: string) =>
      db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(id) != null;
    // draw always returns the colliding token; maxTries=3 -> must throw.
    expect(() => mintId(db, "decision", exists, () => "9m2x", 3)).toThrow(/could not find a free/);
  });
});
