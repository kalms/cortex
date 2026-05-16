import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService relations", () => {
  let dir: string;
  let db: Database.Database;
  let links: DecisionLinksRepository;
  let svc: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-rel-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    links = new DecisionLinksRepository(db);
    svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links,
    });
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("linkRelatedTo + linkDependsOn create links in decision_links", () => {
    const a = svc.create({ title: "A", description: "d", rationale: "r", problem: "p", resolution: "res" });
    const b = svc.create({ title: "B", description: "d", rationale: "r", problem: "p", resolution: "res" });
    const c = svc.create({ title: "C", description: "d", rationale: "r", problem: "p", resolution: "res" });

    svc.linkRelatedTo(a.id, b.id);
    svc.linkDependsOn(a.id, c.id);

    const aLinks = links.findByDecision(a.id);
    const related = aLinks.filter((l) => l.relation === "DECISION_RELATED_TO");
    const depends = aLinks.filter((l) => l.relation === "DECISION_DEPENDS_ON");
    expect(related.map((l) => l.target_ref)).toEqual([b.id]);
    expect(depends.map((l) => l.target_ref)).toEqual([c.id]);
    // both should be target_kind=decision
    expect(related[0].target_kind).toBe("decision");
    expect(depends[0].target_kind).toBe("decision");
  });
});
