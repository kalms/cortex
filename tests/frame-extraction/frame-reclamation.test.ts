import { describe, it, expect } from "vitest";
import { reclaimNoise } from "../../src/frame-extraction/frame-reclamation.js";
import type { ClusterResult } from "../../src/frame-extraction/types.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string): NodeRow {
  return {
    id, kind: "function", name: id, qualified_name: `${path}::${id}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function edge(source: string, target: string, relation = "CALLS"): EdgeRow {
  return { id: `${source}->${target}:${relation}`, source_id: source, target_id: target, relation, data: "{}", created_at: "" };
}

function baseCluster(): ClusterResult {
  return {
    algorithm: "tfidf+hdbscan",
    parameters: {},
    clusters: [
      { cluster_id: 0, member_paths: ["a1.ts", "a2.ts"] },
      { cluster_id: 1, member_paths: ["b1.ts"] },
      { cluster_id: -1, member_paths: ["x.ts", "y.ts"] },
    ],
    total_files: 5,
    noise_count: 2,
  };
}
const nodes: NodeRow[] = [
  fileNode("fa1", "a1.ts"), fileNode("fa2", "a2.ts"), fileNode("fb1", "b1.ts"),
  fileNode("fx", "x.ts"), fileNode("fy", "y.ts"),
  symNode("sx", "x.ts"), symNode("sy", "y.ts"),
  symNode("sa1", "a1.ts"), symNode("sa2", "a2.ts"), symNode("sb1", "b1.ts"),
];

describe("reclaimNoise", () => {
  it("assigns a noise file to the cluster it has the most edges to", () => {
    const edges = [edge("sx", "sa1"), edge("sx", "sa2"), edge("sx", "sb1")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    const c0 = out.clusters.find((c) => c.cluster_id === 0)!;
    expect(c0.member_paths).toContain("x.ts");
    expect(c0.reclaimed_paths).toEqual(["x.ts"]);
  });

  it("leaves a noise file in noise when below the edge threshold", () => {
    const edges = [edge("sy", "sa1")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    const noise = out.clusters.find((c) => c.cluster_id === -1)!;
    expect(noise.member_paths).toContain("y.ts");
    expect(out.noise_count).toBe(2);
  });

  it("reclaims at minEdges=1 with a single qualifying edge", () => {
    const edges = [edge("sx", "sa1")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 1 });
    expect(out.clusters.find((c) => c.cluster_id === 0)!.member_paths).toContain("x.ts");
  });

  it("ignores edges from a noise file to a file in no cluster", () => {
    // z.ts is not in any cluster (not in 0/1, not in noise) — a "frameless"
    // file. x's only edge points at it, so x has no qualifying connectivity.
    const withZ = [...nodes, fileNode("fz", "z.ts"), symNode("sz", "z.ts")];
    const edges = [edge("sx", "sz"), edge("sx", "sz", "USAGE")]; // weight 2 to a frameless file
    const out = reclaimNoise(baseCluster(), withZ, edges, { minEdges: 1 });
    const noise = out.clusters.find((c) => c.cluster_id === -1)!;
    expect(noise.member_paths).toContain("x.ts");
    expect(out.clusters.find((c) => c.cluster_id === 0)!.member_paths).not.toContain("x.ts");
  });

  it("breaks argmax ties on the lowest cluster_id", () => {
    const edges = [edge("sx", "sa1"), edge("sx", "sa2"), edge("sx", "sb1"), edge("sx", "sb1", "USAGE")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    expect(out.clusters.find((c) => c.cluster_id === 0)!.member_paths).toContain("x.ts");
    expect(out.clusters.find((c) => c.cluster_id === 1)!.member_paths).not.toContain("x.ts");
  });

  it("counts CALLS/USAGE/IMPORTS and ignores other relations", () => {
    const edges = [edge("sx", "sa1", "DEFINES"), edge("sx", "sa2", "INHERITS")];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 1 });
    expect(out.clusters.find((c) => c.cluster_id === -1)!.member_paths).toContain("x.ts");
  });

  it("drops the noise cluster entirely when all files are reclaimed", () => {
    const edges = [
      edge("sx", "sa1"), edge("sx", "sa2"),
      edge("sy", "sa1"), edge("sy", "sa2"),
    ];
    const out = reclaimNoise(baseCluster(), nodes, edges, { minEdges: 2 });
    expect(out.clusters.find((c) => c.cluster_id === -1)).toBeUndefined();
    expect(out.noise_count).toBe(0);
  });

  it("is deterministic and a no-op when there is no noise cluster", () => {
    const c: ClusterResult = { ...baseCluster(), clusters: [
      { cluster_id: 0, member_paths: ["a1.ts"] },
    ], noise_count: 0 };
    expect(reclaimNoise(c, nodes, [], {})).toEqual(c);
  });
});
