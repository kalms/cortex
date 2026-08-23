import { describe, it, expect, afterEach } from "vitest";
import { clampLimit, clampOffset, renderNodeSearch, symbolMissHint } from "../../src/mcp-server/tools/search-format.js";
import type { IndexerNode } from "../../src/graph/code-queries.js";

function node(name: string, kind = "function"): IndexerNode {
  return {
    id: name, project: "p", kind, name,
    qualified_name: `mod::${name}`, file_path: "src/mod.ts",
    start_line: 1, end_line: 2, data: "{}",
  };
}

describe("clampLimit", () => {
  it("defaults to 30 when undefined", () => expect(clampLimit(undefined)).toBe(30));
  it("clamps to [1, 100]", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(42)).toBe(42);
  });
});

describe("clampOffset", () => {
  it("defaults to 0 and floors negatives", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(12)).toBe(12);
  });
});

describe("renderNodeSearch", () => {
  const rows = [node("serveA"), node("serveB"), node("serveC")];

  it("renders a header with the showing-window and total", () => {
    const text = renderNodeSearch(rows, { query: "serve", limit: 2, offset: 0, suppressedSections: 0 });
    expect(text.split("\n")[0]).toBe("showing 1–2 of 3 · offset 0");
    expect(text).toContain("function mod::serveA (src/mod.ts:1-2)");
    expect(text).not.toContain("serveC");
  });

  it("appends a suppression note only when sections were suppressed", () => {
    const withNote = renderNodeSearch(rows, { query: "serve", limit: 30, offset: 0, suppressedSections: 41 });
    expect(withNote.split("\n")[0]).toContain("41 section nodes suppressed (pass kinds=[\"section\"])");
    const noNote = renderNodeSearch(rows, { query: "serve", limit: 30, offset: 0, suppressedSections: 0 });
    expect(noNote).not.toContain("suppressed");
  });

  it("emits a showing-0 header on offset overshoot", () => {
    const text = renderNodeSearch(rows, { query: "serve", limit: 10, offset: 200, suppressedSections: 0 });
    expect(text.split("\n")[0]).toBe("showing 0 of 3 · offset 200");
  });

  it("renders a header-only opt-in hint when only sections matched (no code rows)", () => {
    const text = renderNodeSearch([], { query: "Usage", limit: 30, offset: 0, suppressedSections: 2 });
    expect(text).toBe('showing 0 of 0 · offset 0 · 2 section nodes suppressed (pass kinds=["section"])');
  });
});

describe("symbolMissHint", () => {
  const prev = process.env.CORTEX_FRESHNESS;
  afterEach(() => {
    if (prev === undefined) delete process.env.CORTEX_FRESHNESS;
    else process.env.CORTEX_FRESHNESS = prev;
  });

  it("names search_code as the next call", () => {
    delete process.env.CORTEX_FRESHNESS;
    expect(symbolMissHint()).toContain('search_code(pattern="…")');
  });

  it("points at the freshness line while the signal is live", () => {
    delete process.env.CORTEX_FRESHNESS;
    const h = symbolMissHint();
    expect(h).toContain("⚠ cortex freshness");
    expect(h).toContain("re-indexing cannot change this result");
  });

  it("drops the currency claim under CORTEX_FRESHNESS=0", () => {
    // The gate makes freshnessForContext() return `fresh` unconditionally, so
    // no ⚠ line is ever emitted and "no line" says nothing about the index.
    // Claiming currency there would misdiagnose a genuinely stale graph —
    // exactly the failure this hint exists to prevent.
    process.env.CORTEX_FRESHNESS = "0";
    const h = symbolMissHint();
    expect(h).not.toContain("cortex freshness");
    expect(h).not.toContain("re-indexing cannot change this result");
    expect(h).toContain('search_code(pattern="…")');   // routing survives
  });
});
