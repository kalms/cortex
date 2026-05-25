import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInput } from "../../src/shared/resolve-input.js";

describe("shared resolveInput", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  const project = "test-project";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-shared-resolve-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("single match by file path → kind: 'single'", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const r = resolveInput("apps/Card.vue", project, dbPath);
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.symbol.qn).toBe("test-project.apps.Card");
  });

  it("single match by canonical qn → kind: 'single'", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const r = resolveInput("test-project.apps.Card", project, dbPath);
    expect(r.kind).toBe("single");
  });

  it("single match by bare name → kind: 'single'", () => {
    store.createNode({
      kind: "function", name: "handleRequest",
      file_path: "src/handler.ts",
      qualified_name: "test-project.src.handler.handleRequest",
    });
    const r = resolveInput("handleRequest", project, dbPath);
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.symbol.qn).toBe("test-project.src.handler.handleRequest");
  });

  it("multiple matches → kind: 'multi' with candidates", () => {
    store.createNode({ kind: "function", name: "render", file_path: "a.ts", qualified_name: "test-project.a.render" });
    store.createNode({ kind: "function", name: "render", file_path: "b.ts", qualified_name: "test-project.b.render" });
    const r = resolveInput("render", project, dbPath);
    expect(r.kind).toBe("multi");
    if (r.kind === "multi") expect(r.candidates.length).toBe(2);
  });

  it("no matches → kind: 'none'", () => {
    const r = resolveInput("apps/missing.vue", project, dbPath);
    expect(r.kind).toBe("none");
  });
});
