import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);
const server = createServer(store);

const viewerPort = await startViewerServer(store);
process.stderr.write(`Cortex viewer: http://localhost:${viewerPort}/viewer\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
