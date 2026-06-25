// tests/viewer/adapters.test.js
import { describe, it, expect } from "vitest";
import {
  groupNodesIntoFrames,
  basenames,
  buildFrameGovernance,
  buildGovernance,
  buildSpawnsFromIndex,
  filterAmbientTodos,
  todoDotColor,
  withGovernedFramesRendered,
  edgesInternalIndex,
  frameCoverage,
  buildFramePathIndex,
  frameIdForPath,
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

describe("buildFramePathIndex + frameIdForPath", () => {
  // grouped-summary shape, as built near viewer.js step 4: members carry file_path.
  const summaries = [
    { frame_id: 0, frame_label: "auth", members: [{ file_path: "src/auth/a.ts" }, { file_path: "src/auth/b.ts" }] },
    { frame_id: 1, frame_label: "saleor/graphql", members: [{ file_path: "saleor/graphql/schema.ts" }] },
  ];

  it("maps each member file_path to its frame id as a STRING", () => {
    const idx = buildFramePathIndex(summaries);
    expect(idx.get("src/auth/a.ts")).toBe("0");
    expect(idx.get("saleor/graphql/schema.ts")).toBe("1");
  });

  it("resolves an exact member file to its frame", () => {
    const idx = buildFramePathIndex(summaries);
    expect(frameIdForPath(idx, "src/auth/b.ts")).toBe("0");
  });

  it("resolves a directory-level governed path to the frame of a member under it", () => {
    const idx = buildFramePathIndex(summaries);
    expect(frameIdForPath(idx, "saleor/graphql")).toBe("1");
  });

  it("does NOT match by label resemblance — only real membership", () => {
    // "auth/ghost.ts" is not a member of any frame; the old label-prefix matcher
    // (path.startsWith(label + '/')) would have matched the 'auth' frame. It must not.
    const idx = buildFramePathIndex(summaries);
    expect(frameIdForPath(idx, "auth/ghost.ts")).toBeNull();
  });

  it("returns null for an unrelated path and for an empty path", () => {
    const idx = buildFramePathIndex(summaries);
    expect(frameIdForPath(idx, "lib/unrelated.ts")).toBeNull();
    expect(frameIdForPath(idx, "")).toBeNull();
    expect(frameIdForPath(idx, null)).toBeNull();
  });
});

describe("frameCoverage", () => {
  it("flags zeroFrames when file nodes exist but none carry a frame_id", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: {} },
      { id: "2", kind: "file", file_path: "src/b.ts", data: {} },
      { id: "3", kind: "function", name: "foo", data: {} },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 2, framedNodes: 0, zeroFrames: true });
  });

  it("does not flag when at least one file node has a frame_id", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: { frame_id: 0, frame_label: "auth" } },
      { id: "2", kind: "file", file_path: "src/b.ts", data: {} },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 2, framedNodes: 1, zeroFrames: false });
  });

  it("does not flag a project with no file nodes (unindexed / empty)", () => {
    const nodes = [{ id: "1", kind: "function", name: "foo", data: {} }];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 0, framedNodes: 0, zeroFrames: false });
  });

  it("parses stringified data JSON like the rest of the adapter", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: '{"frame_id":2,"frame_label":"x"}' },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 1, framedNodes: 1, zeroFrames: false });
  });

  it("ignores frame_id that is not a number", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: { frame_id: null } },
      { id: "2", kind: "file", file_path: "src/b.ts", data: { frame_id: "0" } },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 2, framedNodes: 0, zeroFrames: true });
  });
});

describe("withGovernedFramesRendered", () => {
  const meta = new Map([
    ["5", { name: "extract", w: 90, h: 70, count: 11 }],
    ["8", { name: "cluster:8", w: 80, h: 60, count: 4 }],
  ]);

  it("promotes governed frames missing from the rendered (ambient) set", () => {
    const ambient = [{ id: "6", name: "extract", x: 0.5, y: 0.5, w: 100, h: 80 }];
    const gov = { "5": ["D-42kw"], "8": ["D-sheh"] };
    const out = withGovernedFramesRendered(ambient, gov, meta);
    const ids = out.map((f) => String(f.id));
    expect(ids).toContain("5");
    expect(ids).toContain("8");
    expect(ids).toContain("6"); // ambient preserved
    const five = out.find((f) => f.id === "5");
    expect(five.promotedForGovernance).toBe(true);
    expect(five.name).toBe("extract");
    // positioned (normalized, on the reserved strip) so the renderer can draw it
    expect(five.x).toBeGreaterThanOrEqual(0);
    expect(five.x).toBeLessThanOrEqual(1);
    expect(five.y).toBeGreaterThan(0);
  });

  it("does not duplicate a governed frame already in the ambient set", () => {
    const ambient = [{ id: "5", name: "extract", x: 0.4, y: 0.4, w: 100, h: 80 }];
    const out = withGovernedFramesRendered(ambient, { "5": ["D-42kw"] }, meta);
    expect(out.filter((f) => String(f.id) === "5")).toHaveLength(1);
    expect(out).toBe(ambient); // nothing missing → same array, no work
  });

  it("returns the input unchanged when there is no governance", () => {
    const ambient = [{ id: "1", x: 0.2, y: 0.2, w: 100, h: 80 }];
    expect(withGovernedFramesRendered(ambient, {}, meta)).toBe(ambient);
  });
});

describe("buildGovernance / buildFrameGovernance", () => {
  const items = [
    { id: "T-1", governs: [{ kind: "frame", id: "3" }, { kind: "file", path: "a.ts" }] },
    { id: "T-2", governs: [{ kind: "frame", id: "3" }] },
  ];
  it("rolls frame-governed entities up by frame id, deduped", () => {
    expect(buildGovernance(items)).toEqual({ "3": ["T-1", "T-2"] });
  });
  it("buildFrameGovernance stays a wrapper over buildGovernance", () => {
    const decs = [{ id: "D-1", governs: [{ kind: "frame", id: "5" }] }];
    expect(buildFrameGovernance(decs)).toEqual({ "5": ["D-1"] });
  });
});

describe("buildSpawnsFromIndex", () => {
  it("maps decision id -> child todo ids, ignoring null", () => {
    const todos = [
      { id: "T-1", spawnsFrom: "D-9" },
      { id: "T-2", spawnsFrom: "D-9" },
      { id: "T-3", spawnsFrom: null },
    ];
    expect(buildSpawnsFromIndex(todos)).toEqual({ "D-9": ["T-1", "T-2"] });
  });
});

describe("filterAmbientTodos", () => {
  it("drops done and cancelled, keeps open/in_progress/blocked", () => {
    const todos = [
      { id: "T-1", state: "open" }, { id: "T-2", state: "in_progress" },
      { id: "T-3", state: "blocked" }, { id: "T-4", state: "done" },
      { id: "T-5", state: "cancelled" },
    ];
    expect(filterAmbientTodos(todos).map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
  });
});

describe("todoDotColor", () => {
  it("open -> solid yellow, no ring", () => {
    expect(todoDotColor("open")).toEqual({ rgb: [250, 204, 21], ring: null });
  });
  it("blocked -> yellow + amber ring", () => {
    expect(todoDotColor("blocked")).toEqual({ rgb: [250, 204, 21], ring: [245, 158, 11] });
  });
  it("in_progress -> yellow base (identity color applied at draw time), no ring", () => {
    expect(todoDotColor("in_progress")).toEqual({ rgb: [250, 204, 21], ring: null });
  });
});
