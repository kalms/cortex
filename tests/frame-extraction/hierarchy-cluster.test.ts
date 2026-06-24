// tests/frame-extraction/hierarchy-cluster.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runTfIdfHdbscan } from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { collectHierarchyPairs, writeHierarchyJsonl } from "../../src/frame-extraction/hierarchy-affinity.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";

const RUN = hasVenv() ? describe : describe.skip;
RUN("hierarchy clustering integration", () => {
  let root: string; let project: string; let dbPath: string; let hierPath: string;
  beforeAll(() => {
    root = join(tmpdir(), `cortex_hier_${Date.now()}`);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    project = root.replace(/[/:]/g, "-").replace(/-+/g, "-").replace(/^-+/, "");
    mkdirSync(join(root, ".cortex"), { recursive: true });
    dbPath = join(root, ".cortex", "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const f = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('file',?,?,?,NULL)");
    const c = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('class',?,?,?,?)");
    // 4 files with disjoint vocab so TF-IDF alone would NOT group them; two share base Foo.
    for (const [name, fp] of [["a","src/a.ts"],["b","src/b.ts"],["c","src/c.ts"],["d","src/d.ts"]] as const) f.run(name, fp, project);
    c.run("Foo", "src/foo.ts", project, JSON.stringify({}));
    c.run("A", "src/a.ts", project, JSON.stringify({ base_classes: ["Foo"] }));
    c.run("B", "src/b.ts", project, JSON.stringify({ base_classes: ["Foo"] }));
    db.close();
    hierPath = join(root, "h.jsonl");
    const rdb = new Database(dbPath, { readonly: true });
    writeHierarchyJsonl(collectHierarchyPairs(rdb, project), hierPath);
    rdb.close();
  });

  it("emits a hierarchy pair for the two Foo subclasses", () => {
    const rdb = new Database(dbPath, { readonly: true });
    const pairs = collectHierarchyPairs(rdb, project);
    rdb.close();
    expect(pairs).toEqual([{ a: "src/a.ts", b: "src/b.ts", count: 1 }]);
  });

  it("γ=0 is inert (passing a hierarchy file with hier_gamma 0 matches no-hierarchy)", () => {
    const base = runTfIdfHdbscan({ repo_path: root, project_name: project, db_path: dbPath, co_change_path: null, out_path: join(root, "base.json") });
    const inert = runTfIdfHdbscan({ repo_path: root, project_name: project, db_path: dbPath, co_change_path: null, hierarchy_path: hierPath, hier_gamma: 0, out_path: join(root, "inert.json") });
    expect(inert.result.parameters?.hier_pairs_loaded).toBeDefined();
    expect(JSON.stringify(inert.result.clusters)).toEqual(JSON.stringify(base.result.clusters));
  }, 30_000);
});
