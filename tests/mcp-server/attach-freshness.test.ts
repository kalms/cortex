import { describe, it, expect } from "vitest";
import { attachFreshness } from "../../src/mcp-server/freshness.js";

const fresh = { state: "fresh" as const };
const stale = { state: "stale:dirty" as const, dirty: true, note: "uncommitted changes present — results may be stale, reindex to refresh" };

describe("attachFreshness", () => {
  it("returns the result unchanged when fresh", () => {
    const r = { content: [{ type: "text", text: "hello" }] };
    expect(attachFreshness(r, fresh)).toBe(r);
  });
  it("appends a freshness note to the first text block when stale", () => {
    const r = { content: [{ type: "text", text: "hello" }] };
    const out = attachFreshness(r, stale) as typeof r & { freshness?: unknown };
    expect(out.content[0].text).toContain("hello");
    expect(out.content[0].text).toContain("cortex freshness: stale:dirty");
    expect(out.freshness).toEqual(stale);
  });
  it("leaves a result with no text content structurally valid", () => {
    const r = { content: [] as Array<{ type: string; text: string }> };
    const out = attachFreshness(r, stale) as typeof r & { freshness?: unknown };
    expect(out.freshness).toEqual(stale);
  });
});
