import { describe, it, expect } from "vitest";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

function makeSvc() {
  const db = openDecisionsDb(":memory:");
  return {
    svc: new DecisionService({
      db,
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    }),
    db,
  };
}

describe("link helpers accept seq or canonical ref (regression: Bug 2)", () => {
  it("linkGoverns via 'D-<seq>' resolves to the canonical decision_id (no FK error)", () => {
    const { svc: s, db } = makeSvc();
    const d = s.create({ title: "t", rationale: "r" }); // seq 1, id D-xxxx
    // Without the fix, "D-1" would be written verbatim to decision_links.decision_id,
    // which violates the FK constraint (REFERENCES decisions(id)) → throws.
    expect(() => s.linkGoverns("D-1", "src/foo.ts")).not.toThrow();
    const row = db
      .prepare("SELECT decision_id, target_ref FROM decision_links WHERE relation = 'GOVERNS'")
      .get() as { decision_id: string; target_ref: string };
    expect(row.decision_id).toBe(d.id);       // canonical, not "D-1"
    expect(row.target_ref).toBe("src/foo.ts");
  });

  it("linkGoverns via bare seq also resolves to canonical decision_id", () => {
    const { svc: s, db } = makeSvc();
    const d = s.create({ title: "t", rationale: "r" });
    expect(() => s.linkGoverns("1", "src/a.ts")).not.toThrow();
    const row = db
      .prepare("SELECT decision_id FROM decision_links WHERE relation = 'GOVERNS'")
      .get() as { decision_id: string };
    expect(row.decision_id).toBe(d.id);
  });

  it("linkGoverns via canonical id and via seq form both store canonical decision_id", () => {
    const { svc: s, db } = makeSvc();
    const d = s.create({ title: "t", rationale: "r" });
    s.linkGoverns("1", "src/a.ts");
    s.linkGoverns(d.id, "src/b.ts");
    const rows = db
      .prepare("SELECT decision_id FROM decision_links WHERE relation = 'GOVERNS'")
      .all() as Array<{ decision_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.decision_id === d.id)).toBe(true);
  });

  it("linkRelatedTo via seq form resolves both owner and target to canonical ids", () => {
    const { svc: s, db } = makeSvc();
    const a = s.create({ title: "a", rationale: "r" }); // seq 1
    const b = s.create({ title: "b", rationale: "r" }); // seq 2
    expect(() => s.linkRelatedTo("D-1", "D-2")).not.toThrow();
    const row = db
      .prepare("SELECT decision_id, target_ref FROM decision_links WHERE relation = 'DECISION_RELATED_TO'")
      .get() as { decision_id: string; target_ref: string };
    expect(row.decision_id).toBe(a.id);
    expect(row.target_ref).toBe(b.id);
  });

  it("linkDependsOn via seq form resolves both owner and target to canonical ids", () => {
    const { svc: s, db } = makeSvc();
    const a = s.create({ title: "a", rationale: "r" }); // seq 1
    const b = s.create({ title: "b", rationale: "r" }); // seq 2
    expect(() => s.linkDependsOn("1", "2")).not.toThrow();
    const row = db
      .prepare("SELECT decision_id, target_ref FROM decision_links WHERE relation = 'DECISION_DEPENDS_ON'")
      .get() as { decision_id: string; target_ref: string };
    expect(row.decision_id).toBe(a.id);
    expect(row.target_ref).toBe(b.id);
  });
});
