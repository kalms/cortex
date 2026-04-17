import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";
import { startWsServer, type WsServerHandle } from "./ws/server.js";
import { EventBus } from "./events/bus.js";
import { EventPersister } from "./events/worker/persister.js";
import { discoverCbmDb } from "./graph/cbm-discovery.js";
import { WorkerSupervisor } from "./events/worker-supervisor.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
const eventsDbPath = process.env.CORTEX_EVENTS_DB_PATH || ".cortex/events.db";
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
      [cwd],
    );
    cbmProject = projects[0]?.name ?? null;
    process.stderr.write(`Cortex: attached CBM database (project: ${cbmProject})\n`);
  }
}

// Main-thread persister for WS backfill reads only.
// The worker owns writes (insert), main only reads (backfill). WAL mode on
// events.db makes concurrent reader + single writer across threads safe.
const mainPersister = new EventPersister(eventsDbPath);

const bus = new EventBus();

let wsHandle: WsServerHandle | null = null;

// Spawn worker via .mjs bootstrap (see src/events/worker-bootstrap.mjs for
// why this isn't just a plain `new Worker('./worker.ts')`).
// The supervisor keeps the worker alive, restarting on crash with exponential
// backoff (1s → 2s → 4s, capped at 30s).
const supervisor = new WorkerSupervisor({
  spawn: () => new Worker(new URL("./events/worker-bootstrap.mjs", import.meta.url)),
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  onSpawn: (w) => {
    w.on("message", (msg) => {
      if (msg.type === "broadcast" && wsHandle) wsHandle.broadcast(msg.bundle);
      else if (msg.type === "error") process.stderr.write(`[worker] ${msg.message}\n`);
    });
    const nodes = store.getAllNodesUnified(cbmProject ?? undefined);
    w.postMessage({
      type: "init",
      events_db_path: eventsDbPath,
      project_id: cbmProject ?? "",
      nodes,
    });
  },
});
await supervisor.start();

// Bus → worker bridge. Every emitted event gets forwarded to the worker,
// which persists it and derives graph mutations for the WS broadcast.
bus.onEvent((event) => {
  supervisor.current()?.postMessage({ type: "event", event });
});

const server = createServer(store, cbmProject, bus);

const { port, httpServer } = await startViewerServer(store, cbmProject);
if (port > 0 && httpServer) {
  wsHandle = startWsServer({
    httpServer,
    persister: mainPersister,
    projectId: cbmProject ?? "",
    serverVersion: "0.2.0",
  });
  process.stderr.write(`Cortex viewer: http://localhost:${port}/viewer (WS at /ws)\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
