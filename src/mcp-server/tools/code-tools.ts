import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { GraphStore } from "../../graph/store.js";
import {
  searchGraph,
  tracePath,
  getGraphSchema,
  listProjects,
  indexStatus,
  CbmNode,
} from "../../graph/cbm-queries.js";
// 5A: response helpers and qualified-name normalizer
import { ok, empty, error as errorResponse } from "../response.js";
import { normalize, denormalize } from "../qualified-name.js";

const execFileAsync = promisify(execFile);
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_CBM = join(__dirname, "..", "..", "..", "bin", "codebase-memory-mcp");
const CBM_BINARY = process.env.CBM_BINARY_PATH || (existsSync(LOCAL_CBM) ? LOCAL_CBM : "codebase-memory-mcp");

// 5B: callCbm now handles binary in-stdout errors and returns structured responses
async function callCbm(tool: string, args: Record<string, unknown>) {
  try {
    const { stdout } = await execFileAsync(CBM_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
    });
    // Binary always exits 0; errors come back as {"isError":true,"content":[...]} in stdout.
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.isError) {
        const detail = parsed.content?.[0]?.text ?? "(no detail)";
        return errorResponse("binary_failed", `codebase-memory-mcp ${tool}: ${detail}`);
      }
    } catch {
      return errorResponse("binary_failed", `codebase-memory-mcp ${tool}: unexpected non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`);
    }
    return ok(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("binary_failed", `codebase-memory-mcp ${tool} failed: ${msg}`);
  }
}

// 5D: formatNodes emits colon form via denormalize
function formatNodes(nodes: CbmNode[]): string {
  if (nodes.length === 0) return "";
  return nodes
    .map((n) => `${n.label} ${denormalize(n.qualified_name, n.file_path)} (${n.file_path}:${n.start_line}-${n.end_line})`)
    .join("\n");
}

export function registerCodeTools(server: McpServer, store: GraphStore, cbmProject: string | null): void {
  // --- Subprocess tools (3) --- 5C: use repo_path internally, keep public arg as `path`

  server.tool(
    "index_repository",
    "Index a repository into the knowledge graph",
    { path: z.string().optional().describe("Repository path (default: current directory)") },
    async ({ path }) => callCbm("index_repository", { repo_path: path || process.cwd() })
  );

  server.tool(
    "detect_changes",
    "Map git diff to affected symbols in the knowledge graph",
    { path: z.string().optional().describe("Repository path") },
    async ({ path }) => callCbm("detect_changes", { repo_path: path || process.cwd() })
  );

  server.tool(
    "delete_project",
    "Remove a project from the code index",
    { project: z.string().describe("Project name to delete") },
    async ({ project }) => callCbm("delete_project", { project })
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
      if (!store.isCbmAttached() || !cbmProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const qn = params.qn_pattern ? normalize(params.qn_pattern, cbmProject) : undefined;
      const results = searchGraph(store, cbmProject, { ...params, qn_pattern: qn });
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
      if (!store.isCbmAttached() || !cbmProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const results = tracePath(store, cbmProject, params);
      if (results.length === 0) return empty(`trace_path(${JSON.stringify(params)})`);
      const lines = results.map((r) =>
        `[d=${r.depth}] ${r.node.label} ${denormalize(r.node.qualified_name, r.node.file_path)} (${r.node.file_path}:${r.node.start_line}-${r.node.end_line})`
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
      if (!store.isCbmAttached() || !cbmProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const qn = normalize(qualified_name, cbmProject);
      const nodes = searchGraph(store, cbmProject, { qn_pattern: qn });
      if (nodes.length === 0) return empty(`get_code_snippet(${qualified_name})`);
      const node = nodes[0];
      try {
        const content = await readFile(node.file_path, "utf-8");
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
      if (!store.isCbmAttached() || !cbmProject) {
        return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
      }
      const schema = getGraphSchema(store, cbmProject);
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
      if (!store.isCbmAttached()) return errorResponse("internal_error", "No CBM database attached.");
      const projects = listProjects(store);
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
      if (!store.isCbmAttached()) return errorResponse("internal_error", "No CBM database attached.");
      const cwd = path || process.cwd();
      const status = indexStatus(store, cwd);
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
        ], { timeout: 10_000 });
        grepOutput = stdout;
      } catch (err: any) {
        if (err.code === "ENOENT") {
          try {
            const { stdout } = await execFileAsync("grep", ["-rn", pattern, "."], { timeout: 10_000 });
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

      if (!store.isCbmAttached() || !cbmProject) {
        return ok(grepOutput);
      }

      const lines = grepOutput.trim().split("\n").slice(0, 50);
      const enriched = lines.map((line) => {
        const match = line.match(/^\.\/(.+?):(\d+):/);
        if (!match) return line;
        const [, filePath, lineNum] = match;
        const lineNumber = parseInt(lineNum, 10);
        const enclosing = store.queryRaw<CbmNode>(
          `SELECT * FROM cbm.nodes
           WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
           ORDER BY (end_line - start_line) ASC LIMIT 1`,
          [cbmProject, filePath, lineNumber, lineNumber]
        );
        if (enclosing.length > 0) {
          return `${line}  // in ${enclosing[0].label} ${denormalize(enclosing[0].qualified_name, enclosing[0].file_path)}`;
        }
        return line;
      });

      return ok(enriched.join("\n"));
    }
  );
}
