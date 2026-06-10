// tests/api/decisions-routing.test.ts
// Regression for the viewer bug where /api/decisions served the server-bound
// (home) repo's decisions for every project. openProjectDecisions must route
// to the requested project's own durable decisions DB.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, type DecisionRecord } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";
import { openProjectDecisions } from "../../src/mcp-server/api.js";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function rec(id: string, title: string): DecisionRecord {
  return {
    id, seq: 1, title, description: null, rationale: null, problem: null,
    resolution: null, alternatives: null, tier: "personal", status: "active",
    superseded_by: null, author: null, provenance: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

// A non-git temp dir → resolveDecisionsDbPath returns <dir>/.cortex/decisions.db
// (no durable-store / cortex.json side effects), a clean sandbox.
function repoWithDecision(prefix: string, id: string, title: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  const db = openDecisionsDb(resolveDecisionsDbPath(dir));
  const decisions = new DecisionsRepository(db);
  decisions.insert(rec(id, title));
  return { dir, decisions, links: new DecisionLinksRepository(db) };
}

describe("openProjectDecisions — viewer decisions are project-scoped", () => {
  it("opens a different registered project's decisions, not the bound home repo's", () => {
    const home = repoWithDecision("dec-home-", "D-home", "HOME decision");
    const other = repoWithDecision("dec-other-", "D-other", "OTHER decision");
    const registry = {
      findByName: (n: string) => (n === "other-proj" ? { root_path: other.dir } : null),
    };
    const pd = openProjectDecisions(home.decisions, home.links, "home-proj", "other-proj", registry);
    try {
      const titles = pd.decisions.list().map((d) => d.title);
      expect(titles).toContain("OTHER decision");
      expect(titles).not.toContain("HOME decision");
      expect(pd.owned).toBe(true);
    } finally {
      pd.close();
    }
  });

  it("returns the bound repo for the home project (no reopen)", () => {
    const home = repoWithDecision("dec-h2-", "D-h2", "HOME2");
    const registry = { findByName: () => null };
    const pd = openProjectDecisions(home.decisions, home.links, "home-proj", "home-proj", registry);
    expect(pd.owned).toBe(false);
    expect(pd.decisions).toBe(home.decisions);
    pd.close();
  });

  it("falls back to the bound repo when the project is unknown to the registry", () => {
    const home = repoWithDecision("dec-h3-", "D-h3", "HOME3");
    const registry = { findByName: () => null };
    const pd = openProjectDecisions(home.decisions, home.links, "home-proj", "ghost-proj", registry);
    expect(pd.owned).toBe(false);
    expect(pd.decisions).toBe(home.decisions);
    pd.close();
  });
});
