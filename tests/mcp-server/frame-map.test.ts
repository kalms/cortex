import { describe, it, expect } from "vitest";
import { buildFrameMap } from "../../src/frame-extraction/positioning/frame-map.js";
import { STAGE_W, STAGE_H } from "../../src/frame-extraction/positioning/frame-layout.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string, frameId: number, label: string): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: JSON.stringify({ frame_id: frameId, frame_label: label }),
    tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string, name: string): NodeRow {
  return {
    id, kind: "function", name, qualified_name: `${path}::${name}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}

// Two frames: "checkout" (2 files) and "viewer" (3 files).
const nodes: NodeRow[] = [
  fileNode("f1", "src/checkout/cart.ts", 0, "checkout"),
  fileNode("f2", "src/checkout/pay.ts", 0, "checkout"),
  symNode("s1", "src/checkout/cart.ts", "addToCart"),
  fileNode("f3", "src/viewer/canvas.ts", 1, "viewer"),
  fileNode("f4", "src/viewer/render.ts", 1, "viewer"),
  fileNode("f5", "src/viewer/layout.ts", 1, "viewer"),
  symNode("s2", "src/viewer/canvas.ts", "drawFrame"),
];
const edges: EdgeRow[] = [
  { id: "e1", source_id: "s1", target_id: "s2", relation: "CALLS", data: "{}", created_at: "" },
];

describe("buildFrameMap", () => {
  it("returns one entry per extracted frame plus the stage dims", () => {
    const map = buildFrameMap(nodes, edges);
    expect(map.frames).toHaveLength(2);
    expect(map.stage).toEqual({ w: STAGE_W, h: STAGE_H });
  });

  it("ranks every frame and positions the ambient ones", () => {
    const map = buildFrameMap(nodes, edges);
    for (const f of map.frames) {
      expect(typeof f.rank).toBe("number");
      if (f.ambient) {
        expect(Number.isInteger(f.x)).toBe(true);
        expect(Number.isInteger(f.y)).toBe(true);
      }
    }
  });

  it("marks all frames ambient when count is under budget", () => {
    // 2 frames → budget 4 → both ambient
    const map = buildFrameMap(nodes, edges);
    expect(map.frames.every((f) => f.ambient)).toBe(true);
  });

  it("carries count and name through from the graph", () => {
    const map = buildFrameMap(nodes, edges);
    const viewer = map.frames.find((f) => f.name === "viewer")!;
    expect(viewer.count).toBe(3);
  });

  it("is deterministic", () => {
    expect(buildFrameMap(nodes, edges)).toEqual(buildFrameMap(nodes, edges));
  });

  it("returns empty frames for a graph with no framed files", () => {
    const bare: NodeRow[] = [symNode("x", "a.ts", "foo")];
    const map = buildFrameMap(bare, []);
    expect(map.frames).toEqual([]);
  });

  it("tolerates malformed data JSON on a file node", () => {
    const withBad: NodeRow[] = [
      ...nodes,
      { id: "bad", kind: "file", name: "x.ts", qualified_name: null, file_path: "src/x.ts",
        data: "{not valid json", tier: "tier1", created_at: "", updated_at: "" },
    ];
    // The malformed node is skipped; the two valid frames still come through.
    const map = buildFrameMap(withBad, edges);
    expect(map.frames).toHaveLength(2);
  });

  it("falls back to a frame:N label when frame_label is missing", () => {
    const noLabel: NodeRow[] = [
      { id: "g1", kind: "file", name: "a.ts", qualified_name: null, file_path: "src/a.ts",
        data: JSON.stringify({ frame_id: 5 }), tier: "tier1", created_at: "", updated_at: "" },
    ];
    const map = buildFrameMap(noLabel, []);
    expect(map.frames).toHaveLength(1);
    expect(map.frames[0].name).toBe("frame:5");
  });
});

describe("buildFrameMap — reclaimed members", () => {
  const fileR = (id: string, path: string, frameId: number, label: string, reclaimed = false): NodeRow => ({
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: JSON.stringify({ frame_id: frameId, frame_label: label, ...(reclaimed ? { reclaimed: true } : {}) }),
    tier: "tier1", created_at: "", updated_at: "",
  });

  it("counts reclaimed members but a reclaimed off-topic file does not lower the score", () => {
    const mk = (reclaimed: boolean): NodeRow[] => ([
      fileR("f1", "src/checkout/cart.ts", 0, "checkout"),
      fileR("f2", "src/checkout/pay.ts", 0, "checkout"),
      fileR("f3", "src/zzz/unrelated.ts", 0, "checkout", reclaimed),
    ]);
    const reclaimedMap = buildFrameMap(mk(true), []);
    const countedMap = buildFrameMap(mk(false), []);
    const reclaimedFrame = reclaimedMap.frames.find((f) => f.id === 0)!;
    const countedFrame = countedMap.frames.find((f) => f.id === 0)!;
    // All three members counted either way.
    expect(reclaimedFrame.count).toBe(3);
    // With the off-topic file reclaimed, nameability is scored on the 2 checkout
    // files only, so the score is strictly > the version where it dilutes the label.
    expect(reclaimedFrame.score).toBeGreaterThan(countedFrame.score);
  });
});
