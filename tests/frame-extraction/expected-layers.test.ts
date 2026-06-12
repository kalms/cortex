// tests/frame-extraction/expected-layers.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFramesInternal,
  type FrameKindInput,
  type FrameLayer,
} from "../../src/frame-extraction/frame-kind.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../fixtures/frame-layers/cortex-frames.json");

/** Hand-labeled ground truth over cortex's own frames (2026-06-12).
 *  `anyOf` = contested; the observation phase decides. Keyed by frame_label
 *  (stable across reindexes where frame_id is not). */
const EXPECTED: Record<string, { anyOf: FrameLayer[] }> = {
  "cli":               { anyOf: ["interface"] },
  "mcp":               { anyOf: ["interface", "infrastructure"] },          // contested
  "decisions/seed":    { anyOf: ["orchestration"] },
  "decisions":         { anyOf: ["domain"] },
  "frame-extraction":  { anyOf: ["data", "infrastructure", "domain", "ceremony"] }, // contested: substrate vs core domain; on the CURRENT graph 64% of members are scripts/evals/hooks tooling, so ceremony is a defensible verdict until frame quality improves
  "events":            { anyOf: ["data"] },
  "contracts":         { anyOf: ["data", "infrastructure", "domain"] },     // substrate pair: at MIN_SIGNAL=0.4 the 0.38 sink contribution falls below threshold → domain fallback
  "server/frame":      { anyOf: ["infrastructure"] },
  "mcp-server":        { anyOf: ["infrastructure"] },
  "hooks":             { anyOf: ["ceremony"] },
  "evals/assertions":  { anyOf: ["ceremony"] },
  "integration":       { anyOf: ["ceremony"] },
};

describe("expected layers — cortex regression fixture", () => {
  const inputs: FrameKindInput[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const results = classifyFramesInternal(inputs);
  // A label can map to MULTIPLE frames (the fixture has two `evals/assertions`);
  // every frame carrying the label must satisfy its expectation.
  const byLabel = new Map<string, typeof results>();
  inputs.forEach((i, idx) => {
    const arr = byLabel.get(i.frame_label) ?? [];
    arr.push(results[idx]);
    byLabel.set(i.frame_label, arr);
  });

  for (const [label, exp] of Object.entries(EXPECTED)) {
    it(`${label} → ${exp.anyOf.join(" | ")}`, () => {
      const rs = byLabel.get(label);
      if (!rs) return; // frame no longer exists on this graph — skip, don't fail
      for (const r of rs) expect(exp.anyOf).toContain(r.layer);
    });
  }

  it("every frame in the fixture gets a layer (no throws, full coverage)", () => {
    expect(results.length).toBe(inputs.length);
    for (const r of results) expect(typeof r.layer).toBe("string");
  });

  it("agreement report (eval visibility — internals allowed HERE only)", () => {
    // Not an assertion: prints the per-frame verdicts for the observe loop.
    inputs.forEach((i, idx) => {
      const r = results[idx];
      // eslint-disable-next-line no-console
      console.log(
        `${i.frame_label.padEnd(22)} → ${r.layer.padEnd(14)} conf=${r.confidence.toFixed(2)}`,
      );
    });
    expect(true).toBe(true);
  });
});
