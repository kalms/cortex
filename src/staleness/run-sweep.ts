import Database from "better-sqlite3";
import { openDecisionsDb } from "../decisions/db.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { TodosRepository } from "../todos/repository.js";
import { TodoLinksRepository } from "../todos/links-repository.js";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { readIndexMeta } from "../graph/index-meta.js";
import { gitChangedFiles, gitKnownBranches, gitHead } from "../git/worktree-state.js";
import { sweepStaleness } from "./sweep.js";
import { writeReport } from "./report-store.js";
import { formatIndexLine } from "./format.js";
import type { SweepCandidate } from "./types.js";

/**
 * Index-time staleness sweep (spec §C1). Returns a bounded one-line summary for
 * the index's stdout, or null when there is nothing to say.
 *
 * ORDERING — MUST be called BEFORE `captureIndexMeta`. It reads the PREVIOUS
 * index's `indexed_commit` out of the graph DB to scope itemization, and
 * `captureIndexMeta` overwrites exactly that value with the current HEAD.
 * Called after, every sweep compares HEAD against HEAD and itemizes nothing,
 * forever, with no error to notice. `cortex_index_meta` is a live-only table
 * that `publishStagedDb` deliberately leaves untouched, so at this point it
 * still holds the previous run's value.
 *
 * `repoPath` is the CHECKOUT root: the sweep hashes the tree that was just
 * indexed. The decisions store it opens is identity-axis by design
 * (`resolveDecisionsDbPath` resolves that internally) — the two axes meeting
 * here is correct, and is the whole point of anchoring the hash to the checkout.
 *
 * NEVER THROWS. A staleness report is metadata about an index, not the index.
 */
export function runStalenessSweep(
  repoPath: string,
  dbPath: string,
  now: () => Date = () => new Date(),
): string | null {
  if (process.env.CORTEX_STALENESS === "0") return null;
  try {
    const sinceCommit = readPrevIndexedCommit(dbPath);
    const db = openDecisionsDb(resolveDecisionsDbPath(repoPath), legacyDecisionsDbPath(repoPath));
    try {
      const report = sweepStaleness({
        repoPath,
        candidates: collectCandidates(db),
        originBranches: collectOriginBranches(db),
        knownBranches: gitKnownBranches(repoPath),
        changedFiles: gitChangedFiles(repoPath, sinceCommit),
        sinceCommit,
        headCommit: gitHead(repoPath),
        now,
      });
      writeReport(repoPath, report);
      return formatIndexLine(report);
    } finally {
      db.close();
    }
  } catch {
    return null; // never fail an index over triage metadata
  }
}

/** The baseline the LAST index left behind, or null on a first index / degraded
 *  DB. Opened read-only and separately from the sweep's own store. */
function readPrevIndexedCommit(dbPath: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readIndexMeta(db)?.indexed_commit ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Flatten decisions + todos into sweep candidates. Stories are deliberately
 *  absent: they carry no `basis_hash` because they govern nothing, so they
 *  contribute to the C4 branch set only (see collectOriginBranches). */
function collectCandidates(db: Database.Database): SweepCandidate[] {
  const out: SweepCandidate[] = [];

  const decisions = new DecisionsRepository(db);
  const decisionLinks = new DecisionLinksRepository(db);
  for (const d of decisions.list()) {
    out.push({
      kind: "decision",
      id: d.id,
      title: d.title,
      status_active: d.status === "active",
      refs: decisionLinks.findByDecision(d.id)
        .filter((l) => l.relation === "GOVERNS")
        .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref })),
      basis_hash: d.basis_hash ?? null,
      reconciled_source_hash: d.reconciled_source_hash ?? null,
      origin_branch: d.origin_branch ?? null,
      origin_commit: d.origin_commit ?? null,
      origin_thread: d.origin_thread ?? null,
    });
  }

  const todos = new TodosRepository(db);
  const todoLinks = new TodoLinksRepository(db);
  for (const t of todos.list()) {
    out.push({
      kind: "todo",
      id: t.id,
      title: t.summary,
      // Non-terminal only, mirroring "active" for decisions: a closed todo's
      // basis moving is not news.
      status_active: t.state !== "done" && t.state !== "cancelled",
      refs: todoLinks.findByTodo(t.id)
        .filter((l) => l.relation === "GOVERNS")
        .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref })),
      basis_hash: t.basis_hash ?? null,
      reconciled_source_hash: null, // todos are never reconciled
      origin_branch: t.origin_branch ?? null,
      origin_commit: t.origin_commit ?? null,
      origin_thread: t.origin_thread ?? null,
    });
  }

  return out;
}

/** Distinct non-null `origin_branch` across all three authored tables. §C4 keys
 *  on the branch, not on governance, so stories count here even though they are
 *  never sweep candidates. Read-only DISTINCT over a fixed table list — the
 *  names are literals, never caller input. A table missing on an old store is
 *  skipped rather than fatal. */
function collectOriginBranches(db: Database.Database): string[] {
  const names = new Set<string>();
  for (const table of ["decisions", "todos", "stories"]) {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT origin_branch FROM ${table}
         WHERE origin_branch IS NOT NULL AND origin_branch != ''`,
      ).all() as Array<{ origin_branch: string }>;
      for (const r of rows) names.add(r.origin_branch);
    } catch {
      /* table absent on a pre-provenance store */
    }
  }
  return [...names];
}
