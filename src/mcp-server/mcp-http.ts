// Stateless streamable-HTTP mount for the MCP server (mesh injection spec,
// 2026-08-04). One fresh McpServer + transport per POST: the consolidated
// tool surface is repo_path-parameterized per call, so requests carry no
// session state, and per-request servers keep concurrent clients (every Mesh
// thread's claude is one) fully isolated. GET/DELETE (SSE notification
// channels of the stateful profile) are deliberately 405.
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createMcpHttpHandler(
  factory: () => McpServer,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
      return;
    }
    const server = factory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
      void transport.close();
      void server.close();
    }
  };
}
