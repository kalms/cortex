import { describe, it, expect } from "vitest";
import { formatOnboarding } from "../../src/onboarding/format.js";

const facts = {
  files: 467, nodes: 4657, edges: 7282,
  hotspots: [
    { module: "mcp-server", path: "src/mcp-server", score: 100, in_edges: 90, nodes: 300, governing_decisions: 8, open_todos: 2 },
    { module: "db", path: "src/db", score: 60, in_edges: 60, nodes: 40, governing_decisions: 6, open_todos: 0 },
  ],
  entrypoints: [
    { label: "cortex", target: "bin/cortex" },
    { label: "entry", target: "src/index.ts" },
  ],
};

describe("formatOnboarding", () => {
  it("produces a bounded headline naming hotspots and entrypoints", () => {
    const out = formatOnboarding(facts);
    expect(out).toContain("mcp-server");
    expect(out).toContain("src/index.ts");
    expect(out.split("\n").length).toBeLessThanOrEqual(8);
  });
  it("returns empty string when there is nothing to say", () => {
    expect(formatOnboarding({ files: 0, nodes: 0, edges: 0, hotspots: [], entrypoints: [] })).toBe("");
  });
});
