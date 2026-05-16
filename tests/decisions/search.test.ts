import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionSearch } from "../../src/decisions/search.js";

describe("DecisionSearch.findGoverning", () => {
  let root: string;
  let db: Database.Database;
  let decisions: DecisionsRepository;
  let links: DecisionLinksRepository;
  let search: DecisionSearch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    decisions = new DecisionsRepository(db);
    links = new DecisionLinksRepository(db);
    search = new DecisionSearch(decisions, links);
    const now = "2026-05-14T10:00:00Z";
    decisions.insert({
      id: "d-fn", title: "Function rule", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null,
      created_at: now, updated_at: now,
    });
    decisions.insert({
      id: "d-file", title: "File rule", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null,
      created_at: now, updated_at: now,
    });
    decisions.insert({
      id: "d-dir", title: "Dir rule", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null,
      created_at: now, updated_at: now,
    });
    links.add({ decision_id: "d-fn", target_kind: "qn", target_ref: "src/foo.ts::bar", relation: "GOVERNS", created_at: now });
    links.add({ decision_id: "d-file", target_kind: "path", target_ref: "src/foo.ts", relation: "GOVERNS", created_at: now });
    links.add({ decision_id: "d-dir", target_kind: "path", target_ref: "src", relation: "GOVERNS", created_at: now });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("returns the function-level rule when given the exact QN", () => {
    const hits = search.findGoverning("src/foo.ts::bar");
    expect(hits.map((d) => d.id)).toEqual(["d-fn"]);
  });

  it("falls back to the file rule when the QN has no direct match", () => {
    const hits = search.findGoverning("src/foo.ts::missing");
    expect(hits.map((d) => d.id)).toEqual(["d-file"]);
  });

  it("walks up directories when no file rule exists", () => {
    const hits = search.findGoverning("src/baz.ts");
    expect(hits.map((d) => d.id)).toEqual(["d-dir"]);
  });

  it("returns empty when nothing governs", () => {
    expect(search.findGoverning("unrelated/path.ts")).toEqual([]);
  });
});
