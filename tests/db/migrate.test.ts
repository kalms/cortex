// tests/db/migrate.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, MigrationError, type Migration } from "../../src/db/migrate.js";

function mem() { return new Database(":memory:"); }
function applied(db: Database.Database, set = "t"): string[] {
  return (db.prepare("SELECT name FROM _cortex_migrations WHERE migration_set=? ORDER BY name").all(set) as Array<{name:string}>).map(r => r.name);
}

describe("runMigrations", () => {
  it("runs unrecorded migrations in order and records them", () => {
    const db = mem(); const order: string[] = [];
    const list: Migration[] = [
      { name: "a", up: () => { order.push("a"); } },
      { name: "b", up: () => { order.push("b"); } },
    ];
    runMigrations(db, list, { set: "t" });
    expect(order).toEqual(["a", "b"]);
    expect(applied(db)).toEqual(["a", "b"]);
  });

  it("skips already-recorded migrations (idempotent re-run)", () => {
    const db = mem(); let runs = 0;
    const list: Migration[] = [{ name: "a", up: () => { runs++; } }];
    runMigrations(db, list, { set: "t" });
    runMigrations(db, list, { set: "t" });
    expect(runs).toBe(1);
  });

  it("calls beforeApply once with pending names when there is work, never when none", () => {
    const db = mem(); const calls: string[][] = [];
    const list: Migration[] = [{ name: "a", up: () => {} }];
    runMigrations(db, list, { set: "t", beforeApply: (p) => calls.push(p) });
    runMigrations(db, list, { set: "t", beforeApply: (p) => calls.push(p) });
    expect(calls).toEqual([["a"]]); // only the first open had pending work
  });

  it("throws store-too-new when the ledger holds an unknown name", () => {
    const db = mem();
    runMigrations(db, [{ name: "a", up: () => {} }, { name: "b", up: () => {} }], { set: "t" });
    // simulate a newer binary having added "c"
    db.prepare("INSERT INTO _cortex_migrations(migration_set,name,applied_at) VALUES('t','c','now')").run();
    expect(() => runMigrations(db, [{ name: "a", up: () => {} }], { set: "t" }))
      .toThrowError(MigrationError);
    try { runMigrations(db, [{ name: "a", up: () => {} }], { set: "t" }); }
    catch (e) { expect((e as MigrationError).kind).toBe("store-too-new"); expect((e as MigrationError).detail?.unknown).toContain("b"); }
  });

  it("a failing migration is not recorded and aborts the run", () => {
    const db = mem(); let bRan = false;
    const list: Migration[] = [
      { name: "a", up: (d) => { d.exec("CREATE TABLE x(v)"); throw new Error("boom"); } },
      { name: "b", up: () => { bRan = true; } },
    ];
    expect(() => runMigrations(db, list, { set: "t" })).toThrowError(/migration 'a' failed/);
    expect(applied(db)).toEqual([]); // nothing recorded
    expect(bRan).toBe(false);        // later migration never ran
  });

  it("rejects duplicate migration names (developer error)", () => {
    const db = mem();
    expect(() => runMigrations(db, [{ name: "a", up: () => {} }, { name: "a", up: () => {} }], { set: "t" }))
      .toThrowError(/duplicate migration name/);
  });
});
