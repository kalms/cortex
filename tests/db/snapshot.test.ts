import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { snapshotDb, restoreDb, pruneSnapshots } from "../../src/db/snapshot.js";

describe("snapshot/restore/prune", () => {
  it("snapshotDb makes a consistent copy with the same rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-snap-"));
    try {
      const dbPath = join(dir, "store.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE t(v); INSERT INTO t VALUES (1),(2),(3);");
      const dest = join(dir, "snap.db");
      snapshotDb(db, dest);
      db.close();
      expect(existsSync(dest)).toBe(true);
      const copy = new Database(dest, { readonly: true });
      expect((copy.prepare("SELECT COUNT(*) n FROM t").get() as {n:number}).n).toBe(3);
      copy.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("restoreDb brings back the snapshot content", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-snap-"));
    try {
      const dbPath = join(dir, "store.db");
      let db = new Database(dbPath);
      db.exec("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
      const snap = join(dir, "snap.db");
      snapshotDb(db, snap);
      db.exec("INSERT INTO t VALUES (2);"); // diverge after snapshot
      db.close();
      restoreDb(dbPath, snap);
      db = new Database(dbPath, { readonly: true });
      expect((db.prepare("SELECT COUNT(*) n FROM t").get() as {n:number}).n).toBe(1);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("pruneSnapshots keeps the newest N by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-snap-"));
    try {
      for (const ts of ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]) {
        writeFileSync(join(dir, `decisions.db.bak.${ts}`), "x");
      }
      pruneSnapshots(dir, 3);
      const left = readdirSync(dir).filter((f) => f.startsWith("decisions.db.bak.")).sort();
      expect(left).toEqual(["decisions.db.bak.2026-02-01", "decisions.db.bak.2026-03-01", "decisions.db.bak.2026-04-01"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
