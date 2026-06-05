// tests/db/registry-migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { Registry } from "../../src/db/registry.js";
import { migrateCacheToRegistry, importLegacyRegistry } from "../../src/db/registry-migration.js";

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
    writeFileSync(join(cacheDir, "notes.txt"), "not a db");
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toEqual([]);
  });

  it("refuses .tmp root_paths seeded via migration (Registry guard)", () => {
    writeCacheDb(cacheDir, "corpus.db", "corpus", "/x/cortex/.tmp/frame-extraction-corpus/foo");
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toEqual([]);
  });

  it("registers a shared root_path only once across two slugs", () => {
    writeCacheDb(cacheDir, "slug-one.db", "slug-one", "/repos/shared");
    writeCacheDb(cacheDir, "slug-two.db", "slug-two", "/repos/shared");
    migrateCacheToRegistry(reg, cacheDir);
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.root_path).toBe("/repos/shared");
  });
});

describe("importLegacyRegistry", () => {
  let oldDir: string;
  let newDir: string;
  let reg: Registry;
  beforeEach(() => {
    oldDir = mkdtempSync(join(tmpdir(), "cortex-oldreg-"));
    newDir = mkdtempSync(join(tmpdir(), "cortex-newreg-"));
    reg = new Registry(join(newDir, "registry.db"));
  });
  afterEach(() => {
    reg.close();
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it("carries rows from the legacy registry into the current one", () => {
    const oldPath = join(oldDir, "_registry.db");
    const old = new Registry(oldPath);
    old.register("proj-a", "/repos/a", "t");
    old.register("proj-b", "/repos/b", "t");
    old.close();

    importLegacyRegistry(reg, oldPath);
    expect(reg.list().map((r) => r.name).sort()).toEqual(["proj-a", "proj-b"]);
  });

  it("is a no-op when the legacy registry is absent", () => {
    importLegacyRegistry(reg, join(oldDir, "does-not-exist.db"));
    expect(reg.list()).toEqual([]);
  });

  it("is idempotent across re-runs", () => {
    const oldPath = join(oldDir, "_registry.db");
    const old = new Registry(oldPath);
    old.register("proj-a", "/repos/a", "t");
    old.close();
    importLegacyRegistry(reg, oldPath);
    importLegacyRegistry(reg, oldPath);
    expect(reg.list()).toHaveLength(1);
  });
});
