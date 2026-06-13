// tests/mcp-server/frame-map-layer.test.ts
import { describe, it, expect } from "vitest";
import { buildFrameMap } from "../../src/mcp-server/frame-map.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string, frameId: number, label: string): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: JSON.stringify({ frame_id: frameId, frame_label: label }),
    tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string): NodeRow {
  return {
    id, kind: "function", name: id, qualified_name: `${path}::${id}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function edge(source: string, target: string, relation: string): EdgeRow {
  return { id: `${source}->${target}`, source_id: source, target_id: target, relation, data: "{}", created_at: "" };
}

const nodes: NodeRow[] = [
  fileNode("f1", "src/cli/run.ts", 0, "cli"),
  fileNode("f2", "src/cli/args.ts", 0, "cli"),
  symNode("s1", "src/cli/run.ts"),
  fileNode("f3", "src/events/log.ts", 1, "events"),
  symNode("s2", "src/events/log.ts"),
];
const edges: EdgeRow[] = [edge("s1", "s2", "CALLS")]; // cli → events

describe("buildFrameMap layer field", () => {
  it("attaches a layer to every frame entry", () => {
    const map = buildFrameMap(nodes, edges);
    expect(map.frames.length).toBe(2);
    for (const f of map.frames) {
      expect(["interface", "orchestration", "domain", "data", "infrastructure", "ceremony"])
        .toContain(f.layer);
    }
    const cli = map.frames.find((f) => f.name === "cli")!;
    expect(cli.layer).toBe("interface");
    const events = map.frames.find((f) => f.name === "events")!;
    expect(events.layer).toBe("data");
  });

  it("NEVER serializes classifier internals (negative assertion)", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges));
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
    expect(json).not.toContain("fallback");
  });

  it("classifies frames with zero flows too", () => {
    const map = buildFrameMap(nodes, []); // no edges at all
    for (const f of map.frames) expect(typeof f.layer).toBe("string");
  });
});

describe("kind-weight gating", () => {
  it("flag OFF: scores identical to no kind-weight (inert by default)", () => {
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const dflt = buildFrameMap(nodes, edges); // env unset in test → off
    expect(off.frames.map((f) => [f.id, f.score])).toEqual(dflt.frames.map((f) => [f.id, f.score]));
  });

  it("flag ON: each frame's score is its off-score × kindWeight(layer)", () => {
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
    const offById = new Map(off.frames.map((f) => [f.id, f]));
    for (const f of on.frames) {
      const base = offById.get(f.id)!;
      const w = f.layer === "interface" ? 0.9 : f.layer === "data" ? 0.75 : 1.0;
      expect(f.score).toBeCloseTo(base.score * w, 10);
    }
  });

  it("flag ON still serializes no classifier internals", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges, { applyKindWeight: true }));
    expect(json).not.toContain("fallback");
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
  });
});
