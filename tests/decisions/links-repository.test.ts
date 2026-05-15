import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "../../src/decisions/links-repository.js";

describe("DecisionLinksRepository", () => {
  let root: string;
  let db: Database.Database;
  let decisions: DecisionsRepository;
  let links: DecisionLinksRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    decisions = new DecisionsRepository(db);
    links = new DecisionLinksRepository(db);
    decisions.insert({
      id: "d1", title: "t", description: null, rationale: null, problem: null,
      resolution: null, alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null, created_at: "2026-05-14T10:00:00Z",
      updated_at: "2026-05-14T10:00:00Z",
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("add + findByDecision round-trips", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "src/foo.ts::bar", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    const got = links.findByDecision("d1");
    expect(got).toHaveLength(1);
    expect(got[0].target_kind).toBe("qn");
    expect(got[0].target_ref).toBe("src/foo.ts::bar");
    expect(got[0].relation).toBe("GOVERNS");
  });

  it("findByTarget matches by (kind, ref)", () => {
    links.add({ decision_id: "d1", target_kind: "path", target_ref: "src/foo.ts", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    expect(links.findByTarget("path", "src/foo.ts")).toHaveLength(1);
    expect(links.findByTarget("qn", "src/foo.ts")).toHaveLength(0);
  });

  it("findByTarget supports relation filter", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "REFERENCES", created_at: "2026-05-14T10:00:00Z" });
    expect(links.findByTarget("qn", "x", "GOVERNS")).toHaveLength(1);
    expect(links.findByTarget("qn", "x")).toHaveLength(2);
  });

  it("remove deletes one link by (decision_id, target_kind, target_ref, relation)", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "REFERENCES", created_at: "2026-05-14T10:00:00Z" });
    expect(
      links.remove("d1", "qn", "x", "GOVERNS"),
    ).toBe(true);
    expect(links.findByDecision("d1").map((l) => l.relation)).toEqual(["REFERENCES"]);
  });

  it("CASCADE deletes links when the decision is deleted", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    decisions.delete("d1");
    expect(links.findByDecision("d1")).toHaveLength(0);
  });
});
