import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import {
  searchGraph,
  countSuppressedSections,
  tracePath,
  getGraphSchema,
} from "../../graph/code-queries.js";
import { groupCheckouts } from "../../graph/group-checkouts.js";
import { clampLimit, clampOffset, renderNodeSearch, symbolMissHint } from "./search-format.js";
// 5A: response helpers and qualified-name normalizer
import { ok, empty, error as errorResponse } from "../response.js";
import { normalize, denormalize } from "../qualified-name.js";
import { projectFromCtx, readSnippet } from "./code-tools-shared.js";
import { registerContextPackTool } from "./context-pack.js";
import { resolveInput } from "../../shared/resolve-input.js";
import { resolveCortexDbPath, resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { worktreeRoot, mainWorktreeRoot } from "../../db/git-root.js";
import { gitBranch } from "../../git/worktree-state.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../../decisions/migration.js";
import { computeCacheKey, hasCacheEntry, readCacheEntry, writeCacheEntry } from "../../db/cache.js";
import { runFrameExtraction, type FrameResult } from "../../frame-extraction/run-frames.js";
import { runContractExtraction } from "../../contracts/run-contracts.js";
import { computeContractReport } from "./contract-tools.js";
import { deriveProjectName } from "../../frame-extraction/cluster-tfidf-hdbscan.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { changesSinceShape, changesSinceSchema, changesSinceAction } from "./changes-since.js";
import {
  buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec, runCodeSearch,
} from "../../graph/code-search.js";
import type { SearchExecError, SearchExecOutcome } from "../../graph/code-search.js";
import { Registry } from "../../db/registry.js";
import { captureIndexMeta } from "../../graph/capture-index-meta.js";
import { invalidateFreshness } from "../freshness.js";
import { stagingDbPath, cleanupStagingDb } from "../../db/staging-path.js";
import { publishStagedDb } from "../../db/swap-graph-db.js";
import { withIndexLock } from "../../db/index-lock.js";
import { reapRepoSlugCache } from "../../db/store-gc.js";
import { ensureIndexer } from "../../indexer/binary.js";
import { RepoPathField } from "./shared-fields.js";
import { computeHotspots } from "../../architecture/hotspots.js";
import { loadGovernance } from "../../architecture/governed.js";

// Re-exported for the contract tests, which assert on the shared search
// helpers' arg-building / error-classification behavior.
export { buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec };
export type { SearchExecError, SearchExecOutcome };

// ---------------------------------------------------------------------------
// Per-call repo routing schemas
//
// Mirrors the pattern in decision-tools.ts (see that module's header for
// the rationale). `RepoPathField` is the shared declaration in
// shared-fields.ts.
// ---------------------------------------------------------------------------

const searchGraphShape = {
  repo_path: RepoPathField,
  name_pattern: z.string().optional(),
  label: z.string().optional(),
  qn_pattern: z.string().optional(),
  kinds: z.array(z.string()).optional()
    .describe("Restrict to these node kinds (e.g. [\"function\",\"route\"]). Pass [\"section\"] to include doc/plan headings, which are excluded by default."),
  limit: z.number().int().optional().describe("Page size (default 30, max 100)."),
  offset: z.number().int().optional().describe("Result offset for pagination (default 0)."),
} as const;
const searchGraphSchema = z.object(searchGraphShape);

const getCodeSnippetShape = {
  repo_path: RepoPathField,
  qualified_name: z.string().min(1, "qualified_name must not be empty"),
} as const;
const getCodeSnippetSchema = z.object(getCodeSnippetShape);

const tracePathShape = {
  repo_path: RepoPathField,
  function_name: z.string(),
  mode: z.enum(["calls", "callers"]).describe("Trace mode: calls (outbound) or callers (inbound)"),
  max_depth: z.number().int().min(1).max(10).optional(),
} as const;
const tracePathSchema = z.object(tracePathShape);

const detectChangesShape = {
  repo_path: RepoPathField,
  // Diff base. Defaults to "main" in the indexer when omitted.
  base_branch: z.string().min(1).optional().describe('Branch to diff HEAD against (default "main")'),
  // "files" = changed files only; "symbols"/"impact" = files + impacted symbols (default).
  scope: z.enum(["files", "symbols", "impact"]).optional().describe("Result scope (default symbols)"),
  // BFS depth for impact traversal.
  depth: z.number().int().positive().optional().describe("Impact BFS depth"),
} as const;
const detectChangesSchema = z.object(detectChangesShape);

const getGraphSchemaShape = {
  repo_path: RepoPathField,
} as const;
const getGraphSchemaSchema = z.object(getGraphSchemaShape);

const searchCodeShape = {
  repo_path: RepoPathField,
  pattern: z.string(),
} as const;
const searchCodeSchema = z.object(searchCodeShape);

// query_graph keeps `project` as an IN-GRAPH filter (different concept from
// repo_path, which selects which graph DB to open). `repo_path` addresses the
// `.cortex/db` file; once inside it, `project` filters rows by ctx_projects
// name (only meaningful when an indexer DB holds multiple projects, but the
// arg is kept for backward compatibility with existing callers).
const queryGraphShape = {
  repo_path: RepoPathField,
  query: z.string().describe("Cypher query string"),
  project: z.string().optional().describe("In-graph project filter (default: the addressed repo's only project)"),
  max_rows: z.number().int().optional().describe("Maximum rows to return"),
} as const;
const queryGraphSchema = z.object(queryGraphShape);

const checkContractsShape = { repo_path: RepoPathField } as const;
const checkContractsSchema = z.object(checkContractsShape);

const getArchitectureShape = {
  repo_path: RepoPathField,
  aspects: z.array(z.string()).optional().describe('Aspects to include, e.g. ["all"]'),
} as const;
const getArchitectureSchema = z.object(getArchitectureShape);

const indexStatusShape = {
  repo_path: RepoPathField,
} as const;
const indexStatusSchema = z.object(indexStatusShape);

// list_projects is a crossRepo tool — the caller is *asking which repos exist*,
// so the schema intentionally omits repo_path. The handler reads from the
// resolver's master registry (see `RepoContextResolver.listKnownRepos`).
const listProjectsShape = {} as const;
const listProjectsSchema = z.object(listProjectsShape);

// delete_project is also crossRepo. It addresses a project by name (the
// indexer's slug-form) rather than by path because the target repo may no
// longer exist on disk — routing by repo_path (which the resolver validates
// as a live git root) would falsely block legitimate cleanups of stale entries.
const deleteProjectShape = {
  project: z.string().min(1).describe("Project name to delete (slug-form, e.g. Users-rka-Development-cortex)"),
} as const;
const deleteProjectSchema = z.object(deleteProjectShape);

// index_repository creates `.cortex/db` for `repo_path`. Registered with
// `allowUnindexed: true` so the resolver's RepoNotIndexedError doesn't block
// the very tool that brings the index online.
const indexRepositoryShape = {
  repo_path: RepoPathField,
  // Index depth. `full` (default) runs every pass; `fast`/`moderate` skip
  // passes for a quicker, shallower graph. Forwarded to the indexer binary and
  // folded into the build-cache key so a shallow snapshot is never served for a
  // deeper request (see src/db/cache.ts::computeCacheKey).
  mode: z.enum(["fast", "moderate", "full"]).optional()
    .describe('Index depth: "fast" | "moderate" | "full" (default "full")'),
} as const;
const indexRepositorySchema = z.object(indexRepositoryShape);

const ingestTracesShape = {
  repo_path: RepoPathField,
  traces: z.array(z.unknown()).describe("Array of trace records"),
} as const;
const ingestTracesSchema = z.object(ingestTracesShape);

const execFileAsync = promisify(execFile);
import { join, dirname } from "node:path";

// 5B: callIndexer now handles binary in-stdout errors and returns structured responses
type IndexerCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

// Shape returned by the standalone-indexer's `list_projects` JSON. Used by
// index_status as a fallback lookup when the addressed repo's .cortex/db
// doesn't surface a match. (list_projects itself no longer uses this; it
// reads from the resolver's master registry now.)
type ProjectRow = {
  name: string;
  root_path: string;
  nodes?: number;
  edges?: number;
  indexed_at?: string;
};
async function callIndexer(tool: string, args: Record<string, unknown>, dbPath?: string): Promise<IndexerCallResult> {
  // Make the indexer write to the same SQLite file Cortex uses. Without this
  // the indexer falls back to ~/.cache/cortex-indexer/<project>.db and
  // Cortex would never see the data.
  const cortexDb = dbPath ?? resolveCortexDbPath();
  const subprocEnv = { ...process.env, CORTEX_DB: cortexDb };
  return invokeIndexer(tool, args, subprocEnv);
}

// callIndexerCache — variant of callIndexer that DOES NOT set CORTEX_DB, so
// the indexer resolves DB paths from the shared cache directory instead of
// the bound Cortex DB. Use for tools that must address the indexer's full
// project registry (list_projects, index_status) rather than just whatever
// project this MCP server was started in.
async function callIndexerCache(tool: string, args: Record<string, unknown>): Promise<IndexerCallResult> {
  const subprocEnv = { ...process.env };
  delete subprocEnv.CORTEX_DB;
  return invokeIndexer(tool, args, subprocEnv);
}

async function invokeIndexer(
  tool: string,
  args: Record<string, unknown>,
  subprocEnv: NodeJS.ProcessEnv,
): Promise<IndexerCallResult> {
  let binary: string;
  try {
    binary = await ensureIndexer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("indexer_unavailable", msg);
  }
  try {
    const { stdout } = await execFileAsync(binary, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
      env: subprocEnv,
    });
    // Binary always exits 0; errors come back as {"isError":true,"content":[...]} in stdout.
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.isError) {
        const detail = parsed.content?.[0]?.text ?? "(no detail)";
        return errorResponse("binary_failed", `cortex-indexer ${tool}: ${detail}`);
      }
      // The CLI prints a full MCP envelope ({content:[{type:"text",text}]}).
      // Return it as-is rather than re-wrapping the raw stdout — wrapping put
      // the envelope JSON *inside* content[0].text, so every downstream
      // consumer of a successful bridged call (hotspots merge, index_status
      // cache fallback, MCP clients) saw a double-wrapped payload.
      if (Array.isArray(parsed?.content) && parsed.content.every(
        (c: unknown) => typeof (c as { text?: unknown })?.text === "string",
      )) {
        return parsed as IndexerCallResult;
      }
    } catch {
      return errorResponse("binary_failed", `cortex-indexer ${tool}: unexpected non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`);
    }
    // Defensive: valid JSON but not envelope-shaped — preserve old behavior.
    return ok(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("binary_failed", `cortex-indexer ${tool} failed: ${msg}`);
  }
}

/** Run frame extraction + contract extraction against the STAGING DB, then
 *  publish the staged DB atomically to the canonical live path.
 *
 *  All passes target `stagePath` so no partial write ever touches `liveDbPath`
 *  mid-run. `publishStagedDb` is the single chokepoint that promotes the
 *  finished artifact into place. */
async function withFrames(
  baseText: string,
  repoPath: string,
  stagePath: string,
  liveDbPath: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const project = deriveProjectName(repoPath);
  let frames: FrameResult;
  try {
    frames = await runFrameExtraction({ repoPath, project, dbPath: stagePath });
  } catch (e) {
    frames = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
  const contracts = await runContractExtraction({ repoPath, project, dbPath: stagePath });
  publishStagedDb({ stagePath, liveDbPath });
  return { content: [{ type: "text", text: `${baseText}\nframes: ${JSON.stringify(frames)}\ncontracts: ${JSON.stringify(contracts)}` }] };
}

/**
 * Register code/graph tools on the MCP server.
 *
 * After Phase 4 every tool routes per-call through `resolver` — including
 * the two crossRepo tools (list_projects, delete_project) that previously
 * closed over the startup-bound graph DB. No tool retains a startup-bound
 * handle, so the function takes only the resolver.
 *
 * The previous `store`, `indexerProject`, and `dbPath` params have all
 * been dropped over Phase 3 + 4 as their consumers migrated.
 */
export function registerCodeTools(
  server: McpServer,
  resolver: RepoContextResolver,
): void {

  // index_repository — migrated to per-call routing with allowUnindexed.
  //
  // This tool CREATES `.cortex/db`. Registered with allowUnindexed so the
  // resolver doesn't throw RepoNotIndexedError on the very repo we're about
  // to bring online. The handler validates the path itself (existsSync) and
  // walks through cache-import → indexer-call → cache-write as before, just
  // anchored to the addressed repo_path instead of process.cwd().
  server.tool(
    "index_repository",
    "Index a repository into the knowledge graph (uses content-hash build cache)",
    indexRepositoryShape,
    registerTool(
      "index_repository",
      indexRepositorySchema,
      async (_resolver, args) => {
        // Checkout axis BEFORE any name/db/staging/registry derivation: a
        // subdir still collapses to its enclosing checkout, but a linked
        // worktree no longer collapses — it gets its own root (and so its own
        // store). Non-git dirs canonicalize to their own realpath.
        const repoPath = worktreeRoot(args.repo_path!);
        const mode = args.mode ?? "full";
        const dbPath = resolveCortexDbPath(repoPath);

        const registerRepo = () => {
          try {
            const reg = new Registry();
            try {
              const canonicalRoot = mainWorktreeRoot(repoPath);
              reg.register(deriveProjectName(repoPath), repoPath, undefined, {
                worktree_of: canonicalRoot && canonicalRoot !== repoPath ? canonicalRoot : null,
                branch: gitBranch(repoPath),
              });
            } finally { reg.close(); }
          } catch { /* non-fatal: registration must never fail the index */ }

          // Reap the now-consumed indexer slug cache (best-effort; never fail the index).
          if (process.env.CORTEX_GC !== "0") {
            try { reapRepoSlugCache(repoPath); } catch { /* non-fatal */ }
          }
        };

        // Defensive: before we touch the graph DB (which a cache import will
        // OVERWRITE), make sure any decisions still living in graph.db have
        // been migrated into the sidecar decisions.db. The migration is
        // idempotent (gated by schema_meta) so this is a no-op after the
        // first run.
        try {
          const decisionsDbPath = resolveDecisionsDbPath(repoPath);
          const decDb = openDecisionsDb(decisionsDbPath, legacyDecisionsDbPath(repoPath));
          try {
            migrateDecisionsFromGraphDb(decDb, dbPath);
          } finally {
            decDb.close();
          }
        } catch (e) {
          // Migration failure must not block indexing. Surface to stderr so
          // a regression here is visible without breaking the user's flow.
          process.stderr.write(
            `Cortex: defensive decisions migration failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }

        // Build into a private staging DB so every write (cache import, indexer
        // run, frame/contract passes) targets the staging path. publishStagedDb
        // (called inside withFrames) is the single chokepoint that atomically
        // promotes the finished artifact onto the canonical liveDbPath.
        // withIndexLock serializes concurrent CLI + MCP index operations on the
        // same repo so they never race on staging/publish.
        return await withIndexLock(repoPath, async () => {
          const stagePath = stagingDbPath(repoPath);
          cleanupStagingDb(stagePath); // clear any stale staging from an interrupted run
          try {
            // Cache requires a git tree to key on. Without it, computeCacheKey()
            // returns the same value for every non-git directory — which would
            // let an unrelated repo serve stale results. Skip cache entirely when
            // there's no .git directory.
            let cacheKey: string | null = null;
            if (existsSync(join(repoPath, ".git"))) {
              try {
                cacheKey = computeCacheKey(repoPath, mode);
              } catch {
                cacheKey = null;
              }
            }

            if (cacheKey && hasCacheEntry(cacheKey)) {
              // Import the cached snapshot INTO staging, never directly onto the
              // live db. withFrames will run passes against staging and then
              // publish to dbPath atomically.
              mkdirSync(dirname(stagePath), { recursive: true });
              readCacheEntry(cacheKey, stagePath);
              const out = await withFrames(`imported from cache key ${cacheKey.slice(0, 12)}…`, repoPath, stagePath, dbPath);
              captureIndexMeta(dbPath, repoPath);
              invalidateFreshness(repoPath);
              registerRepo();
              return out;
            }

            const result = await callIndexer("index_repository", { repo_path: repoPath, mode: mode }, stagePath);
            if (!result.isError && cacheKey) {
              // The indexer DB runs in WAL mode (see src/graph/store.ts).
              // Checkpoint WAL into the staging file before snapshotting so the
              // cached copy is self-contained. We checkpoint staging (not the live
              // db) because publish hasn't happened yet at this point.
              let checkpointed = false;
              try {
                const conn = new Database(stagePath);
                try {
                  conn.pragma("wal_checkpoint(TRUNCATE)");
                  checkpointed = true;
                } finally {
                  conn.close();
                }
              } catch { /* non-fatal; skip cache write */ }
              if (checkpointed) {
                try {
                  writeCacheEntry(cacheKey, stagePath);
                } catch {
                  // Cache write failure is non-fatal.
                }
              }
            }
            if (result.isError) return result;
            const baseText = result.content?.[0]?.text ?? "indexed";
            const out = await withFrames(baseText, repoPath, stagePath, dbPath);
            captureIndexMeta(dbPath, repoPath);
            invalidateFreshness(repoPath);
            registerRepo();
            return out;
          } finally {
            cleanupStagingDb(stagePath); // never leak staging — even on indexer error / throw
          }
        });
      },
      { resolver, allowUnindexed: true },
    ),
  );

  // detect_changes — migrated to per-call repo routing. Shells out via
  // callIndexer, but we pin both CORTEX_DB and repo_path to the addressed
  // repo so the indexer's git-diff walk runs against the right working tree.
  server.tool(
    "detect_changes",
    "Map git diff to affected symbols in the knowledge graph",
    detectChangesShape,
    registerTool(
      "detect_changes",
      detectChangesSchema,
      async (ctx, args) => {
        const addressedDbPath = ctx.graphDbPath;
        invalidateFreshness(ctx.repoPath);
        // Forward the optional diff params alongside the addressed repo_path.
        // undefined keys are dropped by JSON.stringify, so the indexer applies
        // its own defaults (base_branch="main", scope="symbols").
        return callIndexer(
          "detect_changes",
          { repo_path: ctx.repoPath, base_branch: args.base_branch, scope: args.scope, depth: args.depth },
          addressedDbPath,
        );
      },
      { resolver },
    ),
  );

  // changes_since — temporal layer (field-report P8, lean v1). TS-side, no
  // indexer round-trip: git supplies the commit window, ctx.graphDb supplies
  // node identity, the decisions sidecar supplies the why-layer.
  server.tool(
    "changes_since",
    "What changed since a ref, date, or decision id: commits + affected graph nodes + decisions created/reconciled/governing the change",
    changesSinceShape,
    registerTool(
      "changes_since",
      changesSinceSchema,
      async (ctx, args) => changesSinceAction(ctx, args),
      { resolver, freshnessAware: true },
    ),
  );

  // delete_project — Phase 4 migration to crossRepo mode.
  //
  // Identifier choice: `project` (slug name) rather than `repo_path`. The
  // registry is keyed on the slug, and the cleanup case explicitly includes
  // projects whose on-disk repo has moved / been deleted — routing by
  // repo_path (which the resolver validates as a live git root) would falsely
  // reject those. Keeping `project` also preserves the pre-Phase-4 CLI
  // contract: `cortex index delete <project>` shells `delete_project` with
  // the same arg shape.
  //
  // Two-part delete: the standalone indexer subprocess drops the legacy cache
  // file + cortex_db row, then we remove the row from the master registry
  // (`_registry.db`) — which is what `listKnownRepos`/`list_projects` now
  // enumerate, so the registry removal is the part that makes the project
  // disappear from listings. Best-effort: registry removal runs even if the
  // subprocess delete errors (e.g. a project whose on-disk repo is already
  // gone), preserving the cleanup-the-stale-entry contract.
  server.tool(
    "delete_project",
    "Remove a project from the code index",
    deleteProjectShape,
    registerTool(
      "delete_project",
      deleteProjectSchema,
      async (_resolver, args) => {
        const result = await callIndexer("delete_project", { project: args.project });
        try {
          const reg = new Registry();
          try { reg.remove(args.project); } finally { reg.close(); }
        } catch { /* non-fatal */ }
        return result;
      },
      { resolver, crossRepo: true },
    ),
  );

  // query_graph — migrated to per-call routing.
  //
  // `repo_path` selects which `.cortex/db` the indexer subprocess opens
  // (via CORTEX_DB). `project` is preserved as a *separate* concern: it's
  // an in-graph filter that scopes the Cypher query to a single
  // ctx_projects row when an indexer DB happens to hold multiple projects.
  // For the common case (one project per .cortex/db), we derive it from
  // ctx so the caller doesn't have to know the in-graph name.
  server.tool(
    "query_graph",
    "Execute a Cypher-style query against the code graph",
    queryGraphShape,
    registerTool(
      "query_graph",
      queryGraphSchema,
      async (ctx, args) => {
        const addressedDbPath = ctx.graphDbPath;
        const indexerArgs: Record<string, unknown> = { query: args.query };
        // Caller-supplied project wins; otherwise derive from the addressed
        // DB. Either way the project filter is applied INSIDE the graph DB
        // selected by repo_path, never across repos.
        if (args.project !== undefined) indexerArgs.project = args.project;
        else {
          const derived = projectFromCtx(ctx);
          if (derived) indexerArgs.project = derived;
        }
        if (args.max_rows !== undefined) indexerArgs.max_rows = args.max_rows;
        return callIndexer("query_graph", indexerArgs, addressedDbPath);
      },
      { resolver, freshnessAware: true },
    ),
  );

  // get_architecture — migrated to per-call routing.
  //
  // Dropped the previously-public `project` arg: with repo_path addressing
  // the `.cortex/db`, the in-graph project name is unambiguous (one project
  // per DB in normal use) and we derive it from ctx. If a future caller
  // needs to override (e.g. multi-project DBs from the indexer cache), they
  // can pass `project` via query_graph instead.
  server.tool(
    "get_architecture",
    "Get architectural overview by aspect (structure, dependencies, routes, all)",
    getArchitectureShape,
    registerTool(
      "get_architecture",
      getArchitectureSchema,
      async (ctx, args) => {
        const addressedDbPath = ctx.graphDbPath;
        const aspects = args.aspects ?? ["all"];
        const project = projectFromCtx(ctx);
        if (aspects.includes("hotspots")) {
          const hotspots = computeHotspots(ctx.store, project ?? "", loadGovernance(ctx.repoPath));
          const other = aspects.filter((a) => a !== "hotspots");
          if (other.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ project, hotspots }) }] };
          }
          const indexerRes = await callIndexer(
            "get_architecture",
            { aspects: other, ...(project ? { project } : {}) },
            addressedDbPath,
          );
          // Propagate an upstream indexer failure as-is — don't mask it by
          // merging hotspots into an error envelope and stripping isError.
          if (indexerRes.isError) return indexerRes;
          try {
            const first = indexerRes.content?.[0];
            if (first && typeof first.text === "string") {
              const parsed = JSON.parse(first.text);
              parsed.hotspots = hotspots;
              return { content: [{ ...first, text: JSON.stringify(parsed) }, ...indexerRes.content.slice(1)] };
            }
          } catch { /* fall through to raw-merge fallback below */ }
          return { content: [...(indexerRes.content ?? []), { type: "text", text: JSON.stringify({ hotspots }) }] };
        }
        const indexerArgs: Record<string, unknown> = { aspects, ...(project ? { project } : {}) };
        return callIndexer("get_architecture", indexerArgs, addressedDbPath);
      },
      { resolver, freshnessAware: true },
    ),
  );

  // ingest_traces — migrated to per-call routing. Traces enrich the graph
  // in a specific repo's .cortex/db, so we pin CORTEX_DB to the addressed
  // repo before invoking the indexer subprocess.
  server.tool(
    "ingest_traces",
    "Ingest runtime traces to enrich the graph",
    ingestTracesShape,
    registerTool(
      "ingest_traces",
      ingestTracesSchema,
      async (ctx, args) => {
        const addressedDbPath = ctx.graphDbPath;
        return callIndexer("ingest_traces", { traces: args.traces }, addressedDbPath);
      },
      { resolver },
    ),
  );

  // check_contracts — reads persisted BINDS_KEY edges and reports mismatches.
  server.tool(
    "check_contracts",
    "Report cross-language RPC contract mismatches (arg-key diffs) + coverage",
    checkContractsShape,
    registerTool(
      "check_contracts",
      checkContractsSchema,
      async (ctx) => {
        const project = projectFromCtx(ctx);
        if (!project) {
          return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
        }
        const report = computeContractReport(ctx.graphDbPath, project);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      },
      { resolver },
    ),
  );

  // --- SQL-based tools (6) ---

  // 5E: search_graph with normalize — migrated to per-call repo routing.
  server.tool(
    "search_graph",
    "Search the knowledge graph for code entities by name, label, or qualified name pattern",
    searchGraphShape,
    registerTool(
      "search_graph",
      searchGraphSchema,
      async (ctx, args) => {
        const project = projectFromCtx(ctx);
        if (!project) {
          return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
        }
        const { repo_path: _repoPath, limit, offset, ...params } = args;
        const qn = params.qn_pattern ? normalize(params.qn_pattern, project) : undefined;
        const searchParams = { ...params, qn_pattern: qn };
        const rows = searchGraph(ctx.store, project, searchParams);
        const queryDesc = `search_graph(${JSON.stringify(params)})`;
        // Sections are hidden only by the DEFAULT filter. Any explicit kinds
        // or label means the caller controls kind selection — they didn't
        // suppress sections by accepting a default, so report no suppression.
        const usesDefaultFilter = (params.kinds ?? []).length === 0 && !params.label;
        const suppressedSections = usesDefaultFilter
          ? countSuppressedSections(ctx.store, project, { name_pattern: params.name_pattern, qn_pattern: qn })
          : 0;
        // Genuinely empty only when no code rows AND no sections were hidden.
        // If sections matched, render the header-only opt-in hint instead of a
        // bare "no results" (which would hide retrievable matches).
        if (rows.length === 0 && suppressedSections === 0) return empty(queryDesc, symbolMissHint());
        const text = renderNodeSearch(rows, {
          // qn is a structural identifier, not a name to match — only a
          // name_pattern drives name-relevance; qn-only searches rank by kind.
          query: params.name_pattern,
          limit: clampLimit(limit),
          offset: clampOffset(offset),
          suppressedSections,
        });
        return ok(text);
      },
      { resolver, freshnessAware: true },
    ),
  );

  // 5H: trace_path with {node, depth}[] shape and max_depth param — migrated.
  server.tool(
    "trace_path",
    "Trace call chains from a function. function_name accepts a bare name, qualified name, file path, or dotted suffix. mode: calls (outbound) or callers (inbound). Returns ambiguous_input with candidates if multiple symbols match.",
    tracePathShape,
    registerTool(
      "trace_path",
      tracePathSchema,
      async (ctx, args) => {
        const project = projectFromCtx(ctx);
        if (!project) {
          return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
        }
        const { repo_path: _repoPath, ...params } = args;
        // Resolve function_name through the shared resolver so file paths,
        // qns, and dotted suffixes work — not just exact bare names. The
        // resolver opens its own GraphStore handle, so point it at the
        // addressed repo's graph DB rather than the server-bound one.
        const graphDbPath = ctx.graphDbPath;
        let fnName = params.function_name;
        const resolved = resolveInput(params.function_name, project, graphDbPath);
        if (resolved.kind === "none") {
          // Name never resolved to a node — a symbol miss, so route sideways.
          return empty(`trace_path(${JSON.stringify(params)})`, symbolMissHint());
        }
        if (resolved.kind === "multi") {
          const candidatesList = resolved.candidates
            .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
            .join("\n");
          return errorResponse(
            "ambiguous_input",
            `Multiple matches for '${params.function_name}'. Pick one and re-call:\n${candidatesList}`,
          );
        }
        // tracePath wants the bare name; pull it from the resolved qn
        fnName = resolved.symbol.qn.split(".").pop() ?? params.function_name;
        const results = tracePath(ctx.store, project, { ...params, function_name: fnName });
        // No hint here: the symbol resolved, so this is the graph reporting
        // "no edges", not failing to carry the shape (see symbolMissHint).
        if (results.length === 0) return empty(`trace_path(${JSON.stringify(params)})`);
        const lines = results.map((r) =>
          `[d=${r.depth}] ${r.node.kind} ${denormalize(r.node.qualified_name, r.node.file_path)} (${r.node.file_path}:${r.node.start_line}-${r.node.end_line})`
        );
        return ok(lines.join("\n"));
      },
      { resolver, freshnessAware: true, briefAware: true },
    ),
  );

  // 5F: get_code_snippet with normalize/denormalize — migrated to per-call routing.
  server.tool(
    "get_code_snippet",
    "Get source code for a symbol. Input can be a qualified name, file path, dotted suffix, or bare symbol name. Returns ambiguous_input with candidates if multiple symbols match.",
    getCodeSnippetShape,
    registerTool(
      "get_code_snippet",
      getCodeSnippetSchema,
      async (ctx, args) => {
        const { qualified_name } = args;
        const project = projectFromCtx(ctx);
        if (!project) {
          return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
        }
        // resolveInput opens its own GraphStore handle on the supplied dbPath
        // — point it at the addressed repo's graph DB, not the server-bound one.
        const graphDbPath = ctx.graphDbPath;
        if (!qualified_name.includes("::")) {
          const resolved = resolveInput(qualified_name, project, graphDbPath);
          if (resolved.kind === "none") {
            return empty(`get_code_snippet(${qualified_name})`, symbolMissHint());
          }
          if (resolved.kind === "multi") {
            const candidatesList = resolved.candidates
              .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
              .join("\n");
            return errorResponse(
              "ambiguous_input",
              `Multiple matches for '${qualified_name}'. Pick one and re-call:\n${candidatesList}`,
            );
          }
          const nodes = searchGraph(ctx.store, project, { qn_pattern: resolved.symbol.qn });
          if (nodes.length === 0) {
            return empty(`get_code_snippet(${qualified_name})`, symbolMissHint());
          }
          const node = nodes[0];
          return readSnippet(ctx, project, node);
        }
        // qn-shaped input (contains '::') — skip the resolver and pattern-match directly.
        const qn = normalize(qualified_name, project);
        const nodes = searchGraph(ctx.store, project, { qn_pattern: qn });
        if (nodes.length === 0) return empty(`get_code_snippet(${qualified_name})`, symbolMissHint());
        const node = nodes[0];
        return readSnippet(ctx, project, node);
      },
      { resolver, freshnessAware: true, briefAware: true },
    ),
  );

  // 5J: get_graph_schema with counts — migrated to per-call repo routing.
  server.tool(
    "get_graph_schema",
    "List node labels, edge types, and their counts in the knowledge graph",
    getGraphSchemaShape,
    registerTool(
      "get_graph_schema",
      getGraphSchemaSchema,
      async (ctx, _args) => {
        const project = projectFromCtx(ctx);
        if (!project) {
          return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
        }
        const schema = getGraphSchema(ctx.store, project);
        const labelLines = schema.labels.map((l) => `  ${l.name}: ${l.count}`).join("\n");
        const edgeLines = schema.edgeTypes.map((e) => `  ${e.name}: ${e.count}`).join("\n");
        return ok(`Labels:\n${labelLines}\nEdge types:\n${edgeLines}`);
      },
      { resolver },
    ),
  );

  // list_projects — Phase 4 migration to crossRepo mode.
  //
  // Previously closed over the startup-bound `store` to read its ctx_projects,
  // then merged in the indexer's cache directory via a subprocess shell-out.
  // After migration the resolver is the single source of truth: it walks
  // ~/.cache/cortex-indexer/ in-process AND surfaces pooled local-DB repos.
  // See `RepoContextResolver.listKnownRepos` for the registry rationale.
  //
  // Field Report rec #1: this contract guarantees list_projects returns every
  // indexed repo the server can address, not just the one its process was
  // started in.
  server.tool(
    "list_projects",
    "List all indexed projects",
    listProjectsShape,
    registerTool(
      "list_projects",
      listProjectsSchema,
      async (resolver, _args) => {
        const repos = resolver.listKnownRepos();
        if (repos.length === 0) return empty("list_projects()");
        // Fold linked worktrees under their canonical parent so a repo with
        // several worktrees doesn't bury the parent under N top-level rows.
        // groupCheckouts keys on `root_path`; AvailableProject calls it `path`.
        const grouped = groupCheckouts(repos.map((p) => ({ ...p, root_path: p.path })));
        const text = grouped
          .map((p) => {
            const line = `${p.name} — ${p.root_path}${p.indexed ? "" : " (not indexed)"}`;
            const worktreeLines = p.worktrees.map(
              (w) => `  worktree: ${w.name} — ${w.root_path}${w.branch ? ` (${w.branch})` : ""}`,
            );
            return [line, ...worktreeLines].join("\n");
          })
          .join("\n");
        return ok(text);
      },
      { resolver, crossRepo: true },
    ),
  );

  // index_status — migrated to per-call routing with allowUnindexed.
  //
  // index_status is the one tool whose normal use case INCLUDES checking a
  // path that's not yet indexed (the answer is "no"). It's registered with
  // allowUnindexed so the resolver doesn't throw RepoNotIndexedError on
  // unindexed paths — the handler does its own .cortex/db check and falls
  // through to the indexer-cache scan if no local DB matches.
  //
  // Public arg renamed `path` → `repo_path` for consistency with the rest of
  // the per-call routing surface.
  server.tool(
    "index_status",
    "Check if a repository is indexed",
    indexStatusShape,
    registerTool(
      "index_status",
      indexStatusSchema,
      async (_resolver, args) => {
        const repoPath = args.repo_path!;

        // (a) addressed repo's .cortex/db (fast path).
        const addressedDbPath = resolveCortexDbPath(repoPath);
        if (existsSync(addressedDbPath)) {
          // Open a tiny read-only handle and inspect ctx_projects. Don't go
          // through the resolver — we want to tolerate corrupt/empty DBs and
          // fall through to cache, not throw.
          try {
            const probe = new Database(addressedDbPath, { readonly: true });
            try {
              const row = probe.prepare(
                "SELECT name, root_path, indexed_at FROM ctx_projects WHERE root_path = ? LIMIT 1",
              ).get(repoPath) as { name: string; root_path: string; indexed_at: string } | undefined;
              if (row) {
                return ok(`Indexed: ${row.name} at ${row.root_path} (last: ${row.indexed_at})`);
              }
              // ctx_projects may store a different root_path than the caller
              // supplied (symlinks, fixtures). If the table has any row at
              // all, this DB belongs to *some* project — report it.
              const anyRow = probe.prepare(
                "SELECT name, root_path, indexed_at FROM ctx_projects LIMIT 1",
              ).get() as { name: string; root_path: string; indexed_at: string } | undefined;
              if (anyRow) {
                return ok(`Indexed: ${anyRow.name} at ${anyRow.root_path} (last: ${anyRow.indexed_at})`);
              }
            } finally {
              probe.close();
            }
          } catch { /* fall through to cache */ }
        }

        // (b) shared indexer cache (covers repos indexed via the CLI from
        // some other server lifetime).
        const listResult = await callIndexerCache("list_projects", {});
        if (!listResult.isError) {
          try {
            const parsed = JSON.parse(listResult.content[0]?.text ?? "{}");
            const projects: ProjectRow[] = parsed.projects ?? [];
            const match = projects.find((p) => p.root_path === repoPath);
            if (match) {
              return ok(`Indexed: ${match.name} at ${match.root_path} (${match.nodes ?? 0} nodes, ${match.edges ?? 0} edges)`);
            }
          } catch { /* fall through to empty */ }
        }

        return empty(`index_status(${repoPath})`);
      },
      { resolver, allowUnindexed: true },
    ),
  );

  // 5K: search_code — migrated to per-call routing.
  //
  // Field Report rec #5: the previous implementation passed `.` as the
  // search target and inherited the server's process.cwd() as the shell's
  // working directory — so a Cortex instance launched from /a/repo would
  // grep repo /a regardless of which project the caller meant. After
  // migration the rg/grep subprocess is anchored to `ctx.repoPath` via the
  // `cwd` option (the args still pass `.`, so the rg/grep tests don't need
  // updating). The graph-enrichment lookup also runs through ctx.store.
  server.tool(
    "search_code",
    "Search source code with graph-enriched results (shows which function/class each match belongs to)",
    searchCodeShape,
    registerTool(
      "search_code",
      searchCodeSchema,
      async (ctx, args) => {
        const { pattern } = args;
        const project = projectFromCtx(ctx);
        const outcome = await runCodeSearch({
          pattern,
          repoRoot: ctx.repoPath,
          store: ctx.store,
          project: project ?? undefined,
          maxHits: 50,
        });
        if (outcome.kind === "empty") return empty(`search_code(${pattern})`);
        if (outcome.kind === "invalid_pattern") {
          return errorResponse(
            "invalid_pattern",
            `Pattern rejected by ripgrep: ${outcome.detail}\n` +
              "search_code uses ripgrep regex syntax — escape regex metacharacters " +
              "(e.g. \\( \\[ \\. \\*) to match them literally.",
          );
        }
        if (outcome.kind === "error") return errorResponse("internal_error", outcome.detail);
        const text = outcome.hits
          .map((h) => {
            const base = `./${h.file}:${h.line}:${h.text}`;
            return h.enclosing
              ? `${base}  // in ${h.enclosing.kind} ${denormalize(h.enclosing.qualified_name, h.enclosing.file_path)}`
              : base;
          })
          .join("\n");
        return ok(text);
      },
      { resolver, freshnessAware: true },
    ),
  );

  // context_pack — composite read (P1). Registered here so both server.ts and
  // the contract harness pick it up via the single registerCodeTools call.
  registerContextPackTool(server, resolver);
}
