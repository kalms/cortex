import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { GraphStore, type NodeRow } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";
import { startWsServer, type WsServerHandle } from "./ws/server.js";
import { EventBus } from "./events/bus.js";
import { EventPersister } from "./events/worker/persister.js";
import { WorkerSupervisor } from "./events/worker-supervisor.js";
import { resolveCortexDbPath } from "./db/resolve-path.js";
import type { WireNode } from "./events/types.js";

const dbPath = resolveCortexDbPath();
const eventsDbPath = process.env.CORTEX_EVENTS_DB_PATH || ".cortex/events.db";

// Ensure <repo>/.cortex/ exists and seed a .gitignore so SQLite artifacts
// (db, db-wal, db-shm) and the future local/ dir don't leak into the repo's
// git history when Cortex indexes a foreign repo.
const cortexDir = dirname(dbPath);
mkdirSync(cortexDir, { recursive: true });
const gitignorePath = join(cortexDir, ".gitignore");
if (!existsSync(gitignorePath)) {
  try {
    writeFileSync(gitignorePath, "db\ndb-wal\ndb-shm\nlocal/\n");
  } catch (e) {
    process.stderr.write(`Cortex: could not seed ${gitignorePath} (${(e as Error).message})\n`);
  }
}

const store = new GraphStore(dbPath);

const cwd = process.cwd();
let cbmProject: string | null = null;

// Resolve the indexed project for this repo. The indexer (bin/cortex-indexer)
// writes to the same cortex.db file when CORTEX_DB env var is set; once it has
// run at least once for this repo, ctx_projects has a row keyed by absolute
// repo path. Until then, cbmProject is null and code-tools surface a clear
// "not indexed" error.
try {
  const row = store
    .queryRaw<{ name: string }>(
      "SELECT name FROM ctx_projects WHERE root_path = ? LIMIT 1",
      [cwd],
    )[0];
  if (row) {
    cbmProject = row.name;
    process.stderr.write(`Cortex: indexed project '${cbmProject}' (root: ${cwd})\n`);
  } else {
    process.stderr.write(`Cortex: no indexed project for ${cwd} — run index_repository\n`);
  }
} catch (e) {
  // ctx_projects table doesn't exist yet — first run, indexer hasn't created it.
  // That's fine: index_repository will create it on first call.
  if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
  process.stderr.write(`Cortex: no indexer state in cortex.db — run index_repository\n`);
}

// Main-thread persister for WS backfill reads only.
// The worker owns writes (insert), main only reads (backfill). WAL mode on
// events.db makes concurrent reader + single writer across threads safe.
const mainPersister = new EventPersister(eventsDbPath);

const bus = new EventBus();

let wsHandle: WsServerHandle | null = null;

/**
 * Project NodeRow (SQLite shape with stringified `data`) into the WireNode
 * shape the worker and wire protocol expect. Lifts `status` out of `data`
 * so consumers (mutation deriver, viewer) can read it at top level.
 */
function toWireNodes(rows: NodeRow[]): WireNode[] {
  return rows.map((n) => {
    let parsed: Record<string, unknown> = {};
    if (n.data) {
      try {
        parsed = JSON.parse(n.data) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      data: parsed,
    };
  });
}

/**
 * Build a map: repo-relative file path → decision ids governing that path.
 * The GitWatcher uses this to populate `decision_links` on each commit event.
 * Built from GOVERNS edges; target node's `file_path` (preferred) or `name`
 * is used as the key.
 */
function buildGovernedFilesMap(s: GraphStore): Map<string, string[]> {
  const edges = s.queryRaw<{ source_id: string; target_id: string }>(
    "SELECT source_id, target_id FROM edges WHERE relation = 'GOVERNS'",
  );
  const nodesById = new Map(s.getAllNodesUnified().map((n) => [n.id, n]));
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const targetNode = nodesById.get(e.target_id);
    if (!targetNode) continue;
    const path = targetNode.file_path ?? targetNode.name;
    if (!path) continue;
    const list = map.get(path) ?? [];
    list.push(e.source_id);
    map.set(path, list);
  }
  return map;
}

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
    const wireNodes = toWireNodes(store.getAllNodesUnified(cbmProject ?? undefined));
    const governedFilesMap = buildGovernedFilesMap(store);
    w.postMessage({
      type: "init",
      events_db_path: eventsDbPath,
      project_id: cbmProject ?? "",
      nodes: wireNodes,
      repo_path: cwd,
      governed_files: Object.fromEntries(governedFilesMap),
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
