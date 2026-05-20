// tests/api/edges-adapter.test.ts
import { describe, it, expect } from "vitest";
import { buildFileEdges } from "../../src/mcp-server/api-edges.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fn(id: string, file_path: string): NodeRow {
  return {
    id,
    kind: "function",
    name: id,
    qualified_name: null,
    file_path,
    project: "p",
    tier: null,
    data: "{}",
    created_at: "",
    updated_at: "",
  } as unknown as NodeRow;
}

function edge(source_id: string, target_id: string, relation: string): EdgeRow {
  return {
    id: `e:${source_id}->${target_id}:${relation}`,
    source_id,
    target_id,
    relation,
    project: "p",
    data: "{}",
    created_at: "",
  } as unknown as EdgeRow;
}

describe("buildFileEdges — happy path", () => {
  it("aggregates CALLS edges between functions to a file-level edge", () => {
    const nodes = [
      fn("a1", "src/auth/middleware.ts"),
      fn("a2", "src/auth/token.ts"),
    ];
    const edges = [
      edge("a1", "a2", "CALLS"),
      edge("a1", "a2", "CALLS"), // second call between same files
    ];
    const result = buildFileEdges(nodes, edges, { min_weight: 1 });
    expect(result).toEqual([
      { from_path: "src/auth/middleware.ts", to_path: "src/auth/token.ts", weight: 2 },
    ]);
  });

  it("ignores non-CALLS edges by default", () => {
    const nodes = [
      fn("a1", "src/auth/middleware.ts"),
      fn("a2", "src/auth/token.ts"),
    ];
    const edges = [
      edge("a1", "a2", "IMPORTS"),
      edge("a1", "a2", "USAGE"),
    ];
    expect(buildFileEdges(nodes, edges, { min_weight: 1 })).toEqual([]);
  });

  it("uses a custom relations list when provided", () => {
    const nodes = [
      fn("a1", "src/auth/middleware.ts"),
      fn("a2", "src/auth/token.ts"),
    ];
    const edges = [edge("a1", "a2", "IMPORTS")];
    const result = buildFileEdges(nodes, edges, {
      relations: ["IMPORTS"],
      min_weight: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.weight).toBe(1);
  });
});

describe("buildFileEdges — normalization + dedup", () => {
  it("treats edges as undirected — A→B and B→A aggregate into one edge", () => {
    const nodes = [
      fn("a1", "src/a.ts"),
      fn("b1", "src/b.ts"),
    ];
    const edges = [
      edge("a1", "b1", "CALLS"),
      edge("b1", "a1", "CALLS"),
    ];
    const result = buildFileEdges(nodes, edges, { min_weight: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]?.weight).toBe(2);
    // Lexically smaller path is `from`:
    expect(result[0]?.from_path).toBe("src/a.ts");
    expect(result[0]?.to_path).toBe("src/b.ts");
  });

  it("drops self-edges (source and target in same file)", () => {
    const nodes = [
      fn("a1", "src/x.ts"),
      fn("a2", "src/x.ts"),
    ];
    const edges = [edge("a1", "a2", "CALLS")];
    expect(buildFileEdges(nodes, edges, { min_weight: 1 })).toEqual([]);
  });
});

describe("buildFileEdges — missing data", () => {
  it("skips edges whose source or target node is not in the node set", () => {
    const nodes = [fn("a1", "src/a.ts")];
    const edges = [edge("a1", "missing", "CALLS")];
    expect(buildFileEdges(nodes, edges, { min_weight: 1 })).toEqual([]);
  });

  it("skips nodes with null/empty file_path", () => {
    const nodes = [
      fn("a1", "src/a.ts"),
      { ...fn("b1", ""), file_path: null } as unknown as NodeRow,
    ];
    const edges = [edge("a1", "b1", "CALLS")];
    expect(buildFileEdges(nodes, edges, { min_weight: 1 })).toEqual([]);
  });
});

describe("buildFileEdges — threshold + sort", () => {
  it("applies min_weight threshold (default 2)", () => {
    const nodes = [
      fn("a1", "src/a.ts"),
      fn("b1", "src/b.ts"),
      fn("c1", "src/c.ts"),
    ];
    const edges = [
      edge("a1", "b1", "CALLS"), // a-b weight 1, dropped by default threshold
      edge("a1", "c1", "CALLS"),
      edge("c1", "a1", "CALLS"),  // a-c weight 2, kept
    ];
    const result = buildFileEdges(nodes, edges);
    expect(result).toHaveLength(1);
    expect(result[0]?.from_path).toBe("src/a.ts");
    expect(result[0]?.to_path).toBe("src/c.ts");
    expect(result[0]?.weight).toBe(2);
  });

  it("sorts results by weight desc, then from_path asc", () => {
    const nodes = [
      fn("a1", "src/a.ts"),
      fn("b1", "src/b.ts"),
      fn("c1", "src/c.ts"),
      fn("d1", "src/d.ts"),
    ];
    // Pair (a,b): 3 calls; pair (c,d): 5 calls; pair (a,c): 3 calls
    const edges = [
      edge("a1", "b1", "CALLS"), edge("a1", "b1", "CALLS"), edge("a1", "b1", "CALLS"),
      edge("c1", "d1", "CALLS"), edge("c1", "d1", "CALLS"), edge("c1", "d1", "CALLS"),
      edge("c1", "d1", "CALLS"), edge("c1", "d1", "CALLS"),
      edge("a1", "c1", "CALLS"), edge("a1", "c1", "CALLS"), edge("a1", "c1", "CALLS"),
    ];
    const result = buildFileEdges(nodes, edges);
    expect(result.map((e) => `${e.from_path}-${e.to_path}-${e.weight}`)).toEqual([
      "src/c.ts-src/d.ts-5",
      "src/a.ts-src/b.ts-3",  // tied at weight 3; a < c lexically
      "src/a.ts-src/c.ts-3",
    ]);
  });
});

describe("buildFileEdges — determinism", () => {
  it("produces the same output for the same input", () => {
    const nodes = [
      fn("a1", "src/a.ts"),
      fn("b1", "src/b.ts"),
    ];
    const edges = [
      edge("a1", "b1", "CALLS"),
      edge("b1", "a1", "CALLS"),
    ];
    expect(buildFileEdges(nodes, edges, { min_weight: 1 }))
      .toEqual(buildFileEdges(nodes, edges, { min_weight: 1 }));
  });
});
