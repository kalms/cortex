// src/db/registry.ts
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RegistryRepo {
  name: string;
  root_path: string;
  indexed_at: string;
  /** Canonical repo root when this row is a linked worktree; null otherwise. */
  worktree_of: string | null;
  /** Branch at index time; null when detached or unknown. */
  branch: string | null;
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

    // Additive, idempotent migration. A worktree row is a first-class registry
    // entry under the two-axis model, not an orphan — see registry-audit.
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("worktree_of")) this.db.exec("ALTER TABLE repos ADD COLUMN worktree_of TEXT");
    if (!cols.has("branch")) this.db.exec("ALTER TABLE repos ADD COLUMN branch TEXT");
  }

  /**
   * Register or update a repo entry.
   *
   * `indexed_at` should be the timestamp of when indexing *finished*; it
   * defaults to call-time `new Date().toISOString()` only as a fallback when
   * the caller has no more-precise value.
   *
   * `meta.worktree_of` names the canonical repo root when this row is a
   * linked worktree; `meta.branch` is the branch at index time. On INSERT both
   * default to `null`.
   *
   * On UPDATE, omitting a key PRESERVES whatever the row already holds, while
   * passing it explicitly (including as `null`) overwrites — the distinction
   * matters because callers that know nothing about checkouts re-register
   * existing rows routinely. `importLegacyRegistry` and `migrateCacheToRegistry`
   * both use the 3-arg form, and `startViewerServer` runs both on EVERY server
   * start; when a legacy `_registry.db` row or a leftover
   * `~/.cache/cortex-indexer/<slug>.db` collides on `name`, an unconditional
   * `worktree_of = excluded.worktree_of` silently NULLed it. That is data loss
   * with teeth: `worktree_of` is what earns a row `cortex doctor`'s carve-out,
   * so clearing it makes `doctor --fix` prune the deliberate per-checkout
   * entries. Pass `{ worktree_of: null }` explicitly to clear (e.g. a worktree
   * promoted to a main checkout).
   *
   * `root_path` carries a UNIQUE constraint. Registering a *different* `name`
   * that points at a `root_path` already owned by another name will throw a
   * SQLite UNIQUE-constraint error. In practice callers derive `name`
   * deterministically from `root_path` (a bijection) so this path is
   * unreachable; call sites should treat registration as best-effort
   * (try/catch) if they cannot guarantee uniqueness.
   */
  register(
    name: string,
    root_path: string,
    indexed_at: string = new Date().toISOString(),
    meta: { worktree_of?: string | null; branch?: string | null } = {},
  ): void {
    if (isTmpPath(root_path)) return;
    // Omitted key => keep the stored value; explicitly-passed key (even null)
    // => overwrite. `"x" in meta` is the only way to tell the two apart once
    // the value has been defaulted to null for the INSERT arm.
    const keep = (col: "worktree_of" | "branch") =>
      col in meta ? `excluded.${col}` : `COALESCE(excluded.${col}, repos.${col})`;
    this.db
      .prepare(
        `INSERT INTO repos (name, root_path, indexed_at, worktree_of, branch) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path, indexed_at = excluded.indexed_at,
           worktree_of = ${keep("worktree_of")}, branch = ${keep("branch")}`,
      )
      .run(name, root_path, indexed_at, meta.worktree_of ?? null, meta.branch ?? null);
  }

  list(): RegistryRepo[] {
    return this.db
      .prepare(`SELECT name, root_path, indexed_at, worktree_of, branch FROM repos ORDER BY name`)
      .all() as RegistryRepo[];
  }

  findByName(name: string): RegistryRepo | null {
    return (this.db
      .prepare(`SELECT name, root_path, indexed_at, worktree_of, branch FROM repos WHERE name = ?`)
      .get(name) as RegistryRepo | undefined) ?? null;
  }

  remove(name: string): void {
    this.db.prepare(`DELETE FROM repos WHERE name = ?`).run(name);
  }

  close(): void {
    this.db.close();
  }
}
