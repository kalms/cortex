import { describe, it, expect } from "vitest";
import { clampLimit, clampOffset, renderNodeSearch } from "../../src/mcp-server/tools/search-format.js";
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
});
