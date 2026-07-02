import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { GraphStore } from "../../src/graph/store.js";
import { computeHotspots } from "../../src/architecture/hotspots.js";

function makeStore(): { store: GraphStore; path: string } {
  const path = `/tmp/cortex-hot-${process.pid}-${Math.floor(performance.now())}.db`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
    CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
    -- module src/hub: two symbols, depended on by cli and db
    INSERT INTO nodes VALUES ('h1','p','a','','src/hub/a.ts','function');
    INSERT INTO nodes VALUES ('h2','p','b','','src/hub/b.ts','function');
    INSERT INTO nodes VALUES ('c1','p','c','','src/cli/c.ts','function');
    INSERT INTO nodes VALUES ('d1','p','d','','src/db/d.ts','function');
    INSERT INTO nodes VALUES ('h3','p','e','','src/hub/e.ts','function'); -- intra-module caller
    INSERT INTO edges VALUES ('p','c1','h1','CALLS');    -- cli → hub (external)
    INSERT INTO edges VALUES ('p','d1','h1','IMPORTS');  -- db  → hub (external)
    INSERT INTO edges VALUES ('p','h3','h2','CALLS');    -- hub → hub (intra, excluded)
    INSERT INTO edges VALUES ('p','c1','h1','CALLS');    -- duplicate edge (deduped)
  `);
  db.close();
  return { store: new GraphStore(path, { readonly: true }), path };
}

let made: { store: GraphStore; path: string } | null = null;
afterEach(() => {
  made?.store.close?.();
  try { if (made) unlinkSync(made.path); } catch {}
  made = null;
});

describe("computeHotspots", () => {
  it("ranks by external inbound fan-in, dedupes callers, excludes intra-module", () => {
    made = makeStore();
    const areas = computeHotspots(made.store, "p");
    expect(areas[0]).toMatchObject({ module: "hub", path: "src/hub", in_edges: 2, nodes: 3 });
    // cli and db have zero inbound → in_edges 0, ranked after hub
    expect(areas.map((a) => a.module)).toEqual(["hub", "cli", "db"]);
  });
  it("annotates governing_decisions from govern paths (display only, not ranked)", () => {
    made = makeStore();
    const areas = computeHotspots(made.store, "p", ["src/db/d.ts", "src/db/other.ts"]);
    const db = areas.find((a) => a.module === "db")!;
    expect(db.governing_decisions).toBe(2);
    // ranking still hub first despite db having decisions
    expect(areas[0].module).toBe("hub");
  });
  it("honors the limit", () => {
    made = makeStore();
    expect(computeHotspots(made.store, "p", [], { limit: 1 })).toHaveLength(1);
  });
});
