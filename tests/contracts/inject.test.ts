import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CREATE_TABLES } from "../../src/graph/schema.js";
import { injectContracts } from "../../src/contracts/inject.js";
import type { Binding } from "../../src/contracts/types.js";

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "contracts-db-"));
  const path = join(dir, "db");
  const db = new Database(path);
  db.exec(CREATE_TABLES);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO nodes (id,kind,name,file_path,data,tier,created_at,updated_at,project)
              VALUES ('n1','file','code-tools.ts','src/mcp-server/tools/code-tools.ts','{}','personal',?,?,'P')`).run(now, now);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const consumer: Binding = { tool: "detect_changes", role: "consumes", keys: ["repo_path"], file: "src/mcp-server/tools/code-tools.ts", symbol: "code-tools.ts", line: 5 };

describe("injectContracts", () => {
  it("creates an Anchor node and a BINDS_KEY edge from the file node", () => {
    const { path, cleanup } = tmpDb();
    try {
      injectContracts({ bindings: [consumer], project: "P", dbPath: path });
      const db = new Database(path, { readonly: true });
      const anchor = db.prepare(`SELECT id,kind,name FROM nodes WHERE kind='anchor' AND project='P'`).get() as any;
      expect(anchor).toMatchObject({ kind: "anchor", name: "detect_changes" });
      const edge = db.prepare(`SELECT source_id,target_id,relation,data FROM edges WHERE relation='BINDS_KEY' AND project='P'`).get() as any;
      expect(edge.source_id).toBe("n1");
      expect(edge.target_id).toBe(anchor.id);
      expect(JSON.parse(edge.data)).toMatchObject({ role: "consumes", keys: ["repo_path"] });
      db.close();
    } finally { cleanup(); }
  });

  it("is idempotent — re-running replaces prior anchors/edges, not appends", () => {
    const { path, cleanup } = tmpDb();
    try {
      injectContracts({ bindings: [consumer], project: "P", dbPath: path });
      injectContracts({ bindings: [consumer], project: "P", dbPath: path });
      const db = new Database(path, { readonly: true });
      const n = db.prepare(`SELECT COUNT(*) c FROM edges WHERE relation='BINDS_KEY' AND project='P'`).get() as any;
      expect(n.c).toBe(1);
      db.close();
    } finally { cleanup(); }
  });

  it("skips a binding whose source file has no node, writing nothing", () => {
    const { path, cleanup } = tmpDb();
    try {
      const orphan: Binding = { tool: "ghost", role: "consumes", keys: ["x"], file: "src/does/not/exist.ts", symbol: "s", line: 1 };
      const written = injectContracts({ bindings: [orphan], project: "P", dbPath: path });
      expect(written).toBe(0);
      const db = new Database(path, { readonly: true });
      const edges = db.prepare(`SELECT COUNT(*) c FROM edges WHERE relation='BINDS_KEY' AND project='P'`).get() as any;
      expect(edges.c).toBe(0);
      // anchor node is still created for the tool, but no edge attaches
      db.close();
    } finally { cleanup(); }
  });

  it("creates ONE anchor but TWO edges for a tool bound twice (e.g. consumer + provider)", () => {
    const { path, cleanup } = tmpDb();
    try {
      // tmpDb only has the 'n1' file node for code-tools.ts; add a second file node for the provider.
      const seed = new Database(path);
      const now = new Date().toISOString();
      seed.prepare(`INSERT INTO nodes (id,kind,name,file_path,data,tier,created_at,updated_at,project)
                    VALUES ('n2','file','handlers.c','internal/indexer/src/handlers/handlers.c','{}','personal',?,?,'P')`).run(now, now);
      seed.close();
      const consumes: Binding = { tool: "detect_changes", role: "consumes", keys: ["repo_path"], file: "src/mcp-server/tools/code-tools.ts", symbol: "s", line: 5 };
      const provides: Binding = { tool: "detect_changes", role: "provides", keys: ["project"], file: "internal/indexer/src/handlers/handlers.c", symbol: "handle_detect_changes", line: 10 };
      const written = injectContracts({ bindings: [consumes, provides], project: "P", dbPath: path });
      expect(written).toBe(2);
      const db = new Database(path, { readonly: true });
      const anchors = db.prepare(`SELECT COUNT(*) c FROM nodes WHERE kind='anchor' AND project='P'`).get() as any;
      const edges = db.prepare(`SELECT COUNT(*) c FROM edges WHERE relation='BINDS_KEY' AND project='P'`).get() as any;
      expect(anchors.c).toBe(1);
      expect(edges.c).toBe(2);
      db.close();
    } finally { cleanup(); }
  });
});
