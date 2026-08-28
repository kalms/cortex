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

function fixture(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cortex-runsweep-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "T"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "seed"], { stdio: "ignore" });
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const dbPath = join(root, ".cortex", "db");
  new Database(dbPath).close();
  return { root, dbPath };
}

function seedDecision(root: string, basis: string | null, id = "D-aaaa"): void {
  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  try {
    new DecisionsRepository(db).insert({
      id, seq: 1, title: "governs a", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "team",
      status: "active", superseded_by: null, author: "t", provenance: null,
      created_at: ISO, updated_at: ISO, basis_hash: basis,
    } as never);
    new DecisionLinksRepository(db).add({
      decision_id: id, target_kind: "path", target_ref: "src/a.ts",
      relation: "GOVERNS", created_at: ISO,
    } as never);
  } finally { db.close(); }
}

function seedTodo(root: string, basis: string | null, state: string, id: string): void {
  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  try {
    new TodosRepository(db).insert({
      id, seq: Number(id.charCodeAt(2)), summary: `todo ${state}`, description: null,
      state, state_reason: null, proposed_by: "t", proposed_at: ISO,
      started_at: null, closed_at: null, assignee: null,
      created_at: ISO, updated_at: ISO, basis_hash: basis,
    } as never);
    new TodoLinksRepository(db).add({
      todo_id: id, target_kind: "path", target_ref: "src/a.ts",
      relation: "GOVERNS", created_at: ISO,
    } as never);
  } finally { db.close(); }
}

describe("runStalenessSweep", () => {
  it("writes a report and itemizes a row whose basis moved since the last index", () => {
    const { root, dbPath } = fixture();
    const basis = hashGovernedSource(root, [{ target_kind: "path", target_ref: "src/a.ts" }]);
    seedDecision(root, basis);
    writeIndexMeta(dbPath, { indexed_commit: gitHead(root), indexed_dirty_sig: null, indexed_at: "x" });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "change"], { stdio: "ignore" });

    const line = runStalenessSweep(root, dbPath, NOW);
    expect(line).toContain("1 newly flagged");
    const report = readReport(root)!;
    expect(report.itemized.map((r) => r.id)).toEqual(["D-aaaa"]);
  });

  it("itemizes nothing when there is no previous index baseline", () => {
    const { root, dbPath } = fixture();
    const basis = hashGovernedSource(root, [{ target_kind: "path", target_ref: "src/a.ts" }]);
    seedDecision(root, basis);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    runStalenessSweep(root, dbPath, NOW);
    const report = readReport(root)!;
    expect(report.since_commit).toBeNull();
    expect(report.itemized).toHaveLength(0);
    expect(report.counts.outstanding).toBe(1);
  });

  it("counts a NULL-basis row without itemizing it", () => {
    const { root, dbPath } = fixture();
    seedDecision(root, null);
    writeIndexMeta(dbPath, { indexed_commit: gitHead(root), indexed_dirty_sig: null, indexed_at: "x" });
    writeFileSync(join(root, "src", "a.ts"), "changed\n");
    runStalenessSweep(root, dbPath, NOW);
    const report = readReport(root)!;
    expect(report.counts.no_reference_point).toBe(1);
    expect(report.itemized).toHaveLength(0);
  });

  it("MUTATES NOTHING — every authored row is byte-identical after a sweep (C5)", () => {
    const { root, dbPath } = fixture();
    const basis = hashGovernedSource(root, [{ target_kind: "path", target_ref: "src/a.ts" }]);
    seedDecision(root, basis);
    writeIndexMeta(dbPath, { indexed_commit: gitHead(root), indexed_dirty_sig: null, indexed_at: "x" });
    writeFileSync(join(root, "src", "a.ts"), "changed\n");

    const snapshot = () => {
      const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
      try {
        const rows = ["decisions", "todos", "stories"].map((t) =>
          JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
        expect(rows[0]).not.toBe("[]"); // the decisions snapshot must be non-empty
        return rows.join("|");
      } finally { db.close(); }
    };
    const before = snapshot();
    runStalenessSweep(root, dbPath, NOW);
    expect(snapshot()).toBe(before);
  });

  it("returns null and writes nothing when CORTEX_STALENESS=0", () => {
    const { root, dbPath } = fixture();
    seedDecision(root, null);
    process.env.CORTEX_STALENESS = "0";
    try {
      expect(runStalenessSweep(root, dbPath, NOW)).toBeNull();
      expect(readReport(root)).toBeNull();
    } finally { delete process.env.CORTEX_STALENESS; }
  });

  it("sweeps an open todo but never a done or cancelled one", () => {
    const { root, dbPath } = fixture();
    const basis = hashGovernedSource(root, [{ target_kind: "path", target_ref: "src/a.ts" }]);
    seedTodo(root, basis, "open", "T-open");
    seedTodo(root, basis, "done", "T-done");
    seedTodo(root, basis, "cancelled", "T-canc");
    writeIndexMeta(dbPath, { indexed_commit: gitHead(root), indexed_dirty_sig: null, indexed_at: "x" });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "change"], { stdio: "ignore" });

    runStalenessSweep(root, dbPath, NOW);
    const ids = readReport(root)!.itemized.map((r) => r.id);
    expect(ids).toContain("T-open");
    expect(ids).not.toContain("T-done");
    expect(ids).not.toContain("T-canc");
  });

  it("never throws when the graph DB is absent", () => {
    const { root } = fixture();
    expect(() => runStalenessSweep(root, join(root, ".cortex", "nope"), NOW)).not.toThrow();
  });
});
