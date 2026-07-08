import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Registry } from "../../src/db/registry.js";
import { auditStores, fixStores } from "../../src/db/store-gc-audit.js";

let tmp: string;
const saved = { home: process.env.CORTEX_HOME, cache: process.env.CTX_CACHE_DIR, reg: process.env.CORTEX_REGISTRY_DB };
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "audit-"));
  process.env.CORTEX_HOME = tmp;
  process.env.CTX_CACHE_DIR = join(tmp, "cache");
  process.env.CORTEX_REGISTRY_DB = join(tmp, "registry.db");
  mkdirSync(join(tmp, "cache"), { recursive: true });
});
afterEach(() => {
  Object.assign(process.env, { CORTEX_HOME: saved.home, CTX_CACHE_DIR: saved.cache, CORTEX_REGISTRY_DB: saved.reg });
  rmSync(tmp, { recursive: true, force: true });
});

function decisionsDir(repoId: string, rows: number) {
  const dir = join(tmp, ".cortex", repoId);
  mkdirSync(dir, { recursive: true });
  const db = new BetterSqlite3(join(dir, "decisions.db"));
  db.exec("CREATE TABLE decisions (id TEXT PRIMARY KEY)");
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO decisions VALUES (?)").run(`D-${i}`);
  db.close();
  return dir;
}

describe("store-gc-audit", () => {
  it("audit flags empty dirs as reapable and content orphans as archive candidates", () => {
    const emptyDir = decisionsDir("empty-id", 0);
    decisionsDir("orphan-id", 4); // has data, no live repo → archive
    const reg = new Registry();
    reg.close();
    const a = auditStores(new Registry());
    expect(a.reapable.some((r) => r.path === emptyDir)).toBe(true);
    expect(a.archiveCandidates.some((c) => c.repoId === "orphan-id")).toBe(true);
  });

  it("fix deletes empties + reapables and archives content orphans (never rm)", () => {
    const emptyDir = decisionsDir("empty-id", 0);
    const orphanDir = decisionsDir("orphan-id", 4);
    const audit = auditStores(new Registry());
    const res = fixStores(new Registry(), audit);
    expect(existsSync(emptyDir)).toBe(false); // empty deleted
    expect(existsSync(orphanDir)).toBe(false); // moved...
    expect(existsSync(join(tmp, ".cortex", "_archive", "orphan-id", "decisions.db"))).toBe(true); // ...to archive
    expect(res.archived).toContain("orphan-id");
  });

  it("computes sane per-finding byte accounting (no require, no dirSize-of-whole-cache-dir for files)", () => {
    const slugPath = join(tmp, "cache", "orphan-slug.db");
    writeFileSync(slugPath, "0123456789"); // 10 bytes
    const a = auditStores(new Registry());
    const finding = a.reapable.find((r) => r.path === slugPath);
    expect(finding).toBeDefined();
    expect(finding!.bytes).toBe(10);
  });

  it("never flags _archive or _registry.db", () => {
    mkdirSync(join(tmp, ".cortex", "_archive"), { recursive: true });
    writeFileSync(join(tmp, "cache", "_registry.db"), "x");
    const a = auditStores(new Registry());
    expect(a.reapable.some((r) => r.path.includes("_archive"))).toBe(false);
    expect(a.reapable.some((r) => r.path.endsWith("_registry.db"))).toBe(false);
    expect(a.archiveCandidates.some((c) => c.repoId === "_archive")).toBe(false);
  });
});
