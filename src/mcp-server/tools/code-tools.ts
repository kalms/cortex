import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { GraphStore } from "../../graph/store.js";
import {
  searchGraph,
  tracePath,
  getGraphSchema,
  listProjects,
  indexStatus,
  IndexerNode,
} from "../../graph/code-queries.js";
// 5A: response helpers and qualified-name normalizer
import { ok, empty, error as errorResponse } from "../response.js";
import { normalize, denormalize } from "../qualified-name.js";
import { resolveCortexDbPath } from "../../db/resolve-path.js";
import { computeCacheKey, hasCacheEntry, readCacheEntry, writeCacheEntry } from "../../db/cache.js";

const execFileAsync = promisify(execFile);
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_INDEXER = join(__dirname, "..", "..", "..", "bin", "cortex-indexer");
const INDEXER_BINARY = process.env.CORTEX_INDEXER_PATH || process.env.CBM_BINARY_PATH || LOCAL_INDEXER;
const RG_MAX_BUFFER = 64 * 1024 * 1024;

// 5B: callIndexer now handles binary in-stdout errors and returns structured responses
type IndexerCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};
async function callIndexer(tool: string, args: Record<string, unknown>, dbPath?: string): Promise<IndexerCallResult> {
  // Make the indexer write to the same SQLite file Cortex uses. Without this
  // the indexer falls back to ~/.cache/codebase-memory-mcp/<project>.db and
  // Cortex would never see the data.
  const cortexDb = dbPath ?? resolveCortexDbPath();
  const subprocEnv = { ...process.env, CORTEX_DB: cortexDb };
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

export function registerCodeTools(server: McpServer, store: GraphStore, indexerProject: string | null): void {
  // --- Subprocess tools (3) --- 5C: use repo_path internally, keep public arg as `path`

  server.tool(
    "index_repository",
    "Index a repository into the knowledge graph (uses content-hash build cache)",
    { path: z.string().optional().describe("Repository path (default: current directory)") },
    async ({ path }) => {
      const repoPath = path || process.cwd();
      const dbPath = resolveCortexDbPath(repoPath);

      // Cache requires a git tree to key on. Without it, computeCacheKey()
      // returns the same value for every non-git directory — which would let
      // an unrelated repo serve stale results. Skip cache entirely when there's
      // no .git directory.
      let cacheKey: string | null = null;
      if (existsSync(join(repoPath, ".git"))) {
        try {
          cacheKey = computeCacheKey(repoPath);
        } catch {
          // Defensive: current cache module catches errors internally, but
          // keep this so a future stricter implementation can't break
          // index_repository.
          cacheKey = null;
        }
      }

      if (cacheKey && hasCacheEntry(cacheKey)) {
        readCacheEntry(cacheKey, dbPath);
        // Remove any stale WAL sidecars left over from a previous indexer run.
        // Otherwise SQLite will replay them on top of the freshly restored
        // main file and serve stale data.
        for (const ext of ["-wal", "-shm"]) {
          const sidecar = dbPath + ext;
          if (existsSync(sidecar)) {
            try { unlinkSync(sidecar); } catch { /* non-fatal */ }
          }
        }
        return ok(`imported from cache key ${cacheKey.slice(0, 12)}…`);
      }

      const result = await callIndexer("index_repository", { repo_path: repoPath }, dbPath);
      if (!result.isError && cacheKey) {
        // The indexer DB runs in WAL mode (see src/graph/store.ts). Checkpoint
        // WAL into the main file before copying so the cached snapshot is
        // self-contained — otherwise uncheckpointed pages would be missing.
        let checkpointed = false;
        try {
          const conn = new Database(dbPath);
          try {
            conn.pragma("wal_checkpoint(TRUNCATE)");
            checkpointed = true;
          } finally {
            conn.close();
          }
        } catch { /* checkpoint failure is non-fatal; skip cache write */ }
        if (!checkpointed) {
          return result;
        }
        try {
          writeCacheEntry(cacheKey, dbPath);
        } catch {
          // Cache write failure is non-fatal.
        }
      }
      return result;
    }
  );

  server.tool(
    "detect_changes",
    "Map git diff to affected symbols in the knowledge graph",
    { path: z.string().optional().describe("Repository path") },
    async ({ path }) => callIndexer("detect_changes", { repo_path: path || process.cwd() })
  );

  server.tool(
    "delete_project",
    "Remove a project from the code index",
    { project: z.string().describe("Project name to delete") },
    async ({ project }) => callIndexer("delete_project", { project })
  );

  // 6.8: bridge three indexer tools that don't yet have TS registrations
  server.tool(
    "query_graph",
    "Execute a Cypher-style query against the code graph",
    {
      query: z.string().describe("Cypher query string"),
      project: z.string().optional().describe("Project name (default: active project)"),
      max_rows: z.number().int().optional().describe("Maximum rows to return"),
    },
    async ({ query, project, max_rows }) => {
      const args: Record<string, unknown> = { query };
      if (project !== undefined) args.project = project;
      else if (indexerProject) args.project = indexerProject;
      if (max_rows !== undefined) args.max_rows = max_rows;
      return callIndexer("query_graph", args);
    }
  );

  server.tool(
    "get_architecture",
    "Get architectural overview by aspect (structure, dependencies, routes, all)",
    {
      aspects: z
        .array(z.string())
        .optional()
        .describe('Aspects to include, e.g. ["all"]'),
      project: z.string().optional().describe("Project name (default: active project)"),
    },
    async ({ aspects, project }) => {
      const args: Record<string, unknown> = { aspects: aspects ?? ["all"] };
      if (project !== undefined) args.project = project;
      else if (indexerProject) args.project = indexerProject;
      return callIndexer("get_architecture", args);
    }
  );

  server.tool(
    "ingest_traces",
    "Ingest runtime traces to enrich the graph",
    {
      traces: z.array(z.unknown()).describe("Array of trace records"),
    },
    async ({ traces }) => callIndexer("ingest_traces", { traces })
  );

  // --- SQL-based tools (6) ---

  // 5E: search_graph with normalize
  server.tool(
    "search_graph",
    "Search the knowledge graph for code entities by name, label, or qualified name pattern",
    {
      name_pattern: z.string().optional(),
      label: z.string().optional(),
      qn_pattern: z.string().optional(),
    },
    async (params) => {
      if (!indexerProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const qn = params.qn_pattern ? normalize(params.qn_pattern, indexerProject) : undefined;
      const results = searchGraph(store, indexerProject, { ...params, qn_pattern: qn });
      const text = formatNodes(results);
      const queryDesc = `search_graph(${JSON.stringify(params)})`;
      return text ? ok(text) : empty(queryDesc);
    }
  );

  // 5H: trace_path with {node, depth}[] shape and max_depth param
  server.tool(
    "trace_path",
    "Trace call chains from a function (mode: calls, callers)",
    {
      function_name: z.string(),
      mode: z.enum(["calls", "callers"]).describe("Trace mode: calls (outbound) or callers (inbound)"),
      max_depth: z.number().int().min(1).max(10).optional(),
    },
    async (params) => {
      if (!indexerProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const results = tracePath(store, indexerProject, params);
      if (results.length === 0) return empty(`trace_path(${JSON.stringify(params)})`);
      const lines = results.map((r) =>
        `[d=${r.depth}] ${r.node.kind} ${denormalize(r.node.qualified_name, r.node.file_path)} (${r.node.file_path}:${r.node.start_line}-${r.node.end_line})`
      );
      return ok(lines.join("\n"));
    }
  );

  // 5F: get_code_snippet with normalize/denormalize
  server.tool(
    "get_code_snippet",
    "Get source code for a fully qualified name",
    {
      qualified_name: z.string().min(1, "qualified_name must not be empty"),
    },
    async ({ qualified_name }) => {
      if (!indexerProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const qn = normalize(qualified_name, indexerProject);
      const nodes = searchGraph(store, indexerProject, { qn_pattern: qn });
      if (nodes.length === 0) return empty(`get_code_snippet(${qualified_name})`);
      const node = nodes[0];
      try {
        // Resolve file_path: it's relative to project root, so prepend root_path
        const projectRow = store.queryRaw<{ root_path: string }>(
          "SELECT root_path FROM ctx_projects WHERE name = ?",
          [indexerProject]
        );
        if (projectRow.length === 0) {
          return errorResponse("project_not_found", `Project ${indexerProject} not found in CBM DB`);
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
  );

  // 5J: get_graph_schema with counts
  server.tool(
    "get_graph_schema",
    "List node labels, edge types, and their counts in the knowledge graph",
    {},
    async () => {
      if (!indexerProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const schema = getGraphSchema(store, indexerProject);
      const labelLines = schema.labels.map((l) => `  ${l.name}: ${l.count}`).join("\n");
      const edgeLines = schema.edgeTypes.map((e) => `  ${e.name}: ${e.count}`).join("\n");
      return ok(`Labels:\n${labelLines}\nEdge types:\n${edgeLines}`);
    }
  );

  // 5L: list_projects with response helpers
  server.tool(
    "list_projects",
    "List all indexed projects",
    {},
    async () => {
      let projects;
      try {
        projects = listProjects(store);
      } catch (e) {
        if (e instanceof Error && /no such table/i.test(e.message)) return empty("list_projects()");
        throw e;
      }
      if (projects.length === 0) return empty("list_projects()");
      const text = projects.map((p) => `${p.name} — ${p.root_path} (indexed: ${p.indexed_at})`).join("\n");
      return ok(text);
    }
  );

  // 5M: index_status with response helpers
  server.tool(
    "index_status",
    "Check if a repository is indexed",
    {
      path: z.string().optional().describe("Repository path to check (default: current directory)"),
    },
    async ({ path }) => {
      const cwd = path || process.cwd();
      let status;
      try {
        status = indexStatus(store, cwd);
      } catch (e) {
        if (e instanceof Error && /no such table/i.test(e.message)) return empty(`index_status(${cwd})`);
        throw e;
      }
      if (!status) return empty(`index_status(${cwd})`);
      return ok(`Indexed: ${status.name} at ${status.root_path} (last: ${status.indexed_at})`);
    }
  );

  // 5K: search_code with proper error discrimination
  server.tool(
    "search_code",
    "Search source code with graph-enriched results (shows which function/class each match belongs to)",
    {
      pattern: z.string(),
    },
    async ({ pattern }) => {
      let grepOutput = "";
      try {
        const { stdout } = await execFileAsync("rg", [
          "--no-heading", "--line-number", "--color=never", pattern, ".",
        ], { timeout: 10_000, maxBuffer: RG_MAX_BUFFER });
        grepOutput = stdout;
      } catch (err: any) {
        if (err.code === "ENOENT") {
          try {
            const { stdout } = await execFileAsync("grep", ["-rn", pattern, "."], { timeout: 10_000, maxBuffer: RG_MAX_BUFFER });
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

      if (!indexerProject) {
        return ok(grepOutput);
      }

      const lines = grepOutput.trim().split("\n").slice(0, 50);
      const enriched = lines.map((line) => {
        const match = line.match(/^\.\/(.+?):(\d+):/);
        if (!match) return line;
        const [, filePath, lineNum] = match;
        const lineNumber = parseInt(lineNum, 10);
        const enclosing = store.queryRaw<IndexerNode>(
          `SELECT * FROM nodes
           WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
             AND kind NOT IN ('decision', 'pr', 'todo')
           ORDER BY (end_line - start_line) ASC LIMIT 1`,
          [indexerProject, filePath, lineNumber, lineNumber]
        );
        if (enclosing.length > 0) {
          return `${line}  // in ${enclosing[0].kind} ${denormalize(enclosing[0].qualified_name, enclosing[0].file_path)}`;
        }
        return line;
      });

      return ok(enriched.join("\n"));
    }
  );
}
