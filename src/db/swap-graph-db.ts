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
 * `CREATE TABLE IF NOT EXISTS` cannot widen a live table that already exists,
 * so a column the C indexer has since ADDED (e.g. ctx_projects.extract_schema)
 * would leave the row copy naming a column the live table lacks — the publish
 * throws and the freshly built index is discarded while a stale graph stays
 * live (ruevu/cortex#81). `reconcileSchema` closes that: it widens the live
 * table with ALTER TABLE ... ADD COLUMN, and falls back to rebuilding it from
 * staging's DDL when a column cannot be expressed that way.
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
          reconcileSchema(db, t, createSql);
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

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Make the live table able to receive staging's columns, in place, before the
 * row copy.
 *
 * The copy names staging's columns explicitly, so it throws unless the live
 * table has every one of them — and `CREATE TABLE IF NOT EXISTS` is a no-op
 * against an existing table, so a live store written before a C-indexer schema
 * upgrade never gains the new column on its own. That is issue #81: a store
 * predating `ctx_projects.extract_schema` fails at publish *after* the index
 * has been built, so the run reports what it built and then discards it.
 *
 * The default path is additive — `ALTER TABLE ... ADD COLUMN` per missing
 * column — because it preserves both the live table's indexes and any
 * live-only column a lazy migration added. SQLite refuses ADD COLUMN for a
 * PRIMARY KEY or for NOT NULL with no default; for those, and for the mirror
 * case (a live-only NOT NULL column with no default, which the copy could
 * never fill), the table is rebuilt from staging's DDL instead. A rebuild
 * drops the table's indexes with it, so their DDL is replayed afterwards.
 *
 * Contents are replaced wholesale either way, so nothing is lost by a rebuild
 * beyond schema the live store alone knew about.
 */
function reconcileSchema(db: BetterSqlite3.Database, table: string, stageCreateSql: string): void {
  const stageCols = db.prepare(`PRAGMA stage.table_info(${q(table)})`).all() as ColumnInfo[];
  const liveCols = db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as ColumnInfo[];
  const liveNames = new Set(liveCols.map((c) => c.name));
  const stageNames = new Set(stageCols.map((c) => c.name));

  const missing = stageCols.filter((c) => !liveNames.has(c.name));
  // A live-only NOT NULL column with no default cannot be satisfied by a copy
  // that names staging's columns only — every row would violate it.
  const unfillable = liveCols.some(
    (c) => !stageNames.has(c.name) && c.notnull === 1 && c.dflt_value === null,
  );
  if (missing.length === 0 && !unfillable) return;

  if (!unfillable && missing.every(isAddable)) {
    for (const c of missing) db.exec(`ALTER TABLE main.${q(table)} ADD COLUMN ${columnDecl(c)}`);
    return;
  }

  const indexes = db
    .prepare("SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(table) as Array<{ sql: string }>;
  db.exec(`DROP TABLE main.${q(table)}`);
  db.exec(stageCreateSql); // unqualified CREATE lands in main, not the attached stage
  for (const ix of indexes) {
    try { db.exec(ix.sql); } catch { /* index over a column staging dropped — it goes with it */ }
  }
}

/** SQLite refuses ADD COLUMN for a PRIMARY KEY, or for NOT NULL with no default. */
function isAddable(c: ColumnInfo): boolean {
  return c.pk === 0 && (c.notnull === 0 || c.dflt_value !== null);
}

/** Rebuild a column definition from PRAGMA table_info, for ADD COLUMN. */
function columnDecl(c: ColumnInfo): string {
  let decl = c.type ? `${q(c.name)} ${c.type}` : q(c.name);
  if (c.notnull === 1) decl += " NOT NULL";
  if (c.dflt_value !== null) decl += ` DEFAULT ${c.dflt_value}`;
  return decl;
}

/** Quote a SQLite identifier. */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
