import { describe, it, expect } from "vitest";
import { positionAggregates } from "../../src/mcp-server/aggregate-positioning.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";
import type { FrameMap } from "../../src/mcp-server/frame-map.js";

const fileNode = (id: string, file_path: string, frame_id?: number): NodeRow => ({
  id, kind: "file", file_path, name: file_path, qualified_name: file_path,
  data: frame_id === undefined ? "{}" : JSON.stringify({ frame_id, frame_label: `f${frame_id}` }),
} as NodeRow);

describe("positionAggregates", () => {
  it("attaches integer x/y to an edge-tied aggregate", () => {
    const nodes: NodeRow[] = [
      fileNode("a", "app/locales/en.json"),
      fileNode("f1", "app/ui/menu.ts", 1),
    ];
    const edges: EdgeRow[] = [{ source_id: "f1", target_id: "a", relation: "USAGE" } as EdgeRow];
    const frameMap = { frames: [{ id: 1, name: "f1", count: 2, ambient: true, x: 200, y: 300, w: 120, h: 120, rank: 0, score: 1, layer: "interface" }], stage: { w: 1000, h: 800 } } as unknown as FrameMap;
    const aggs = positionAggregates(nodes, edges, frameMap);
    const a = aggs.find((x) => x.id === "aux:locales:locales")!;
    expect(Number.isInteger(a.x)).toBe(true);
    expect(Number.isInteger(a.y)).toBe(true);
    expect(a.x).toBe(200); // edge-tied to frame 1 at x=200
  });

  it("leaves aggregates present even when there are no ambient frames (margin)", () => {
    const nodes: NodeRow[] = [fileNode("a", "vendor/x.js")];
    const frameMap = { frames: [], stage: { w: 1000, h: 800 } } as unknown as FrameMap;
    const aggs = positionAggregates(nodes, [], frameMap);
    expect(aggs.length).toBe(1);
    expect(typeof aggs[0]!.x).toBe("number"); // margin-positioned
  });
});
