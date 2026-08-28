import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportPath, writeReport, readReport } from "../../src/staleness/report-store.js";
import type { StalenessReport } from "../../src/staleness/types.js";

const REPORT: StalenessReport = {
  version: 1, swept_at: "2026-08-28T00:00:00.000Z", repo_path: "/x",
  head_commit: "h", since_commit: "s", itemized: [],
  counts: { no_reference_point: 3, basis_moved: 0, verdict_stale: 0, itemized: 0, outstanding: 0 },
  concluded_branches: [], orphaned: [],
};

describe("staleness report store", () => {
  it("round-trips a report", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-report-"));
    writeReport(root, REPORT);
    expect(readReport(root)).toEqual(REPORT);
    expect(reportPath(root)).toBe(join(root, ".cortex", "staleness.json"));
  });

  it("returns null when no report exists", () => {
    expect(readReport(mkdtempSync(join(tmpdir(), "cortex-report-")))).toBeNull();
  });

  it("returns null on unparseable content", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-report-"));
    mkdirSync(join(root, ".cortex"), { recursive: true });
    writeFileSync(reportPath(root), "{ not json");
    expect(readReport(root)).toBeNull();
  });

  it("returns null on a future version rather than misparsing it", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-report-"));
    mkdirSync(join(root, ".cortex"), { recursive: true });
    writeFileSync(reportPath(root), JSON.stringify({ ...REPORT, version: 2 }));
    expect(readReport(root)).toBeNull();
  });

  it("leaves no .tmp file behind and never throws on an unwritable root", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-report-"));
    writeReport(root, REPORT);
    expect(readdirSync(join(root, ".cortex"))).toEqual(["staleness.json"]);
    expect(() => writeReport("/proc/definitely/not/writable", REPORT)).not.toThrow();
  });
});
