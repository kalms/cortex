import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { scanRepoContracts } from "../../src/contracts/extract.js";
import { findMismatches, summarizeCoverage } from "../../src/contracts/diff.js";

// Known mismatches — remove each when the underlying issue is resolved.
//
// detect_changes: genuine bug — TS sends repo_path, C reads "project".
//   Awaiting HANDOFF #4. Remove when that fix lands.
//
// index_repository: genuine gap — C handler reads an optional "mode" key
//   ("fast" | "moderate" | full default) that the TS MCP layer never sends.
//   The MCP schema only exposes repo_path, so callers cannot choose index
//   depth. Deferred: the gap is low-severity (defaulting to full is safe)
//   but should be closed by adding mode to indexRepositoryShape.
//
// ingest_traces: parser false positive — C reads "traces" via yyjson_obj_get()
//   directly (not ctx_mcp_get_string_arg), so the regex parser sees
//   provider_keys=[] even though the handler does consume the key correctly.
//   Fix: extend parseCProviders to recognise yyjson_obj_get call sites, or
//   annotate the handler with a ctx_mcp_get_array_arg wrapper. See
//   src/contracts/parse.ts C_ARG regex.
const KNOWN_MISMATCHES = new Set<string>([
  "detect_changes",    // genuine bug — awaiting HANDOFF #4
  "index_repository",  // genuine gap — mode param unreachable via TS MCP schema
  "ingest_traces",     // parser false positive — C uses yyjson_obj_get not ctx_mcp_get_*_arg
]);

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
