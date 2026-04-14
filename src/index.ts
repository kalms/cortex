import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";
import { discoverCbmDb } from "./graph/cbm-discovery.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);

// Discover and attach CBM database
const cwd = process.cwd();
const cbmDbPath = discoverCbmDb(cwd, undefined, process.env.CBM_DB_PATH);
let cbmProject: string | null = null;

if (cbmDbPath) {
  store.attachCbm(cbmDbPath);
  if (store.isCbmAttached()) {
    const projects = store.queryRaw<{ name: string }>(
      "SELECT name FROM cbm.projects WHERE root_path = ?",
      [cwd]
    );
    cbmProject = projects[0]?.name ?? null;
    process.stderr.write(`Cortex: attached CBM database (project: ${cbmProject})\n`);
  }
}

const server = createServer(store, cbmProject);

const viewerPort = await startViewerServer(store, cbmProject);
process.stderr.write(`Cortex viewer: http://localhost:${viewerPort}/viewer\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
