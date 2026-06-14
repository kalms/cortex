import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { allocateSeq } from "../../ids/allocator.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import type { DecisionCommand } from "./decision.js";

/**
 * `cortex decision rehome <id> --to=<repo_path> [--dry-run]`
 *
 * Move a single decision (row + its `decision_links`) from the source repo
 * (resolved from cwd's git root) into the target repo's
 * `.cortex/decisions.db`. Manual re-home workflow for historical mis-routed
 * decisions — Phase 6 of the MCP multi-project routing design.
 *
 * The order is insert-into-target, then delete-from-source — never the reverse
 * — because a crash between the two leaves the data in the source DB rather
 * than vaporizing it. SQLite has no cross-file transaction so this is the best
 * available shape.
 */
export function cmdRehome(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) {
    throw new UsageError(
      "missing <id>",
      "Usage: cortex decision rehome <id> --to=<repo_path> [--dry-run]",
    );
  }
  const toFlag = cmd.flags["to"];
  if (typeof toFlag !== "string" || toFlag.length === 0) {
    throw new UsageError(
      "missing --to=<repo_path>",
      "Usage: cortex decision rehome <id> --to=<repo_path> [--dry-run]",
    );
  }
  const dryRun = cmd.flags["dry-run"] === true;

  // Source side — cwd must resolve to an indexed repo (or at least a git
  // root with a decisions sidecar; same check we apply to the target).
  if (ctx.state === "no-project") {
    throw new EnvironmentError(
      "decision rehome must run inside a git repository — cd into the source repo first",
      "cortex tour    to see what's available without a project",
    );
  }
  const sourceRepoPath = ctx.gitRoot ?? ctx.cwd;
  const sourceDbPath = join(sourceRepoPath, ".cortex", "decisions.db");
  if (!existsSync(sourceDbPath)) {
    throw new EnvironmentError(
      `source repo ${sourceRepoPath} isn't indexed — no .cortex/decisions.db found`,
      `cortex index . ${sourceRepoPath}`,
    );
  }

  // Target side — must be an absolute path (or resolvable from cwd) whose
  // git root holds a `.cortex/decisions.db`. We don't auto-walk-up here; the
  // user passes the repo root explicitly.
  const targetRepoPath = isAbsolute(toFlag) ? toFlag : resolve(ctx.cwd, toFlag);
  const targetDbPath = join(targetRepoPath, ".cortex", "decisions.db");
  if (!existsSync(targetRepoPath)) {
    throw new EnvironmentError(
      `target path ${targetRepoPath} doesn't exist`,
      `Pass --to=<absolute path to an indexed repo>`,
    );
  }
  if (!existsSync(targetDbPath)) {
    throw new EnvironmentError(
      `target ${targetRepoPath} isn't indexed — no .cortex/decisions.db found`,
      `cortex index . ${targetRepoPath}`,
    );
  }

  // Safety net: identical source and target is almost certainly a typo. Bail
  // before touching either DB so the user gets a clear message rather than a
  // confusing "already exists in target" error.
  if (resolve(sourceRepoPath) === resolve(targetRepoPath)) {
    throw new UsageError(
      `--to points at the source repo (${sourceRepoPath}); rehome is a move, not a self-link`,
      "Pass a different repo with --to=...",
    );
  }

  // Load source decision + links.
  const sourceDb = openDecisionsDb(sourceDbPath);
  let sourceClosed = false;
  try {
    const sourceDecisions = new DecisionsRepository(sourceDb);
    const sourceLinks = new DecisionLinksRepository(sourceDb);

    const decision = sourceDecisions.get(id);
    if (!decision) {
      throw new DomainError(
        `no decision '${id}' in ${sourceRepoPath}`,
        "Try: cortex decision list",
      );
    }
    const links = sourceLinks.findByDecision(id);

    // Open target and check for id collision before we mutate anything.
    const targetDb = openDecisionsDb(targetDbPath);
    let targetClosed = false;
    try {
      const targetDecisions = new DecisionsRepository(targetDb);
      const targetLinks = new DecisionLinksRepository(targetDb);

      if (targetDecisions.get(id)) {
        throw new DomainError(
          `'${id}' already exists in target ${targetRepoPath}; use update there if you want to modify it`,
          "Try: cortex decision show " + id,
        );
      }

      if (dryRun) {
        process.stdout.write(
          `[dry-run] would move ${id} from ${sourceRepoPath} → ${targetRepoPath} ` +
            `(${links.length} ${links.length === 1 ? "link" : "links"}).\n`,
        );
        return;
      }

      // Insert decision + links into target inside one target-side transaction.
      // The canonical `id` survives the move unchanged, but `seq` MUST be
      // reassigned from the target repo's counter — the source seq can collide
      // with an existing destination seq, and the target's next_val would never
      // advance if we just copied the source row verbatim.
      targetDb.transaction(() => {
        const targetSeq = allocateSeq(targetDb, "decision");
        targetDecisions.insert({ ...decision, seq: targetSeq });
        for (const link of links) targetLinks.add(link);
      })();

      // Verify the insert landed before we delete from source.
      const verify = targetDecisions.get(id);
      if (!verify) {
        throw new DomainError(
          `rehome failed: decision was not visible in target after insert (target: ${targetRepoPath})`,
          "Source DB was not modified.",
        );
      }

      // Dangling-reference check — emit warning BEFORE deleting from source so
      // the user sees the warning even if the delete step crashes. Stderr,
      // never stdout, to keep machine-readable output clean.
      const referencingLinks = sourceLinks.findByTarget("decision", id);
      const supersededByRefs = sourceDb
        .prepare(
          `SELECT id FROM decisions WHERE superseded_by = ?`,
        )
        .all(id) as Array<{ id: string }>;
      if (referencingLinks.length > 0 || supersededByRefs.length > 0) {
        process.stderr.write(
          `warning: ${id} is referenced by other decisions in ${sourceRepoPath}; ` +
            `those references will dangle after rehome:\n`,
        );
        for (const ref of referencingLinks) {
          process.stderr.write(
            `  - decision ${ref.decision_id} -[${ref.relation}]-> ${id}\n`,
          );
        }
        for (const r of supersededByRefs) {
          process.stderr.write(`  - decision ${r.id} has superseded_by = ${id}\n`);
        }
      }

      // Delete from source. Wrapped in one source-side transaction. The link
      // rows cascade away via ON DELETE CASCADE on decision_links.decision_id.
      try {
        sourceDb.transaction(() => {
          sourceDecisions.delete(id);
        })();
      } catch (e) {
        // RehomePartialError — the move is half-done. Print the exact SQL the
        // user can re-run manually so the recovery story is mechanical, not
        // forensic.
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `RehomePartialError: target insert succeeded but source delete failed (${msg}).\n` +
            `The decision now exists in BOTH ${sourceRepoPath} and ${targetRepoPath}.\n` +
            `To finish, run this against the source DB:\n` +
            `  sqlite3 "${sourceDbPath}" "DELETE FROM decisions WHERE id = '${id}';"\n`,
        );
        // Re-throw so the CLI exits non-zero.
        throw new DomainError(
          `rehome partial failure: ${msg}`,
          "See stderr for recovery SQL.",
        );
      }

      process.stdout.write(
        `Moved ${id} from ${sourceRepoPath} → ${targetRepoPath} ` +
          `(${links.length} ${links.length === 1 ? "link" : "links"}).\n`,
      );
    } finally {
      if (!targetClosed) {
        targetDb.close();
        targetClosed = true;
      }
    }
  } finally {
    if (!sourceClosed) {
      sourceDb.close();
      sourceClosed = true;
    }
  }
}
