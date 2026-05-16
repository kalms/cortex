import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import type { Event } from "../../src/events/types.js";

describe("DecisionService.supersede / propose", () => {
  let root: string;
  let db: Database.Database;
  let svc: DecisionService;
  let events: Event[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    events = [];
    svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
      bus: { emit: (e: Event) => events.push(e) },
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

  it("propose emits decision.proposed with pr_number null when no PR linked", () => {
    const d = svc.propose({
      title: "draft", problem: "x", resolution: "y", rationale: "z",
    });
    const ev = events.find((e) => e.kind === "decision.proposed") as any;
    expect(ev).toBeDefined();
    expect(ev.payload.decision_id).toBe(d.id);
    expect(ev.payload.pr_number).toBeNull();
  });

  it("propose emits decision.proposed with pr_number set when linked", () => {
    const d = svc.propose({
      title: "draft", problem: "x", resolution: "y", rationale: "z", pr_number: 512,
    });
    const ev = events.find((e) => e.kind === "decision.proposed") as any;
    expect(ev.payload.decision_id).toBe(d.id);
    expect(ev.payload.pr_number).toBe(512);
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

  it("supersede throws if old_decision_id does not exist, no partial write", () => {
    expect(() =>
      svc.supersede({
        old_decision_id: "nonexistent",
        title: "x",
        problem: "p",
        resolution: "r",
        rationale: "why",
      })
    ).toThrow();
    expect(new DecisionsRepository(db).list()).toHaveLength(0);
  });

  it("supersede emits decision.created for new and decision.superseded for old", () => {
    const old = svc.create({
      title: "old",
      description: "d",
      rationale: "r",
      problem: "p",
      resolution: "res",
    });
    events.length = 0; // clear the create event
    svc.supersede({
      old_decision_id: old.id,
      title: "new",
      problem: "np",
      resolution: "nr",
      rationale: "why",
    });
    expect(events.filter((e) => e.kind === "decision.created").length).toBe(1);
    expect(events.filter((e) => e.kind === "decision.superseded").length).toBe(1);
  });

  it("supersede creates exactly one SUPERSEDES link", () => {
    const old = svc.create({
      title: "old", description: "d", rationale: "r",
      problem: "p", resolution: "res",
    });
    const next = svc.supersede({
      old_decision_id: old.id,
      title: "new", problem: "np", resolution: "nr", rationale: "why",
    });
    const links = new DecisionLinksRepository(db).findByDecision(next.id);
    const supersedes = links.filter((l) => l.relation === "SUPERSEDES");
    expect(supersedes.length).toBe(1);
    expect(supersedes[0].target_ref).toBe(old.id);
    expect(supersedes[0].target_kind).toBe("decision");
  });
});
