import Database from "better-sqlite3";
import { existsSync } from "node:fs";

const META_KEY = "relocated_from_repo_cache";

export interface RelocationResult { copied: number; }

// Explicit column lists matching the decisions table schema as created by
// openDecisionsDb (BASE_SCHEMA CREATE TABLE columns, then ALTER TABLE additions
// ensureProvenanceColumn, ensureSeqColumn, ensureReconciliationColumns).
// We use explicit lists rather than SELECT * to be safe against any column-order
// drift that could arise if a DB was created by an older schema version.
const DECISIONS_COLS = [
  "id", "title", "description", "rationale", "problem", "resolution",
  "alternatives", "tier", "status", "superseded_by", "author", "provenance",
  "created_at", "updated_at",
  "seq",
  "reconciliation_verdict", "reconciled_at", "reconciled_source_hash",
  "reconciled_by", "nonconformant_nodes", "reconciliation_note",
].join(", ");

// decision_links: omit rowid so SQLite auto-assigns new rowids in the target,
// avoiding any rowid collision between the two DBs.
const LINKS_COLS = [
  "decision_id", "target_kind", "target_ref", "relation", "created_at",
].join(", ");

function alreadyRelocated(db: Database.Database): boolean {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(META_KEY) as
    | { value: string } | undefined;
  return row?.value === "true";
}

function markRelocated(db: Database.Database): void {
  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(META_KEY, "true");
}

/**
 * One-shot, idempotent relocation: union the legacy in-repo decisions DB
 * (`<repo>/.cortex/decisions.db`) into `target` (the new out-of-repo store).
 * INSERT OR IGNORE on primary keys → distinct decisions merge, identical ids
 * dedupe (target wins). Guarded by a schema_meta flag. Legacy file is left in
 * place. Returns the number of decision rows copied.
 */
export function relocateLegacyDecisions(
  target: Database.Database,
  legacyPath: string,
): RelocationResult {
  if (alreadyRelocated(target)) return { copied: 0 };
  if (!existsSync(legacyPath)) { markRelocated(target); return { copied: 0 }; }

  const before = (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c;
  target.exec(`ATTACH '${legacyPath.replace(/'/g, "''")}' AS legacy`);
  try {
    target.transaction(() => {
      target.exec(
        `INSERT OR IGNORE INTO decisions (${DECISIONS_COLS})
         SELECT ${DECISIONS_COLS} FROM legacy.decisions`,
      );
      target.exec(
        `INSERT INTO decision_links (${LINKS_COLS})
         SELECT ${LINKS_COLS} FROM legacy.decision_links`,
      );
      target.exec(
        `INSERT INTO id_sequences (entity_type, next_val)
         SELECT entity_type, next_val FROM legacy.id_sequences WHERE true
         ON CONFLICT(entity_type) DO UPDATE SET
           next_val = MAX(id_sequences.next_val, excluded.next_val)`,
      );
      markRelocated(target);
    })();
  } finally {
    target.exec(`DETACH legacy`);
  }
  const after = (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c;
  return { copied: after - before };
}
