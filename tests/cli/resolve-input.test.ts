import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInput } from "../../src/cli/resolve-input.js";
import { DomainError } from "../../src/cli/errors.js";

describe("resolveInput", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  const project = "test-project";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-resolve-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("file path: looks up by file_path", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const result = resolveInput("apps/Card.vue", project, dbPath);
    expect("qn" in result).toBe(true);
    if ("qn" in result) expect(result.qn).toBe("test-project.apps.Card");
  });

  it("canonical qn (starts with project prefix): direct lookup", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const result = resolveInput("test-project.apps.Card", project, dbPath);
    expect("qn" in result).toBe(true);
  });

  it("bare name: search_graph fallback", () => {
    store.createNode({
      kind: "function", name: "handleRequest",
      file_path: "src/handler.ts",
      qualified_name: "test-project.src.handler.handleRequest",
    });
    const result = resolveInput("handleRequest", project, dbPath);
    expect("qn" in result).toBe(true);
    if ("qn" in result) expect(result.qn).toBe("test-project.src.handler.handleRequest");
  });

  it("multiple matches → disambiguation", () => {
    store.createNode({ kind: "function", name: "render", file_path: "a.ts", qualified_name: "test-project.a.render" });
    store.createNode({ kind: "function", name: "render", file_path: "b.ts", qualified_name: "test-project.b.render" });
    const result = resolveInput("render", project, dbPath);
    expect("candidates" in result).toBe(true);
    if ("candidates" in result) expect(result.candidates.length).toBe(2);
  });

  it("zero matches throws DomainError", () => {
    expect(() => resolveInput("apps/missing.vue", project, dbPath))
      .toThrow(DomainError);
  });
});
