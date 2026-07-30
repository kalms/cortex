/**
 * Unit tests for the changes_since window resolution (P8 temporal layer).
 * `since` accepts three spellings — a decision id (D-xxxx → the decision's
 * capture time), an ISO date, or any git ref — and garbage must throw, never
 * degrade to an unbounded window.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSinceWindow } from "../../src/mcp-server/tools/changes-since.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

describe("resolveSinceWindow", () => {
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "cortex-changes-since-")));
    execFileSync("git", ["init", "--initial-branch=main", repo]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-m", "feat: seed");
    git("tag", "v0");
  });

  afterAll(() => {
    try { rmSync(repo, { recursive: true }); } catch { /* ignore */ }
  });

  it("resolves a decision id via the lookup and uses its created_at", () => {
    const w = resolveSinceWindow(repo, "D-ab12", (id) =>
      id === "D-ab12" ? { created_at: "2026-07-01T10:00:00.000Z" } : null);
    expect(w.kind).toBe("decision");
    expect(w.window_start).toBe("2026-07-01T10:00:00.000Z");
  });

  it("throws for an unknown decision id", () => {
    expect(() => resolveSinceWindow(repo, "D-none", () => null))
      .toThrow(/unresolvable since/);
  });

  it("resolves an ISO date, normalized to full UTC ISO", () => {
    // git parses bare --since dates in LOCAL time; the sidecar compares UTC —
    // the window carries the normalized form so both sides agree.
    const w = resolveSinceWindow(repo, "2026-07-01", () => null);
    expect(w.kind).toBe("date");
    expect(w.window_start).toBe("2026-07-01T00:00:00.000Z");
  });

  it("resolves a git ref and derives the ref's commit time", () => {
    const w = resolveSinceWindow(repo, "v0", () => null);
    expect(w.kind).toBe("ref");
    expect(w.window_start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws for garbage that is neither id, date, nor ref", () => {
    expect(() => resolveSinceWindow(repo, "definitely-not-a-ref", () => null))
      .toThrow(/unresolvable since/);
  });
});
