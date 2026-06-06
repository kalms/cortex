import { describe, it, expect } from "vitest";
import { parseTsConsumers } from "../../src/contracts/parse.js";

describe("parseTsConsumers", () => {
  it("extracts tool name and object-literal keys", () => {
    const src = `await callIndexer("detect_changes", { repo_path: ctx.repoPath });`;
    const { bindings } = parseTsConsumers(src, "code-tools.ts");
    expect(bindings).toMatchObject([{ tool: "detect_changes", role: "consumes", keys: ["repo_path"] }]);
  });
  it("handles callIndexerCache and multiple keys", () => {
    const src = `callIndexerCache("index_repository", { repo_path: p, mode: m });`;
    const { bindings } = parseTsConsumers(src, "f.ts");
    expect(bindings[0]).toMatchObject({ tool: "index_repository", keys: ["repo_path", "mode"] });
  });
  it("counts a non-literal arg as unrecognized (keys unknown)", () => {
    const src = `return callIndexer("query_graph", indexerArgs, dbPath);`;
    const { bindings, unrecognized } = parseTsConsumers(src, "f.ts");
    expect(bindings).toEqual([]);
    expect(unrecognized).toBe(1);
  });
  it("records the 1-based line number", () => {
    const src = `x\ny\ncallIndexer("delete_project", { project: n });`;
    expect(parseTsConsumers(src, "f.ts").bindings[0].line).toBe(3);
  });
  it("parses a multi-line call across newlines", () => {
    const src = `callIndexer(\n  "detect_changes",\n  { repo_path: x }\n);`;
    const { bindings } = parseTsConsumers(src, "f.ts");
    expect(bindings[0]).toMatchObject({ tool: "detect_changes", keys: ["repo_path"] });
  });
  it("extracts only keys, not tokens inside values", () => {
    const src = `callIndexer("ingest_traces", { traces: a.b, mode: "x:y" });`;
    const { bindings } = parseTsConsumers(src, "f.ts");
    expect(bindings[0].keys).toEqual(["traces", "mode"]);
  });
});
