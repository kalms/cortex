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
});
