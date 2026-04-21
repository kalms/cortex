import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";

describe("FTS5 Search", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("indexes and searches decision content", () => {
    store = new GraphStore(":memory:");
    const node = store.createNode({ kind: "decision", name: "Use Redis for caching" });
    store.indexDecisionContent(node.id, "Use Redis for caching", { description: "We need a fast cache layer", rationale: "Redis supports TTL and pub/sub" });

    const results = store.searchDecisionContent("caching");
    expect(results).toHaveLength(1);
    expect(results[0].node_id).toBe(node.id);
  });

  it("searches across title, description, and rationale", () => {
    store = new GraphStore(":memory:");
    const n1 = store.createNode({ kind: "decision", name: "d1" });
    const n2 = store.createNode({ kind: "decision", name: "d2" });
    const n3 = store.createNode({ kind: "decision", name: "d3" });

    store.indexDecisionContent(n1.id, "authentication with JWT", { description: "desc1", rationale: "rationale1" });
    store.indexDecisionContent(n2.id, "title2", { description: "authentication flow described here", rationale: "rationale2" });
    store.indexDecisionContent(n3.id, "title3", { description: "desc3", rationale: "authentication is critical for security" });

    const results = store.searchDecisionContent("authentication");
    expect(results).toHaveLength(3);
  });

  it("updates indexed content", () => {
    store = new GraphStore(":memory:");
    const node = store.createNode({ kind: "decision", name: "d1" });
    store.indexDecisionContent(node.id, "old title", { description: "old desc", rationale: "old rationale" });
    store.updateDecisionContent(node.id, "new title about Redis", { description: "new desc", rationale: "new rationale" });

    expect(store.searchDecisionContent("old")).toHaveLength(0);
    expect(store.searchDecisionContent("Redis")).toHaveLength(1);
  });

  it("removes indexed content", () => {
    store = new GraphStore(":memory:");
    const node = store.createNode({ kind: "decision", name: "d1" });
    store.indexDecisionContent(node.id, "searchable", { description: "desc", rationale: "rationale" });
    store.removeDecisionContent(node.id);

    expect(store.searchDecisionContent("searchable")).toHaveLength(0);
  });

  it("returns empty array for no matches", () => {
    store = new GraphStore(":memory:");
    expect(store.searchDecisionContent("nonexistent")).toHaveLength(0);
  });
});
