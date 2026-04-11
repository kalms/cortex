import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";

describe("GraphStore", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates all tables on initialization", () => {
    store = new GraphStore(":memory:");

    const tables = store.listTables();
    expect(tables).toContain("nodes");
    expect(tables).toContain("edges");
    expect(tables).toContain("edge_annotations");
    expect(tables).toContain("decisions_fts");
  });

  it("creates indexes on initialization", () => {
    store = new GraphStore(":memory:");

    const indexes = store.listIndexes();
    expect(indexes).toContain("idx_nodes_kind");
    expect(indexes).toContain("idx_nodes_name");
    expect(indexes).toContain("idx_nodes_qualified_name");
    expect(indexes).toContain("idx_nodes_file_path");
    expect(indexes).toContain("idx_nodes_tier");
    expect(indexes).toContain("idx_edges_source");
    expect(indexes).toContain("idx_edges_target");
    expect(indexes).toContain("idx_edges_relation");
  });
});

describe("Node CRUD", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves a node", () => {
    store = new GraphStore(":memory:");

    const node = store.createNode({
      kind: "function",
      name: "handleRequest",
      qualified_name: "src/api.ts::handleRequest",
      file_path: "src/api.ts",
      data: { params: ["req", "res"], return_type: "void" },
    });

    expect(node.id).toBeDefined();
    expect(node.kind).toBe("function");
    expect(node.name).toBe("handleRequest");
    expect(node.qualified_name).toBe("src/api.ts::handleRequest");
    expect(node.file_path).toBe("src/api.ts");
    expect(JSON.parse(node.data)).toEqual({ params: ["req", "res"], return_type: "void" });
    expect(node.tier).toBe("personal");
    expect(node.created_at).toBeDefined();
    expect(node.updated_at).toBeDefined();

    const retrieved = store.getNode(node.id);
    expect(retrieved).toEqual(node);
  });

  it("returns undefined for non-existent node", () => {
    store = new GraphStore(":memory:");
    expect(store.getNode("non-existent")).toBeUndefined();
  });

  it("updates a node", () => {
    store = new GraphStore(":memory:");

    const node = store.createNode({ kind: "function", name: "old" });
    const updated = store.updateNode(node.id, { name: "new", tier: "team" });

    expect(updated.name).toBe("new");
    expect(updated.tier).toBe("team");
    expect(updated.updated_at).not.toBe(node.updated_at);
  });

  it("throws when updating non-existent node", () => {
    store = new GraphStore(":memory:");
    expect(() => store.updateNode("fake", { name: "x" })).toThrow("Node not found: fake");
  });

  it("deletes a node", () => {
    store = new GraphStore(":memory:");

    const node = store.createNode({ kind: "function", name: "temp" });
    store.deleteNode(node.id);

    expect(store.getNode(node.id)).toBeUndefined();
  });

  it("finds nodes by filter", () => {
    store = new GraphStore(":memory:");

    store.createNode({ kind: "function", name: "a", file_path: "src/a.ts" });
    store.createNode({ kind: "function", name: "b", file_path: "src/b.ts" });
    store.createNode({ kind: "component", name: "c", file_path: "src/c.vue" });

    expect(store.findNodes({ kind: "function" })).toHaveLength(2);
    expect(store.findNodes({ file_path: "src/a.ts" })).toHaveLength(1);
    expect(store.findNodes({ kind: "component" })).toHaveLength(1);
    expect(store.findNodes({})).toHaveLength(3);
  });
});

describe("Edge CRUD", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves an edge", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "caller" });
    const b = store.createNode({ kind: "function", name: "callee" });

    const edge = store.createEdge({
      source_id: a.id,
      target_id: b.id,
      relation: "CALLS",
    });

    expect(edge.id).toBeDefined();
    expect(edge.source_id).toBe(a.id);
    expect(edge.target_id).toBe(b.id);
    expect(edge.relation).toBe("CALLS");

    const retrieved = store.getEdge(edge.id);
    expect(retrieved).toEqual(edge);
  });

  it("deletes an edge", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    store.deleteEdge(edge.id);
    expect(store.getEdge(edge.id)).toBeUndefined();
  });

  it("cascade-deletes edges when a node is deleted", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    store.deleteNode(a.id);
    expect(store.findEdges({ source_id: a.id })).toHaveLength(0);
  });

  it("finds edges by filter", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });

    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: a.id, target_id: c.id, relation: "IMPORTS" });

    expect(store.findEdges({ source_id: a.id })).toHaveLength(2);
    expect(store.findEdges({ relation: "CALLS" })).toHaveLength(1);
    expect(store.findEdges({ target_id: b.id })).toHaveLength(1);
  });
});

describe("Edge Annotation CRUD", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves an annotation", () => {
    store = new GraphStore(":memory:");
    const decision = store.createNode({ kind: "decision", name: "Use REST" });
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const annotation = store.createAnnotation({
      decision_id: decision.id,
      edge_id: edge.id,
    });

    expect(annotation.id).toBeDefined();
    expect(annotation.decision_id).toBe(decision.id);
    expect(annotation.edge_id).toBe(edge.id);
  });

  it("finds annotations by decision_id", () => {
    store = new GraphStore(":memory:");
    const decision = store.createNode({ kind: "decision", name: "d" });
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createAnnotation({ decision_id: decision.id, edge_id: edge.id });

    expect(store.findAnnotations({ decision_id: decision.id })).toHaveLength(1);
  });

  it("cascade-deletes annotations when edge is deleted", () => {
    store = new GraphStore(":memory:");
    const decision = store.createNode({ kind: "decision", name: "d" });
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createAnnotation({ decision_id: decision.id, edge_id: edge.id });

    store.deleteEdge(edge.id);
    expect(store.findAnnotations({ decision_id: decision.id })).toHaveLength(0);
  });
});
