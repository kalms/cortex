import { describe, it, expect } from "vitest";
import { classifyFreshness } from "../../src/mcp-server/freshness.js";

const base = {
  canonical: true,
  nodeCount: 100,
  meta: { indexed_commit: "AAA", indexed_dirty_sig: "sig", indexed_at: "2026-06-07T00:00:00Z" },
  isGit: true,
  curHead: "AAA",
  curDirtySig: "sig",
  commitsBehind: 0,
};

describe("classifyFreshness", () => {
  it("fresh when head + dirty-sig match the baseline", () => {
    expect(classifyFreshness(base).state).toBe("fresh");
  });
  it("stale:dirty when only the working tree changed", () => {
    expect(classifyFreshness({ ...base, curDirtySig: "other" }).state).toBe("stale:dirty");
  });
  it("stale:commits (with count) when HEAD moved", () => {
    const f = classifyFreshness({ ...base, curHead: "BBB", commitsBehind: 3 });
    expect(f.state).toBe("stale:commits");
    expect(f.commits_behind).toBe(3);
  });
  it("stale:both when head and dirty-sig differ", () => {
    expect(classifyFreshness({ ...base, curHead: "BBB", curDirtySig: "other" }).state).toBe("stale:both");
  });
  it("empty when not canonical (fallback DB)", () => {
    expect(classifyFreshness({ ...base, canonical: false }).state).toBe("empty");
  });
  it("empty when node count is zero", () => {
    expect(classifyFreshness({ ...base, nodeCount: 0 }).state).toBe("empty");
  });
  it("unknown when no baseline meta", () => {
    expect(classifyFreshness({ ...base, meta: null }).state).toBe("unknown");
  });
  it("unknown when not a git repo", () => {
    expect(classifyFreshness({ ...base, isGit: false }).state).toBe("unknown");
  });
  it("omits commits_behind when uncomputable after a rebase", () => {
    const f = classifyFreshness({ ...base, curHead: "BBB", commitsBehind: null });
    expect(f.state).toBe("stale:commits");
    expect(f.commits_behind).toBeUndefined();
  });
});
