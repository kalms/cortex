// tests/frame-extraction/graph-stats.test.ts
import { describe, it, expect } from "vitest";
import { deriveGraphStats } from "../../scripts/frame-extraction/graph-stats.js";

describe("deriveGraphStats", () => {
  it("computes entity_count from function+class+method+interface+type", () => {
    const stats = deriveGraphStats({
      project: "p",
      total_nodes: 200,
      total_edges: 600,
      node_labels: [
        { label: "function", count: 100 },
        { label: "class", count: 20 },
        { label: "method", count: 10 },
        { label: "interface", count: 5 },
        { label: "type", count: 3 },
        { label: "file", count: 50 },
        { label: "folder", count: 12 },
      ],
    });
    expect(stats.entity_count).toBe(100 + 20 + 10 + 5 + 3);
    expect(stats.total_nodes).toBe(200);
    expect(stats.total_edges).toBe(600);
    expect(stats.edge_density).toBeCloseTo(600 / 200, 5);
  });

  it("edge_density is 0 when total_nodes is 0", () => {
    const stats = deriveGraphStats({
      project: "p", total_nodes: 0, total_edges: 0, node_labels: [],
    });
    expect(stats.edge_density).toBe(0);
    expect(stats.entity_count).toBe(0);
  });

  it("ignores labels not in the entity set", () => {
    const stats = deriveGraphStats({
      project: "p", total_nodes: 30, total_edges: 10,
      node_labels: [
        { label: "function", count: 5 },
        { label: "section", count: 1000 },
        { label: "channel", count: 7 },
      ],
    });
    expect(stats.entity_count).toBe(5);
  });
});
