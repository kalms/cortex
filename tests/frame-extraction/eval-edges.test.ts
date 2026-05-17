// tests/frame-extraction/eval-edges.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { collectCallsEdges } from "../../scripts/frame-extraction/eval-edges.js";

let root: string;
let db: Database.Database;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-eval-edges-"));
  db = new Database(join(root, "graph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      project TEXT
    );
    CREATE TABLE edges (
      source_id TEXT,
      target_id TEXT,
      relation  TEXT
    );
  `);
  // Two function nodes per file.
  const insN = db.prepare(
    "INSERT INTO nodes (id, kind, name, file_path, project) VALUES (?, ?, ?, ?, ?)",
  );
  insN.run("a1", "function", "a1", "src/auth.ts", "p");
  insN.run("a2", "function", "a2", "src/auth.ts", "p");
  insN.run("b1", "function", "b1", "src/billing.ts", "p");
  insN.run("c1", "function", "c1", "src/api.ts", "p");
  insN.run("e1", "function", "external", null, "p");
  insN.run("o1", "function", "other", "src/x.ts", "other_project");

  const insE = db.prepare(
    "INSERT INTO edges (source_id, target_id, relation) VALUES (?, ?, ?)",
  );
  // Cross-file CALLS: src/auth.ts → src/billing.ts (counts as 2 weight via dedupe)
  insE.run("a1", "b1", "CALLS");
  insE.run("a2", "b1", "CALLS");
  // Cross-file CALLS: src/auth.ts → src/api.ts (weight 1)
  insE.run("a1", "c1", "CALLS");
  // Intra-file CALLS: same file both ends — must be dropped
  insE.run("a1", "a2", "CALLS");
  // Edge with NULL endpoint file_path — must be dropped
  insE.run("a1", "e1", "CALLS");
  // Edge in another project — must be dropped (we scope to project p)
  insE.run("a1", "o1", "CALLS");
  // Non-CALLS edge — must be dropped
  insE.run("a1", "b1", "IMPORTS");
});

afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("collectCallsEdges", () => {
  it("aggregates cross-file CALLS into ImportEdge[] with sorted endpoints", () => {
    const edges = collectCallsEdges(db, "p");
    const ab = edges.find((e) => e.a === "src/auth.ts" && e.b === "src/billing.ts");
    const ac = edges.find((e) => e.a === "src/api.ts" && e.b === "src/auth.ts");
    expect(ab?.weight).toBe(2);
    expect(ac?.weight).toBe(1);
  });

  it("drops intra-file calls, NULL-path endpoints, other projects, and non-CALLS relations", () => {
    const edges = collectCallsEdges(db, "p");
    expect(edges.some((e) => e.a === "src/auth.ts" && e.b === "src/auth.ts")).toBe(false);
    expect(edges.some((e) => /\bexternal\b/.test(e.a) || /\bexternal\b/.test(e.b))).toBe(false);
    expect(edges.some((e) => e.a === "src/x.ts" || e.b === "src/x.ts")).toBe(false);
  });

  it("returns edges sorted by weight desc", () => {
    const edges = collectCallsEdges(db, "p");
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i - 1]!.weight).toBeGreaterThanOrEqual(edges[i]!.weight);
    }
  });
});
