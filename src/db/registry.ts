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

/** Canonical registry location. `_`-prefixed so existing cache scanners that
 *  skip `_`/`tmp-` files never mistake it for a project graph DB. */
export function defaultRegistryPath(): string {
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
