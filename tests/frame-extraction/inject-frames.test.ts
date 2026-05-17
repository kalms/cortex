// tests/frame-extraction/inject-frames.test.ts
import { describe, it, expect } from "vitest";
import {
  pickFrameLabel,
  buildFrameAssignments,
} from "../../scripts/frame-extraction/inject-frames.js";
import type { ClusterResult } from "../../scripts/frame-extraction/types.js";

describe("pickFrameLabel", () => {
  it("returns the first non-generic top token", () => {
    expect(pickFrameLabel(["src", "auth", "token"])).toBe("auth");
  });

  it("falls back to cluster:<id> when all tokens are generic", () => {
    expect(pickFrameLabel(["src", "index", "util"], 7)).toBe("cluster:7");
  });

  it("falls back to cluster:<id> when no top tokens at all", () => {
    expect(pickFrameLabel([], 3)).toBe("cluster:3");
  });

  it("is case-insensitive in the stop list", () => {
    expect(pickFrameLabel(["SRC", "UTIL", "billing"])).toBe("billing");
  });
});

describe("buildFrameAssignments", () => {
  const cluster: ClusterResult = {
    algorithm: "tfidf+hdbscan",
    parameters: {
      top_tokens_per_cluster: {
        "0": ["auth", "token"],
        "1": ["billing", "invoice"],
      },
    },
    clusters: [
      { cluster_id: 0, member_paths: ["src/auth/a.ts", "src/auth/b.ts"] },
      { cluster_id: 1, member_paths: ["src/billing/c.ts"] },
      { cluster_id: -1, member_paths: ["src/noise.ts"] },
    ],
    total_files: 4,
    noise_count: 1,
  };

  it("emits one assignment per file in non-noise clusters", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments).toEqual([
      { file_path: "src/auth/a.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0 },
      { file_path: "src/auth/b.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0 },
      { file_path: "src/billing/c.ts", frame_id: 1, frame_label: "billing", frame_confidence: 1.0 },
    ]);
  });

  it("does not emit assignments for noise (cluster_id = -1)", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments.some((a) => a.file_path === "src/noise.ts")).toBe(false);
  });

  it("uses cluster:<id> fallback when top_tokens_per_cluster is missing", () => {
    const minimalCluster: ClusterResult = {
      ...cluster,
      parameters: {},
      clusters: [{ cluster_id: 5, member_paths: ["src/x.ts"] }],
    };
    const assignments = buildFrameAssignments(minimalCluster);
    expect(assignments[0]?.frame_label).toBe("cluster:5");
  });
});
