import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("propose_decision forwards provenance + author", () => {
  it("stores provenance + cortex:seed author", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-mcp-prov-"));
    const db = openDecisionsDb(join(root, "decisions.db"));
    const service = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
    try {
      const d = service.propose({
        title: "X", problem: "p", resolution: "r", rationale: "why",
        author: "cortex:seed",
        provenance: { source: "adr", doc_path: "docs/adr/1.md", confidence: "high" },
      });
      expect(d.author).toBe("cortex:seed");
      expect(d.provenance?.source).toBe("adr");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
