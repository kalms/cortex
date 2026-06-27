import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { blastRadius } from "../../src/briefing/blast-radius.js";

function makeStore(): { store: GraphStore; path: string } {
  const path = `/tmp/cortex-brief-${process.pid}-${Math.floor(performance.now())}.db`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
    CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
    INSERT INTO nodes VALUES ('t','p','bar','src/foo.ts::bar','src/foo.ts','function');
    INSERT INTO nodes VALUES ('self','p','helper','src/foo.ts::helper','src/foo.ts','function');
    INSERT INTO nodes VALUES ('c1','p','a','src/a.ts::a','src/a.ts','function');
    INSERT INTO nodes VALUES ('c2','p','b','src/b.ts::b','src/b.ts','function');
    INSERT INTO edges VALUES ('p','c1','t','CALLS');
    INSERT INTO edges VALUES ('p','c2','t','IMPORTS');
    INSERT INTO edges VALUES ('p','self','t','CALLS');   -- internal, excluded for file target
  `);
  db.close();
  return { store: new GraphStore(path, { readonly: true }), path };
}

let made: { store: GraphStore; path: string } | null = null;
afterEach(() => { made?.store.close?.(); made = null; });

describe("blastRadius", () => {
  it("counts distinct external callers of a qn", () => {
    made = makeStore();
    expect(blastRadius(made.store, "p", "src/foo.ts::bar")).toBe(3);
  });
  it("excludes same-file callers for a file-path target", () => {
    made = makeStore();
    // file target counts callers into any node of src/foo.ts, minus internal (self)
    expect(blastRadius(made.store, "p", "src/foo.ts")).toBe(2);
  });
});
