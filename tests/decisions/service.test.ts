import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService — classifyTarget", () => {
  let dir: string;
  let db: Database.Database;
  let links: DecisionLinksRepository;
  let svc: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-svc-classify-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    links = new DecisionLinksRepository(db);
    svc = new DecisionService({
      db,
      decisions: new DecisionsRepository(db),
      links,
    });
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("classifies a qualified-name governs target as qn, not path", () => {
    const d = svc.create({
      title: "T",
      description: "D",
      rationale: "R",
      governs: ["src/foo/bar.ts::doThing"],
    });
    const allLinks = links.findByDecision(d.id);
    const governs = allLinks.find((l) => l.relation === "GOVERNS");
    expect(governs?.target_kind).toBe("qn"); // currently "path" — bug
  });
});
