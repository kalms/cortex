import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";

describe("DecisionPromotion", () => {
  let dir: string;
  let db: Database.Database;
  let svc: DecisionService;
  let repo: DecisionsRepository;
  let promotion: DecisionPromotion;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-promo-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    repo = new DecisionsRepository(db);
    svc = new DecisionService({
      decisions: repo,
      links: new DecisionLinksRepository(db),
    });
    promotion = new DecisionPromotion(repo);
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("promotes a decision to team tier", () => {
    const decision = svc.create({
      title: "Logging standard",
      description: "desc",
      rationale: "rationale",
    });

    expect(decision.tier).toBe("personal");

    const promoted = promotion.promote(decision.id, "team");
    expect(promoted.tier).toBe("team");
    expect(promoted.title).toBe("Logging standard");
  });

  it("promotes a decision to public tier", () => {
    const decision = svc.create({
      title: "API versioning",
      description: "desc",
      rationale: "rationale",
    });

    const promoted = promotion.promote(decision.id, "public");
    expect(promoted.tier).toBe("public");
  });

  it("throws for non-existent decision", () => {
    expect(() => promotion.promote("fake-id", "team")).toThrow("Decision not found");
  });
});
