import BetterSqlite3 from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { ensureRepoId } from "./repo-id.js";
import { mainWorktreeRoot } from "./git-root.js";

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
 * docs/superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md — the
 * `.mcp.json` `CORTEX_DB_PATH=.cortex/graph.db` env did exactly that, sending
 * every repo's reads to one relative DB regardless of `repo_path`).
 */
export function resolveCortexDbPath(startDir?: string): string {
  if (startDir === undefined) {
    const override = process.env.CORTEX_DB_PATH;
    if (override) return override;
    startDir = process.cwd();
  }
  const gitRoot = findGitRoot(startDir);
  const base = gitRoot ?? startDir;
  return join(base, ".cortex", "db");
}

/** Slug-form of an absolute path, matching the standalone indexer's cache
 *  filename convention (leading slash dropped, remaining slashes flattened to
 *  '-'). Mirrors deriveProjectName in src/cli/context.ts. */
function cacheSlug(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
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

/**
 * Resolve the graph DB to READ for an addressed repo, independent of any
 * global `CORTEX_DB_PATH` override.
 *
 * Different writers populate different stores: MCP `index_repository` writes
 * `<repo>/.cortex/db`; the CLI `cortex index` writes the shared cache
 * (`~/.cache/cortex-indexer/<slug>.db`); the legacy override era wrote
 * `<repo>/.cortex/graph.db`. This searches all three (in that priority order)
 * and returns the first that is POPULATED (has node rows), so a successful
 * index is visible regardless of how it was created. If none are populated but
 * one exists (e.g. a repo mid-index with a freshly-created empty DB), the
 * highest-priority existing path is returned. Returns null when the repo has
 * no store at all — the caller raises RepoNotIndexedError.
 */
export function resolveGraphDbForRead(repoPath: string): string | null {
  const gitRoot = findGitRoot(repoPath) ?? repoPath;
  const candidates = [
    join(gitRoot, ".cortex", "db"),
    join(gitRoot, ".cortex", "graph.db"),
    join(homedir(), ".cache", "cortex-indexer", `${cacheSlug(gitRoot)}.db`),
  ];
  const existing = candidates.filter(existsSync);
  const populated = existing.find(hasNodes);
  return populated ?? existing[0] ?? null;
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
