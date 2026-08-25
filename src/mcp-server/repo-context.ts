import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import type { ZodSchema } from "zod";
import { resolveDecisionsDbPath, resolveGraphDbForRead, resolveCortexDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { mainWorktreeRoot, worktreeRoot } from "../db/git-root.js";
import { gitBranch } from "../git/worktree-state.js";
import { Registry } from "../db/registry.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { migrateDecisionIdsToShortForm } from "../decisions/id-migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { GraphStore } from "../graph/store.js";
import { freshnessForContext, attachFreshness } from "./freshness.js";
import { attachBriefing } from "./briefing-attach.js";

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
  /** Canonical repo root when this context is a linked worktree; null for a
   *  main checkout or a non-git project. The repo-identity axis. */
  readonly worktreeOf: string | null;
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
export function deriveProjectName(absPath: string): string {
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
  /** Canonical repo root when this project is a linked worktree; null/absent
   *  for a main checkout. Lets `list_projects` fold worktrees under their
   *  parent instead of listing every checkout as a top-level project. */
  readonly worktree_of?: string | null;
  /** Branch at index time; null/absent when detached, unknown, or (for a
   *  pooled in-process context) not tracked. */
  readonly branch?: string | null;
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
  constructor(
    readonly path: string,
    readonly availableProjects: AvailableProject[],
    readonly branch: string | null = null,
    readonly canonical: string | null = null,
  ) {
    super(`repo_path '${path}' has no .cortex/ — repo not indexed`);
    this.name = "RepoNotIndexedError";
    this.hint = `Run cortex index . ${path} first.`;
  }
}

/** Thrown when a checkout has no store yet but a background index is running. */
export class WorktreeIndexPendingError extends Error {
  readonly hint: string;
  constructor(
    readonly path: string,
    readonly branch: string | null,
    readonly canonical: string | null,
  ) {
    super(`checkout '${path}'${branch ? ` (${branch})` : ""} is being indexed — retry shortly`);
    this.name = "WorktreeIndexPendingError";
    this.hint =
      `A background index is in flight. Retry in a few seconds. ` +
      (canonical ? `To read the main checkout instead, pass repo_path='${canonical}'.` : "");
  }
}

/**
 * Start a detached index for a checkout that has none, mirroring
 * hooks/prefer-cortex.sh's maybe_bg_index — same 60-minute sentinel, same
 * opt-out, same `<checkout>/.cortex/auto-index.log` diagnostic trail (child
 * stdout/stderr, plus a swallowed spawn-time 'error' event). Returns true
 * when an index is in flight (just started, or started recently), so the
 * caller can raise WorktreeIndexPendingError instead of a flat "not
 * indexed". Never throws: a failed kick just means the caller gets the
 * plain not-indexed error.
 */
function kickBackgroundIndex(checkout: string): boolean {
  if (process.env.CORTEX_AUTO_INDEX === "0") return false;
  const sentinel = join(checkout, ".cortex", ".auto-index-attempted");
  try {
    const age = Date.now() - statSync(sentinel).mtimeMs;
    if (age < 60 * 60 * 1000) return true; // an attempt is already in flight
  } catch {
    /* no sentinel — fall through and start one */
  }

  const bin = process.env.CORTEX_BIN ?? "cortex";
  const logPath = join(checkout, ".cortex", "auto-index.log");
  try {
    mkdirSync(join(checkout, ".cortex"), { recursive: true });
    writeFileSync(sentinel, "");
    // Mirror hooks/prefer-cortex.sh's maybe_bg_index, which redirects the
    // spawned index's stdout+stderr to <checkout>/.cortex/auto-index.log
    // instead of discarding them. Without this, `stdio: "ignore"` plus a
    // swallowed 'error' event (below) left a broken/missing `bin` (e.g.
    // `cortex` absent from PATH — reachable when Cortex runs as a sidecar
    // from a tarball) with zero diagnostic trail: every read just keeps
    // getting WorktreeIndexPendingError's "retry shortly" for the full
    // 60-minute sentinel window. Opening the log is best-effort — if it
    // fails, fall back to the prior silent-but-safe "ignore" behavior
    // rather than letting a logging problem fail the read.
    //
    // Truncate ("w"), not append — the shell twin uses `>"$log" 2>&1`, so the
    // log always describes the LATEST attempt. Appending would accumulate the
    // full stdout of every index run this checkout ever performs, growing
    // without bound on a long-lived checkout, and "the last run failed" is
    // the question this file exists to answer.
    let logFd: number | undefined;
    try {
      logFd = openSync(logPath, "w");
    } catch {
      logFd = undefined;
    }
    const child = spawn(bin, ["index", ".", checkout], {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    });
    // spawn() dup's the fd into the child synchronously before returning, so
    // it's safe to close our copy right away (mirrors the pattern in
    // scripts/corpus/run-survey.ts's runIndex).
    if (logFd !== undefined) closeSync(logFd);
    // A detached child spawned against an unresolvable/broken `bin` emits an
    // async 'error' event rather than throwing synchronously; with no
    // listener that becomes an unhandled rejection that could crash the
    // process. Swallow it — "never throws" applies here too — but record it
    // to the same log: this is the one failure stdio redirection above can't
    // capture, since the child never started and so never wrote anything
    // itself. Best-effort: a failure to append here must not surface either.
    child.on("error", (err) => {
      try {
        appendFileSync(logPath, `[auto-index] failed to spawn '${bin}': ${err.message}\n`);
      } catch {
        /* diagnostic only — never let logging itself throw */
      }
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The only entry point tool handlers use to obtain a {@link RepoContext}.
 *
 * Per-call resolution replaces the previous startup-time `repoPath` binding
 * that pooled writes from all tool calls into the server's home repo
 * (decisions DB) and made non-cwd projects unreachable (graph DB). See
 * `docs/architecture/graph-storage.md` ("Per-call repo routing (RepoContext)").
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
   * {@link PathNotFoundError}, {@link RepoNotIndexedError},
   * {@link WorktreeIndexPendingError}.
   *
   * The supplied path is canonicalized to the **checkout axis**
   * (`worktreeRoot`, `git rev-parse --show-toplevel`): a subdirectory
   * collapses to its enclosing checkout root, but a linked worktree resolves
   * to ITSELF, not to the main checkout. A path outside any git repo routes
   * by its own realpath, so genuinely-non-git projects resolve to their own
   * `.cortex/db`. STRICT READS: a checkout with no store of its own is never
   * served from its canonical repo's graph, even when that graph is
   * populated — {@link resolveGraphDbForRead} has no cross-checkout fallback.
   * Instead this kicks a detached background index for the checkout (mirrors
   * hooks/prefer-cortex.sh's maybe_bg_index) and throws
   * {@link WorktreeIndexPendingError} when one is now in flight, or
   * {@link RepoNotIndexedError} when the kick itself couldn't start (opted
   * out via `CORTEX_AUTO_INDEX=0`, or the spawn failed).
   *
   * Two-axis model — no more worktree collapse
   * -------------------------------------------
   * Earlier, every worktree of a repo collapsed onto the canonical
   * main-worktree root (`mainWorktreeRoot`, `git --git-common-dir`) and
   * shared one `RepoContext`, one pair of DB handles, and one pool entry.
   * That collapse is gone for the graph/store side: `ctx.repoPath` is now
   * the checkout itself, keyed in the pool by checkout, and each worktree
   * gets its own `.cortex/db`, staging, index lock, and freshness baseline.
   * `ctx.worktreeOf` still exposes the canonical root — non-null only when
   * this checkout is a linked worktree — for callers that need repo
   * identity rather than checkout identity.
   *
   * The repo-identity axis has NOT moved: `resolveDecisionsDbPath` and
   * `legacyDecisionsDbPath` still canonicalize internally via
   * `mainWorktreeRoot`, so every worktree of a repo continues to share one
   * decisions/todos store even though it no longer shares a graph store.
   *
   * Why split them: cortex's new invariant is "one graph index per
   * checkout" (so in-flight branch/PR work indexes and reads back
   * independently) alongside the older invariant "one decisions store per
   * repo" (so a decision captured in any worktree is visible from every
   * other worktree of the same repo).
   */
  resolve(repoPath: string): RepoContext {
    const abs = resolvePath(repoPath);
    if (!existsSync(abs)) throw new PathNotFoundError(abs);

    // Checkout axis: a linked worktree is its own root and gets its own store.
    // A subdir still collapses to its enclosing checkout, preserving the
    // anti-orphan property T-119 bought. The identity axis (decisions store,
    // repoId) still routes through mainWorktreeRoot below.
    const checkout = worktreeRoot(abs);
    const canonicalRoot = mainWorktreeRoot(abs);
    const worktreeOf = canonicalRoot && canonicalRoot !== checkout ? canonicalRoot : null;

    // Pool is keyed by checkout so a worktree and its main checkout no longer
    // share a cached entry — each gets its own DB handles.
    const cached = this.pool.get(checkout);
    if (cached) return cached;

    // Read-path resolution: find the CHECKOUT's own POPULATED graph store
    // across the .cortex/db, .cortex/graph.db, and ~/.cache slot conventions —
    // repo-scoped and independent of any global CORTEX_DB_PATH override
    // (which previously collapsed every repo to one relative DB and defeated
    // routing). No cross-checkout fallback: see resolveGraphDbForRead.
    const graphDbPath = resolveGraphDbForRead(checkout);
    if (!graphDbPath) {
      // Self-healing strictness: refuse to answer from another branch's graph,
      // but start the index that makes the retry succeed.
      const pending = kickBackgroundIndex(checkout);
      const branch = gitBranch(checkout);
      if (pending) throw new WorktreeIndexPendingError(checkout, branch, worktreeOf);
      throw new RepoNotIndexedError(checkout, this.listKnownRepos(), branch, worktreeOf);
    }

    // Identity axis — unchanged. Passing the checkout is safe because
    // resolveDecisionsDbPath canonicalizes internally via mainWorktreeRoot,
    // so every worktree of a repo still shares one decisions store.
    const decisionsDbPath = resolveDecisionsDbPath(checkout);

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
    const decisionsDb = openDecisionsDb(decisionsDbPath, legacyDecisionsDbPath(checkout));
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
      repoPath: checkout,
      graphDbPath,
      canonical: graphDbPath === resolveCortexDbPath(checkout),
      worktreeOf,
      graphDb,
      decisionsDb,
      store,
      decisionsRepo,
      decisionLinksRepo,
    });
    this.pool.set(checkout, ctx);
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
        worktree_of: ctx.worktreeOf,
      });
    }

    // (b) Master registry — the persistent record of every known repo and its
    // root_path, independent of graph storage.
    try {
      const registry = new Registry();
      try {
        for (const r of registry.list()) {
          if (byPath.has(r.root_path)) continue;
          byPath.set(r.root_path, {
            name: r.name,
            path: r.root_path,
            indexed: true,
            worktree_of: r.worktree_of,
            branch: r.branch,
          });
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
 * Extracts the briefing target from tool args.
 * Prefers `qualified_name` (get_code_snippet) and falls back to
 * `function_name` (trace_path). Returns `undefined` when neither is present
 * or both are empty strings.
 */
export function briefTargetFromArgs(args: Record<string, unknown>): string | undefined {
  const qn = args["qualified_name"];
  if (typeof qn === "string" && qn.length > 0) return qn;
  const fn = args["function_name"];
  if (typeof fn === "string" && fn.length > 0) return fn;
  return undefined;
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
  options: { resolver: RepoContextResolver; crossRepo?: false; allowUnindexed?: false; freshnessAware?: boolean; briefAware?: boolean },
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
  options: { resolver: RepoContextResolver; crossRepo?: boolean; allowUnindexed?: boolean; freshnessAware?: boolean; briefAware?: boolean },
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
    let result = await handler(ctx, args);
    if (options.freshnessAware && result && typeof result === "object" && "content" in (result as object)) {
      const f = freshnessForContext({ repoPath: ctx.repoPath, graphDb: ctx.graphDb, canonical: ctx.canonical });
      result = attachFreshness(result as any, f) as R;
    }
    if (options.briefAware && result && typeof result === "object" && "content" in (result as object)) {
      result = attachBriefing(result as any, ctx, briefTargetFromArgs(args as Record<string, unknown>)) as R;
    }
    return result;
  };
}
