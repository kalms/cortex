import { describe, it, expect } from "vitest";
import { buildSearchIndex, searchIndex } from "../../src/viewer/app/palette/search-index.ts";

const bundle = {
  frames: [{ id: "1", name: "graph store", layer: "data" }],
  rawNodes: [
    { id: "f1", kind: "file", name: "store.ts", file_path: "src/graph/store.ts" },
    { id: "s1", kind: "function", name: "createStore", file_path: "src/graph/store.ts" },
    { id: "v1", kind: "section", name: "Overview", file_path: "docs/x.md" },
  ],
  decisions: [{ id: "d1", seq: 4, summary: "two sqlite files", state: "active" }],
  allTodos: [{ id: "t1", seq: 9, summary: "fix drawer", state: "proposed" }],
};
const projects = [{ name: "slug", root_path: "/x/cortex" }];

describe("search index", () => {
  const entries = buildSearchIndex(bundle, projects);
  it("indexes files, symbols, frames, decisions, todos", () => {
    const groups = new Set(entries.map((e) => e.group));
    for (const g of ["files", "symbols", "frames", "decisions", "todos"]) expect(groups).toContain(g);
  });
  it("excludes non-symbol node kinds (sections)", () =>
    expect(entries.some((e) => e.label === "Overview")).toBe(false));
  it("search returns grouped, capped, scored results", () => {
    const groups = searchIndex(entries, "store", 5);
    const flat = groups.flat();
    expect(flat.some((e) => e.group === "files" && e.label === "store.ts")).toBe(true);
    expect(flat.some((e) => e.group === "symbols" && e.label === "createStore")).toBe(true);
    for (const g of groups) expect(g.length).toBeLessThanOrEqual(5);
  });
  it("group order is actions, frames, files, symbols, decisions, todos", () => {
    const groups = searchIndex(entries, "s", 5).filter((g) => g.length);
    const order = groups.map((g) => g[0].group);
    expect([...order].sort((a, b) =>
      ["actions", "frames", "files", "symbols", "decisions", "todos"].indexOf(a) -
      ["actions", "frames", "files", "symbols", "decisions", "todos"].indexOf(b))).toEqual(order);
  });
});
