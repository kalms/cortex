import Database from "better-sqlite3";
import { existsSync } from "node:fs";

const META_KEY = "relocated_from_repo_cache";

export interface RelocationResult { copied: number; }

function alreadyRelocated(db: Database.Database): boolean {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(META_KEY) as
    | { value: string } | undefined;
  return row?.value === "true";
}

function markRelocated(db: Database.Database): void {
  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(META_KEY, "true");
}

/**
 * Compute the intersection of columns that exist in BOTH the target and the
 * attached `legacy` schema for the given table, preserving target column order.
 * Column names come from PRAGMA table_info (trusted schema metadata, not user
 * input) so interpolating them into SQL is safe.
 *
 * Using the intersection means columns present only in the target (e.g. `seq`,
 * reconciliation columns added by ALTER TABLE in newer schema versions) are
 * simply omitted from the SELECT; they then take their schema defaults (NULL)
 * for rows copied from an older legacy DB. Columns present only in the legacy
 * are likewise ignored.
 */
function sharedColumns(target: Database.Database, table: string): string[] {
  const targetCols = (
    target.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const legacyCols = new Set(
    (
      target.prepare(`PRAGMA legacy.table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name),
  );
  return targetCols.filter((c) => legacyCols.has(c));
}

/**
 * One-shot, idempotent relocation: union the legacy in-repo decisions DB
 * (`<repo>/.cortex/decisions.db`) into `target` (the new out-of-repo store).
 * INSERT OR IGNORE on primary keys → distinct decisions merge, identical ids
 * dedupe (target wins). decision_links are copied with a NOT-EXISTS guard so
 * logically-identical link tuples are never duplicated. Guarded by a
 * schema_meta flag so the operation runs at most once per target store. Legacy
 * file is left in place. Returns the number of decision rows copied.
 *
 * Column lists are computed at runtime as the intersection of columns that
 * exist in both the legacy and target tables, so this is robust to legacy DBs
 * of any schema age (e.g. missing `seq` or reconciliation columns that were
 * added by ALTER TABLE in newer schema versions). Target-only columns take
 * their schema defaults (NULL) for legacy rows.
 *
 * Non-fatal: if `legacyPath` exists but is corrupt or unreadable, the
 * function logs a concise warning and returns `{ copied: 0 }` rather than
 * throwing. The schema_meta flag is NOT set in this case so a later retry
 * (after the legacy DB is repaired) will attempt the relocation again.
 */
export function relocateLegacyDecisions(
  target: Database.Database,
  legacyPath: string,
): RelocationResult {
  if (alreadyRelocated(target)) return { copied: 0 };
  if (!existsSync(legacyPath)) { markRelocated(target); return { copied: 0 }; }

  const before = (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c;
  const escaped = legacyPath.replace(/'/g, "''");
  try {
    target.exec(`ATTACH '${escaped}' AS legacy`);
  } catch (err) {
    console.warn(`[relocation] skipped legacy ${legacyPath}: ${err}`);
    return { copied: 0 };
  }
  try {
    target.transaction(() => {
      // Compute the column intersection at runtime so we handle legacy DBs of
      // any age without hardcoded column lists.
      const decisionsCols = sharedColumns(target, "decisions").join(", ");
      target.exec(
        `INSERT OR IGNORE INTO decisions (${decisionsCols})
         SELECT ${decisionsCols} FROM legacy.decisions`,
      );

      // decision_links: omit rowid so SQLite auto-assigns new rowids in the
      // target, avoiding any rowid collision between the two DBs. The dedup
      // predicate columns (decision_id, target_kind, target_ref, relation) are
      // base schema columns present in every known legacy version.
      const linksCols = sharedColumns(target, "decision_links")
        .filter((c) => c !== "rowid")
        .join(", ");
      target.exec(
        `INSERT INTO decision_links (${linksCols})
         SELECT l.${linksCols.split(", ").join(", l.")}
         FROM legacy.decision_links l
         WHERE NOT EXISTS (
           SELECT 1 FROM decision_links t
           WHERE t.decision_id = l.decision_id
             AND t.target_ref  = l.target_ref
             AND t.relation    = l.relation
             AND t.target_kind = l.target_kind
         )`,
      );

      // id_sequences: entity_type and next_val are base columns present in all
      // legacy versions. Guard against a legacy that has no id_sequences table.
      const hasIdSeq = (
        target
          .prepare(`SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='id_sequences'`)
          .get()
      ) != null;
      if (hasIdSeq) {
        target.exec(
          `INSERT INTO id_sequences (entity_type, next_val)
           SELECT entity_type, next_val FROM legacy.id_sequences WHERE true
           ON CONFLICT(entity_type) DO UPDATE SET
             next_val = MAX(id_sequences.next_val, excluded.next_val)`,
        );
      }

      markRelocated(target);
    })();
  } catch (err) {
    console.warn(`[relocation] skipped legacy ${legacyPath}: ${err}`);
    try { target.exec(`DETACH legacy`); } catch { /* ignore detach failure */ }
    return { copied: 0 };
  }
  try { target.exec(`DETACH legacy`); } catch { /* ignore detach failure */ }
  const after = (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c;
  return { copied: after - before };
}
