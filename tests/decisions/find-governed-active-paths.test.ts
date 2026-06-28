import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionSearch } from "../../src/decisions/search.js";

describe("DecisionSearch.findGovernedActivePaths", () => {
  let root: string;
  let db: Database.Database;
  let decisions: DecisionsRepository;
  let links: DecisionLinksRepository;
  let search: DecisionSearch;
  const now = "2026-06-28T10:00:00Z";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-agp-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    decisions = new DecisionsRepository(db);
    links = new DecisionLinksRepository(db);
    search = new DecisionSearch(decisions, links);

    // active decision governs two paths
    decisions.insert({
      id: "d-active", seq: 1, title: "Active decision", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null, provenance: null,
      created_at: now, updated_at: now,
    });
    links.add({ decision_id: "d-active", target_kind: "path", target_ref: "src/active-a.ts", relation: "GOVERNS", created_at: now });
    links.add({ decision_id: "d-active", target_kind: "path", target_ref: "src/active-b.ts", relation: "GOVERNS", created_at: now });

    // active decision with a qn link — should NOT appear (only path kind)
    links.add({ decision_id: "d-active", target_kind: "qn", target_ref: "src/active-a.ts::fn", relation: "GOVERNS", created_at: now });

    // superseded decision — governed path must NOT appear
    decisions.insert({
      id: "d-superseded", seq: 2, title: "Superseded decision", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "superseded", superseded_by: "d-active", author: null, provenance: null,
      created_at: now, updated_at: now,
    });
    links.add({ decision_id: "d-superseded", target_kind: "path", target_ref: "src/old.ts", relation: "GOVERNS", created_at: now });

    // proposed decision — governed path must NOT appear
    decisions.insert({
      id: "d-proposed", seq: 3, title: "Proposed decision", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "proposed", superseded_by: null, author: null, provenance: null,
      created_at: now, updated_at: now,
    });
    links.add({ decision_id: "d-proposed", target_kind: "path", target_ref: "src/proposed.ts", relation: "GOVERNS", created_at: now });

    // second active decision governs a path already governed above (dedup test)
    decisions.insert({
      id: "d-active2", seq: 4, title: "Active decision 2", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null, provenance: null,
      created_at: now, updated_at: now,
    });
    links.add({ decision_id: "d-active2", target_kind: "path", target_ref: "src/active-a.ts", relation: "GOVERNS", created_at: now });
    links.add({ decision_id: "d-active2", target_kind: "path", target_ref: "src/active-c.ts", relation: "GOVERNS", created_at: now });
  });

  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("returns only path targets of active decisions, deduped", () => {
    const paths = search.findGovernedActivePaths();
    // active paths present
    expect(paths).toContain("src/active-a.ts");
    expect(paths).toContain("src/active-b.ts");
    expect(paths).toContain("src/active-c.ts");
    // qn target from active decision must not appear
    expect(paths).not.toContain("src/active-a.ts::fn");
    // superseded decision's path must not appear
    expect(paths).not.toContain("src/old.ts");
    // proposed decision's path must not appear
    expect(paths).not.toContain("src/proposed.ts");
  });

  it("deduplicates paths governed by multiple active decisions", () => {
    const paths = search.findGovernedActivePaths();
    const count = paths.filter((p) => p === "src/active-a.ts").length;
    expect(count).toBe(1);
  });

  it("returns empty array when no decisions exist", () => {
    decisions.delete("d-active");
    decisions.delete("d-active2");
    decisions.delete("d-superseded");
    decisions.delete("d-proposed");
    expect(search.findGovernedActivePaths()).toEqual([]);
  });
});
