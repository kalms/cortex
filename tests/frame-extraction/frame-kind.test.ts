// tests/frame-extraction/frame-kind.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyFrames,
  classifyFramesInternal,
  KIND_WEIGHT,
  kindWeight,
  LAYER_ORDER,
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

describe("handler-suffix signal (Nitro/h3 method-suffixed route files)", () => {
  it("method-suffixed route files break the topological surface tie toward orchestration", () => {
    // Observe-phase finding (private-monorepo, 2026-06-13): Nuxt/Nitro
    // server/api/*.{get,post}.ts frames are pure sources (sink 0.0) and the
    // surface-pair tie always broke to interface — orchestration starved.
    // sink 0.0 → interface+orchestration 1.0 each; handler suffixes add to
    // orchestration only.
    const [r] = classifyFrames([
      input({
        frame_id: 20,
        fanIn: 0, fanOut: 8,
        member_paths: ["server/api/users.get.ts", "server/api/users.post.ts"],
      }),
    ]);
    expect(r.layer).toBe("orchestration");
  });

  it("handler files alone clear MIN_SIGNAL without topology", () => {
    // 'api' is deliberately NOT a PATH_LAYER_TABLE token, so this isolates
    // the handler signal — orchestration wins on margin, not tie-break.
    const [r] = classifyFrames([
      input({ frame_id: 21, member_paths: ["api/a.get.ts", "api/b.delete.ts"] }),
    ]);
    expect(r.layer).toBe("orchestration");
  });

  it("requires a route-dir segment — method-suffixed accessor utilities do NOT fire orchestration", () => {
    // `<thing>.get.ts` is also a common typed-accessor idiom outside route
    // dirs; without scoping, a data-substrate frame would flip orchestration.
    const [r] = classifyFrames([
      input({ frame_id: 23, member_paths: ["src/store/cache.get.ts", "src/store/cache.delete.ts"] }),
    ]);
    expect(r.layer).toBe("data"); // 'store' token only; no handler contribution
  });

  it("matches method suffixes case-insensitively, like every other path signal", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 24,
        fanIn: 0, fanOut: 8,
        member_paths: ["server/api/users.GET.ts", "server/api/users.POST.ts"],
      }),
    ]);
    expect(r.layer).toBe("orchestration");
  });

  it("scales by fraction — a mostly-UI frame with one handler stays interface", () => {
    // 3/4 'components' → interface 0.6; 1/4 handler → orchestration 0.2.
    const [r] = classifyFrames([
      input({
        frame_id: 22,
        member_paths: [
          "app/components/A.vue",
          "app/components/B.vue",
          "app/components/C.vue",
          "server/api/x.get.ts",
        ],
      }),
    ]);
    expect(r.layer).toBe("interface");
  });
});

describe("positive mid-band domain signal", () => {
  it("mid-band runtime frame with no layer tokens EARNS domain (not fallback)", () => {
    // sink 0.5 (middle band), members are runtime .ts with no PATH_LAYER_TABLE
    // token → domain = W_DOMAIN_RUNTIME(0.5) × runtimeFrac(1.0) = 0.5 ≥ MIN_SIGNAL.
    const [r] = classifyFramesInternal([
      input({ frame_id: 40, fanIn: 5, fanOut: 5, member_paths: ["src/foo/alpha.ts", "src/foo/beta.ts"] }),
    ]);
    expect(r.layer).toBe("domain");
    expect(r.fallback).toBe(false);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("does NOT override a typed mid-band frame (W_DOMAIN_RUNTIME < W_PATH)", () => {
    // 'store' → data token at W_PATH(0.8); domain residual only 0.5 → data wins.
    const [r] = classifyFrames([
      input({ frame_id: 41, fanIn: 5, fanOut: 5, member_paths: ["src/store/alpha.ts", "src/store/beta.ts"] }),
    ]);
    expect(r.layer).toBe("data");
  });

  it("a mostly-test mid-band frame stays fallback (runtime signal below MIN_SIGNAL)", () => {
    // 3 tests + 1 runtime → runtimeFrac 0.25 → domain 0.125 < 0.4; testFrac 0.75 < 0.8 → no ceremony.
    const [r] = classifyFramesInternal([
      input({
        frame_id: 42, fanIn: 5, fanOut: 5,
        member_paths: ["a/w.test.ts", "a/x.test.ts", "a/y.test.ts", "a/z.ts"],
      }),
    ]);
    expect(r.layer).toBe("domain");
    expect(r.fallback).toBe(true);
  });

  it("does NOT fire outside the middle band — a substrate frame gets no domain contribution", () => {
    // sink 0.8 ≥ SINK_SUBSTRATE → substrate branch only; domain contribution stays 0.
    const [r] = classifyFramesInternal([
      input({ frame_id: 43, fanIn: 8, fanOut: 2, member_paths: ["src/foo/alpha.ts", "src/foo/beta.ts"] }),
    ]);
    expect(r.contributions.domain).toBe(0);
    expect(r.layer).toBe("data");
  });

  it("an empty-member mid-band frame is still a fallback (guarded on members.length)", () => {
    const [r] = classifyFramesInternal([input({ frame_id: 44, fanIn: 5, fanOut: 5 })]);
    expect(r.layer).toBe("domain");
    expect(r.fallback).toBe(true);
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

  it("internal result distinguishes fallback (no signal) from within-pair tie (strong, unsplit signal)", () => {
    // Observe-phase finding (2026-06-13): conf=0.00 conflated two states.
    // Pure fallback: middle-band sink, no lexical signal → domain, fallback=true.
    const [fb] = classifyFramesInternal([input({ frame_id: 30, fanIn: 5, fanOut: 5 })]);
    expect(fb.layer).toBe("domain");
    expect(fb.fallback).toBe(true);
    // Within-pair tie: sink 0.8 → data+infrastructure 0.6 each, conf 0 — but NOT fallback.
    const [tie] = classifyFramesInternal([input({ frame_id: 31, fanIn: 8, fanOut: 2 })]);
    expect(tie.layer).toBe("data");
    expect(tie.confidence).toBe(0);
    expect(tie.fallback).toBe(false);
  });

  it("fallback flag never reaches the production surface", () => {
    const [r] = classifyFrames([input({ frame_id: 32, fanIn: 5, fanOut: 5 })]);
    expect(Object.keys(r).sort()).toEqual(["frame_id", "layer"]);
  });
});

describe("kind weight (enable slice)", () => {
  it("returns the taxonomy weight per layer", () => {
    expect(kindWeight("domain", false)).toBe(1.0);
    expect(kindWeight("interface", false)).toBe(0.9);
    expect(kindWeight("orchestration", false)).toBe(0.85);
    expect(kindWeight("data", false)).toBe(0.75);
    expect(kindWeight("infrastructure", false)).toBe(0.55);
    expect(kindWeight("ceremony", false)).toBe(0.2);
  });

  it("demotes fallback-domain to 0.5 (D-qn7z: earned nothing → not top weight)", () => {
    expect(kindWeight("domain", true)).toBe(0.5);
  });

  it("fallback flag only affects domain", () => {
    expect(kindWeight("interface", true)).toBe(0.9);
    expect(kindWeight("ceremony", true)).toBe(0.2);
  });

  it("KIND_WEIGHT covers every FrameLayer", () => {
    for (const layer of LAYER_ORDER) expect(typeof KIND_WEIGHT[layer]).toBe("number");
  });
});
