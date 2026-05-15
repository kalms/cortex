import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService.supersede / propose", () => {
  let root: string;
  let db: Database.Database;
  let svc: DecisionService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("supersede creates a new decision, marks old superseded, links SUPERSEDES", () => {
    const original = svc.create({ title: "v1", description: "x", rationale: "y" });
    const replacement = svc.supersede({
      old_decision_id: original.id,
      title: "v2",
      problem: "better needed",
      resolution: "use v2",
      rationale: "improved",
      alternatives: [],
    });
    expect(svc.get(original.id)?.status).toBe("superseded");
    expect(svc.get(original.id)?.superseded_by).toBe(replacement.id);
    const links = new DecisionLinksRepository(db).findByDecision(replacement.id);
    expect(links.find((l) => l.relation === "SUPERSEDES")?.target_ref).toBe(original.id);
  });

  it("propose creates a decision with status='proposed'", () => {
    const d = svc.propose({
      title: "draft", problem: "x", rationale: "y", resolution: "z",
    });
    expect(svc.get(d.id)?.status).toBe("proposed");
  });

  it("propose with pr_number adds a PR_INTRODUCES_DECISION link", () => {
    const d = svc.propose({
      title: "draft", problem: "x", rationale: "y", resolution: "z",
      pr_number: 42,
    });
    const links = new DecisionLinksRepository(db).findByDecision(d.id);
    expect(links.find((l) => l.relation === "PR_INTRODUCES_DECISION")?.target_ref).toBe("42");
    expect(links.find((l) => l.relation === "PR_INTRODUCES_DECISION")?.target_kind).toBe("pr");
  });
});
