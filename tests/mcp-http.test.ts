import { describe, expect, test, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpHandler } from "../src/mcp-server/mcp-http.js";
import { createServer } from "../src/mcp-server/server.js";

const handler = createMcpHttpHandler(() => createServer(null));
const http = createHttpServer((req, res) => { void handler(req, res); });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const port = (http.address() as { port: number }).port;
afterAll(() => new Promise<void>((r) => http.close(() => r())));

describe("streamable-HTTP /mcp", () => {
  test("serves the full tool surface and answers a call", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`)));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const t of ["search_graph", "get_code_snippet", "decision", "list_projects"]) {
      expect(names).toContain(t);
    }
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    expect(res.content).toBeDefined();
    await client.close();
  });

  test("non-POST is 405", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
    expect(r.status).toBe(405);
  });
});
