import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStalenessCommand } from "../../src/cli/commands/staleness.js";
import { writeReport } from "../../src/staleness/report-store.js";
import type { StalenessReport } from "../../src/staleness/types.js";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-cli-staleness-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

function capture(fn: () => void): string {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out += String(c); return true; });
  try { fn(); } finally { spy.mockRestore(); }
  return out;
}

const REPORT: StalenessReport = {
  version: 1, swept_at: "2026-08-28T00:00:00.000Z", repo_path: "/x",
  head_commit: "h", since_commit: "s",
  itemized: [{
    kind: "decision", id: "D-aaaa", title: "governs a", reason: "basis_moved",
    origin_branch: "feature/x", origin_commit: "abc1234", origin_thread: null,
    branch_concluded: false, unresolved_refs: [],
  }],
  counts: { no_reference_point: 7, basis_moved: 1, verdict_stale: 0, itemized: 1, outstanding: 0 },
  concluded_branches: [], orphaned: [],
};

afterEach(() => vi.restoreAllMocks());

describe("cortex staleness", () => {
  it("prints the headline for the last sweep", () => {
    const root = gitRepo();
    writeReport(root, REPORT);
    const out = capture(() => runStalenessCommand({}, root));
    expect(out).toContain("D-aaaa");
    expect(out).toContain("7 without a reference point");
  });

  it("prints NOTHING when there is no report", () => {
    expect(capture(() => runStalenessCommand({}, gitRepo()))).toBe("");
  });

  it("prints NOTHING when the sweep flagged nothing new", () => {
    const root = gitRepo();
    writeReport(root, { ...REPORT, itemized: [], counts: { ...REPORT.counts, itemized: 0 } });
    expect(capture(() => runStalenessCommand({}, root))).toBe("");
  });

  it("prints NOTHING when CORTEX_STALENESS=0", () => {
    const root = gitRepo();
    writeReport(root, REPORT);
    process.env.CORTEX_STALENESS = "0";
    try {
      expect(capture(() => runStalenessCommand({}, root))).toBe("");
    } finally { delete process.env.CORTEX_STALENESS; }
  });

  it("--json emits the full report", () => {
    const root = gitRepo();
    writeReport(root, REPORT);
    const parsed = JSON.parse(capture(() => runStalenessCommand({ json: true }, root)));
    expect(parsed.counts.itemized).toBe(1);
  });
});
