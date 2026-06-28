import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markBriefed, wasBriefed, clearBriefed, ledgerPath } from "../../src/briefing/ledger.js";

let dir: string | null = null;
function repo(): string { dir = mkdtempSync(join(tmpdir(), "cortex-ledger-")); return dir; }
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe("briefed ledger", () => {
  it("records and detects a briefed target", () => {
    const r = repo();
    expect(wasBriefed(r, "src/a.ts::x")).toBe(false);
    markBriefed(r, "src/a.ts::x");
    expect(wasBriefed(r, "src/a.ts::x")).toBe(true);
    expect(ledgerPath(r)).toBe(join(r, ".cortex", ".briefed"));
  });
  it("is idempotent and clearable", () => {
    const r = repo();
    markBriefed(r, "t"); markBriefed(r, "t");
    clearBriefed(r);
    expect(wasBriefed(r, "t")).toBe(false);
  });
  it("never throws on an unwritable repo path", () => {
    expect(() => markBriefed("/nonexistent/path", "x")).not.toThrow();
    expect(wasBriefed("/nonexistent/path", "x")).toBe(false);
  });
});
