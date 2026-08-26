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
      db,
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

  it("stamps last_touched_* from the passed origin, leaving origin_* alone", () => {
    const decision = svc.create({
      title: "Provenance on promote",
      description: "desc",
      rationale: "rationale",
      origin: { branch: "feature/orig", commit: "aaa", thread: null },
    });

    promotion.promote(decision.id, "team", { branch: "feature/later", commit: "bbb", thread: "th-9" });

    const row = db.prepare(
      "SELECT origin_branch, origin_commit, last_touched_branch, last_touched_commit, last_touched_thread FROM decisions WHERE id=?",
    ).get(decision.id) as Record<string, unknown>;
    expect(row.origin_branch).toBe("feature/orig"); // immutable
    expect(row.origin_commit).toBe("aaa");
    expect(row.last_touched_branch).toBe("feature/later");
    expect(row.last_touched_commit).toBe("bbb");
    expect(row.last_touched_thread).toBe("th-9");
  });

  it("defaults last_touched_* to null when promote() is called without an origin", () => {
    const decision = svc.create({
      title: "No origin on promote",
      description: "desc",
      rationale: "rationale",
    });

    promotion.promote(decision.id, "team");

    const row = db.prepare(
      "SELECT last_touched_branch, last_touched_commit, last_touched_thread FROM decisions WHERE id=?",
    ).get(decision.id) as Record<string, unknown>;
    expect(row.last_touched_branch).toBeNull();
    expect(row.last_touched_commit).toBeNull();
    expect(row.last_touched_thread).toBeNull();
  });
});
