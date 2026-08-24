import { describe, it, expect } from "vitest";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

function svc(): DecisionService {
  const db = openDecisionsDb(":memory:");
  return new DecisionService({
    db,
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
  });
}

describe("DecisionService.getWithRefs", () => {
  it("returns identical payloads for canonical id, seq form, and bare seq", () => {
    const s = svc();
    const created = s.create({
      title: "t",
      rationale: "r",
      governs: ["src/a.ts", "src/b.ts"],
    });

    const byCanonical = s.getWithRefs(created.id);
    const bySeqForm = s.getWithRefs("D-1");
    const byBareSeq = s.getWithRefs("1");

    expect(byCanonical).not.toBeNull();
    expect(bySeqForm).toEqual(byCanonical);
    expect(byBareSeq).toEqual(byCanonical);
  });

  it("populates governs when addressed by the seq form", () => {
    const s = svc();
    s.create({ title: "t", rationale: "r", governs: ["src/a.ts", "src/b.ts"] });

    const d = s.getWithRefs("D-1");
    expect(d?.governs.map((g) => g.target_ref).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("carries reconciliation columns that toDecision() strips", () => {
    const s = svc();
    const created = s.create({ title: "t", rationale: "r", governs: ["src/a.ts"] });

    const d = s.getWithRefs("D-1");
    expect(d).toHaveProperty("reconciliation_verdict", null);
    expect(d).toHaveProperty("reconciled_at", null);
    expect(d?.id).toBe(created.id);
  });

  it("resolveId maps every accepted form to the canonical id, null otherwise", () => {
    const s = svc();
    const created = s.create({ title: "t", rationale: "r" });

    expect(s.resolveId("D-1")).toBe(created.id);
    expect(s.resolveId("1")).toBe(created.id);
    expect(s.resolveId(created.id)).toBe(created.id);
    expect(s.resolveId("D-999")).toBeNull();
    expect(s.resolveId("D-zzzz")).toBeNull();
  });

  it("returns null for an unknown ref", () => {
    const s = svc();
    expect(s.getWithRefs("D-99")).toBeNull();
  });
});
