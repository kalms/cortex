import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CBM_BINARY = process.env.CBM_BINARY_PATH || "codebase-memory-mcp";

async function callCbm(tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(CBM_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      error: `codebase-memory-mcp call failed: ${message}. Set CBM_BINARY_PATH if the binary is not in PATH.`,
    });
  }
}

export function registerCodeTools(server: McpServer): void {
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
    "search_graph",
    "Search the knowledge graph for code entities by name, label, or qualified name pattern",
    {
      name_pattern: z.string().optional(),
      label: z.string().optional(),
      qn_pattern: z.string().optional(),
    },
    async (params) => {
      const result = await callCbm("search_graph", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "trace_path",
    "Trace call chains, data flow, or cross-service paths from a function",
    {
      function_name: z.string(),
      mode: z.string().describe("Trace mode: calls, data_flow, or cross_service"),
    },
    async (params) => {
      const result = await callCbm("trace_path", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "get_code_snippet",
    "Get source code for a fully qualified name",
    {
      qualified_name: z.string(),
    },
    async (params) => {
      const result = await callCbm("get_code_snippet", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "query_graph",
    "Run a Cypher query against the knowledge graph",
    {
      query: z.string(),
    },
    async (params) => {
      const result = await callCbm("query_graph", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "get_architecture",
    "Get architecture overview for specified aspects of the codebase",
    {
      aspects: z.string().describe("Comma-separated aspects to analyze"),
    },
    async (params) => {
      const result = await callCbm("get_architecture", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "search_code",
    "Full-text search across repository source code",
    {
      pattern: z.string(),
    },
    async (params) => {
      const result = await callCbm("search_code", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}
