import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService over sidecar DB", () => {
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

  it("create returns a decision with an id", () => {
    const d = svc.create({
      title: "Use vitest",
      description: "Standardize.",
      rationale: "Speed.",
      alternatives: [{ name: "jest", reason_rejected: "slower" }],
    });
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.title).toBe("Use vitest");
  });

  it("create + get round-trips", () => {
    const d = svc.create({ title: "t", description: "x", rationale: "y" });
    const got = svc.get(d.id);
    expect(got?.title).toBe("t");
  });

  it("create with governs links populates decision_links", () => {
    const d = svc.create({
      title: "t", description: "x", rationale: "y",
      governs: ["src/foo.ts"],
    });
    const links = new DecisionLinksRepository(db).findByDecision(d.id);
    expect(links).toHaveLength(1);
    expect(links[0].target_kind).toBe("path");
    expect(links[0].target_ref).toBe("src/foo.ts");
    expect(links[0].relation).toBe("GOVERNS");
  });

  it("search hits FTS via DecisionsRepository", () => {
    svc.create({ title: "Use vitest", description: "fast", rationale: "single runner" });
    svc.create({ title: "Use mimalloc", description: "low rss", rationale: "fragmentation" });
    const hits = svc.search("fragmentation");
    expect(hits.map((h) => h.title)).toEqual(["Use mimalloc"]);
  });
});
