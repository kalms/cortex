import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runStalenessSweep } from "../../src/staleness/run-sweep.js";
import { readReport } from "../../src/staleness/report-store.js";
import { writeIndexMeta } from "../../src/graph/index-meta.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../src/db/resolve-path.js";
import { hashGovernedSource } from "../../src/decisions/reconciliation.js";
import { gitHead } from "../../src/git/worktree-state.js";

const NOW = () => new Date("2026-08-28T00:00:00.000Z");
const ISO = "2026-08-28T00:00:00.000Z";
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });

const GOVERNED = ["d1", "d2", "d3", "t1", "t2", "t3"];
const ref = (n: string) => ({ target_kind: "path", target_ref: `src/${n}.ts` });

/**
 * main with six governed files; three decisions and three todos authored on
 * `feature/work` (a branch that never exists locally, standing in for a pruned
 * worktree); one pre-provenance decision with no reference point; and the last
 * index's baseline recorded at HEAD.
 */
function motivatingFixture(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cortex-motivating-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  mkdirSync(join(root, "src"), { recursive: true });
  for (const n of GOVERNED) writeFileSync(join(root, "src", `${n}.ts`), `export const ${n} = 1;\n`);
  writeFileSync(join(root, "src", "unrelated.ts"), "export const u = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "--no-gpg-sign", "-m", "seed");
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const dbPath = join(root, ".cortex", "db");
  new Database(dbPath).close();

  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  try {
    const decisions = new DecisionsRepository(db);
    const decisionLinks = new DecisionLinksRepository(db);
    const todos = new TodosRepository(db);
    const todoLinks = new TodoLinksRepository(db);
    let seq = 0;
    for (const n of ["d1", "d2", "d3"]) {
      const id = `D-${n}00`;
      decisions.insert({
        id, seq: ++seq, title: `decision ${n}`, description: null, rationale: null,
        problem: null, resolution: null, alternatives: null, tier: "team",
        status: "active", superseded_by: null, author: "t", provenance: null,
        created_at: ISO, updated_at: ISO,
        origin_branch: "feature/work", origin_commit: gitHead(root),
        basis_hash: hashGovernedSource(root, [ref(n)]),
      } as never);
      decisionLinks.add({ decision_id: id, ...ref(n), relation: "GOVERNS", created_at: ISO } as never);
    }
    for (const n of ["t1", "t2", "t3"]) {
      const id = `T-${n}00`;
      todos.insert({
        id, seq: ++seq, summary: `todo ${n}`, description: null, state: "open",
        state_reason: null, proposed_by: "t", proposed_at: ISO, started_at: null,
        closed_at: null, assignee: null, created_at: ISO, updated_at: ISO,
        origin_branch: "feature/work", origin_commit: gitHead(root),
        basis_hash: hashGovernedSource(root, [ref(n)]),
      } as never);
      todoLinks.add({ todo_id: id, ...ref(n), relation: "GOVERNS", created_at: ISO } as never);
    }
    // The pre-existing population: no reference point, and none can be made.
    decisions.insert({
      id: "D-old0", seq: ++seq, title: "pre-provenance", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "team",
      status: "active", superseded_by: null, author: "t", provenance: null,
      created_at: ISO, updated_at: ISO, basis_hash: null,
    } as never);
    decisionLinks.add({ decision_id: "D-old0", ...ref("d1"), relation: "GOVERNS", created_at: ISO } as never);
  } finally { db.close(); }

  writeIndexMeta(dbPath, { indexed_commit: gitHead(root), indexed_dirty_sig: null, indexed_at: ISO });
  return { root, dbPath };
}

/** Land an edit to each named file, as a merge would. */
function land(root: string, names: string[]): void {
  for (const n of names) writeFileSync(join(root, "src", `${n}.ts`), `export const ${n} = 2;\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "--no-gpg-sign", "-m", "merge");
}

function snapshotRows(root: string): string {
  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  try {
    const decisions = db.prepare("SELECT * FROM decisions ORDER BY id").all();
    const todos = db.prepare("SELECT * FROM todos ORDER BY id").all();
    expect(decisions.length).toBeGreaterThan(0);
    expect(todos.length).toBeGreaterThan(0);
    return JSON.stringify(decisions) + JSON.stringify(todos);
  } finally { db.close(); }
}

describe("the motivating sequence, end to end", () => {
  it("itemizes exactly the rows the merge touched, counts the rest, mutates nothing", () => {
    const { root, dbPath } = motivatingFixture();
    land(root, ["d1", "t1", "t2"]);

    const before = snapshotRows(root);
    runStalenessSweep(root, dbPath, NOW);
    const report = readReport(root)!;

    // Exactly the three touched rows are itemized.
    expect(report.itemized.map((r) => r.id).sort()).toEqual(["D-d100", "T-t100", "T-t200"]);
    // The untouched branch rows are silent.
    expect(report.itemized.map((r) => r.id)).not.toContain("D-d200");
    // The pre-existing row is counted, never itemized.
    expect(report.counts.no_reference_point).toBe(1);
    // The authoring branch is gone, and every itemized row says so.
    expect(report.concluded_branches).toContain("feature/work");
    expect(report.itemized.length).toBeGreaterThan(0);
    expect(report.itemized.every((r) => r.branch_concluded)).toBe(true);
    // Nothing landed on any row (C5).
    expect(snapshotRows(root)).toBe(before);
  });

  it("a clean merge itemizes nothing", () => {
    const { root, dbPath } = motivatingFixture();
    land(root, ["unrelated"]);

    runStalenessSweep(root, dbPath, NOW);
    const report = readReport(root)!;
    expect(report.itemized).toHaveLength(0);
    expect(report.counts.outstanding).toBe(0);
    expect(report.counts.basis_moved).toBe(0);
    // The backlog is still counted — it just is not news.
    expect(report.counts.no_reference_point).toBe(1);
  });
});
