import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository, type DecisionLink } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

/** Fault injection: throws on insert of a sentinel target, after deletes ran. */
class FailingDecisionLinks extends DecisionLinksRepository {
  override add(link: DecisionLink): void {
    if (link.target_ref === "src/boom.ts") throw new Error("injected insert failure");
    super.add(link);
  }
}

describe("DecisionService.update — link replacement is atomic", () => {
  let dir: string;
  let db: Database.Database;
  let links: DecisionLinksRepository;
  let svc: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-txn-links-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    links = new FailingDecisionLinks(db);
    svc = new DecisionService({
      db,
      decisions: new DecisionsRepository(db),
      links,
    });
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function targetsFor(decisionId: string, relation: "GOVERNS" | "REFERENCES"): string[] {
    return links.findByDecision(decisionId)
      .filter((l) => l.relation === relation)
      .map((l) => l.target_ref)
      .sort();
  }

  it("keeps the old GOVERNS set when an insert fails mid-replacement", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts"],
    });
    expect(() => svc.update(d.id, { governs: ["src/boom.ts"] })).toThrow("injected insert failure");
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps the old REFERENCES set when an insert fails mid-replacement", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      references: ["docs/spec.md"],
    });
    expect(() => svc.update(d.id, { references: ["src/boom.ts"] })).toThrow("injected insert failure");
    expect(targetsFor(d.id, "REFERENCES")).toEqual(["docs/spec.md"]);
  });

  it("rolls back removals AND partial inserts together", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/old.ts"],
    });
    // "src/aaa.ts" inserts fine before "src/boom.ts" throws — it must not survive.
    expect(() => svc.update(d.id, { governs: ["src/aaa.ts", "src/boom.ts"] })).toThrow();
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/old.ts"]);
  });
});
