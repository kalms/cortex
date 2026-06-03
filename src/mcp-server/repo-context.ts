import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { resolveDecisionsDbPath, resolveCortexDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { GraphStore } from "../graph/store.js";

/**
 * Everything a tool needs to act on one repo. Constructed by
 * {@link RepoContextResolver}; never instantiated by tool handlers directly.
 * DB handles are pooled — the same RepoContext is returned for repeated
 * calls against the same repo within one server lifetime.
 */
export interface RepoContext {
  readonly repoPath: string;
  readonly graphDb: Database.Database;
  readonly decisionsDb: Database.Database;
  readonly store: GraphStore;
  readonly decisionsRepo: DecisionsRepository;
  readonly decisionLinksRepo: DecisionLinksRepository;
}

/**
 * Internal LRU cache keyed by absolute repo path. Tool handlers do not see
 * this class directly — they go through {@link RepoContextResolver}.
 *
 * Capacity exists to bound DB handle leaks if an agent thrashes across
 * many repos; in normal use a session touches 1–2 repos. Eviction policy
 * is intentionally an internal detail and not pinned by contract tests.
 */
export class RepoContextPool {
  // Map preserves insertion order; we exploit that for LRU semantics:
  // delete-and-re-set on access promotes to most-recently-used.
  private readonly map = new Map<string, RepoContext>();
  private readonly capacity: number;

  constructor(options: { capacity: number }) {
    this.capacity = options.capacity;
  }

  get(repoPath: string): RepoContext | undefined {
    const ctx = this.map.get(repoPath);
    if (ctx) {
      this.map.delete(repoPath);
      this.map.set(repoPath, ctx);
    }
    return ctx;
  }

  set(repoPath: string, ctx: RepoContext): void {
    if (this.map.has(repoPath)) this.map.delete(repoPath);
    this.map.set(repoPath, ctx);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      closeAll(evicted);
    }
  }

  /** Closes every pooled DB handle and empties the cache. Idempotent. */
  shutdown(): void {
    for (const ctx of this.map.values()) {
      closeAll(ctx);
    }
    this.map.clear();
  }

  /**
   * Iterates over every currently-pooled context in LRU order
   * (oldest-touched first). Read-only view used by
   * {@link RepoContextResolver.listKnownRepos}; does not promote entries.
   */
  values(): IterableIterator<RepoContext> {
    return this.map.values();
  }
}

/**
 * Close every owned handle on a context. The resolver opens both raw DB
 * handles (`graphDb`, `decisionsDb`) AND a `GraphStore` that owns its own
 * internal handle to the same graph DB file. All three are closed here so
 * eviction doesn't leak the store's handle. Treated defensively so pool
 * tests can use stubs that lack `store.close`.
 */
function closeAll(ctx: RepoContext): void {
  ctx.graphDb.close();
  ctx.decisionsDb.close();
  const storeWithClose = ctx.store as { close?: () => void };
  if (typeof storeWithClose.close === "function") storeWithClose.close();
}

/**
 * Shape included in MissingRepoPathError and RepoNotIndexedError so an agent
 * that hit the wrong path can paste the right repo_path back without a
 * second tool call. `indexed: false` is for repos the resolver knows about
 * but whose `.cortex/graph.db` is missing — the Field Report's
 * "indexed-but-unreachable" case made explicit.
 */
export interface AvailableProject {
  readonly name: string;
  readonly path: string;
  readonly indexed: boolean;
}

/** Thrown when a non-crossRepo tool was called without `repo_path`. */
export class MissingRepoPathError extends Error {
  readonly hint: string;
  readonly availableProjects: AvailableProject[];
  constructor(toolName: string, availableProjects: AvailableProject[]) {
    super(`repo_path required for tool '${toolName}'`);
    this.name = "MissingRepoPathError";
    this.hint =
      "Pass an absolute path to an indexed git root. Use list_projects to discover indexed repos.";
    this.availableProjects = availableProjects;
  }
}

/** Thrown when the supplied path does not exist on disk. */
export class PathNotFoundError extends Error {
  readonly hint = "Check the path; was it just deleted or moved?";
  constructor(path: string) {
    super(`repo_path '${path}' does not exist`);
    this.name = "PathNotFoundError";
  }
}

/** Thrown when the supplied path is not a git root. */
export class NotAGitRepoError extends Error {
  readonly hint = "Pass the repository root, not a subdirectory or file.";
  constructor(path: string, readonly gitRoot?: string) {
    super(`repo_path '${path}' is not a git root`);
    this.name = "NotAGitRepoError";
  }
}

/** Thrown when the path is a git root but `.cortex/graph.db` is missing. */
export class RepoNotIndexedError extends Error {
  readonly hint: string;
  constructor(path: string, readonly availableProjects: AvailableProject[]) {
    super(`repo_path '${path}' has no .cortex/ — repo not indexed`);
    this.name = "RepoNotIndexedError";
    this.hint = `Run cortex index repository --path=${path} first.`;
  }
}

/**
 * The only entry point tool handlers use to obtain a {@link RepoContext}.
 *
 * Per-call resolution replaces the previous startup-time `repoPath` binding
 * that pooled writes from all tool calls into the server's home repo
 * (decisions DB) and made non-cwd projects unreachable (graph DB). See
 * `docs/superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md`.
 *
 * Pool hits skip all I/O. Pool misses validate the path, open both DBs,
 * run the (idempotent) decisions migration, and cache the result.
 */
export class RepoContextResolver {
  private readonly pool: RepoContextPool;

  constructor(options: { poolCapacity: number }) {
    this.pool = new RepoContextPool({ capacity: options.poolCapacity });
  }

  /**
   * Resolve a repo by path. Throws one of:
   * {@link PathNotFoundError}, {@link NotAGitRepoError}, {@link RepoNotIndexedError}.
   *
   * The supplied path must be the git root itself — passing a subdirectory
   * resolves the same git root via `git rev-parse --show-toplevel` and is
   * rejected as {@link NotAGitRepoError} with the inferred root in the
   * payload, so the caller can re-issue against the right repo without a
   * second lookup.
   */
  resolve(repoPath: string): RepoContext {
    const abs = resolvePath(repoPath);
    const cached = this.pool.get(abs);
    if (cached) return cached;

    if (!existsSync(abs)) throw new PathNotFoundError(abs);

    let gitRoot: string;
    try {
      gitRoot = execSync(`git -C "${abs}" rev-parse --show-toplevel`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new NotAGitRepoError(abs);
    }
    // Symlink-tolerant comparison: macOS routinely surfaces `/tmp/foo` while
    // git reports `/private/tmp/foo`. Both normalize to the same realpath
    // when the supplied path IS the root; they diverge when the caller
    // passed a subdir.
    if (realpathSync(gitRoot) !== realpathSync(abs)) {
      throw new NotAGitRepoError(abs, gitRoot);
    }

    const graphDbPath = resolveCortexDbPath(abs);
    if (!existsSync(graphDbPath)) {
      throw new RepoNotIndexedError(abs, this.listKnownRepos());
    }
    const decisionsDbPath = resolveDecisionsDbPath(abs);

    // GraphStore opens its own handle to graphDbPath and runs schema
    // migration (idempotent CREATE TABLE IF NOT EXISTS). Constructing it
    // BEFORE the decisions migration ensures `nodes` exists, since the
    // migration reads `SELECT FROM nodes WHERE kind='decision'`.
    const store = new GraphStore(graphDbPath);
    // Separate read-write handle exposed on RepoContext for callers that
    // need raw SQL access (migrations, tools that bypass GraphStore). Same
    // file, WAL-safe across handles in the same process.
    const graphDb = new BetterSqlite3(graphDbPath);
    const decisionsDb = openDecisionsDb(decisionsDbPath);
    migrateDecisionsFromGraphDb(decisionsDb, graphDbPath);
    const decisionsRepo = new DecisionsRepository(decisionsDb);
    const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);

    const ctx: RepoContext = Object.freeze({
      repoPath: abs,
      graphDb,
      decisionsDb,
      store,
      decisionsRepo,
      decisionLinksRepo,
    });
    this.pool.set(abs, ctx);
    return ctx;
  }

  /**
   * Returns repos this resolver knows about. Phase 1 only emits pooled
   * repos (those a tool call has touched in this server lifetime); Phase 4
   * extends this to read from the indexer's master project registry so
   * agents see every indexed repo, not just the active ones.
   */
  listKnownRepos(): AvailableProject[] {
    // TODO(phase-4): merge in entries from the indexer's master project
    // registry (cortex index list_projects) so callers see indexed repos
    // that haven't been touched in this server lifetime yet.
    const out: AvailableProject[] = [];
    for (const ctx of this.pool.values()) {
      out.push({
        name: ctx.repoPath.replace(/^\//, "").replace(/\//g, "-"),
        path: ctx.repoPath,
        indexed: true,
      });
    }
    return out;
  }

  /** Closes all pooled DB handles. Call on server shutdown. */
  shutdown(): void {
    this.pool.shutdown();
  }
}
