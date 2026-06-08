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

describe("decision ref resolution", () => {
  it("get() resolves canonical id, seq form, and bare seq to the same row", () => {
    const s = svc();
    const created = s.create({ title: "t", rationale: "r" }); // seq 1
    expect(s.get(created.id)?.id).toBe(created.id);     // D-xxxx
    expect(s.get("D-1")?.id).toBe(created.id);          // seq form
    expect(s.get("1")?.id).toBe(created.id);            // bare seq
  });

  it("get() returns null for an unknown ref", () => {
    const s = svc();
    expect(s.get("D-99")).toBeNull();
    expect(s.get("D-zzzz")).toBeNull();
  });
});
