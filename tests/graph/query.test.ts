import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { getConnected, findPath } from "../../src/graph/query.js";

describe("getConnected", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("returns outgoing connections", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: a.id, target_id: c.id, relation: "CALLS" });

    const results = getConnected(store, a.id, { direction: "outgoing" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.node.name)).toContain("b");
    expect(results.map((r) => r.node.name)).toContain("c");
  });

  it("returns incoming connections", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const results = getConnected(store, b.id, { direction: "incoming" });
    expect(results).toHaveLength(1);
    expect(results[0].node.name).toBe("a");
  });

  it("filters by relation type", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: a.id, target_id: c.id, relation: "IMPORTS" });

    const results = getConnected(store, a.id, { direction: "outgoing", relation: "CALLS" });
    expect(results).toHaveLength(1);
    expect(results[0].node.name).toBe("b");
  });
});

describe("findPath", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("finds a direct path between two nodes", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const path = findPath(store, a.id, b.id);
    expect(path).not.toBeNull();
    expect(path!).toHaveLength(2);
    expect(path![0].node.name).toBe("a");
    expect(path![1].node.name).toBe("b");
  });

  it("finds a multi-hop path", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: b.id, target_id: c.id, relation: "CALLS" });

    const path = findPath(store, a.id, c.id);
    expect(path).not.toBeNull();
    expect(path!).toHaveLength(3);
  });

  it("returns null when no path exists", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });

    expect(findPath(store, a.id, b.id)).toBeNull();
  });

  it("respects maxDepth", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: b.id, target_id: c.id, relation: "CALLS" });

    expect(findPath(store, a.id, c.id, 1)).toBeNull();
    expect(findPath(store, a.id, c.id, 2)).not.toBeNull();
  });
});
