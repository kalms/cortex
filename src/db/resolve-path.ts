import BetterSqlite3 from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { ensureRepoId } from "./repo-id.js";
import { mainWorktreeRoot, worktreeRoot } from "./git-root.js";
import { cacheSlug } from "./store-paths.js";

export { cacheSlug };

function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Resolve the canonical `.cortex/db` write/default path for a repo.
 *
 * The global `CORTEX_DB_PATH` override applies ONLY to the implicit (cwd)
 * case — `resolveCortexDbPath()` with no argument. When a caller addresses a
 * SPECIFIC repo (explicit `startDir`), per-call routing wins and the override
 * is ignored: a single global override must never collapse every addressed
 * repo to one path, which silently defeats multi-project routing (see
 * docs/architecture/graph-storage.md, "Per-call repo routing (RepoContext)" — the
 * `.mcp.json` `CORTEX_DB_PATH=.cortex/graph.db` env did exactly that, sending
 * every repo's reads to one relative DB regardless of `repo_path`).
 */
export function resolveCortexDbPath(startDir?: string): string {
  if (startDir === undefined) {
    const override = process.env.CORTEX_DB_PATH;
    if (override) return override;
    startDir = process.cwd();
  }
  // Checkout-axis: a linked worktree gets its OWN store; a subdir collapses to
  // its enclosing checkout. The identity axis (decisions) still uses
  // mainWorktreeRoot — see the two-axis model in graph-storage.md.
  const base = worktreeRoot(startDir);
  return join(base, ".cortex", "db");
}

/** True if `dbPath` is a readable SQLite graph DB whose `nodes` table has at
 *  least one row. Any open/query failure (missing file, not a DB, no `nodes`
 *  table) is treated as "not populated". */
function hasNodes(dbPath: string): boolean {
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare("SELECT 1 FROM nodes LIMIT 1").get() !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** True if `dbPath` is a structurally-valid SQLite file that opens without
 *  error — including a 0-byte file (an empty DB) or a valid DB with no rows.
 *  A non-SQLite file (garbage content) throws on access and returns false.
 *  This is the distinction that lets the canonical `.cortex/db` win whenever
 *  it is *usable* (populated, empty, or 0-byte drift) while still ceding to a
 *  legacy fallback when it is genuinely corrupt non-DB content. */
function isOpenableSqlite(dbPath: string): boolean {
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("schema_version");
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Resolve the graph DB to READ for an addressed repo, independent of any
 * global `CORTEX_DB_PATH` override.
 *
 * The canonical store is `<repo>/.cortex/db` (the only write target today).
 * It wins UNCONDITIONALLY whenever it is an openable SQLite file — populated,
 * valid-but-empty, or a 0-byte drift. An empty canonical DB must surface as
 * empty (so the freshness layer flags `empty` and prompts a reindex), and must
 * never be shadowed by a stale sibling `<repo>/.cortex/graph.db`: once
 * `.cortex/db` exists, `graph.db` is by definition stale-or-equal, and serving
 * it produced the 2026-06-09 viewer stale-map bug (`.cortex/db` held the fresh
 * 25-frame index while the default read path served an 8-frame `graph.db`).
 *
 * Only when `.cortex/db` is absent or structurally unusable (non-SQLite
 * garbage) do we fall back to the legacy stores — the pre-canonical
 * `<repo>/.cortex/graph.db` and the CLI's shared cache
 * (`~/.cache/cortex-indexer/<slug>.db`) — preferring a populated one so
 * un-migrated repos still resolve.
 *
 * Checkout axis: `root` here is {@link worktreeRoot} (a linked worktree gets
 * its own store), not {@link mainWorktreeRoot} — the identity axis, which
 * stays reserved for decisions/todos. Stage 1 transitional: when the checkout
 * has no *usable* store of its own (and no legacy fallback either), this cedes
 * to the canonical main-worktree store so a freshly-created worktree that
 * hasn't been indexed yet still resolves instead of coming up empty. Stage 3
 * removes this cross-checkout fallback and raises instead. Returns null when
 * neither the checkout nor the canonical repo has a store at all; the caller
 * raises RepoNotIndexedError.
 *
 * "Usable" is axis-dependent, and deliberately so:
 *  - **Main checkout** — the canonical store wins whenever it merely *opens*,
 *    including when it is valid-but-empty or a 0-byte drift. There is nothing
 *    to cede to, and the freshness layer must surface `empty` (reindex me)
 *    rather than `RepoNotIndexedError`.
 *  - **Linked worktree** — the checkout's own store must additionally be
 *    POPULATED to win over the canonical fallback. Merely booting the server
 *    in a worktree creates an empty `<wt>/.cortex/db` (`mkdirSync` + `new
 *    GraphStore` in src/index.ts); if that empty file won here, the Stage 1
 *    fallback would silently never fire again for that checkout and every read
 *    would come back empty — a later stage's strict mode without its error.
 *    When there is no canonical store to cede to, the empty checkout store is
 *    still returned, so `empty` freshness works there too.
 */
export function resolveGraphDbForRead(repoPath: string): string | null {
  const root = worktreeRoot(repoPath);
  const cortexDb = join(root, ".cortex", "db");
  const checkoutUsable = existsSync(cortexDb) && isOpenableSqlite(cortexDb);

  // Stage 1 cross-checkout fallback target — non-null only for a LINKED
  // worktree (in a main checkout both axes resolve to the same root).
  const canonicalRoot = mainWorktreeRoot(repoPath);
  const canonicalDb =
    canonicalRoot && canonicalRoot !== root ? join(canonicalRoot, ".cortex", "db") : null;

  if (checkoutUsable && (canonicalDb === null || hasNodes(cortexDb))) return cortexDb;

  if (!checkoutUsable) {
    const legacy = [
      join(root, ".cortex", "graph.db"),
      join(homedir(), ".cache", "cortex-indexer", `${cacheSlug(root)}.db`),
    ];
    const existing = legacy.filter(existsSync);
    const populated = existing.find(hasNodes);
    if (populated) return populated;
    if (existing[0]) return existing[0];
  }

  if (canonicalDb && existsSync(canonicalDb) && isOpenableSqlite(canonicalDb)) return canonicalDb;
  return existsSync(cortexDb) ? cortexDb : null;
}

/**
 * Out-of-repo durable home for authored primitives: `~/.cortex` (advertised,
 * discoverable). Distinct from the in-repo `.cortex/` derived cache.
 *
 * `$CORTEX_HOME` overrides the base home directory for isolation (tests,
 * CI). When set, the durable root becomes `$CORTEX_HOME/.cortex` rather
 * than `~/.cortex`.
 */
export function durableStoreRoot(): string {
  return join(process.env.CORTEX_HOME ?? homedir(), ".cortex");
}

/**
 * True if `dbPath` points at a per-repo *canonical* graph store —
 * `<repo>/.cortex/db` (the write target) or `<repo>/.cortex/graph.db` (the
 * legacy read-fallback). Such a store may only ever hold ONE repo's index:
 * the C indexer's dump pass replaces all nodes/edges and node IDs are global
 * (`ctx-N`), so merging foreign sources into it silently clobbers the repo's
 * real index. Eval / corpus-merge / multi-repo-viewer tooling must therefore
 * target a dedicated DB outside `.cortex/`, never a canonical store. This
 * predicate is the guard those tools call to refuse a canonical target.
 *
 * Path-shape only — does not stat the filesystem. The input is normalized
 * first so relative and redundant-segment paths are judged correctly.
 */
export function isCanonicalGraphDbPath(dbPath: string): boolean {
  const abs = resolvePath(dbPath);
  const file = basename(abs);
  if (file !== "db" && file !== "graph.db") return false;
  return basename(dirname(abs)) === ".cortex";
}

/** The pre-relocation in-repo decisions path, used only as a one-time
 *  migration source. Resolves from the MAIN worktree root so that a linked
 *  worktree finds the same legacy data as the main worktree. */
export function legacyDecisionsDbPath(startDir?: string): string {
  const start = startDir ?? process.cwd();
  const root = mainWorktreeRoot(start) ?? findGitRoot(start) ?? start;
  return join(root, ".cortex", "decisions.db");
}

/**
 * Resolve the durable decisions DB for the repo containing `startDir`.
 *
 * Durable primitives live OUT of the repo at `~/.cortex/<repo-id>/decisions.db`,
 * keyed by a generated, committed, repo-stable id so every worktree/clone of a
 * repo shares one store (fixing per-worktree stranding). `$CORTEX_DECISIONS_DB`
 * overrides verbatim (tests/isolation). Outside any git repo, falls back to the
 * legacy `<startDir>/.cortex/decisions.db`.
 *
 * Side effect: on the first call for a repo whose `cortex.json` has no `repoId`,
 * this mints and persists one via `ensureRepoId` (writes `<repoRoot>/cortex.json`).
 */
export function resolveDecisionsDbPath(startDir?: string): string {
  const override = process.env.CORTEX_DECISIONS_DB;
  if (override) return override;

  const start = startDir ?? process.cwd();
  const repoRoot = mainWorktreeRoot(start);
  if (repoRoot === null) {
    return join(start, ".cortex", "decisions.db");
  }
  const repoId = ensureRepoId(repoRoot);
  return join(durableStoreRoot(), repoId, "decisions.db");
}
