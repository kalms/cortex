// tests/decisions/migration-runner-integration.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";

function backupsDir(storePath: string) { return join(storePath, "..", "backups"); }

describe("openDecisionsDb migration runner", () => {
  it("records the migration set on a fresh store and takes NO snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      const db = openDecisionsDb(p);
      const names = (db.prepare("SELECT name FROM _cortex_migrations WHERE migration_set='primitives'").all() as Array<{name:string}>).map(r=>r.name);
      db.close();
      expect(names).toContain("id-short-form");
      expect(existsSync(backupsDir(p))).toBe(false); // empty store → no snapshot
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("converts a wild UUID store to short ids and snapshots it (populated upgrade)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      // seed a pre-runner store: schema via openDecisionsDb, then drop the ledger
      // + insert a UUID decision directly to simulate an un-migrated wild store.
      let db = openDecisionsDb(p);
      db.exec("DROP TABLE _cortex_migrations");
      db.prepare("DELETE FROM schema_meta WHERE key='decision_ids_shortform'").run();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO decisions(id,title,created_at,updated_at) VALUES(?,?,?,?)")
        .run("0155458d-af39-4701-b03e-fd570809a9d8", "wild", now, now);
      db.close();

      db = openDecisionsDb(p); // re-open → runner adopts + converts
      const ids = (db.prepare("SELECT id FROM decisions").all() as Array<{id:string}>).map(r=>r.id);
      db.close();
      expect(ids.every((id) => id.startsWith("D-"))).toBe(true);
      expect(readdirSync(backupsDir(p)).some((f)=>f.startsWith("decisions.db.bak."))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("hard-refuses a too-new store", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      const db = openDecisionsDb(p);
      db.prepare("INSERT INTO _cortex_migrations(migration_set,name,applied_at) VALUES('primitives','future-thing',?)").run(new Date().toISOString());
      db.close();
      expect(() => openDecisionsDb(p)).toThrowError(/newer version|doesn't recognize/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("preserves a directly-inserted UUID id (rehome-fixture invariant)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      const db = openDecisionsDb(p); // empty → id-short-form recorded now
      const now = new Date().toISOString();
      db.prepare("INSERT INTO decisions(id,title,created_at,updated_at) VALUES(?,?,?,?)")
        .run("11111111-2222-3333-4444-555555555555", "fixture", now, now);
      db.close();
      const db2 = openDecisionsDb(p); // already recorded → no conversion
      const id = (db2.prepare("SELECT id FROM decisions").get() as {id:string}).id;
      db2.close();
      expect(id).toBe("11111111-2222-3333-4444-555555555555");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
