import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CREATE_TABLES } from "../../src/graph/schema.js";
import { injectContracts } from "../../src/contracts/inject.js";
import { computeContractReport } from "../../src/mcp-server/tools/contract-tools.js";

describe("computeContractReport", () => {
  it("reports the detect_changes mismatch from persisted edges", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-")); const path = join(dir, "db");
    try {
      const db = new Database(path); db.exec(CREATE_TABLES);
      const now = new Date().toISOString();
      for (const [id, fp] of [["c","src/mcp-server/tools/code-tools.ts"],["h","internal/indexer/src/handlers/handlers.c"]] as const)
        db.prepare(`INSERT INTO nodes (id,kind,name,file_path,data,tier,created_at,updated_at,project) VALUES (?,'file',?,?,'{}','personal',?,?,'P')`).run(id, id, fp, now, now);
      db.close();
      injectContracts({ project: "P", dbPath: path, bindings: [
        { tool: "detect_changes", role: "consumes", keys: ["repo_path"], file: "src/mcp-server/tools/code-tools.ts", symbol: "c", line: 1 },
        { tool: "detect_changes", role: "provides", keys: ["project"], file: "internal/indexer/src/handlers/handlers.c", symbol: "handle_detect_changes", line: 1 },
      ]});
      const report = computeContractReport(path, "P");
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0]).toMatchObject({ tool: "detect_changes", missing_on_provider: ["repo_path"], missing_on_consumer: ["project"] });
      expect(report.coverage.matched).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns an empty report for a DB with no contract edges", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-empty-")); const path = join(dir, "db");
    try {
      const db = new Database(path); db.exec(CREATE_TABLES); db.close();
      const report = computeContractReport(path, "P");
      expect(report.mismatches).toEqual([]);
      expect(report.coverage.matched).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports no mismatch for a contract whose keys match on both sides", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-ok-")); const path = join(dir, "db");
    try {
      const db = new Database(path); db.exec(CREATE_TABLES);
      const now = new Date().toISOString();
      for (const [id, fp] of [["c","src/a.ts"],["h","internal/indexer/src/handlers/handlers.c"]] as const)
        db.prepare(`INSERT INTO nodes (id,kind,name,file_path,data,tier,created_at,updated_at,project) VALUES (?,'file',?,?,'{}','personal',?,?,'P')`).run(id, id, fp, now, now);
      db.close();
      injectContracts({ project: "P", dbPath: path, bindings: [
        { tool: "good_tool", role: "consumes", keys: ["repo_path"], file: "src/a.ts", symbol: "c", line: 1 },
        { tool: "good_tool", role: "provides", keys: ["repo_path"], file: "internal/indexer/src/handlers/handlers.c", symbol: "handle_good_tool", line: 1 },
      ]});
      const report = computeContractReport(path, "P");
      expect(report.mismatches).toEqual([]);
      expect(report.coverage.matched).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
