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

  it("finds the seam (non-empty contracts on both sides)", () => {
    const cov = summarizeCoverage(bindings, unrecognized);
    expect(cov.matched).toBeGreaterThan(0);
    expect(cov.providers).toBeGreaterThan(0);
    expect(cov.consumers).toBeGreaterThan(0);
  });

  it("has no contract mismatches beyond the known allowlist", () => {
    const unexpected = findMismatches(bindings).filter((m) => !KNOWN_MISMATCHES.has(m.tool));
    expect(unexpected).toEqual([]);
  });
});
