import BetterSqlite3 from "better-sqlite3";

export interface PublishResult {
  /** Tables copied from staging into the live DB (staging's table set). */
  tablesReplaced: string[];
}

/**
 * Atomically replace the contents of the live graph DB with the staging DB's
 * contents, through a single libsqlite3 WAL transaction.
 *
 * Why: the canonical .cortex/db must NEVER be mutated out-of-band (the C
 * writer's fopen("wb") truncate) while the long-lived MCP server holds it open
 * — that corrupts the index b-trees. Here every byte reaching the live file
 * goes through libsqlite3 in WAL mode (safe single-writer / N-reader), so an
 * already-open reader sees the new committed snapshot on its next read with no
 * reopen, and a crash before COMMIT leaves the old state intact.
 *
 * Only tables present in STAGING are replaced. Live-only tables (e.g. the
 * lazily-migrated edge_annotations / cortex_index_meta) are left untouched —
 * the omission is the preservation. INSERT...SELECT copies rows (not pages), so
 * a page-size mismatch between staging (64 KiB, C writer) and live (4 KiB,
 * libsqlite3 default) is irrelevant.
 *
 * FTS5 virtual tables (e.g. ctx_nodes_fts) are a special case: a *contentless*
 * FTS5 index cannot be copied across databases via SQL — its shadow tables
 * (_data/_idx/_docsize/_config) are write-protected, and a contentless table
 * has no source table to rebuild from. So each virtual table is recreated from
 * staging's DDL and then REPOPULATED from the freshly-copied `nodes` table,
 * mirroring the C indexer (internal/indexer/src/pipeline/pipeline.c). The FTS
 * rowid follows the C indexer's search contract — the BM25 handler joins
 * `nodes n ON n.id = 'ctx-' || <fts>.rowid` (handlers.c) — so we key each FTS
 * row by the numeric suffix of the node id (NOT the live rowid, which
 * INSERT...SELECT reassigns). Searchable columns are derived from the FTS table
 * itself and intersected with `nodes`, so a schema change stays in sync; the
 * C-only `ctx_camel_split` tokenizer degrades to plain `name` (its own
 * documented fallback). Repopulation is best-effort: FTS is a search index, not
 * a source of truth.
 */
export function publishStagedDb(opts: { stagePath: string; liveDbPath: string }): PublishResult {
  const db = new BetterSqlite3(opts.liveDbPath); // creates the live DB on first index
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    db.exec(`ATTACH '${opts.stagePath.replace(/'/g, "''")}' AS stage`);
    try {
      const allTables = db
        .prepare("SELECT name, sql FROM stage.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string; sql: string }>;

      // Virtual (FTS5) tables and their SQLite-managed shadow tables
      // (<vtable>_data/_idx/_docsize/_config) are handled apart from the generic
      // row-copy — see the function docstring.
      const virtual = allTables.filter((r) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? ""));
      const virtualNames = new Set(virtual.map((r) => r.name));
      const isShadow = (name: string) => [...virtualNames].some((vt) => name.startsWith(vt + "_"));
      const regular = allTables
        .filter((r) => !virtualNames.has(r.name) && !isShadow(r.name))
        .map((r) => r.name);

      const tx = db.transaction(() => {
        // 1. Full content replace for every regular table (incl. `nodes`).
        for (const t of regular) {
          const { sql: createSql } = db
            .prepare("SELECT sql FROM stage.sqlite_master WHERE type='table' AND name=?")
            .get(t) as { sql: string };
          db.exec(createSql.replace(/CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS"));
          const cols = (db.prepare(`PRAGMA stage.table_info(${q(t)})`).all() as Array<{ name: string }>)
            .map((c) => q(c.name));
          db.exec(`DELETE FROM main.${q(t)}`);
          db.exec(`INSERT INTO main.${q(t)} (${cols.join(",")}) SELECT ${cols.join(",")} FROM stage.${q(t)}`);
        }
        // 2. Recreate each virtual table from staging DDL, then repopulate from
        //    the now-copied `nodes` (keyed by the 'ctx-<rowid>' search contract).
        const nodeCols = new Set(
          (db.prepare("PRAGMA main.table_info(nodes)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        for (const v of virtual) {
          db.exec(`DROP TABLE IF EXISTS main.${q(v.name)}`);
          db.exec(v.sql);
          try {
            const ftsCols = (db.prepare(`PRAGMA main.table_info(${q(v.name)})`).all() as Array<{ name: string }>)
              .map((c) => c.name)
              .filter((c) => nodeCols.has(c));
            if (ftsCols.length > 0) {
              const sel = ftsCols.map(q).join(", ");
              db.exec(
                `INSERT INTO main.${q(v.name)}(rowid, ${sel}) ` +
                  `SELECT CAST(substr(id, 5) AS INTEGER), ${sel} FROM main.nodes WHERE id LIKE 'ctx-%'`,
              );
            }
          } catch { /* FTS is a search index, not source of truth — degrade to empty */ }
        }
      });
      tx();

      db.pragma("wal_checkpoint(PASSIVE)");
      return { tablesReplaced: regular };
    } finally {
      db.exec("DETACH stage");
    }
  } finally {
    db.close();
  }
}

/** Quote a SQLite identifier. */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
