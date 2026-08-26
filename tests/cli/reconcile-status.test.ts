import { describe, it, expect } from "vitest";
import { countDriftedDecisions } from "../../src/cli/commands/reconcile.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runReconcileCommand } from "../../src/cli/commands/reconcile.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";
import { hashGovernedSource } from "../../src/decisions/reconciliation.js";

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

describe("runReconcileCommand anchors to the checkout root", () => {
  // Governed refs are stored repo-relative. Anchored to a subdirectory, every
  // one resolves to <missing> and a clean store reports as entirely drifted.
  // This was invisible while CORTEX_RECONCILE gated the command; it is
  // always-on now, and the SessionStart hook is only safe because it cds to
  // the repo first — a hand-run `cortex reconcile status` does not.
  it("reports 0 from a subdirectory when the store is clean at the root", () => {
    const repo = mkdtempSync(join(tmpdir(), "rec-anchor-"));
    try {
      execSync(`git init -q "${repo}"`);
      writeFileSync(join(repo, "x.ts"), "v1");
      mkdirSync(join(repo, "src", "deep"), { recursive: true });

      const db = openDecisionsDb(resolveDecisionsDbPath(repo));
      const decisions = new DecisionsRepository(db);
      const links = new DecisionLinksRepository(db);
      decisions.insert({ id: "d-anchor", seq: 0, title: "t", description: null, rationale: null,
        problem: null, resolution: null, alternatives: null, tier: "personal", status: "active",
        superseded_by: null, author: null, provenance: null, created_at: "t", updated_at: "t" });
      links.add({ decision_id: "d-anchor", target_kind: "path", target_ref: "x.ts",
        relation: "GOVERNS", created_at: "t" });
      // Judge it clean AT THE ROOT — the only anchor that gives x.ts meaning.
      decisions.update("d-anchor", {
        reconciled_source_hash: hashGovernedSource(repo, [{ target_kind: "path", target_ref: "x.ts" }]),
      });
      db.close();

      const out: string[] = [];
      const orig = process.stdout.write;
      process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
      try {
        runReconcileCommand("status", join(repo, "src", "deep"));
      } finally {
        process.stdout.write = orig;
      }
      expect(out.join("").trim()).toBe("0");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
