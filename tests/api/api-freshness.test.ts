import { describe, it, expect } from "vitest";
import { computeEtag } from "../../src/mcp-server/api-freshness.js";
import type { IndexMeta } from "../../src/graph/index-meta.js";

describe("computeEtag", () => {
  const meta: IndexMeta = { indexed_commit: "abc", indexed_dirty_sig: "sig", indexed_at: "2026-01-01" };

  it("is a quoted strong validator carrying version + project", () => {
    const tag = computeEtag("cortex", meta);
    expect(tag.startsWith('"1:cortex:')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });

  it("is stable for identical inputs and changes when the baseline changes", () => {
    expect(computeEtag("cortex", meta)).toBe(computeEtag("cortex", meta));
    const moved = { ...meta, indexed_commit: "def" };
    expect(computeEtag("cortex", moved)).not.toBe(computeEtag("cortex", meta));
  });

  it("differs by project and tolerates null meta / null project", () => {
    expect(computeEtag("a", meta)).not.toBe(computeEtag("b", meta));
    expect(computeEtag(null, null)).toMatch(/^"1:_:/);
  });
});
