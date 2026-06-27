import type Database from "better-sqlite3";

export type Migration = { name: string; up: (db: Database.Database) => void };

export type MigrationErrorKind = "store-too-new" | "migration-failed";

export class MigrationError extends Error {
  constructor(
    readonly kind: MigrationErrorKind,
    message: string,
    readonly detail?: { set?: string; unknown?: string[]; failed?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _cortex_migrations (
  migration_set TEXT NOT NULL,
  name          TEXT NOT NULL,
  applied_at    TEXT NOT NULL,
  PRIMARY KEY (migration_set, name)
);`;

export type RunOpts = {
  set: string;
  /** Called once, after the too-new guard passes, iff >=1 migration is pending,
   *  BEFORE any migration runs. The chokepoint uses it to take a snapshot. */
  beforeApply?: (pending: string[]) => void;
};

export function runMigrations(db: Database.Database, migrations: Migration[], opts: RunOpts): void {
  const names = migrations.map((m) => m.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) throw new Error(`runMigrations: duplicate migration name(s): ${dupes.join(", ")}`);

  db.exec(LEDGER_DDL);
  const applied = new Set(
    (db.prepare("SELECT name FROM _cortex_migrations WHERE migration_set = ?").all(opts.set) as Array<{ name: string }>)
      .map((r) => r.name),
  );

  const known = new Set(names);
  const unknown = [...applied].filter((n) => !known.has(n));
  if (unknown.length) {
    throw new MigrationError(
      "store-too-new",
      `this ${opts.set} store has migration(s) [${unknown.join(", ")}] this Cortex doesn't recognize — it was written by a newer version`,
      { set: opts.set, unknown },
    );
  }

  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;
  opts.beforeApply?.(pending.map((m) => m.name));

  const record = db.prepare("INSERT INTO _cortex_migrations(migration_set, name, applied_at) VALUES (?, ?, ?)");
  for (const m of pending) {
    try {
      m.up(db); // migration owns its own atomicity (db.transaction inside)
    } catch (cause) {
      throw new MigrationError("migration-failed", `migration '${m.name}' failed in set '${opts.set}'`, { set: opts.set, failed: m.name, cause });
    }
    record.run(opts.set, m.name, new Date().toISOString());
  }
}
