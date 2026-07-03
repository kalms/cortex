import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { cmdArchHotspots } from "../../src/cli/commands/code.js";
import { GraphStore } from "../../src/graph/store.js";

function makeStore(): { path: string } {
  const path = `/tmp/cortex-archcli-${process.pid}-${Math.floor(performance.now())}.db`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
    CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
    INSERT INTO nodes VALUES ('h1','p','a','','src/hub/a.ts','function');
    INSERT INTO nodes VALUES ('c1','p','c','','src/cli/c.ts','function');
    INSERT INTO edges VALUES ('p','c1','h1','CALLS');
  `);
  db.close();
  return { path };
}

let path = "";
afterEach(() => { try { if (path) unlinkSync(path); } catch {} path = ""; });

describe("cmdArchHotspots", () => {
  it("prints modules ranked by fan-in", () => {
    ({ path } = makeStore());
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ctx: any = { graphDbPath: path, projectName: "p", gitRoot: "/tmp", state: "indexed" };
    cmdArchHotspots(ctx, {});
    const printed = out.mock.calls.map((c) => String(c[0])).join("");
    out.mockRestore();
    expect(printed).toContain("hub");
    expect(printed.indexOf("hub")).toBeLessThan(printed.indexOf("cli"));
  });
});
