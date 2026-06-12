// tests/frame-extraction/frame-kind.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyFrames,
  classifyFramesInternal,
  type FrameKindInput,
} from "../../src/frame-extraction/frame-kind.js";

function input(partial: Partial<FrameKindInput> & { frame_id: number }): FrameKindInput {
  return {
    frame_label: `frame:${partial.frame_id}`,
    member_paths: [],
    fanIn: 0,
    fanOut: 0,
    ...partial,
  };
}

describe("graph-position source", () => {
  it("low sink ratio (source-heavy) proposes the surface pair; lexical silence leaves the canonical-order winner", () => {
    // fanIn 2 / fanOut 8 → sink 0.2 ≤ 0.35 → interface + orchestration get
    // (0.5-0.2)*2*W_GRAPH = 0.6 each; tie → canonical order → interface.
    const [r] = classifyFrames([input({ frame_id: 1, fanIn: 2, fanOut: 8 })]);
    expect(r).toEqual({ frame_id: 1, layer: "interface" });
  });

  it("high sink ratio (imported-heavy) proposes the substrate pair; tie resolves to data by canonical order", () => {
    // fanIn 8 / fanOut 2 → sink 0.8 ≥ 0.65 → data + infrastructure 0.6 each.
    const [r] = classifyFrames([input({ frame_id: 2, fanIn: 8, fanOut: 2 })]);
    expect(r.layer).toBe("data");
  });

  it("is silent in the middle band", () => {
    // sink 0.5 → no graph contribution, no other signals → domain fallback.
    const [r] = classifyFrames([input({ frame_id: 3, fanIn: 5, fanOut: 5 })]);
    expect(r.layer).toBe("domain");
  });

  it("treats zero flows as sink 0.5 (silent)", () => {
    const [r] = classifyFrames([input({ frame_id: 4 })]);
    expect(r.layer).toBe("domain");
  });
});

describe("path-pattern source", () => {
  it("maps member directory segments to layers", () => {
    const [r] = classifyFrames([
      input({ frame_id: 5, member_paths: ["src/cli/run.ts", "src/cli/args.ts"] }),
    ]);
    expect(r.layer).toBe("interface");
  });

  it("lexical signal breaks the topological surface tie toward orchestration", () => {
    // sink 0.2 → interface+orchestration 0.6 each; 'seed' paths add W_PATH to orchestration.
    const [r] = classifyFrames([
      input({
        frame_id: 6,
        fanIn: 2, fanOut: 8,
        member_paths: ["src/decisions/seed/commit-clustering.ts", "src/decisions/seed/doc-discovery.ts"],
      }),
    ]);
    expect(r.layer).toBe("orchestration");
  });

  it("accumulates fractions per layer when members span tables", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 7,
        member_paths: ["src/events/log.ts", "src/events/bus.ts", "src/events/store.ts", "x/misc.ts"],
      }),
    ]);
    expect(r.layer).toBe("data"); // 3/4 members match data tokens
  });
});

describe("content signals", () => {
  it("near-all-tests frames are ceremony (fraction ≥ 0.8)", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 8,
        member_paths: ["a/x.test.ts", "a/y.test.ts", "a/z.spec.ts", "a/w.test.ts", "a/v.test.ts"],
      }),
    ]);
    expect(r.layer).toBe("ceremony");
  });

  it("mixed frames (65% tests) do NOT become ceremony by content", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 9,
        member_paths: ["a/x.test.ts", "a/y.test.ts", "a/z.test.ts", "a/svc.ts", "a/types.ts"],
      }),
    ]);
    expect(r.layer).toBe("domain"); // testFrac 0.6 < 0.8 → silent → fallback
  });

  it("non-runtime-extension majority is ceremony", () => {
    const [r] = classifyFrames([
      input({ frame_id: 10, member_paths: ["h/check.sh", "h/run.sh", "h/conf.yml"] }),
    ]);
    expect(r.layer).toBe("ceremony");
  });

  it("frame_label tokens run through the path table", () => {
    const [r] = classifyFrames([
      input({ frame_id: 11, frame_label: "events/worker", member_paths: ["x/a.ts"] }),
    ]);
    expect(r.layer).toBe("data"); // label token 'events' → data via W_LABEL
  });

  it("a member firing both a layer token and the test signal: ceremony wins at full test fraction", () => {
    // Source B: 'cli' → interface 0.8; Source C: testFrac 1.0 ≥ 0.8 → ceremony 0.9.
    // Pins W_TEST > W_PATH; lowering W_TEST below W_PATH would flip this.
    const [r] = classifyFrames([input({ frame_id: 14, member_paths: ["src/cli/x.test.ts"] })]);
    expect(r.layer).toBe("ceremony");
  });
});

describe("combination + contract", () => {
  it("returns one result per input, sorted by frame_id", () => {
    const out = classifyFrames([input({ frame_id: 9 }), input({ frame_id: 1 })]);
    expect(out.map((r) => r.frame_id)).toEqual([1, 9]);
  });

  it("is deterministic under input order shuffles", () => {
    const a = input({ frame_id: 1, fanIn: 2, fanOut: 8 });
    const b = input({ frame_id: 2, member_paths: ["src/cli/x.ts"] });
    const c = input({ frame_id: 3, member_paths: ["a/x.test.ts", "a/y.test.ts"] });
    expect(classifyFrames([a, b, c])).toEqual(classifyFrames([c, a, b]));
  });

  it("classifyFrames exposes ONLY frame_id and layer", () => {
    const [r] = classifyFrames([input({ frame_id: 12, fanIn: 8, fanOut: 2 })]);
    expect(Object.keys(r).sort()).toEqual(["frame_id", "layer"]);
  });

  it("classifyFramesInternal carries confidence and contributions for the eval harness", () => {
    const [r] = classifyFramesInternal([input({ frame_id: 13, member_paths: ["src/cli/x.ts"] })]);
    expect(r.layer).toBe("interface");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.contributions.interface).toBeGreaterThan(0);
  });

  it("empty input → empty output", () => {
    expect(classifyFrames([])).toEqual([]);
  });
});
