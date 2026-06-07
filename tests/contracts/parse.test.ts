import { describe, it, expect } from "vitest";
import { parseTsConsumers } from "../../src/contracts/parse.js";
import { parseCProviders } from "../../src/contracts/parse.js";

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

describe("parseCProviders", () => {
  const src = [
    `static char *handle_detect_changes(ctx_mcp_server_t *srv, const char *args) {`,
    `  char *project = ctx_mcp_get_string_arg(args, "project");`,
    `  int n = ctx_mcp_get_int_arg(args, "limit", 10);`,
    `  return ok;`,
    `}`,
    `static char *handle_delete_project(ctx_mcp_server_t *srv, const char *args) {`,
    `  char *name = ctx_mcp_get_string_arg(args, "project");`,
    `}`,
  ].join("\n");

  it("maps each handler to its read keys, stripping the handle_ prefix", () => {
    const { bindings } = parseCProviders(src, "handlers.c");
    expect(bindings).toEqual([
      { tool: "detect_changes", role: "provides", keys: ["project", "limit"], file: "handlers.c", symbol: "handle_detect_changes", line: 1 },
      { tool: "delete_project", role: "provides", keys: ["project"], file: "handlers.c", symbol: "handle_delete_project", line: 6 },
    ]);
  });

  it("emits an empty key list for a handler that reads no args, and ignores non-handler statics", () => {
    const s = [
      `static char *read_file_lines(const char *p) { return 0; }`,
      `static char *handle_list_projects(ctx_mcp_server_t *srv, const char *args) {`,
      `  (void)args;`,
      `  return ok;`,
      `}`,
    ].join("\n");
    const { bindings } = parseCProviders(s, "handlers.c");
    expect(bindings).toEqual([
      { tool: "list_projects", role: "provides", keys: [], file: "handlers.c", symbol: "handle_list_projects", line: 2 },
    ]);
  });

  it("captures int/bool args that carry a default value (3-arg form)", () => {
    const s = `static char *handle_x(s, a) { ctx_mcp_get_bool_arg(args, "flag", false); }`;
    expect(parseCProviders(s, "h.c").bindings[0].keys).toEqual(["flag"]);
  });
});
