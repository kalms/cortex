import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);
const server = createServer(store);

const transport = new StdioServerTransport();
await server.connect(transport);
