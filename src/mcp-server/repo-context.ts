import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { ZodSchema } from "zod";
import { resolveDecisionsDbPath, resolveGraphDbForRead, resolveCortexDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { Registry } from "../db/registry.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { migrateDecisionIdsToShortForm } from "../decisions/id-migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { GraphStore } from "../graph/store.js";
import { freshnessForContext, attachFreshness } from "./freshness.js";

/**
 * Everything a tool needs to act on one repo. Constructed by
 * {@link RepoContextResolver}; never instantiated by tool handlers directly.
 * DB handles are pooled — the same RepoContext is returned for repeated
 * calls against the same repo within one server lifetime.
 */
export interface RepoContext {
  readonly repoPath: string;
  /** The resolved graph DB file this context reads from — the SINGLE source
   *  of truth for the addressed repo's store (via resolveGraphDbForRead).
   *  Read-path tools MUST use this rather than re-deriving a path, so every
   *  reader hits the same populated store the resolver chose. */
  readonly graphDbPath: string;
  /** True when graphDbPath is the canonical <repo>/.cortex/db; false when the
   *  resolver fell back to a legacy graph.db / cache slot (a degraded read). */
  readonly canonical: boolean;
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
 * Convert an absolute path into the indexer's project naming convention —
 * leading slash dropped, remaining slashes flattened to dashes. Mirrors the
 * standalone indexer CLI so cache directory filenames line up with what
 * `list_projects` reports.
 */
function deriveProjectName(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * Close every owned handle on a context. The resolver opens both raw DB
 * handles (`graphDb`, `decisionsDb`) AND a `GraphStore` that owns its own
 * internal handle to the same graph DB file. All three are closed here so
 * eviction doesn't leak the store's handle.
 */
function closeAll(ctx: RepoContext): void {
  ctx.graphDb.close();
  ctx.decisionsDb.close();
  ctx.store.close();
}

/**
 * Shape included in MissingRepoPathError and RepoNotIndexedError so an agent
 * that hit the wrong path can paste the right repo_path back without a
 * second tool call. `indexed: false` is for repos the resolver knows about
 * but whose `.cortex/db` is missing — the Field Report's
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

/** Thrown when the path is a git root but `.cortex/db` is missing. */
export class RepoNotIndexedError extends Error {
  readonly hint: string;
  constructor(path: string, readonly availableProjects: AvailableProject[]) {
    super(`repo_path '${path}' has no .cortex/ — repo not indexed`);
    this.name = "RepoNotIndexedError";
    this.hint = `Run cortex index . ${path} first.`;
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
   *
   * Worktree collapse
   * -----------------
   * If the supplied path is a `git worktree add` worktree (or the canonical
   * repo itself), the resolver routes to the **canonical repo's `.cortex/`**
   * — every worktree of the same repo shares one `RepoContext`, one pair of
   * DB handles, and one pool entry. Mechanism: `git rev-parse --git-common-dir`
   * returns the shared `.git/` directory (relative `.git` from canonical, or
   * absolute `/<canonical>/.git` from inside a worktree); resolving it
   * against the input and taking its dirname yields the canonical root.
   * `ctx.repoPath` always reports the canonical root, never the worktree
   * path the caller passed.
   *
   * Why: cortex's invariant is "one index per repo, shared across all
   * worktrees." Worktrees model in-flight branches/PRs against the same
   * logical codebase (see HANDOFF.md "Worktrees as in-flight PRs"); their
   * changes will eventually be captured as PR touches against the canonical
   * graph rather than as a separate index. Routing every worktree to
   * canonical means decisions captured in any worktree are immediately
   * visible from every other worktree of the same repo.
   */
  resolve(repoPath: string): RepoContext {
    const abs = resolvePath(repoPath);
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
    // when the supplied path IS the root (canonical or a worktree); they
    // diverge when the caller passed a subdir.
    if (realpathSync(gitRoot) !== realpathSync(abs)) {
      throw new NotAGitRepoError(abs, gitRoot);
    }

    // Worktree collapse — see JSDoc above for rationale. We realpath the
    // result because:
    //   - From the canonical, `--git-common-dir` returns relative `.git`,
    //     yielding the input path verbatim (which may contain symlinks like
    //     macOS's /tmp → /private/tmp).
    //   - From a worktree, `--git-common-dir` returns an absolute path that
    //     git has already resolved through symlinks.
    // Without normalization, the two paths differ as pool keys and dedupe
    // fails. realpath normalizes both forms to the same value.
    const commonDir = execSync(`git -C "${abs}" rev-parse --git-common-dir`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const canonical = realpathSync(dirname(resolvePath(abs, commonDir)));

    // Pool is keyed by canonical so every worktree of the same repo dedupes
    // to one cached entry. Fast path when the canonical is already pooled
    // (incl. via a sibling worktree's earlier resolve).
    const cached = this.pool.get(canonical);
    if (cached) return cached;

    // Read-path resolution: find the repo's POPULATED graph store across the
    // .cortex/db, .cortex/graph.db, and ~/.cache slot conventions — repo-scoped
    // and independent of any global CORTEX_DB_PATH override (which previously
    // collapsed every repo to one relative DB and defeated routing).
    const graphDbPath = resolveGraphDbForRead(canonical);
    if (!graphDbPath) {
      throw new RepoNotIndexedError(canonical, this.listKnownRepos());
    }
    const decisionsDbPath = resolveDecisionsDbPath(canonical);

    // GraphStore opens its own handle to graphDbPath and runs schema
    // migration (idempotent CREATE TABLE IF NOT EXISTS). Constructing it
    // BEFORE the decisions migration ensures `nodes` exists, since the
    // migration reads `SELECT FROM nodes WHERE kind='decision'`.
    const store = new GraphStore(graphDbPath);
    // Separate read-write handle exposed on RepoContext for callers that
    // need raw SQL access (migrations, tools that bypass GraphStore). Same
    // file, WAL-safe across handles in the same process.
    const graphDb = new BetterSqlite3(graphDbPath);
    graphDb.pragma("busy_timeout = 5000");
    const decisionsDb = openDecisionsDb(decisionsDbPath, legacyDecisionsDbPath(canonical));
    const graphImport = migrateDecisionsFromGraphDb(decisionsDb, graphDbPath);
    if (graphImport.decisions > 0) {
      // migrateDecisionsFromGraphDb inserts UUID-keyed rows AFTER openDecisionsDb's
      // migration runner already recorded id-short-form done, so the converter's
      // normal flag short-circuit would skip them. Force a re-scan to rewrite the
      // freshly imported legacy ids to D- form. Deliberate exception to the
      // single-chokepoint rule: this legacy import is intentionally kept out of the
      // runner (it needs the graph DB path), so its import-then-convert ordering
      // lives here. See the migration-runner spec.
      migrateDecisionIdsToShortForm(decisionsDb, { force: true });
    }
    const decisionsRepo = new DecisionsRepository(decisionsDb);
    const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);

    const ctx: RepoContext = Object.freeze({
      repoPath: canonical,
      graphDbPath,
      canonical: graphDbPath === resolveCortexDbPath(canonical),
      graphDb,
      decisionsDb,
      store,
      decisionsRepo,
      decisionLinksRepo,
    });
    this.pool.set(canonical, ctx);
    return ctx;
  }

  /**
   * Returns every indexed repo this server can address — the union of
   * (a) repos pooled (resolved) in this server lifetime, and (b) all rows
   * in the master Registry (`~/.local/share/cortex-indexer/registry.db`),
   * deduped by `root_path`. Used by `list_projects` (crossRepo tool) and
   * the friendly error payloads on {@link MissingRepoPathError} /
   * {@link RepoNotIndexedError}.
   *
   * Pooled entries cover the local `.cortex/db` convention (DB lives next
   * to the repo rather than in the shared cache); the registry wouldn't
   * surface those until explicit indexing writes a registry row.
   *
   * @returns {@link AvailableProject}[] — every known project, all with
   * `indexed: true`. (`indexed: false` is reserved for a future mode that
   * surfaces registry rows whose backing `.db` has been deleted.)
   */
  listKnownRepos(): AvailableProject[] {
    const byPath = new Map<string, AvailableProject>();

    // (a) Pooled repos — covers the local `.cortex/db` convention even when
    // the cache directory has nothing for them. Indexed because resolve()
    // wouldn't have succeeded otherwise.
    for (const ctx of this.pool.values()) {
      byPath.set(ctx.repoPath, {
        name: deriveProjectName(ctx.repoPath),
        path: ctx.repoPath,
        indexed: true,
      });
    }

    // (b) Master registry — the persistent record of every known repo and its
    // root_path, independent of graph storage.
    try {
      const registry = new Registry();
      try {
        for (const r of registry.list()) {
          if (byPath.has(r.root_path)) continue;
          byPath.set(r.root_path, { name: r.name, path: r.root_path, indexed: true });
        }
      } finally {
        registry.close();
      }
    } catch {
      // Registry unavailable — pooled repos only.
    }

    return Array.from(byPath.values());
  }

  /** Closes all pooled DB handles. Call on server shutdown. */
  shutdown(): void {
    this.pool.shutdown();
  }
}

/**
 * Wraps a tool handler so it receives a validated {@link RepoContext} instead
 * of doing its own per-call repo resolution. Three modes:
 *
 *   - Default (per-repo): handler signature `(ctx, args) => result`. The
 *     wrapper extracts `args.repo_path`, calls `resolver.resolve`, and
 *     passes `(ctx, args)` to the handler. If `repo_path` is missing,
 *     throws {@link MissingRepoPathError} before the handler runs.
 *
 *   - `crossRepo: true`: handler signature `(resolver, args) => result`.
 *     The wrapper skips resolution and hands the resolver to the handler
 *     for cross-repo work (list_projects, delete_project). Schemas for
 *     crossRepo tools should NOT include `repo_path`.
 *
 *   - `allowUnindexed: true`: handler signature `(resolver, args) => result`.
 *     The wrapper still requires `repo_path` (and throws MissingRepoPathError
 *     when absent) but does NOT call `resolver.resolve` — instead it hands
 *     the resolver to the handler. Used by tools that create or populate
 *     `.cortex/db` (notably index_repository), since the resolver's default
 *     path would throw {@link RepoNotIndexedError} on the very repo this
 *     tool is meant to bring online. Handlers are expected to validate the
 *     path themselves (existsSync, git root checks) before writing.
 *
 * If you're unsure which mode you want, the default is the right answer.
 *
 * @example default mode
 *   registerTool("create_decision", schema, async (ctx, args) => {
 *     return ctx.decisionsRepo.create(args);
 *   }, { resolver });
 *
 * @example crossRepo mode
 *   registerTool("list_projects", schema, async (resolver, _args) => {
 *     return resolver.listKnownRepos();
 *   }, { resolver, crossRepo: true });
 *
 * @example allowUnindexed mode
 *   registerTool("index_repository", schema, async (resolver, args) => {
 *     // args.repo_path is guaranteed non-empty here; handler creates .cortex/db
 *     return runIndexer(args.repo_path);
 *   }, { resolver, allowUnindexed: true });
 */
export function registerTool<A extends { repo_path?: string }, R>(
  name: string,
  schema: ZodSchema<A>,
  handler: (ctx: RepoContext, args: A) => Promise<R>,
  options: { resolver: RepoContextResolver; crossRepo?: false; allowUnindexed?: false; freshnessAware?: boolean },
): (rawArgs: unknown) => Promise<R>;
export function registerTool<A, R>(
  name: string,
  schema: ZodSchema<A>,
  handler: (resolver: RepoContextResolver, args: A) => Promise<R>,
  options: { resolver: RepoContextResolver; crossRepo: true },
): (rawArgs: unknown) => Promise<R>;
export function registerTool<A extends { repo_path?: string }, R>(
  name: string,
  schema: ZodSchema<A>,
  handler: (resolver: RepoContextResolver, args: A) => Promise<R>,
  options: { resolver: RepoContextResolver; allowUnindexed: true },
): (rawArgs: unknown) => Promise<R>;
export function registerTool<A, R>(
  name: string,
  schema: ZodSchema<A>,
  handler: any,
  options: { resolver: RepoContextResolver; crossRepo?: boolean; allowUnindexed?: boolean; freshnessAware?: boolean },
): (rawArgs: unknown) => Promise<R> {
  return async (rawArgs: unknown) => {
    // crossRepo skips the repo_path pre-check entirely (e.g. list_projects).
    // Default and allowUnindexed both REQUIRE repo_path — the friendly
    // MissingRepoPathError surfaces available_projects so the agent can
    // self-correct without a second tool call.
    if (!options.crossRepo) {
      const probe = (rawArgs ?? {}) as Record<string, unknown>;
      if (typeof probe.repo_path !== "string" || probe.repo_path === "") {
        throw new MissingRepoPathError(name, options.resolver.listKnownRepos());
      }
    }
    const args = schema.parse(rawArgs) as A & { repo_path?: string };
    if (options.crossRepo) {
      return handler(options.resolver, args);
    }
    if (options.allowUnindexed) {
      // Skip resolver.resolve — the handler is expected to validate the
      // path itself and may create `.cortex/db` as part of its work. We
      // still pass the resolver so the handler can opt back into a full
      // RepoContext after it creates the DB (e.g. for read-after-write).
      return handler(options.resolver, args);
    }
    const ctx = options.resolver.resolve(args.repo_path!);
    const result = await handler(ctx, args);
    if (options.freshnessAware && result && typeof result === "object" && "content" in (result as object)) {
      const f = freshnessForContext({ repoPath: ctx.repoPath, graphDb: ctx.graphDb, canonical: ctx.canonical });
      return attachFreshness(result as any, f) as R;
    }
    return result;
  };
}
