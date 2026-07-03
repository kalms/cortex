import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdArchHeadline } from "../../src/cli/commands/code.js";

let dir = "";
afterEach(() => { try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {} dir = ""; });

describe("cmdArchHeadline", () => {
  it("prints a headline for a populated graph", () => {
    dir = mkdtempSync(join(tmpdir(), "cortex-hl-"));
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
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ctx: any = { graphDbPath: dbPath, projectName: "p", gitRoot: dir, cwd: dir, state: "indexed" };
    cmdArchHeadline(ctx, {});
    const printed = out.mock.calls.map((c) => String(c[0])).join("");
    out.mockRestore();
    expect(printed).toContain("hub");
  });
});
