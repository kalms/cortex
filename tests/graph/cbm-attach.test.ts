import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { searchGraph, getGraphSchema, tracePath, listProjects, indexStatus } from "../../src/graph/cbm-queries.js";
import { discoverCbmDb } from "../../src/graph/cbm-discovery.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createTestCbmDb(dir: string): string {
  const dbPath = join(dir, "test-cbm.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE projects (
      name TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL,
      root_path TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      label TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      start_line INTEGER DEFAULT 0,
      end_line INTEGER DEFAULT 0,
      properties TEXT DEFAULT '{}'
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      properties TEXT DEFAULT '{}'
    );
    INSERT INTO projects VALUES ('test', '2026-04-13T00:00:00Z', '/test/repo');
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Function', 'handleRequest', 'test.src.server.handleRequest', 'src/server.ts', 10, 25);
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Function', 'parseBody', 'test.src.server.parseBody', 'src/server.ts', 30, 45);
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Class', 'Router', 'test.src.router.Router', 'src/router.ts', 1, 80);
    INSERT INTO edges (project, source_id, target_id, type)
      VALUES ('test', 1, 2, 'CALLS');
    INSERT INTO edges (project, source_id, target_id, type)
      VALUES ('test', 3, 1, 'CALLS');
  `);
  db.close();
  return dbPath;
}

describe("CBM ATTACH", () => {
  let store: GraphStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches a CBM database and reports attached state", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    expect(store.isCbmAttached()).toBe(false);
    store.attachCbm(cbmPath);
    expect(store.isCbmAttached()).toBe(true);
  });

  it("returns false for isCbmAttached when no db attached", () => {
    expect(store.isCbmAttached()).toBe(false);
  });

  it("handles missing CBM database gracefully", () => {
    expect(() => store.attachCbm("/nonexistent/path.db")).not.toThrow();
    expect(store.isCbmAttached()).toBe(false);
  });

  it("searchGraph finds nodes by name pattern", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const results = searchGraph(store, "test", { name_pattern: "handle" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("handleRequest");
    expect(results[0].label).toBe("Function");
  });

  it("searchGraph finds nodes by label", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const results = searchGraph(store, "test", { label: "Class" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Router");
  });

  it("searchGraph finds nodes by qualified name pattern", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const results = searchGraph(store, "test", { qn_pattern: "test.src.router%" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Router");
  });

  it("getGraphSchema returns distinct labels and edge types with counts", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const schema = getGraphSchema(store, "test");
    // labels and edgeTypes are now {name, count}[] objects
    expect(schema.labels.map((l) => l.name)).toContain("Function");
    expect(schema.labels.map((l) => l.name)).toContain("Class");
    expect(schema.edgeTypes.map((e) => e.name)).toContain("CALLS");
    // counts are numeric
    const funcEntry = schema.labels.find((l) => l.name === "Function");
    expect(funcEntry?.count).toBeGreaterThanOrEqual(1);
  });

  it("tracePath follows CALLS edges outbound", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const results = tracePath(store, "test", { function_name: "handleRequest", mode: "calls" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // results are now {node, depth}[] — extract .node for name checks
    expect(results.some((r) => r.node.name === "parseBody")).toBe(true);
    // depth 1 = direct callee
    expect(results[0].depth).toBe(1);
  });

  it("tracePath follows CALLS edges inbound", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const results = tracePath(store, "test", { function_name: "handleRequest", mode: "callers" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // results are now {node, depth}[] — extract .node for name checks
    expect(results.some((r) => r.node.name === "Router")).toBe(true);
  });

  it("listProjects returns all CBM projects", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const projects = listProjects(store);
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe("test");
    expect(projects[0].root_path).toBe("/test/repo");
  });

  it("indexStatus returns project info for matching path", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const status = indexStatus(store, "/test/repo");
    expect(status).not.toBeNull();
    expect(status!.name).toBe("test");
  });

  it("indexStatus returns null for unindexed path", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const status = indexStatus(store, "/nonexistent");
    expect(status).toBeNull();
  });

  it("discoverCbmDb finds database by root_path match", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    const found = discoverCbmDb("/test/repo", tmpDir);
    expect(found).toBe(cbmPath);
  });

  it("discoverCbmDb returns null when no match", () => {
    createTestCbmDb(tmpDir);
    const found = discoverCbmDb("/nonexistent", tmpDir);
    expect(found).toBeNull();
  });

  it("discoverCbmDb uses explicit path if provided", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    const found = discoverCbmDb("/whatever", tmpDir, cbmPath);
    expect(found).toBe(cbmPath);
  });

  it("getAllNodesUnified returns nodes from both stores", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);

    // Create a decision node in Cortex's store
    store.createNode({ kind: "decision", name: "Use Express", data: { description: "test" } });

    const nodes = store.getAllNodesUnified("test");
    const cortexNodes = nodes.filter((n) => !n.id.startsWith("cbm-"));
    const cbmNodes = nodes.filter((n) => n.id.startsWith("cbm-"));

    expect(cortexNodes.length).toBe(1);
    expect(cortexNodes[0].name).toBe("Use Express");
    expect(cbmNodes.length).toBe(3); // handleRequest, parseBody, Router
    expect(cbmNodes[0].kind).toBe("function"); // lowercase mapped
  });

  it("getAllEdgesUnified returns edges from both stores", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);

    const edges = store.getAllEdgesUnified("test");
    const cbmEdges = edges.filter((e) => e.id.startsWith("cbm-"));

    expect(cbmEdges.length).toBe(2); // two CALLS edges
    expect(cbmEdges[0].source_id.startsWith("cbm-")).toBe(true);
    expect(cbmEdges[0].relation).toBe("CALLS");
  });

  it("getAllNodesUnified works without CBM attached", () => {
    store.createNode({ kind: "decision", name: "Test decision" });
    const nodes = store.getAllNodesUnified();
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe("Test decision");
  });
});
