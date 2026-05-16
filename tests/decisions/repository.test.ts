import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, DecisionRecord } from "../../src/decisions/repository.js";

describe("DecisionsRepository", () => {
  let root: string;
  let db: Database.Database;
  let repo: DecisionsRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    repo = new DecisionsRepository(db);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  function sample(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
    return {
      id: "d1",
      title: "Use vitest",
      description: "Standardize on vitest for unit tests.",
      rationale: "Same runner across packages, fast watch mode.",
      problem: "Mixed jest/mocha setups slow contributor onboarding.",
      resolution: "Convert all suites to vitest by end of quarter.",
      alternatives: JSON.stringify([{ name: "jest", reason_rejected: "slower watch mode" }]),
      tier: "personal",
      status: "active",
      superseded_by: null,
      author: "claude",
      created_at: "2026-05-14T10:00:00Z",
      updated_at: "2026-05-14T10:00:00Z",
      ...overrides,
    };
  }

  it("insert + get round-trips a full record", () => {
    repo.insert(sample());
    const got = repo.get("d1");
    expect(got).toEqual(sample());
  });

  it("update modifies only the changed fields", () => {
    repo.insert(sample());
    repo.update("d1", { status: "deprecated", updated_at: "2026-05-14T11:00:00Z" });
    const got = repo.get("d1");
    expect(got?.status).toBe("deprecated");
    expect(got?.updated_at).toBe("2026-05-14T11:00:00Z");
    expect(got?.title).toBe("Use vitest"); // unchanged
  });

  it("delete removes the record and returns true; returns false if missing", () => {
    repo.insert(sample());
    expect(repo.delete("d1")).toBe(true);
    expect(repo.get("d1")).toBeNull();
    expect(repo.delete("d1")).toBe(false);
  });

  it("list returns all decisions ordered by created_at desc", () => {
    repo.insert(sample({ id: "d1", created_at: "2026-05-14T10:00:00Z" }));
    repo.insert(sample({ id: "d2", created_at: "2026-05-14T11:00:00Z" }));
    const all = repo.list();
    expect(all.map((d) => d.id)).toEqual(["d2", "d1"]);
  });

  it("get returns null for missing id", () => {
    expect(repo.get("missing")).toBeNull();
  });

  it("survives updates to indexed columns with non-trivial content", () => {
    // Regression for the FTS5 external-content corruption bug
    // (cortex#2): updating problem/resolution/description/rationale with
    // 3+ token text would corrupt the FTS index, with subsequent ops
    // failing as "database disk image is malformed".
    repo.insert(sample());

    repo.update("d1", { problem: "Prior decision framed the calibration finding as a binary choice" });
    repo.update("d1", { resolution: "drop the complexity gate and the ACDC step entirely" });
    repo.update("d1", { description: "The gate's whole reason for existing - gating ACDC step 3 - is gone." });
    repo.update("d1", {
      rationale: "ACDC's three patterns reviewed individually: dominator, fan, orphan-adoption.",
    });
    repo.update("d1", { title: "Drop the complexity gate and ACDC refinement" });

    const got = repo.get("d1");
    expect(got?.title).toBe("Drop the complexity gate and ACDC refinement");
    expect(got?.problem).toMatch(/calibration finding/);
    expect(got?.resolution).toMatch(/complexity gate/);

    // FTS search must still work on every indexed column after the updates.
    expect(repo.search("calibration").map((d) => d.id)).toEqual(["d1"]);
    expect(repo.search("entirely").map((d) => d.id)).toEqual(["d1"]);
    expect(repo.search("dominator").map((d) => d.id)).toEqual(["d1"]);
    expect(repo.search("refinement").map((d) => d.id)).toEqual(["d1"]);
  });
});

describe("DecisionsRepository search", () => {
  let root: string;
  let db: Database.Database;
  let repo: DecisionsRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    repo = new DecisionsRepository(db);
    repo.insert({
      id: "d1", title: "Use vitest", description: "vitest is fast.",
      rationale: "Single runner across packages.",
      problem: "Mixed jest/mocha.", resolution: "Convert.",
      alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null,
      created_at: "2026-05-14T10:00:00Z", updated_at: "2026-05-14T10:00:00Z",
    });
    repo.insert({
      id: "d2", title: "Use mimalloc", description: "Replace system malloc.",
      rationale: "Lower RSS, better fragmentation behavior.",
      problem: null, resolution: null,
      alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null,
      created_at: "2026-05-14T11:00:00Z", updated_at: "2026-05-14T11:00:00Z",
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("search matches against title", () => {
    const hits = repo.search("vitest");
    expect(hits.map((h) => h.id)).toEqual(["d1"]);
  });

  it("search matches against rationale text", () => {
    const hits = repo.search("fragmentation");
    expect(hits.map((h) => h.id)).toEqual(["d2"]);
  });

  it("search returns empty array on no match", () => {
    expect(repo.search("zzz_no_match")).toEqual([]);
  });
});
