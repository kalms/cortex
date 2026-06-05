import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import {
  searchGraph,
  tracePath,
  getGraphSchema,
  IndexerNode,
} from "../../graph/code-queries.js";
// 5A: response helpers and qualified-name normalizer
import { ok, empty, error as errorResponse } from "../response.js";
import { normalize, denormalize } from "../qualified-name.js";
import { resolveInput } from "../../shared/resolve-input.js";
import { resolveCortexDbPath, resolveDecisionsDbPath } from "../../db/resolve-path.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../../decisions/migration.js";
import { computeCacheKey, hasCacheEntry, readCacheEntry, writeCacheEntry } from "../../db/cache.js";
import { runFrameExtraction, type FrameResult } from "../../frame-extraction/run-frames.js";
import { deriveProjectName } from "../../frame-extraction/cluster-tfidf-hdbscan.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";

// ---------------------------------------------------------------------------
// Per-call repo routing schemas
//
// Mirrors the pattern in decision-tools.ts (see that module's header for
// the rationale). `RepoPathField` is duplicated here rather than imported —
// the field is small and self-contained; hoist to a shared module if a third
// consumer appears. See decision-tools.ts for the canonical declaration.
// ---------------------------------------------------------------------------

const RepoPathField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "REQUIRED. Absolute path to the indexed git root this query targets. " +
      "If you don't know it, call list_projects first.",
  );

const searchGraphShape = {
  repo_path: RepoPathField,
  name_pattern: z.string().optional(),
  label: z.string().optional(),
  qn_pattern: z.string().optional(),
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
} as const;
const indexRepositorySchema = z.object(indexRepositoryShape);

const ingestTracesShape = {
  repo_path: RepoPathField,
  traces: z.array(z.unknown()).describe("Array of trace records"),
} as const;
const ingestTracesSchema = z.object(ingestTracesShape);

/**
 * Derive the project name from the addressed repo's graph DB.
 *
 * Each `.cortex/db` written by the indexer holds rows for exactly one project
 * (its `ctx_projects` table). We pick the first row rather than filtering by
 * `root_path` because the path stored at indexing time can diverge from the
 * agent's current absolute path (symlinks, copied fixtures, moved trees) —
 * but the DB always contains a single project, so LIMIT 1 is unambiguous.
 * Returns null when the table is missing (pre-migration DB) or empty.
 */
function projectFromCtx(ctx: RepoContext): string | null {
  try {
    const rows = ctx.store.queryRaw<{ name: string }>(
      "SELECT name FROM ctx_projects LIMIT 1",
    );
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a code snippet for a resolved node off disk.
 *
 * Honors the stored `ctx_projects.root_path` because the indexer wrote
 * `file_path` relative to *that* root, not relative to the path the caller
 * addressed (`ctx.repoPath`). The two can diverge when a fixture clones the
 * graph DB into a tmp tree without copying the source files alongside.
 */
async function readSnippet(
  ctx: RepoContext,
  project: string,
  node: IndexerNode,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  try {
    const projectRow = ctx.store.queryRaw<{ root_path: string }>(
      "SELECT root_path FROM ctx_projects WHERE name = ?",
      [project],
    );
    if (projectRow.length === 0) {
      return errorResponse("project_not_found", `Project ${project} not found in indexer DB`);
    }
    const fullPath = join(projectRow[0].root_path, node.file_path);
    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, node.start_line - 1);
    const end = Math.min(lines.length, node.end_line);
    const snippet = lines.slice(start, end).join("\n");
    const display = denormalize(node.qualified_name, node.file_path);
    return ok(`// ${display} (${node.file_path}:${node.start_line}-${node.end_line})\n${snippet}`);
  } catch (e) {
    return errorResponse("fs_error", e instanceof Error ? e.message : String(e));
  }
}

const execFileAsync = promisify(execFile);
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_INDEXER = join(__dirname, "..", "..", "..", "bin", "cortex-indexer");
// CBM_BINARY_PATH retained as deprecated alias; remove in Phase 9.
const INDEXER_BINARY = process.env.CORTEX_INDEXER_PATH || process.env.CBM_BINARY_PATH || LOCAL_INDEXER;
const RG_MAX_BUFFER = 64 * 1024 * 1024;

export function buildRgArgs(pattern: string): string[] {
  return [
    "--no-heading",
    "--line-number",
    "--color=never",
    "--max-count", "200",
    pattern,
    ".",
  ];
}

export function buildGrepFallbackArgs(pattern: string): string[] {
  return [
    "-rn",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.cache",
    "--exclude-dir=vendored",
    pattern,
    ".",
  ];
}

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
  try {
    const { stdout } = await execFileAsync(INDEXER_BINARY, ["cli", tool, JSON.stringify(args)], {
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
    } catch {
      return errorResponse("binary_failed", `cortex-indexer ${tool}: unexpected non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`);
    }
    return ok(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("binary_failed", `cortex-indexer ${tool} failed: ${msg}`);
  }
}

// 5D: formatNodes emits colon form via denormalize
function formatNodes(nodes: IndexerNode[]): string {
  if (nodes.length === 0) return "";
  return nodes
    .map((n) => `${n.kind} ${denormalize(n.qualified_name, n.file_path)} (${n.file_path}:${n.start_line}-${n.end_line})`)
    .join("\n");
}

/** Run frame extraction for an already-indexed repo and fold a structured
 *  `frames` field into the tool's text response. The MCP envelope is text;
 *  we append a machine-readable JSON line so agents can parse status. */
async function withFrames(
  baseText: string,
  repoPath: string,
  dbPath: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const project = deriveProjectName(repoPath);
  let frames: FrameResult;
  try {
    frames = await runFrameExtraction({ repoPath, project, dbPath });
  } catch (e) {
    frames = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
  return { content: [{ type: "text", text: `${baseText}\nframes: ${JSON.stringify(frames)}` }] };
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
        const repoPath = args.repo_path!;
        const dbPath = resolveCortexDbPath(repoPath);

        // Defensive: before we touch the graph DB (which a cache import will
        // OVERWRITE), make sure any decisions still living in graph.db have
        // been migrated into the sidecar decisions.db. The migration is
        // idempotent (gated by schema_meta) so this is a no-op after the
        // first run.
        try {
          const decisionsDbPath = resolveDecisionsDbPath(repoPath);
          const decDb = openDecisionsDb(decisionsDbPath);
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

        // Cache requires a git tree to key on. Without it, computeCacheKey()
        // returns the same value for every non-git directory — which would
        // let an unrelated repo serve stale results. Skip cache entirely when
        // there's no .git directory.
        let cacheKey: string | null = null;
        if (existsSync(join(repoPath, ".git"))) {
          try {
            cacheKey = computeCacheKey(repoPath);
          } catch {
            cacheKey = null;
          }
        }

        if (cacheKey && hasCacheEntry(cacheKey)) {
          readCacheEntry(cacheKey, dbPath);
          // Remove any stale WAL sidecars left over from a previous indexer run.
          for (const ext of ["-wal", "-shm"]) {
            const sidecar = dbPath + ext;
            if (existsSync(sidecar)) {
              try { unlinkSync(sidecar); } catch { /* non-fatal */ }
            }
          }
          return await withFrames(`imported from cache key ${cacheKey.slice(0, 12)}…`, repoPath, dbPath);
        }

        const result = await callIndexer("index_repository", { repo_path: repoPath }, dbPath);
        if (!result.isError && cacheKey) {
          // The indexer DB runs in WAL mode (see src/graph/store.ts).
          // Checkpoint WAL into the main file before copying so the cached
          // snapshot is self-contained.
          let checkpointed = false;
          try {
            const conn = new Database(dbPath);
            try {
              conn.pragma("wal_checkpoint(TRUNCATE)");
              checkpointed = true;
            } finally {
              conn.close();
            }
          } catch { /* non-fatal; skip cache write */ }
          if (!checkpointed) {
            return result;
          }
          try {
            writeCacheEntry(cacheKey, dbPath);
          } catch {
            // Cache write failure is non-fatal.
          }
        }
        if (result.isError) return result;
        const baseText = result.content?.[0]?.text ?? "indexed";
        return await withFrames(baseText, repoPath, dbPath);
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
      async (ctx, _args) => {
        const addressedDbPath = ctx.graphDbPath;
        return callIndexer("detect_changes", { repo_path: ctx.repoPath }, addressedDbPath);
      },
      { resolver },
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
  // The underlying delete (cache file removal + cortex_db row drop) is
  // performed by the standalone indexer subprocess; from there it propagates
  // back to listKnownRepos automatically since the master registry IS the
  // cache directory. No CORTEX_DB pinning here — by design the indexer
  // resolves the cache slot from the slug.
  server.tool(
    "delete_project",
    "Remove a project from the code index",
    deleteProjectShape,
    registerTool(
      "delete_project",
      deleteProjectSchema,
      async (_resolver, args) => callIndexer("delete_project", { project: args.project }),
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
      { resolver },
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
        const indexerArgs: Record<string, unknown> = { aspects: args.aspects ?? ["all"] };
        const project = projectFromCtx(ctx);
        if (project) indexerArgs.project = project;
        return callIndexer("get_architecture", indexerArgs, addressedDbPath);
      },
      { resolver },
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
        const { repo_path: _repoPath, ...params } = args;
        const qn = params.qn_pattern ? normalize(params.qn_pattern, project) : undefined;
        const results = searchGraph(ctx.store, project, { ...params, qn_pattern: qn });
        const text = formatNodes(results);
        const queryDesc = `search_graph(${JSON.stringify(params)})`;
        return text ? ok(text) : empty(queryDesc);
      },
      { resolver },
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
          return empty(`trace_path(${JSON.stringify(params)})`);
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
        if (results.length === 0) return empty(`trace_path(${JSON.stringify(params)})`);
        const lines = results.map((r) =>
          `[d=${r.depth}] ${r.node.kind} ${denormalize(r.node.qualified_name, r.node.file_path)} (${r.node.file_path}:${r.node.start_line}-${r.node.end_line})`
        );
        return ok(lines.join("\n"));
      },
      { resolver },
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
            return empty(`get_code_snippet(${qualified_name})`);
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
            return empty(`get_code_snippet(${qualified_name})`);
          }
          const node = nodes[0];
          return readSnippet(ctx, project, node);
        }
        // qn-shaped input (contains '::') — skip the resolver and pattern-match directly.
        const qn = normalize(qualified_name, project);
        const nodes = searchGraph(ctx.store, project, { qn_pattern: qn });
        if (nodes.length === 0) return empty(`get_code_snippet(${qualified_name})`);
        const node = nodes[0];
        return readSnippet(ctx, project, node);
      },
      { resolver },
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
        const text = repos
          .map((p) => `${p.name} — ${p.path}${p.indexed ? "" : " (not indexed)"}`)
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
        // Anchor the shell-out to the addressed repo so `.` resolves to
        // ctx.repoPath instead of process.cwd(). This is the Field Report
        // rec #5 fix.
        const execOpts = {
          timeout: 10_000,
          maxBuffer: RG_MAX_BUFFER,
          cwd: ctx.repoPath,
        };
        let grepOutput = "";
        try {
          const { stdout } = await execFileAsync("rg", buildRgArgs(pattern), execOpts);
          grepOutput = stdout;
        } catch (err: any) {
          if (err.code === "ENOENT") {
            try {
              const { stdout } = await execFileAsync("grep", buildGrepFallbackArgs(pattern), execOpts);
              grepOutput = stdout;
            } catch (err2: any) {
              if (err2.code === "ENOENT") {
                return errorResponse("internal_error", "Neither rg nor grep available on PATH.");
              }
              if (err2.code !== 1) {
                return errorResponse("internal_error", err2.message ?? String(err2));
              }
              if (!err2.stdout) return empty(`search_code(${pattern})`);
              grepOutput = err2.stdout;
            }
          } else if (err.stdout) {
            grepOutput = err.stdout;
          } else if (err.code === 1) {
            return empty(`search_code(${pattern})`);
          } else {
            return errorResponse("internal_error", err.message ?? String(err));
          }
        }

        if (!grepOutput.trim()) return empty(`search_code(${pattern})`);

        // Graph enrichment uses the addressed repo's graph DB (ctx.store)
        // and its in-graph project name. Without an indexed project, we
        // surface the raw grep output rather than failing outright — the
        // caller still gets file:line hits.
        const project = projectFromCtx(ctx);
        if (!project) {
          return ok(grepOutput);
        }

        const lines = grepOutput.trim().split("\n").slice(0, 50);
        const enriched = lines.map((line) => {
          const match = line.match(/^\.\/(.+?):(\d+):/);
          if (!match) return line;
          const [, filePath, lineNum] = match;
          const lineNumber = parseInt(lineNum, 10);
          const enclosing = ctx.store.queryRaw<IndexerNode>(
            `SELECT * FROM nodes
             WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
               AND kind NOT IN ('decision', 'pr', 'todo')
             ORDER BY (end_line - start_line) ASC LIMIT 1`,
            [project, filePath, lineNumber, lineNumber]
          );
          if (enclosing.length > 0) {
            return `${line}  // in ${enclosing[0].kind} ${denormalize(enclosing[0].qualified_name, enclosing[0].file_path)}`;
          }
          return line;
        });

        return ok(enriched.join("\n"));
      },
      { resolver },
    ),
  );
}
