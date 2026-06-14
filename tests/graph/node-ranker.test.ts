import { describe, it, expect } from "vitest";
import { rankNodes, scoreNode, nameMatchQuality, KIND_WEIGHT } from "../../src/graph/node-ranker.js";
import type { IndexerNode } from "../../src/graph/code-queries.js";

function node(partial: Partial<IndexerNode>): IndexerNode {
  return {
    id: partial.qualified_name ?? partial.name ?? "id",
    project: "p",
    kind: partial.kind ?? "function",
    name: partial.name ?? "x",
    qualified_name: partial.qualified_name ?? `mod::${partial.name ?? "x"}`,
    file_path: partial.file_path ?? "src/mod.ts",
    start_line: 1, end_line: 2, data: "{}",
  };
}

describe("nameMatchQuality", () => {
  it("returns 1 when query is absent (qn-only search)", () => {
    expect(nameMatchQuality("anything", undefined)).toBe(1);
  });
  it("scores exact (case-insensitive) > prefix > substring", () => {
    expect(nameMatchQuality("Serve", "serve")).toBe(1.0);
    expect(nameMatchQuality("serveViewer", "serve")).toBe(0.7);
    expect(nameMatchQuality("httpServe", "serve")).toBe(0.4);
  });
});

describe("scoreNode", () => {
  it("weights kind: a substring function beats an exact section", () => {
    const fn = node({ kind: "function", name: "doServe" });
    const sec = node({ kind: "section", name: "serve" });
    expect(scoreNode(fn, "serve")).toBeGreaterThan(scoreNode(sec, "serve"));
  });
  it("falls back to a default weight for unknown kinds", () => {
    const unknown = node({ kind: "gizmo", name: "serve" });
    expect(scoreNode(unknown, "serve")).toBeCloseTo(0.5 * 1.0);
  });
});

describe("rankNodes", () => {
  it("orders by kind priority for equal name-match quality", () => {
    const nodes = [
      node({ kind: "variable", name: "serveX", qualified_name: "m::serveX" }),
      node({ kind: "route", name: "serveY", qualified_name: "m::serveY" }),
      node({ kind: "function", name: "serveZ", qualified_name: "m::serveZ" }),
    ];
    const ranked = rankNodes(nodes, "serve");
    expect(ranked.map((n) => n.kind)).toEqual(["route", "function", "variable"]);
  });
  it("breaks ties by shorter name, then qualified_name ascending", () => {
    const nodes = [
      node({ kind: "function", name: "serveLong", qualified_name: "m::b" }),
      node({ kind: "function", name: "serveLong", qualified_name: "m::a" }),
      node({ kind: "function", name: "serve", qualified_name: "m::c" }),
    ];
    const ranked = rankNodes(nodes, "serveX");
    expect(ranked.map((n) => n.qualified_name)).toEqual(["m::c", "m::a", "m::b"]);
  });
  it("is deterministic across repeated calls (pagination stability)", () => {
    const nodes = [
      node({ kind: "function", name: "alpha", qualified_name: "m::alpha" }),
      node({ kind: "function", name: "beta", qualified_name: "m::beta" }),
      node({ kind: "method", name: "gamma", qualified_name: "m::gamma" }),
    ];
    const a = rankNodes(nodes, "a").map((n) => n.qualified_name);
    const b = rankNodes([...nodes].reverse(), "a").map((n) => n.qualified_name);
    expect(a).toEqual(b);
  });
  it("does not mutate the input array", () => {
    const nodes = [node({ name: "b" }), node({ name: "a" })];
    const before = nodes.map((n) => n.name);
    rankNodes(nodes, "a");
    expect(nodes.map((n) => n.name)).toEqual(before);
  });
  it("exposes a KIND_WEIGHT table with section lowest", () => {
    expect(KIND_WEIGHT.section).toBeLessThan(KIND_WEIGHT.variable);
    expect(KIND_WEIGHT.route).toBeGreaterThanOrEqual(KIND_WEIGHT.function);
  });
});
