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

/** Hand-labeled ground truth over cortex's own frames (regenerated
 *  2026-06-13 against the 17-frame graph). `anyOf` = contested; the
 *  observation phase decides. Keyed by frame_label (stable across reindexes
 *  where frame_id is not). Labels for frames absent from the current fixture
 *  are kept (they skip) — frames come and go across reindexes. */
const EXPECTED: Record<string, { anyOf: FrameLayer[] }> = {
  "cli":               { anyOf: ["interface"] },
  "mcp":               { anyOf: ["interface", "infrastructure"] },          // contested (absent on current graph)
  "decisions/seed":    { anyOf: ["orchestration"] },
  "decisions":         { anyOf: ["domain"] },
  "frame-extraction":  { anyOf: ["data", "infrastructure", "domain", "ceremony"] }, // contested: substrate vs core domain; the label maps to TWO frames on the current graph (23-member 64%-tooling → ceremony; 7-member src split → domain) — fragmentation finding, see HANDOFF observe section
  "extraction/eval":   { anyOf: ["domain", "ceremony"] },                   // contested: 10/17 members are scripts+tests (eval harness), but inject-frames/label-quality/structural-tokens are core extraction src
  "events":            { anyOf: ["data"] },
  "contracts":         { anyOf: ["data", "infrastructure", "domain"] },     // substrate pair: at MIN_SIGNAL=0.4 the 0.38 sink contribution falls below threshold → domain fallback
  "server/frame":      { anyOf: ["infrastructure"] },
  "mcp-server":        { anyOf: ["infrastructure"] },
  "repo":              { anyOf: ["data", "infrastructure"] },               // decisions repositories + id allocator: data-access substrate either way
  "hooks":             { anyOf: ["ceremony"] },
  "evals/assertions":  { anyOf: ["ceremony"] },
  "integration":       { anyOf: ["ceremony"] },
};

/** Unnamed clusters are exempt from labeling: they are clustering noise, and
 *  hand-labeling a blob ossifies it. They still must classify (coverage test).
 *  Prefix match, not `cluster:\d+`: the producer (inject-frames.ts) can emit
 *  `cluster:?` when the id is nullish. */
const UNLABELED_RE = /^cluster:/;

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

  it("every named frame in the fixture has a hand label (regen ⇒ relabel)", () => {
    // Guards the net's blind spot: a regenerated fixture with new frames
    // previously passed silently because unmatched labels skip. Unnamed
    // cluster:N blobs are exempt (see UNLABELED_RE).
    const unlabeled = [...new Set(inputs.map((i) => i.frame_label))].filter(
      (l) => !UNLABELED_RE.test(l) && !Object.hasOwn(EXPECTED, l),
    );
    expect(unlabeled).toEqual([]);
  });

  it("agreement report (eval visibility — internals allowed HERE only)", () => {
    // Not an assertion: prints the per-frame verdicts for the observe loop.
    // conf=0.00 splits into (tie) — strong signal, unsplit pair — and
    // (fallback) — nothing cleared MIN_SIGNAL.
    inputs.forEach((i, idx) => {
      const r = results[idx];
      // < 1e-9, not === 0: confidence is float arithmetic over summed
      // fractional weights — a near-tie must not print unannotated as 0.00.
      const note = r.fallback ? " (fallback)" : r.confidence < 1e-9 ? " (tie)" : "";
      // eslint-disable-next-line no-console
      console.log(
        `${i.frame_label.padEnd(22)} → ${r.layer.padEnd(14)} conf=${r.confidence.toFixed(2)}${note}`,
      );
    });
    expect(true).toBe(true);
  });
});
