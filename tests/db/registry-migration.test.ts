// tests/db/registry-migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { Registry } from "../../src/db/registry.js";
import { migrateCacheToRegistry } from "../../src/db/registry-migration.js";

function writeCacheDb(dir: string, file: string, name: string, root_path: string) {
  const db = new BetterSqlite3(join(dir, file));
  db.exec(`CREATE TABLE ctx_projects (name TEXT, root_path TEXT, indexed_at TEXT)`);
  db.prepare(`INSERT INTO ctx_projects VALUES (?, ?, ?)`).run(name, root_path, "2026-01-01T00:00:00.000Z");
  db.close();
}

describe("migrateCacheToRegistry", () => {
  let cacheDir: string;
  let regDir: string;
  let reg: Registry;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "cortex-cache-"));
    regDir = mkdtempSync(join(tmpdir(), "cortex-reg-"));
    reg = new Registry(join(regDir, "_registry.db"));
  });
  afterEach(() => {
    reg.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
  });

  it("seeds registry rows from cache <slug>.db ctx_projects", () => {
    writeCacheDb(cacheDir, "proj-a.db", "proj-a", "/repos/a");
    writeCacheDb(cacheDir, "proj-b.db", "proj-b", "/repos/b");
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list().map((r) => r.name).sort()).toEqual(["proj-a", "proj-b"]);
  });

  it("is idempotent across re-runs", () => {
    writeCacheDb(cacheDir, "proj-a.db", "proj-a", "/repos/a");
    migrateCacheToRegistry(reg, cacheDir);
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toHaveLength(1);
  });

  it("skips _-prefixed, tmp- prefixed, sidecars, and non-db files", () => {
    writeCacheDb(cacheDir, "_registry.db", "_registry", "/should/skip");
    writeCacheDb(cacheDir, "tmp-staging.db", "tmp-staging", "/should/skip");
    mkdirSync(join(cacheDir, "ignore-me"));
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toEqual([]);
  });

  it("skips cache DBs whose root_path is under .tmp", () => {
    writeCacheDb(cacheDir, "corpus.db", "corpus", "/x/cortex/.tmp/frame-extraction-corpus/foo");
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toEqual([]);
  });
});
