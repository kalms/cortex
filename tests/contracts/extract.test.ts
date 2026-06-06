import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepoContracts } from "../../src/contracts/extract.js";

describe("scanRepoContracts", () => {
  it("collects TS consumers and C providers across the known dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "contracts-"));
    try {
      mkdirSync(join(root, "src/mcp-server/tools"), { recursive: true });
      mkdirSync(join(root, "internal/indexer/src/handlers"), { recursive: true });
      writeFileSync(join(root, "src/mcp-server/tools/code-tools.ts"),
        `callIndexer("detect_changes", { repo_path: x });`);
      writeFileSync(join(root, "internal/indexer/src/handlers/handlers.c"),
        `static char *handle_detect_changes(s,a){ ctx_mcp_get_string_arg(args, "project"); }`);
      const { bindings, unrecognized } = scanRepoContracts(root);
      const tools = bindings.map((b) => `${b.role}:${b.tool}`).sort();
      expect(tools).toEqual(["consumes:detect_changes", "provides:detect_changes"]);
      expect(bindings.find((b) => b.role === "consumes")!.file).toBe("src/mcp-server/tools/code-tools.ts");
      expect(unrecognized).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("skips .test.ts files so test fixtures aren't scanned as real call sites", () => {
    const root = mkdtempSync(join(tmpdir(), "contracts-skip-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/real.ts"), `callIndexer("index_repository", { repo_path: x });`);
      writeFileSync(join(root, "src/fixture.test.ts"), `callIndexer("ghost_tool", { x: 1 });`);
      const { bindings } = scanRepoContracts(root);
      const tools = bindings.map((b) => b.tool);
      expect(tools).toContain("index_repository");
      expect(tools).not.toContain("ghost_tool");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("aggregates the unrecognized count from non-literal call args", () => {
    const root = mkdtempSync(join(tmpdir(), "contracts-unrec-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), `callIndexer("query_graph", someVar);`);
      const { bindings, unrecognized } = scanRepoContracts(root);
      expect(bindings).toEqual([]);
      expect(unrecognized).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
