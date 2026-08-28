import { describe, it, expect } from "vitest";
import { formatIndexLine, formatHeadline } from "../../src/staleness/format.js";
import type { StalenessReport, StaleRow } from "../../src/staleness/types.js";

function row(over: Partial<StaleRow> = {}): StaleRow {
  return {
    kind: "decision", id: "D-aaaa", title: "a decision", reason: "basis_moved",
    origin_branch: "feature/x", origin_commit: "abc1234", origin_thread: null,
    branch_concluded: false, unresolved_refs: [], ...over,
  };
}

function report(over: Partial<StalenessReport> = {}): StalenessReport {
  return {
    version: 1, swept_at: "2026-08-28T00:00:00.000Z", repo_path: "/x",
    head_commit: "h", since_commit: "s", itemized: [],
    counts: { no_reference_point: 0, basis_moved: 0, verdict_stale: 0, itemized: 0, outstanding: 0 },
    concluded_branches: [], orphaned: [], ...over,
  };
}

describe("formatIndexLine", () => {
  it("is null on a clean sweep", () => {
    expect(formatIndexLine(report())).toBeNull();
  });
  it("is null when only the never-referenced backlog is non-zero", () => {
    expect(formatIndexLine(report({
      counts: { no_reference_point: 170, basis_moved: 0, verdict_stale: 0, itemized: 0, outstanding: 0 },
    }))).toBeNull();
  });
  it("names the newly-flagged count first", () => {
    const line = formatIndexLine(report({
      itemized: [row()],
      counts: { no_reference_point: 170, basis_moved: 1, verdict_stale: 0, itemized: 1, outstanding: 4 },
    }))!;
    expect(line.startsWith("staleness: 1 newly flagged")).toBe(true);
    expect(line).toContain("4 outstanding");
    expect(line).toContain("170");
  });
});

describe("formatHeadline", () => {
  it("is empty when nothing was newly flagged — the backlog alone is not news", () => {
    expect(formatHeadline(report({
      counts: { no_reference_point: 170, basis_moved: 9, verdict_stale: 0, itemized: 0, outstanding: 9 },
    }))).toBe("");
  });

  it("lists the itemized rows with their origin branch", () => {
    const h = formatHeadline(report({
      itemized: [row(), row({ id: "T-bbbb", kind: "todo", title: "a todo", branch_concluded: true })],
      counts: { no_reference_point: 170, basis_moved: 2, verdict_stale: 0, itemized: 2, outstanding: 0 },
    }));
    expect(h).toContain("D-aaaa");
    expect(h).toContain("T-bbbb");
    expect(h).toContain("feature/x");
    expect(h).toContain("branch gone");
    expect(h).toContain("170");
  });

  it("caps the list and says how many were elided", () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ id: `D-${i}${i}${i}${i}` }));
    const h = formatHeadline(report({
      itemized: many,
      counts: { no_reference_point: 0, basis_moved: 9, verdict_stale: 0, itemized: 9, outstanding: 0 },
    }));
    expect(h).toContain("D-0000");
    expect(h).not.toContain("D-8888");
    expect(h).toContain("and 4 more");
    expect(h.split("\n").length).toBeLessThanOrEqual(8);
  });
});
