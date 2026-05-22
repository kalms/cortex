import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { computeScorecard } from "../../evals/src/scorecard.js";

describe("scorecard", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-scorecard-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("nodes_by_label counts kinds correctly", () => {
    store.createNode({ kind: "function", name: "foo" });
    store.createNode({ kind: "function", name: "bar" });
    store.createNode({ kind: "module", name: "m1" });
    const sc = computeScorecard(dbPath, "test-project");
    expect(sc.nodes_by_label.function).toBe(2);
    expect(sc.nodes_by_label.module).toBe(1);
  });

  it("edges_by_type counts relations correctly", () => {
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    // Use raw insert because GraphStore's edge API may differ; the harness
    // queries the table directly, so we set it up the same way.
    (store as any).db.prepare(
      "INSERT INTO edges (id, source_id, target_id, relation, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run("e1", a.id, b.id, "CALLS", new Date().toISOString());
    (store as any).db.prepare(
      "INSERT INTO edges (id, source_id, target_id, relation, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run("e2", a.id, b.id, "HTTP_CALLS", new Date().toISOString());
    const sc = computeScorecard(dbPath, "test-project");
    expect(sc.edges_by_type.CALLS).toBe(1);
    expect(sc.edges_by_type.HTTP_CALLS).toBe(1);
  });

  it("killer_queries returns a list with name, row_count, sample_rows", () => {
    store.createNode({ kind: "function", name: "foo", file_path: "src/a.ts" });
    const sc = computeScorecard(dbPath, "test-project");
    expect(Array.isArray(sc.killer_queries)).toBe(true);
    const vue = sc.killer_queries.find((q) => q.name === "vue_function_count");
    expect(vue).toBeDefined();
    expect(vue?.row_count).toBe(0); // no .vue files in this fixture
  });

  it("nodes in .vue files are reflected in vue_function_count killer query", () => {
    store.createNode({ kind: "function", name: "render", file_path: "app/Card.vue" });
    store.createNode({ kind: "function", name: "setup", file_path: "app/Button.vue" });
    const sc = computeScorecard(dbPath, "test-project");
    const vue = sc.killer_queries.find((q) => q.name === "vue_function_count");
    expect(vue?.row_count).toBe(2);
  });
});
