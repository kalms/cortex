import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { composeOnboarding } from "../../src/onboarding/compose.js";

let dir = "";
afterEach(() => { try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {} dir = ""; });

describe("composeOnboarding", () => {
  it("returns a headline naming hotspots for a populated graph", () => {
    dir = mkdtempSync(join(tmpdir(), "cortex-onb-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: { cortex: "bin/cortex" } }));
    const dbPath = join(dir, "g.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
      CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
      INSERT INTO nodes VALUES ('h1','p','a','','src/hub/a.ts','function');
      INSERT INTO nodes VALUES ('c1','p','c','','src/cli/c.ts','function');
      INSERT INTO edges VALUES ('p','c1','h1','CALLS');
    `);
    db.close();
    const store = new GraphStore(dbPath, { readonly: true });
    const { headline } = composeOnboarding({ store, project: "p", root: dir });
    store.close?.();
    expect(headline).toContain("hub");
    expect(headline).toContain("bin/cortex");
  });
  it("returns empty headline for an empty graph", () => {
    dir = mkdtempSync(join(tmpdir(), "cortex-onb-"));
    const dbPath = join(dir, "g.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
      CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
    `);
    db.close();
    const store = new GraphStore(dbPath, { readonly: true });
    const { headline } = composeOnboarding({ store, project: "p", root: dir });
    store.close?.();
    expect(headline).toBe("");
  });
});
