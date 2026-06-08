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

describe("DecisionService minting", () => {
  it("create() assigns a D- canonical id and seq starting at 1", () => {
    const s = svc();
    const a = s.create({ title: "first", rationale: "r" });
    const b = s.create({ title: "second", rationale: "r" });
    expect(a.id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("propose() shares the same seq counter as create()", () => {
    const s = svc();
    s.create({ title: "first", rationale: "r" });
    const p = s.propose({ title: "p", rationale: "r", problem: "p", resolution: "r" });
    expect(p.seq).toBe(2);
    expect(p.id).toMatch(/^D-/);
  });
});
