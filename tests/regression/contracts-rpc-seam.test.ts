import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { scanRepoContracts } from "../../src/contracts/extract.js";
import { findMismatches, summarizeCoverage } from "../../src/contracts/diff.js";

// Known mismatches — add an entry only with a documented reason, and remove it
// when the underlying issue is resolved. The allowlist is currently EMPTY: the
// seam is fully consistent and this guard enforces zero tolerance for drift.
const KNOWN_MISMATCHES = new Set<string>([]);

describe("RPC contract seam (real repo)", () => {
  const repo = resolve(__dirname, "../..");
  const { bindings, unrecognized } = scanRepoContracts(repo);

  it("finds the TS consumer side of the seam", () => {
    const cov = summarizeCoverage(bindings, unrecognized);
    // The TS consumer side lives in this repo and must be detected.
    expect(cov.consumers).toBeGreaterThan(0);
    // Post-split: the C provider side moved to the separate cortex-indexer repo,
    // so scanning the cortex tree alone finds zero providers (and thus zero
    // matched). Cross-repo contract verification against cortex-indexer is a
    // documented follow-up; until then this guards the TS side from regressing.
    expect(cov.providers).toBe(0);
  });

  it("has no contract mismatches beyond the known allowlist", () => {
    const unexpected = findMismatches(bindings).filter((m) => !KNOWN_MISMATCHES.has(m.tool));
    expect(unexpected).toEqual([]);
  });
});
