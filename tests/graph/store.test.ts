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
