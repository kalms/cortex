import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService.update — governs replacement", () => {
  let dir: string;
  let db: Database.Database;
  let links: DecisionLinksRepository;
  let svc: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-update-governs-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    links = new DecisionLinksRepository(db);
    svc = new DecisionService({
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

  it("adds new governs when none existed before", () => {
    const d = svc.create({ title: "T", description: "D", rationale: "R" });
    svc.update(d.id, { governs: ["src/a.ts", "src/b.ts"] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("removes governs that are not in the new set", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    svc.update(d.id, { governs: ["src/a.ts"] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts"]);
  });

  it("clears all governs when governs: [] is passed", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts"],
    });
    svc.update(d.id, { governs: [] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual([]);
  });

  it("leaves governs untouched when undefined", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts"],
    });
    svc.update(d.id, { title: "T2" });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts"]);
  });

  it("computes minimal diff (no duplicate inserts on overlap)", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts"],
    });
    svc.update(d.id, { governs: ["src/b.ts", "src/c.ts"] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("references replacement: same semantics as governs", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      references: ["doc/spec.md"],
    });
    svc.update(d.id, { references: ["doc/other.md"] });
    expect(targetsFor(d.id, "REFERENCES")).toEqual(["doc/other.md"]);
  });
});
