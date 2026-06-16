import { describe, it, expect } from "vitest";
import { buildAggregatePathIndex, buildAggregateEdgeTies, frameRepDirs, aggregateDirs } from "../../src/mcp-server/aggregate-ties.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

const fileNode = (id: string, file_path: string, frame_id?: number): NodeRow => ({
  id, kind: "file", file_path, name: file_path, qualified_name: file_path,
  data: frame_id === undefined ? "{}" : JSON.stringify({ frame_id, frame_label: `f${frame_id}` }),
} as NodeRow);
const edge = (source_id: string, target_id: string, relation = "IMPORTS"): EdgeRow =>
  ({ source_id, target_id, relation } as EdgeRow);

describe("buildAggregatePathIndex", () => {
  it("maps every auxiliary file path to its aggregate id", () => {
    const idx = buildAggregatePathIndex(["app/locales/en.json", "app/locales/fr.json", "src/cli/run.ts"]);
    expect(idx.get("app/locales/en.json")).toBe("aux:locales:locales");
    expect(idx.get("app/locales/fr.json")).toBe("aux:locales:locales");
    expect(idx.has("src/cli/run.ts")).toBe(false);
  });
});

describe("buildAggregateEdgeTies", () => {
  it("ties an aggregate to frames its member files link to", () => {
    const nodes: NodeRow[] = [
      fileNode("a", "app/locales/en.json"),
      fileNode("f1", "app/ui/menu.ts", 1),
      fileNode("f2", "app/api/route.ts", 2),
    ];
    const edges: EdgeRow[] = [edge("f1", "a", "USAGE"), edge("a", "f2", "IMPORTS")];
    const ties = buildAggregateEdgeTies(nodes, edges);
    const m = ties.get("aux:locales:locales")!;
    expect(m.get(1)).toBe(1);
    expect(m.get(2)).toBe(1);
  });
  it("ignores non-rollup relations and intra-aux edges", () => {
    const nodes: NodeRow[] = [fileNode("a", "vendor/x.js"), fileNode("b", "vendor/y.js")];
    const edges: EdgeRow[] = [edge("a", "b", "IMPORTS"), edge("a", "b", "CONTAINS")];
    const ties = buildAggregateEdgeTies(nodes, edges);
    expect(ties.size).toBe(0);
  });
  it("counts each direction of a symmetric aux↔frame edge pair", () => {
    const nodes: NodeRow[] = [fileNode("a", "app/locales/en.json"), fileNode("f1", "app/ui/menu.ts", 1)];
    const edges: EdgeRow[] = [edge("a", "f1", "IMPORTS"), edge("f1", "a", "USAGE")];
    const ties = buildAggregateEdgeTies(nodes, edges);
    expect(ties.get("aux:locales:locales")!.get(1)).toBe(2);
  });
});

describe("frameRepDirs", () => {
  it("derives each frame's representative top dir from its member paths", () => {
    const nodes: NodeRow[] = [
      fileNode("f1", "app/ui/menu.ts", 1), fileNode("f1b", "app/ui/list.ts", 1),
      fileNode("f2", "src/api/route.ts", 2),
    ];
    const dirs = frameRepDirs(nodes);
    expect(dirs.get(1)).toBe("app");
    expect(dirs.get(2)).toBe("src");
  });
});

describe("aggregateDirs", () => {
  it("maps an aggregate to the host dir segment above its aux segment", () => {
    const dirs = aggregateDirs(["app/locales/en.json", "i18n/fr.json"]);
    expect(dirs.get("aux:locales:locales")).toBe("app");
    expect(dirs.get("aux:i18n:i18n")).toBe("");
  });
});
