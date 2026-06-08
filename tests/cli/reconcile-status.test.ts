import { describe, it, expect } from "vitest";
import { countDriftedDecisions } from "../../src/cli/commands/reconcile.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("countDriftedDecisions", () => {
  it("counts active, governed decisions whose hash differs from the stored one", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "rec-cli-"));
    writeFileSync(join(repoDir, "x.ts"), "v1");
    const db = openDecisionsDb(join(repoDir, "decisions.db"));
    const decisions = new DecisionsRepository(db);
    const links = new DecisionLinksRepository(db);
    decisions.insert({ id: "d1", seq: 0, title: "t", description: null, rationale: null, problem: null,
      resolution: null, alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null, provenance: null, created_at: "t", updated_at: "t" });
    links.add({ decision_id: "d1", target_kind: "path", target_ref: "x.ts", relation: "GOVERNS", created_at: "t" });
    // never judged ⇒ reconciled_source_hash is null ⇒ drifted
    expect(countDriftedDecisions(repoDir, decisions, links)).toBe(1);
    db.close();
  });

  it("does not count active decisions with no GOVERNS links (declarative)", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "rec-cli-"));
    const db = openDecisionsDb(join(repoDir, "decisions.db"));
    const decisions = new DecisionsRepository(db);
    const links = new DecisionLinksRepository(db);
    decisions.insert({ id: "d2", seq: 0, title: "t", description: null, rationale: null, problem: null,
      resolution: null, alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null, provenance: null, created_at: "t", updated_at: "t" });
    expect(countDriftedDecisions(repoDir, decisions, links)).toBe(0);
    db.close();
  });
});
