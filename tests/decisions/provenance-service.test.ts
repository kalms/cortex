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
    db,
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

  it("create round-trips provenance and reads back null when omitted", () => {
    const { root, db, service } = svc();
    try {
      const dNull = service.create({ title: "Manual", description: "d", rationale: "r" });
      expect(dNull.provenance).toBeNull();

      const prov = { source: "adr" as const, doc_path: "docs/adr/1.md", confidence: "high" as const };
      const dProv = service.create({ title: "Lifted", description: "d", rationale: "r", provenance: prov });
      expect(dProv.provenance).toEqual(prov);
      expect(service.get(dProv.id)?.provenance).toEqual(prov);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
