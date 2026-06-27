import type Database from "better-sqlite3";
import { mintId } from "../ids/allocator.js";
import { PREFIX } from "../ids/short-id.js";

const META_KEY = "decision_ids_shortform";
const DECISION_PREFIX = `${PREFIX.decision}-`; // "D-"

function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Hard cutover: rewrite every legacy (non-"D-") decision id to a short
 * canonical id, assign a per-repo seq in created_at order, and remap all
 * internal references — superseded_by, decision_links.decision_id, and
 * decision_links.target_ref for decision-kind links. UUIDs are dropped (no
 * legacy alias). Idempotent: rows already in D- form are skipped, and the
 * schema_meta flag short-circuits repeat runs once nothing legacy remains.
 *
 * @param opts.force - When true, skip the schema_meta short-circuit and
 *   re-scan for non-D- rows unconditionally. Use only on the graph-import
 *   path where UUID rows are inserted AFTER the runner already recorded the
 *   flag. The WHERE clause still skips rows that are already in D- form, so
 *   force is safe to call on a partially-converted store.
 */
export function migrateDecisionIdsToShortForm(db: Database.Database, opts?: { force?: boolean }): void {
  if (!opts?.force && readMeta(db, META_KEY) === "done") return;

  // PRAGMA foreign_keys is a no-op inside an active transaction (SQLite
  // restriction). Disable FK enforcement at the connection level BEFORE
  // opening the transaction so the PK UPDATE cascade doesn't trip on
  // decision_links.decision_id REFERENCES decisions(id).
  db.pragma("foreign_keys = OFF");

  try {
    db.transaction(() => {
      const legacy = db
        .prepare(
          `SELECT id FROM decisions WHERE id NOT LIKE ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(`${DECISION_PREFIX}%`) as Array<{ id: string }>;

      const idExists = (cand: string) =>
        db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(cand) != null;
      const map = new Map<string, string>();
      for (const { id: oldId } of legacy) {
        const minted = mintId(db, "decision", idExists);
        db.prepare("UPDATE decisions SET seq = ? WHERE id = ?").run(minted.seq, oldId);
        map.set(oldId, minted.id);
      }
      if (map.size === 0) {
        db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'done')").run(META_KEY);
        return;
      }

      for (const [oldId, newId] of map) {
        db.prepare("UPDATE decisions SET id = ? WHERE id = ?").run(newId, oldId);
        db.prepare("UPDATE decisions SET superseded_by = ? WHERE superseded_by = ?").run(newId, oldId);
        db.prepare("UPDATE decision_links SET decision_id = ? WHERE decision_id = ?").run(newId, oldId);
        db.prepare(
          "UPDATE decision_links SET target_ref = ? WHERE target_kind = 'decision' AND target_ref = ?",
        ).run(newId, oldId);
      }

      db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'done')").run(META_KEY);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
