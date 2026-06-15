// tests/mcp-server/frame-map-layer.test.ts
import { describe, it, expect } from "vitest";
import { buildFrameMap } from "../../src/mcp-server/frame-map.js";
import { kindWeight } from "../../src/frame-extraction/frame-kind.js";
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
  it("default ON: no opts (env unset) matches explicit applyKindWeight:true", () => {
    const prev = process.env.CORTEX_KIND_WEIGHT;
    delete process.env.CORTEX_KIND_WEIGHT;
    try {
      const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
      const dflt = buildFrameMap(nodes, edges); // no opts, env unset → default ON
      expect(dflt.frames.map((f) => [f.id, f.score])).toEqual(on.frames.map((f) => [f.id, f.score]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_KIND_WEIGHT;
      else process.env.CORTEX_KIND_WEIGHT = prev;
    }
  });

  it("explicit applyKindWeight:false disables the layer effect (differs from on)", () => {
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
    const offById = new Map(off.frames.map((f) => [f.id, f.score]));
    // cli(interface 0.9) and events(data 0.75) both ≠ 1.0 → at least one score moves.
    expect(on.frames.some((f) => Math.abs(f.score - offById.get(f.id)!) > 1e-9)).toBe(true);
  });

  it("CORTEX_KIND_WEIGHT=0 opts out of the new default", () => {
    const prev = process.env.CORTEX_KIND_WEIGHT;
    process.env.CORTEX_KIND_WEIGHT = "0";
    try {
      const envOff = buildFrameMap(nodes, edges); // env "0" → off
      const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
      expect(envOff.frames.map((f) => [f.id, f.score])).toEqual(off.frames.map((f) => [f.id, f.score]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_KIND_WEIGHT;
      else process.env.CORTEX_KIND_WEIGHT = prev;
    }
  });

  it("flag ON: each frame's score is its off-score × kindWeight(layer)", () => {
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
    const offById = new Map(off.frames.map((f) => [f.id, f]));
    for (const f of on.frames) {
      const base = offById.get(f.id)!;
      const w = kindWeight(f.layer, false);
      expect(f.score).toBeCloseTo(base.score * w, 10);
    }
  });

  it("flag ON still serializes no classifier internals", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges, { applyKindWeight: true }));
    expect(json).not.toContain("fallback");
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
  });

  // Fallback-domain integration: a frame that earns NO layer signal (mid-band
  // sink, no path/label tokens, runtimeFrac below the 0.8 earned-domain bar)
  // should be flagged fallback=true by classifyFramesInternal and demoted to
  // ×0.5 through the full buildFrameMap path. This covers the gap where the
  // fallback-domain branch was only unit-tested in frame-kind.test.ts.
  it("flag ON: a fallback-domain frame is demoted to ×0.5 through frame-map", () => {
    // Two isolated frames, no inter-frame edges → sink=0.5 (middle band).
    // 'widget' frame: two runtime files + one test file (testFrac=1/3 < 0.8,
    // runtimeFrac=2/3 → domainResidual=0.333 < MIN_SIGNAL=0.4) → fallback-domain.
    // Paths use generic names — no PATH_LAYER_TABLE tokens, no label tokens.
    const fbNodes: NodeRow[] = [
      fileNode("g1", "src/widget/alpha.ts", 0, "widget"),
      fileNode("g2", "src/widget/beta.ts", 0, "widget"),
      fileNode("g3", "src/widget/alpha.test.ts", 0, "widget"),
      symNode("gs1", "src/widget/alpha.ts"),
      fileNode("g4", "src/gamma/one.ts", 1, "gamma"),
      fileNode("g5", "src/gamma/two.test.ts", 1, "gamma"),
    ];
    const fbEdges: EdgeRow[] = [];

    const off = buildFrameMap(fbNodes, fbEdges, { applyKindWeight: false });
    const on = buildFrameMap(fbNodes, fbEdges, { applyKindWeight: true });

    const w = on.frames.find((f) => f.id === 0)!;
    expect(w.layer).toBe("domain"); // fallback-domain still reports layer=domain

    const offW = off.frames.find((f) => f.id === 0)!;
    // fallback-domain → kindWeight("domain", true) = 0.5, not 1.0 (earned domain)
    expect(w.score).toBeCloseTo(offW.score * 0.5, 10);
  });
});

describe("layer-diversity gating", () => {
  it("default ON: no opts (env unset) matches explicit applyDiversity:true", () => {
    const prev = process.env.CORTEX_LAYER_DIVERSITY;
    delete process.env.CORTEX_LAYER_DIVERSITY;
    try {
      const on = buildFrameMap(nodes, edges, { applyDiversity: true });
      const dflt = buildFrameMap(nodes, edges); // env unset → default ON (opt-out flag)
      expect(dflt.frames.map((f) => [f.id, f.ambient])).toEqual(on.frames.map((f) => [f.id, f.ambient]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_LAYER_DIVERSITY;
      else process.env.CORTEX_LAYER_DIVERSITY = prev;
    }
  });

  it("CORTEX_LAYER_DIVERSITY=0 opts out (matches explicit applyDiversity:false)", () => {
    const prev = process.env.CORTEX_LAYER_DIVERSITY;
    process.env.CORTEX_LAYER_DIVERSITY = "0";
    try {
      const envOff = buildFrameMap(nodes, edges); // env "0" → off
      const off = buildFrameMap(nodes, edges, { applyDiversity: false });
      expect(envOff.frames.map((f) => [f.id, f.ambient])).toEqual(off.frames.map((f) => [f.id, f.ambient]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_LAYER_DIVERSITY;
      else process.env.CORTEX_LAYER_DIVERSITY = prev;
    }
  });

  it("flag ON caps ceremony in the ambient set end-to-end (OFF does not)", () => {
    // NOTE: kind-weight is OFF here (applyKindWeight:false) on BOTH sides — with
    // kind-weight on, ceremony is already demoted by its 0.2 multiplier and the
    // cap rarely binds. Disabling it isolates the diversity ceremony-cap as the
    // sole intervention so the test is robust to scoring details.
    //
    // 4 ceremony frames (scripts/, high member counts) outscore 8 interface
    // frames (cli/, fewer members) on raw nameability×structural. Budget for 12
    // frames = ceil(12·0.7)=9. OFF: the top-9 includes all 4 ceremony. ON: the
    // cap holds — exactly 1 ceremony, and the 8 interface fill the rest (8+1=9,
    // so the cap never relaxes).
    const big: NodeRow[] = [];
    for (let fr = 0; fr < 4; fr++) {
      const n = 12 - fr; // 12,11,10,9 members → high structural weight
      for (let m = 0; m < n; m++) big.push(fileNode(`c${fr}_${m}`, `src/scripts/f${fr}/m${m}.ts`, fr, `scripts${fr}`));
    }
    for (let fr = 4; fr < 12; fr++) {
      for (let m = 0; m < 5; m++) big.push(fileNode(`u${fr}_${m}`, `src/cli/f${fr}/m${m}.ts`, fr, `cli${fr}`));
    }
    const opts = { applyKindWeight: false as const };
    const off = buildFrameMap(big, [], { ...opts, applyDiversity: false });
    const on = buildFrameMap(big, [], { ...opts, applyDiversity: true });
    const ceremonyAmbient = (m: ReturnType<typeof buildFrameMap>) =>
      m.frames.filter((f) => f.ambient && f.layer === "ceremony").length;
    // Sanity: the fixture really did classify the scripts frames as ceremony.
    expect(off.frames.some((f) => f.layer === "ceremony")).toBe(true);
    expect(ceremonyAmbient(off)).toBeGreaterThan(1);
    expect(ceremonyAmbient(on)).toBeLessThanOrEqual(1);
    expect(on.frames.filter((f) => f.ambient).length).toBeLessThanOrEqual(9);
  });

  it("flag ON is deterministic across repeated builds", () => {
    const a = buildFrameMap(nodes, edges, { applyDiversity: true });
    const b = buildFrameMap(nodes, edges, { applyDiversity: true });
    expect(a.frames.map((f) => [f.id, f.ambient])).toEqual(b.frames.map((f) => [f.id, f.ambient]));
  });

  it("flag ON still serializes no classifier internals", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges, { applyDiversity: true }));
    expect(json).not.toContain("fallback");
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
  });
});
