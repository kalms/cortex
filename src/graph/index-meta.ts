import Database from "better-sqlite3";

export interface IndexMeta {
  indexed_commit: string | null;
  indexed_dirty_sig: string | null;
  indexed_at: string;
}

const KEYS = ["indexed_commit", "indexed_dirty_sig", "indexed_at"] as const;

function ensureTable(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS cortex_index_meta (key TEXT PRIMARY KEY, value TEXT)");
}

/** Idempotently write the freshness baseline into the graph DB at `dbPath`.
 *  Opens its own handle (mirrors inject-frames/inject style). Never throws into
 *  the index path — failures are swallowed (best-effort metadata). */
export function writeIndexMeta(dbPath: string, meta: IndexMeta): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    ensureTable(db);
    const up = db.prepare(
      "INSERT INTO cortex_index_meta (key, value) VALUES (@key, @value) " +
      "ON CONFLICT(key) DO UPDATE SET value = @value",
    );
    const tx = db.transaction(() => {
      up.run({ key: "indexed_commit", value: meta.indexed_commit });
      up.run({ key: "indexed_dirty_sig", value: meta.indexed_dirty_sig });
      up.run({ key: "indexed_at", value: meta.indexed_at });
    });
    tx();
  } catch {
    /* best-effort: never fail indexing over freshness metadata */
  } finally {
    db?.close();
  }
}

/** Read the baseline from an open graph DB handle. Returns null when the table
 *  is absent (pre-feature index) or incomplete. */
export function readIndexMeta(db: Database.Database): IndexMeta | null {
  try {
    const rows = db.prepare("SELECT key, value FROM cortex_index_meta").all() as Array<{ key: string; value: string | null }>;
    if (rows.length === 0) return null;
    const m: Record<string, string | null> = {};
    for (const r of rows) m[r.key] = r.value;
    if (!("indexed_at" in m) || m.indexed_at == null) return null;
    return {
      indexed_commit: m.indexed_commit ?? null,
      indexed_dirty_sig: m.indexed_dirty_sig ?? null,
      indexed_at: m.indexed_at,
    };
  } catch {
    return null; // table missing on a degraded/old DB
  }
}

void KEYS; // (KEYS documents the stored keys; referenced for clarity)
