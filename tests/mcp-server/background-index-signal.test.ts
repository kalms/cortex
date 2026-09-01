import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setIndexSignalEmitter } from "../../src/index-signal.js";
import type { IndexSignalMsg } from "../../src/events/types.js";
import { kickBackgroundIndex } from "../../src/mcp-server/repo-context.js";

const temps: string[] = [];

function makeTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-bg-signal-")));
  temps.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

afterEach(() => {
  setIndexSignalEmitter(null);
  delete process.env.CORTEX_BIN;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The child is detached — wait for its exit listener rather than a fixed delay. */
const settled = async (seen: IndexSignalMsg[]) => {
  for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  return seen;
};

describe("kickBackgroundIndex signals", () => {
  it("emits started at spawn and completed when the child exits 0", async () => {
    const repo = makeTempRepo();
    process.env.CORTEX_BIN = "/usr/bin/true";
    const seen: IndexSignalMsg[] = [];
    setIndexSignalEmitter((m) => seen.push(m));

    expect(kickBackgroundIndex(repo)).toBe(true);
    await settled(seen);

    expect(seen.map((s) => s.phase)).toEqual(["started", "completed"]);
    expect(seen[0].repo_path).toBe(repo);
    // The child writes to auto-index.log, not back to this process, so it
    // reports no counts — only the duration measured on this side.
    expect(seen[1].stats).toEqual({ elapsed_ms: expect.any(Number) });
  });

  it("emits failed when the child exits non-zero", async () => {
    const repo = makeTempRepo();
    process.env.CORTEX_BIN = "/usr/bin/false";
    const seen: IndexSignalMsg[] = [];
    setIndexSignalEmitter((m) => seen.push(m));

    kickBackgroundIndex(repo);
    await settled(seen);

    expect(seen.map((s) => s.phase)).toEqual(["started", "failed"]);
    expect(seen[1].error).toContain("1");
  });

  it("emits nothing when a recent sentinel means an attempt is already in flight", async () => {
    const repo = makeTempRepo();
    process.env.CORTEX_BIN = "/usr/bin/true";
    kickBackgroundIndex(repo); // writes the sentinel
    const seen: IndexSignalMsg[] = [];
    setIndexSignalEmitter((m) => seen.push(m));
    expect(kickBackgroundIndex(repo)).toBe(true); // sentinel path
    expect(seen).toHaveLength(0);
  });
});
