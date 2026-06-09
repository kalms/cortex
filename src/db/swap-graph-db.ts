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
 */
export function publishStagedDb(opts: { stagePath: string; liveDbPath: string }): PublishResult {
  const db = new BetterSqlite3(opts.liveDbPath); // creates the live DB on first index
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    db.exec(`ATTACH '${opts.stagePath.replace(/'/g, "''")}' AS stage`);
    try {
      // Collect all regular (non-virtual) tables from staging.
      // FTS5 virtual tables (e.g. ctx_nodes_fts) and their SQLite-managed
      // shadow tables (_data, _idx, _config, _docsize) are excluded from the
      // row-copy loop — virtual tables cannot be written via plain SQL.
      // Instead, after the row-copy transaction we rebuild FTS in-place from
      // the freshly-published nodes table (see post-tx block below).
      const allTables = (db
        .prepare("SELECT name, sql FROM stage.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string; sql: string }>);

      const virtualNames = new Set(
        allTables
          .filter((r) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? ""))
          .map((r) => r.name),
      );
      const shadowNames = new Set(
        allTables
          .filter(
            (r) =>
              !virtualNames.has(r.name) &&
              [...virtualNames].some((vt) => r.name.startsWith(vt + "_")),
          )
          .map((r) => r.name),
      );

      const tables = allTables
        .filter((r) => !virtualNames.has(r.name) && !shadowNames.has(r.name))
        .map((r) => r.name);

      const tx = db.transaction(() => {
        for (const t of tables) {
          const { sql: createSql } = db
            .prepare("SELECT sql FROM stage.sqlite_master WHERE type='table' AND name=?")
            .get(t) as { sql: string };
          db.exec(createSql.replace(/CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS"));
          const cols = (db.prepare(`PRAGMA stage.table_info(${q(t)})`).all() as Array<{ name: string }>)
            .map((c) => q(c.name));
          db.exec(`DELETE FROM main.${q(t)}`);
          db.exec(`INSERT INTO main.${q(t)} (${cols.join(",")}) SELECT ${cols.join(",")} FROM stage.${q(t)}`);
        }
      });
      tx();

      // Rebuild FTS virtual tables in the live DB from the freshly-published
      // rows. Virtual tables are excluded from the row-copy loop above because
      // their shadow tables cannot be written via plain SQL. Instead we:
      //   1. DROP the virtual table in the live DB (takes its shadow tables)
      //   2. Re-CREATE it using the exact DDL from staging
      //   3. Re-populate it via the FTS5 external-content INSERT API
      for (const entry of allTables.filter((r) => virtualNames.has(r.name))) {
        try {
          db.exec(`DROP TABLE IF EXISTS main.${q(entry.name)}`);
          db.exec(entry.sql); // CREATE VIRTUAL TABLE ... (exact DDL from staging)
          // Use FTS5 external-content insert: rowid matches the numeric suffix of
          // the node id ("ctx-<n>"); only rows with a ctx- id were FTS-indexed.
          db.exec(
            `INSERT INTO ${q(entry.name)}(rowid, name, qualified_name, kind, file_path) ` +
              `SELECT CAST(substr(id, 5) AS INTEGER), name, qualified_name, kind, file_path ` +
              `FROM nodes WHERE id LIKE 'ctx-%'`,
          );
        } catch { /* non-fatal: FTS is a read-speed index, not source of truth */ }
      }

      db.pragma("wal_checkpoint(PASSIVE)");
      return { tablesReplaced: tables };
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
