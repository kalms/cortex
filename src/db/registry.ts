// src/db/registry.ts
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RegistryRepo {
  name: string;
  root_path: string;
  indexed_at: string;
}

/** XDG data home for durable cortex state — `$XDG_DATA_HOME` if set, else
 *  `~/.local/share`. The registry is durable metadata (what repos exist +
 *  where), so it lives under the DATA home, NOT `~/.cache` (which means
 *  "regenerable, safe to delete"). Matches the indexer binary's XDG discipline
 *  (`~/.config/cortex-indexer` for config, `~/.cache/cortex-indexer` for cache). */
function xdgDataHome(): string {
  const env = process.env.XDG_DATA_HOME;
  return env && env.trim() ? env : join(homedir(), ".local", "share");
}

/** Canonical registry location: `<XDG_DATA_HOME>/cortex-indexer/registry.db`.
 *  Honors the `CORTEX_REGISTRY_DB` override (used by tests to avoid polluting
 *  the real registry), mirroring CORTEX_DB / CORTEX_DECISIONS_DB. */
export function defaultRegistryPath(): string {
  return process.env.CORTEX_REGISTRY_DB ?? join(xdgDataHome(), "cortex-indexer", "registry.db");
}

/** Legacy registry location (pre-XDG): `~/.cache/cortex-indexer/_registry.db`.
 *  Read-only migration source — see `importLegacyRegistry`. */
export function legacyRegistryPath(): string {
  return join(homedir(), ".cache", "cortex-indexer", "_registry.db");
}

/** True if any path segment is exactly ".tmp". Eval-corpus clones live under
 *  `cortex/.tmp/frame-extraction-corpus/*` and must never enter the registry. */
export function isTmpPath(p: string): boolean {
  return p.split("/").includes(".tmp");
}

export class Registry {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string = defaultRegistryPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS repos (
      name TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      indexed_at TEXT NOT NULL
    )`);
  }

  /**
   * Register or update a repo entry.
   *
   * `indexed_at` should be the timestamp of when indexing *finished*; it
   * defaults to call-time `new Date().toISOString()` only as a fallback when
   * the caller has no more-precise value.
   *
   * `root_path` carries a UNIQUE constraint. Registering a *different* `name`
   * that points at a `root_path` already owned by another name will throw a
   * SQLite UNIQUE-constraint error. In practice callers derive `name`
   * deterministically from `root_path` (a bijection) so this path is
   * unreachable; call sites should treat registration as best-effort
   * (try/catch) if they cannot guarantee uniqueness.
   */
  register(name: string, root_path: string, indexed_at: string = new Date().toISOString()): void {
    if (isTmpPath(root_path)) return;
    this.db
      .prepare(
        `INSERT INTO repos (name, root_path, indexed_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path, indexed_at = excluded.indexed_at`,
      )
      .run(name, root_path, indexed_at);
  }

  list(): RegistryRepo[] {
    return this.db
      .prepare(`SELECT name, root_path, indexed_at FROM repos ORDER BY name`)
      .all() as RegistryRepo[];
  }

  findByName(name: string): RegistryRepo | null {
    return (this.db
      .prepare(`SELECT name, root_path, indexed_at FROM repos WHERE name = ?`)
      .get(name) as RegistryRepo | undefined) ?? null;
  }

  remove(name: string): void {
    this.db.prepare(`DELETE FROM repos WHERE name = ?`).run(name);
  }

  close(): void {
    this.db.close();
  }
}
