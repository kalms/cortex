import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { entrypoints } from "../../src/onboarding/entrypoints.js";

let dir = "";
let dbPath = "";
afterEach(() => { try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {} dir = ""; });

function setup(pkg: object, files: string[]): GraphStore {
  dir = mkdtempSync(join(tmpdir(), "cortex-entry-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  dbPath = join(dir, "g.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);`);
  for (const [i, f] of files.entries())
    db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?)`).run(`n${i}`, "p", "x", "", f, "file");
  db.close();
  return new GraphStore(dbPath, { readonly: true });
}

describe("entrypoints", () => {
  it("reads package.json bin as command entrypoints", () => {
    const store = setup({ bin: { cortex: "bin/cortex" } }, ["src/index.ts"]);
    const eps = entrypoints(dir, store, "p");
    store.close?.();
    expect(eps).toContainEqual({ label: "cortex", target: "bin/cortex" });
  });
  it("finds conventional source entry files from the graph", () => {
    const store = setup({}, ["src/index.ts", "src/mcp-server/foo.ts"]);
    const eps = entrypoints(dir, store, "p");
    store.close?.();
    expect(eps.map((e) => e.target)).toContain("src/index.ts");
  });
  it("skips main pointing at a build artifact", () => {
    const store = setup({ main: "dist/index.js" }, ["src/index.ts"]);
    const eps = entrypoints(dir, store, "p");
    store.close?.();
    expect(eps.map((e) => e.target)).not.toContain("dist/index.js");
  });
});
