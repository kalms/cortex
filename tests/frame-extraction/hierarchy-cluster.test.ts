// tests/frame-extraction/hierarchy-cluster.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
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
    const fn = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('function',?,?,?,NULL)");
    const cls = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('class',?,?,?,?)");
    // Two vocabulary-distinct groups so real TF-IDF clusters form (mirrors
    // cluster-tfidf-hdbscan.test.ts). 6 auth files + 6 billing files; the
    // blob text comes from the function/class symbol names per file.
    for (let i = 0; i < 6; i++) {
      fn.run(`authMiddleware${i}`, `src/auth/middleware_${i}.ts`, project);
      fn.run(`validateToken${i}`, `src/auth/middleware_${i}.ts`, project);
      cls.run(`SessionStore${i}`, `src/auth/middleware_${i}.ts`, project, JSON.stringify({}));
    }
    for (let i = 0; i < 6; i++) {
      cls.run(`InvoiceList${i}`, `src/billing/invoice_${i}.ts`, project, JSON.stringify({}));
      fn.run(`computeTotal${i}`, `src/billing/invoice_${i}.ts`, project);
      fn.run(`processPayment${i}`, `src/billing/invoice_${i}.ts`, project);
    }
    // Two classes sharing an in-repo base Foo → exactly one hierarchy pair.
    cls.run("Foo", "src/foo.ts", project, JSON.stringify({}));
    cls.run("A", "src/a.ts", project, JSON.stringify({ base_classes: ["Foo"] }));
    cls.run("B", "src/b.ts", project, JSON.stringify({ base_classes: ["Foo"] }));
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
    const base = runTfIdfHdbscan({ repo_path: root, project_name: project, db_path: dbPath, co_change_path: null, min_cluster_size: 3, out_path: join(root, "base.json") });
    const inert = runTfIdfHdbscan({ repo_path: root, project_name: project, db_path: dbPath, co_change_path: null, min_cluster_size: 3, hierarchy_path: hierPath, hier_gamma: 0, out_path: join(root, "inert.json") });
    expect(inert.result.parameters?.hier_pairs_loaded).toBeDefined();
    // Baseline must actually cluster (HDBSCAN ran, not the early-exit path).
    const baseNonNoise = base.result.clusters.filter((c) => c.cluster_id !== -1);
    expect(baseNonNoise.length).toBeGreaterThan(0);
    expect(JSON.stringify(inert.result.clusters)).toEqual(JSON.stringify(base.result.clusters));
  }, 30_000);
});
