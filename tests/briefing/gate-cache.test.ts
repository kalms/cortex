import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { buildGateSet } from "../../src/briefing/gate-cache.js";

let store: GraphStore | null = null;
afterEach(() => { store?.close?.(); store = null; });

function makeStore(): GraphStore {
  const path = `/tmp/cortex-gatecache-${process.pid}-${Math.floor(performance.now())}.db`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
    CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
    INSERT INTO nodes VALUES ('h','p','hub','src/hub.ts::hub','src/hub.ts','function');
    INSERT INTO nodes VALUES ('q','p','quiet','src/quiet.ts::q','src/quiet.ts','function');
  `);
  // 2 distinct callers into hub → fanin 2; threshold 2 includes src/hub.ts
  db.exec(`INSERT INTO nodes VALUES ('c1','p','c1','src/c1.ts::c1','src/c1.ts','function');
           INSERT INTO nodes VALUES ('c2','p','c2','src/c2.ts::c2','src/c2.ts','function');
           INSERT INTO edges VALUES ('p','c1','h','CALLS'); INSERT INTO edges VALUES ('p','c2','h','IMPORTS');`);
  db.close();
  return new GraphStore(path, { readonly: true });
}

describe("buildGateSet", () => {
  it("includes governed paths and high-fanout files, deduped", () => {
    store = makeStore();
    const links = { findGovernedPaths: () => ["src/governed.ts", "src/hub.ts"] } as any; // active GOVERNS paths
    const set = buildGateSet({ decisionsLinks: links, store, project: "p", fanoutThreshold: 2 });
    expect(set).toContain("src/governed.ts"); // governed-only
    expect(set).toContain("src/hub.ts");      // governed AND high-fanout → once (dedup)
    expect(set.filter((e) => e === "src/hub.ts").length).toBe(1);
    expect(set).not.toContain("src/quiet.ts"); // not governed, fanin 0
  });
});
