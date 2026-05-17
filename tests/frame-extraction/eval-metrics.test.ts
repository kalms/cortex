// tests/frame-extraction/eval-metrics.test.ts
import { describe, it, expect } from "vitest";
import {
  agreementScore,
  clusterCount,
  noiseRate,
  buildFileToClusterMap,
} from "../../scripts/frame-extraction/eval-metrics.js";
import type { ClusterAssignment, FilePair, ImportEdge } from "../../scripts/frame-extraction/types.js";

const clusters: ClusterAssignment[] = [
  { cluster_id: 0, member_paths: ["a.ts", "b.ts", "c.ts"] },
  { cluster_id: 1, member_paths: ["d.ts", "e.ts"] },
  { cluster_id: -1, member_paths: ["noise.ts"] },
];

describe("buildFileToClusterMap", () => {
  it("returns one entry per (file, cluster_id) pair", () => {
    const m = buildFileToClusterMap(clusters);
    expect(m.get("a.ts")).toBe(0);
    expect(m.get("d.ts")).toBe(1);
    expect(m.get("noise.ts")).toBe(-1);
    expect(m.size).toBe(6);
  });
});

describe("clusterCount + noiseRate", () => {
  it("counts non-noise clusters", () => {
    expect(clusterCount(clusters)).toBe(2);
  });

  it("computes noise as a fraction of total members", () => {
    expect(noiseRate(clusters)).toBeCloseTo(1 / 6, 6);
  });

  it("noiseRate is 0 when there is no -1 cluster", () => {
    expect(noiseRate(clusters.slice(0, 2))).toBe(0);
  });
});

describe("agreementScore", () => {
  it("returns null when pairs is empty", () => {
    const m = buildFileToClusterMap(clusters);
    expect(agreementScore([], m)).toBeNull();
  });

  it("excludes pairs where either endpoint is in the noise cluster", () => {
    // Noise files aren't confidently clustered — they don't contribute
    // to numerator OR denominator of the agreement score.
    const m = buildFileToClusterMap([
      { cluster_id: -1, member_paths: ["x.ts", "y.ts"] },
    ]);
    const pairs: FilePair[] = [{ a: "x.ts", b: "y.ts", count: 5 }];
    expect(agreementScore(pairs, m)).toBeNull();
  });

  it("counts an intra-cluster pair as agreeing", () => {
    const m = buildFileToClusterMap(clusters);
    const pairs: FilePair[] = [
      { a: "a.ts", b: "b.ts", count: 3 }, // intra (both in cluster 0)
      { a: "a.ts", b: "d.ts", count: 3 }, // cross (0 vs 1)
    ];
    expect(agreementScore(pairs, m)).toBe(0.5);
  });

  it("ignores pairs where either endpoint is not in any cluster", () => {
    // Pairs that reference files not in the clustering at all (e.g. a
    // file the indexer didn't see) are dropped before computing the ratio.
    const m = buildFileToClusterMap(clusters);
    const pairs: FilePair[] = [
      { a: "a.ts", b: "b.ts", count: 1 }, // agrees
      { a: "a.ts", b: "missing.ts", count: 1 }, // dropped
    ];
    expect(agreementScore(pairs, m)).toBe(1);
  });

  it("works for ImportEdge inputs (a, b, weight) just like FilePair", () => {
    const m = buildFileToClusterMap(clusters);
    const edges: ImportEdge[] = [
      { a: "a.ts", b: "b.ts", weight: 7 },
      { a: "a.ts", b: "d.ts", weight: 1 },
    ];
    expect(agreementScore(edges, m)).toBe(0.5);
  });
});
