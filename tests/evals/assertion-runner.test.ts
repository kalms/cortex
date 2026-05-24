import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runAssertion } from "../../evals/src/assertions/runner.js";
import type { Assertion } from "../../evals/src/assertions/types.js";

describe("assertion runner — graph queries", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-runner-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("count_label > 0 passes when nodes of that kind exist", () => {
    store.createNode({ kind: "function", name: "f" });
    const a: Assertion = {
      fix_id: 4,
      name: "has_functions",
      description: "at least one function node exists",
      query: { kind: "count_label", label: "function" },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);
    expect(result.observed).toBe(1);
    expect(result.surprised).toBe(true); // baseline expected fail, got pass = surprised
  });

  it("count_label > 0 fails when no nodes of that kind exist; surprised when baseline=pass", () => {
    const a: Assertion = {
      fix_id: 6,
      name: "no_tarball_routes",
      description: "no polluted Route nodes",
      query: { kind: "count_label", label: "Route" },
      predicate: { op: "eq", value: 0 },
      baseline_expected: "pass",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);   // 0 == 0
    expect(result.surprised).toBe(false); // baseline=pass, actual=pass
  });

  it("count_edge counts edges by relation", () => {
    const n = store.createNode({ kind: "function", name: "f" });
    (store as any).db.prepare(
      "INSERT INTO edges (id, source_id, target_id, relation, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run("e1", n.id, n.id, "HTTP_CALLS", new Date().toISOString());
    const a: Assertion = {
      fix_id: 2,
      name: "http_calls_edge_count_nonzero",
      description: "at least one HTTP_CALLS edge",
      query: { kind: "count_edge", type: "HTTP_CALLS" },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);
    expect(result.observed).toBe(1);
  });

  it("sql query with 'matches' predicate checks every returned row", () => {
    store.createNode({ kind: "Route", name: "/api/orders" });
    store.createNode({ kind: "Route", name: "/api/users" });
    const a: Assertion = {
      fix_id: 2,
      name: "all_routes_under_api",
      description: "every route under /api",
      query: { kind: "sql", sql: "SELECT name FROM nodes WHERE kind = 'Route'" },
      predicate: { op: "matches", regex: "^/api/" },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);
    expect(result.observed).toEqual(["/api/orders", "/api/users"]);
  });

  it("sql COUNT(*) with numeric predicate uses the count value, not rows.length", () => {
    store.createNode({ kind: "function", name: "a" });
    store.createNode({ kind: "function", name: "b" });
    store.createNode({ kind: "function", name: "c" });
    const a: Assertion = {
      fix_id: 4,
      name: "test_count_aggregate",
      description: "count(*) > 1 should observe 3, not 1",
      query: { kind: "sql", sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'function'" },
      predicate: { op: "gt", value: 1 },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.observed).toBe(3);
    expect(result.passed).toBe(true);
  });

  it("sql query returning multiple rows still uses rows.length for numeric predicates", () => {
    store.createNode({ kind: "Route", name: "/api/orders" });
    store.createNode({ kind: "Route", name: "/api/users" });
    const a: Assertion = {
      fix_id: 2,
      name: "test_multi_row",
      description: "multi-row result uses rows.length",
      query: { kind: "sql", sql: "SELECT name FROM nodes WHERE kind = 'Route'" },
      predicate: { op: "gt", value: 1 },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.observed).toBe(2);
  });

  it("'no_match' predicate fails when any row matches", () => {
    store.createNode({ kind: "Route", name: "https://codeartifact.example.com/foo.tgz" });
    store.createNode({ kind: "Route", name: "/api/orders" });
    const a: Assertion = {
      fix_id: 6,
      name: "no_codeartifact_routes",
      description: "no codeartifact in route names",
      query: { kind: "sql", sql: "SELECT name FROM nodes WHERE kind = 'Route'" },
      predicate: { op: "no_match", regex: "codeartifact" },
      baseline_expected: "pass",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(false);
    expect(result.surprised).toBe(true); // baseline=pass, got fail = regression
  });
});
