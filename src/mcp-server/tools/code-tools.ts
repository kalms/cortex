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

const execFileAsync = promisify(execFile);
const CBM_BINARY = process.env.CBM_BINARY_PATH || "codebase-memory-mcp";

async function callCbm(tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(CBM_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      error: `codebase-memory-mcp call failed: ${message}. Set CBM_BINARY_PATH if the binary is not in PATH.`,
    });
  }
}

function formatNodes(nodes: CbmNode[]): string {
  if (nodes.length === 0) return "No results found.";
  return nodes
    .map((n) => `${n.label} ${n.qualified_name} (${n.file_path}:${n.start_line}-${n.end_line})`)
    .join("\n");
}

export function registerCodeTools(server: McpServer, store: GraphStore, cbmProject: string | null): void {
  // --- Subprocess tools (3) ---

  server.tool(
    "index_repository",
    "Index a repository into the knowledge graph",
    {
      path: z.string().optional().describe("Repository path (default: current directory)"),
    },
    async ({ path }) => {
      const result = await callCbm("index_repository", path ? { path } : {});
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "detect_changes",
    "Map git diff to affected symbols in the knowledge graph",
    {
      path: z.string().optional().describe("Repository path"),
    },
    async ({ path }) => {
      const result = await callCbm("detect_changes", path ? { path } : {});
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "delete_project",
    "Remove a project from the code index",
    {
      project: z.string().describe("Project name to delete"),
    },
    async ({ project }) => {
      const result = await callCbm("delete_project", { project });
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // --- SQL-based tools (6) ---

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
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const results = searchGraph(store, cbmProject, params);
      return { content: [{ type: "text" as const, text: formatNodes(results) }] };
    }
  );

  server.tool(
    "trace_path",
    "Trace call chains from a function (mode: calls, callers)",
    {
      function_name: z.string(),
      mode: z.string().describe("Trace mode: calls (outbound) or callers (inbound)"),
    },
    async (params) => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const results = tracePath(store, cbmProject, params);
      return { content: [{ type: "text" as const, text: formatNodes(results) }] };
    }
  );

  server.tool(
    "get_code_snippet",
    "Get source code for a fully qualified name",
    {
      qualified_name: z.string(),
    },
    async ({ qualified_name }) => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const nodes = searchGraph(store, cbmProject, { qn_pattern: qualified_name });
      if (nodes.length === 0) {
        return { content: [{ type: "text" as const, text: `No code entity found for: ${qualified_name}` }] };
      }
      const node = nodes[0];
      try {
        const content = await readFile(node.file_path, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, node.start_line - 1);
        const end = Math.min(lines.length, node.end_line);
        const snippet = lines.slice(start, end).join("\n");
        return {
          content: [{
            type: "text" as const,
            text: `// ${node.qualified_name} (${node.file_path}:${node.start_line}-${node.end_line})\n${snippet}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error reading file: ${msg}` }] };
      }
    }
  );

  server.tool(
    "get_graph_schema",
    "List node labels, edge types, and their counts in the knowledge graph",
    {},
    async () => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const schema = getGraphSchema(store, cbmProject);
      return {
        content: [{
          type: "text" as const,
          text: `Labels: ${schema.labels.join(", ")}\nEdge types: ${schema.edgeTypes.join(", ")}`,
        }],
      };
    }
  );

  server.tool(
    "list_projects",
    "List all indexed projects",
    {},
    async () => {
      if (!store.isCbmAttached()) {
        return { content: [{ type: "text" as const, text: "No CBM database attached." }] };
      }
      const projects = listProjects(store);
      if (projects.length === 0) {
        return { content: [{ type: "text" as const, text: "No projects indexed." }] };
      }
      const text = projects
        .map((p) => `${p.name} — ${p.root_path} (indexed: ${p.indexed_at})`)
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "index_status",
    "Check if a repository is indexed",
    {
      path: z.string().optional().describe("Repository path to check (default: current directory)"),
    },
    async ({ path }) => {
      if (!store.isCbmAttached()) {
        return { content: [{ type: "text" as const, text: "No CBM database attached." }] };
      }
      const cwd = path || process.cwd();
      const status = indexStatus(store, cwd);
      if (!status) {
        return { content: [{ type: "text" as const, text: `Not indexed: ${cwd}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Indexed: ${status.name} at ${status.root_path} (last: ${status.indexed_at})`,
        }],
      };
    }
  );

  server.tool(
    "search_code",
    "Search source code with graph-enriched results (shows which function/class each match belongs to)",
    {
      pattern: z.string(),
    },
    async ({ pattern }) => {
      let grepOutput: string;
      try {
        const { stdout } = await execFileAsync("rg", [
          "--no-heading", "--line-number", "--color=never", pattern, ".",
        ], { timeout: 10_000 });
        grepOutput = stdout;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          try {
            const { stdout } = await execFileAsync("grep", [
              "-rn", pattern, ".",
            ], { timeout: 10_000 });
            grepOutput = stdout;
          } catch {
            return { content: [{ type: "text" as const, text: "No matches found." }] };
          }
        } else if (error.stdout) {
          grepOutput = error.stdout;
        } else {
          return { content: [{ type: "text" as const, text: "No matches found." }] };
        }
      }

      if (!grepOutput.trim()) {
        return { content: [{ type: "text" as const, text: "No matches found." }] };
      }

      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: grepOutput }] };
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
          return `${line}  // in ${enclosing[0].label} ${enclosing[0].qualified_name}`;
        }
        return line;
      });

      return { content: [{ type: "text" as const, text: enriched.join("\n") }] };
    }
  );
}
