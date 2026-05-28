import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

function svc() {
  const root = mkdtempSync(join(tmpdir(), "cortex-prov-svc-"));
  const db = openDecisionsDb(join(root, "decisions.db"));
  const service = new DecisionService({
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
  });
  return { root, db, service };
}

describe("DecisionService provenance + author", () => {
  it("propose persists provenance + author and surfaces them on read", () => {
    const { root, db, service } = svc();
    try {
      const prov = { source: "commits" as const, commit_shas: ["abc"], confidence: "low" as const };
      const d = service.propose({
        title: "Seeded", problem: "p", resolution: "r", rationale: "why",
        author: "cortex:seed", provenance: prov,
      });
      expect(d.status).toBe("proposed");
      expect(d.author).toBe("cortex:seed");
      expect(d.provenance).toEqual(prov);
      expect(service.get(d.id)?.provenance).toEqual(prov);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("create without provenance reads back null", () => {
    const { root, db, service } = svc();
    try {
      const d = service.create({ title: "Manual", description: "d", rationale: "r" });
      expect(d.provenance).toBeNull();
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
