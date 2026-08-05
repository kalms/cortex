import { describe, expect, test, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHttpHandler } from "../src/mcp-server/mcp-http.js";
import { createServer } from "../src/mcp-server/server.js";
import { startViewerServer } from "../src/mcp-server/api.js";
import { GraphStore } from "../src/graph/store.js";

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

  test("connect() rejection is answered as a 500, not an unhandled rejection", async () => {
    const stub = {
      connect: () => Promise.reject(new Error("boom")),
      close: () => Promise.resolve(),
    } as unknown as McpServer;
    const badHandler = createMcpHttpHandler(() => stub);
    const badHttp = createHttpServer((req, res) => { void badHandler(req, res); });
    await new Promise<void>((r) => badHttp.listen(0, "127.0.0.1", r));
    const badPort = (badHttp.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${badPort}/`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
      });
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body).toEqual({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    } finally {
      await new Promise<void>((r) => badHttp.close(() => r()));
    }
  });
});

describe("/mcp mounted on the viewer server", () => {
  test("viewer server mounts /mcp when a factory is passed, 404 otherwise", async () => {
    const prevPort = process.env.CORTEX_VIEWER_PORT;
    process.env.CORTEX_VIEWER_PORT = "0";
    try {
      const store = new GraphStore(":memory:");
      const withMcp = await startViewerServer(
        store, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        () => createServer(null),
      );
      try {
        const client = new Client({ name: "t", version: "0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${withMcp.port}/mcp`)));
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        await client.close();
      } finally {
        withMcp.close();
      }

      const without = await startViewerServer(store, null);
      try {
        const r = await fetch(`http://127.0.0.1:${without.port}/mcp`, { method: "POST" });
        expect(r.status).toBe(404);
      } finally {
        without.close();
        store.close();
      }
    } finally {
      if (prevPort === undefined) delete process.env.CORTEX_VIEWER_PORT;
      else process.env.CORTEX_VIEWER_PORT = prevPort;
    }
  });

  test("401s POST /mcp without Authorization when CORTEX_API_TOKEN is set", async () => {
    const prevPort = process.env.CORTEX_VIEWER_PORT;
    const prevToken = process.env.CORTEX_API_TOKEN;
    process.env.CORTEX_VIEWER_PORT = "0";
    process.env.CORTEX_API_TOKEN = "test-token";
    const store = new GraphStore(":memory:");
    try {
      const handle = await startViewerServer(
        store, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        () => createServer(null),
      );
      try {
        const r = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: "POST" });
        expect(r.status).toBe(401);
      } finally {
        handle.close();
      }
    } finally {
      store.close();
      if (prevPort === undefined) delete process.env.CORTEX_VIEWER_PORT; else process.env.CORTEX_VIEWER_PORT = prevPort;
      if (prevToken === undefined) delete process.env.CORTEX_API_TOKEN; else process.env.CORTEX_API_TOKEN = prevToken;
    }
  });
});
