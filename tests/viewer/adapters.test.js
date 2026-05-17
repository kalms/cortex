// tests/viewer/adapters.test.js
import { describe, it, expect } from "vitest";
import {
  groupNodesIntoFrames,
  basenames,
  buildFrameGovernance,
  edgesInternalIndex,
} from "../../src/viewer/adapters.js";

describe("groupNodesIntoFrames", () => {
  const nodes = [
    { id: "1", kind: "file", file_path: "src/auth/a.ts", data: { frame_id: 0, frame_label: "auth" } },
    { id: "2", kind: "file", file_path: "src/auth/b.ts", data: { frame_id: 0, frame_label: "auth" } },
    { id: "3", kind: "file", file_path: "src/billing/c.ts", data: { frame_id: 1, frame_label: "billing" } },
    { id: "4", kind: "file", file_path: "src/noise.ts", data: {} },
    { id: "5", kind: "file", file_path: "src/x.ts", data: '{"frame_id": 2, "frame_label": "x"}' },
  ];

  it("buckets file nodes by data.frame_id", () => {
    const frames = groupNodesIntoFrames(nodes);
    const auth = frames.find((f) => f.frame_id === 0);
    expect(auth?.members.map((n) => n.id).sort()).toEqual(["1", "2"]);
  });

  it("uses frame_label from first node with one", () => {
    const frames = groupNodesIntoFrames(nodes);
    expect(frames.find((f) => f.frame_id === 0)?.frame_label).toBe("auth");
  });

  it("computes member_count", () => {
    const frames = groupNodesIntoFrames(nodes);
    expect(frames.find((f) => f.frame_id === 0)?.member_count).toBe(2);
  });

  it("ignores nodes without frame_id", () => {
    const frames = groupNodesIntoFrames(nodes);
    // 0, 1, 2 — 3 frames; noise file isn't in any frame.
    expect(frames.map((f) => f.frame_id).sort()).toEqual([0, 1, 2]);
  });

  it("parses string-form data (raw SQLite JSON)", () => {
    const frames = groupNodesIntoFrames(nodes);
    expect(frames.find((f) => f.frame_id === 2)?.members[0].id).toBe("5");
  });
});

describe("basenames", () => {
  it("returns up to limit basenames from file paths", () => {
    const result = basenames(
      [{ file_path: "src/a/foo.ts" }, { file_path: "src/b/bar.ts" }, { file_path: "src/c/baz.ts" }],
      2,
    );
    expect(result).toEqual(["foo.ts", "bar.ts"]);
  });

  it("handles nodes without file_path", () => {
    expect(basenames([{ file_path: undefined }, { file_path: "x.ts" }], 10)).toEqual(["x.ts"]);
  });
});

describe("buildFrameGovernance", () => {
  it("groups decision ids by frame id (from governs[] frame refs)", () => {
    const decisions = [
      { id: "d-1", governs: [{ kind: "frame", id: "0", label: "auth" }] },
      { id: "d-2", governs: [{ kind: "frame", id: "0", label: "auth" }, { kind: "file", path: "x" }] },
      { id: "d-3", governs: [{ kind: "frame", id: "1", label: "billing" }] },
      { id: "d-4", governs: [] },
    ];
    expect(buildFrameGovernance(decisions)).toEqual({
      "0": ["d-1", "d-2"],
      "1": ["d-3"],
    });
  });
});

describe("edgesInternalIndex", () => {
  it("indexes edges by node id pairs for fast lookups", () => {
    const edges = [
      { source_id: "1", target_id: "2", relation: "CALLS" },
      { source_id: "2", target_id: "3", relation: "IMPORTS" },
    ];
    const index = edgesInternalIndex(edges);
    expect(index.has("1::2")).toBe(true);
    expect(index.has("2::3")).toBe(true);
    expect(index.has("3::1")).toBe(false);
  });
});
