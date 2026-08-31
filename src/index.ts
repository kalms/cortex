import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { GraphStore, type NodeRow } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer, buildPathIndices } from "./mcp-server/api.js";
import { createGracefulShutdown } from "./mcp-server/shutdown.js";
import { startWsServer, type WsServerHandle } from "./ws/server.js";
import { deriveProjectionDeltas, type ProjectionSources } from "./mcp-server/projection-deriver.js";
import { EventBus } from "./events/bus.js";
import { EventPersister } from "./events/worker/persister.js";
import { WorkerSupervisor } from "./events/worker-supervisor.js";
import { resolveCortexDbPath, resolveDecisionsDbPath, legacyDecisionsDbPath } from "./db/resolve-path.js";
import { openDecisionsDb } from "./decisions/db.js";
import { DecisionsRepository } from "./decisions/repository.js";
import { DecisionLinksRepository } from "./decisions/links-repository.js";
import { TodosRepository } from "./todos/repository.js";
import { TodoLinksRepository } from "./todos/links-repository.js";
import { StoriesRepository, StoryStepsRepository } from "./stories/repository.js";
import type { WireNode } from "./events/types.js";
import { newUlid } from "./events/ulid.js";
import { presenceActivityEvent, showFocusEvent, showAdvanceEvent } from "./events/show-events.js";
import { resolveBoundProject } from "./mcp-server/bound-project.js";

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

// Resolve the indexed project for this checkout. The indexer (bin/cortex-indexer)
// writes to the same cortex.db file when CORTEX_DB env var is set; once it has
// run at least once for this checkout, ctx_projects has a row keyed by absolute
// checkout path. Until then, indexerProject is null and code-tools surface a clear
// "not indexed" error.
//
// The lookup key rides the CHECKOUT axis — the same axis `dbPath` above is
// derived on. Keying it on the identity axis instead would query a linked
// worktree's own store with the MAIN checkout's path, which never matches
// ("(no projects)" dropdown, null /api/projects.active, empty
// hello.project_id) — the mirror image of the mismatch T-a1kg fixed.
const bound = resolveBoundProject(store, cwd);
const indexerProject: string | null = bound.project;
if (bound.project) {
  process.stderr.write(`Cortex: indexed project '${bound.project}' (root: ${bound.root})\n`);
} else if (bound.noIndexerState) {
  process.stderr.write(`Cortex: no indexer state in cortex.db — run index_repository\n`);
} else {
  process.stderr.write(`Cortex: no indexed project for ${bound.root} — run index_repository\n`);
}

// Main-thread persister for WS backfill reads only.
// The worker owns writes (insert), main only reads (backfill). WAL mode on
// events.db makes concurrent reader + single writer across threads safe.
const mainPersister = new EventPersister(eventsDbPath);

const bus = new EventBus();

let wsHandle: WsServerHandle | null = null;
let projectionSources: ProjectionSources | null = null;

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
      if (msg.type === "broadcast" && wsHandle) {
        wsHandle.broadcast(msg.bundle);
        if (projectionSources) {
          try {
            const deltas = deriveProjectionDeltas(msg.bundle.events, projectionSources);
            if (deltas.length) wsHandle.broadcastProjections(deltas);
          } catch (err) {
            process.stderr.write(`[projection] derive failed: ${(err as Error).message}\n`);
            // Skip the projection broadcast — the event/mutation broadcast already happened above.
          }
        }
      } else if (msg.type === "error") process.stderr.write(`[worker] ${msg.message}\n`);
    });
    const wireNodes = toWireNodes(store.getAllNodesUnified(indexerProject ?? undefined));
    const governedFilesMap = buildGovernedFilesMap(store);
    w.postMessage({
      type: "init",
      events_db_path: eventsDbPath,
      project_id: indexerProject ?? "",
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

const server = createServer(indexerProject, bus);

const decisionsDbPath = resolveDecisionsDbPath(cwd);
const decisionsDb = openDecisionsDb(decisionsDbPath, legacyDecisionsDbPath(cwd));
// Note: unlike repo-context.ts, this path intentionally does NOT run
// migrateDecisionsFromGraphDb — that legacy graph→sidecar import is driven
// per-repo by the context resolver. The primitives migration runner (wired
// inside openDecisionsDb) handles id-short-form and any future migrations.
const decisionsRepo = new DecisionsRepository(decisionsDb);
const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);
const todosRepo = new TodosRepository(decisionsDb);
const todoLinksRepo = new TodoLinksRepository(decisionsDb);
const storiesRepo = new StoriesRepository(decisionsDb);
const storyStepsRepo = new StoryStepsRepository(decisionsDb);

// Projection sources for the read-path sync engine. pathIndices() re-reads the
// graph store per derive batch — events are low-rate (tool calls, commits), so
// freshness beats caching here; a reindex mid-session is picked up for free.
projectionSources = {
  decisions: decisionsRepo,
  decisionLinks: decisionLinksRepo,
  todos: todosRepo,
  todoLinks: todoLinksRepo,
  pathIndices: () => buildPathIndices(store.getAllNodesUnified(indexerProject ?? undefined)),
};

const { port, httpServer } = await startViewerServer(
  store,
  indexerProject,
  decisionsRepo,
  decisionLinksRepo,
  todosRepo,
  todoLinksRepo,
  storiesRepo,
  storyStepsRepo,
  {
    emit: (p, t) => bus.emit(presenceActivityEvent(p, t, newUlid(), Date.now())),
    emitFocus: (p, t) => bus.emit(showFocusEvent(p, t, newUlid(), Date.now())),
    emitAdvance: (p, t) => bus.emit(showAdvanceEvent(p, t, newUlid(), Date.now())),
  },
  () => createServer(indexerProject, bus),
);
if (port > 0 && httpServer) {
  wsHandle = startWsServer({
    httpServer,
    persister: mainPersister,
    projectId: indexerProject ?? "",
    serverVersion: "0.2.0",
    deriveProjections: (events) => {
      if (!projectionSources) return [];
      try {
        return deriveProjectionDeltas(events, projectionSources);
      } catch (err) {
        process.stderr.write(`[projection] derive failed during catchup: ${(err as Error).message}\n`);
        // Degrade to an empty replay — the client sets its cursor to head and
        // re-converges on the next change or reconnect. Never crash the process.
        return [];
      }
    },
  });
  process.stderr.write(`Cortex viewer: http://localhost:${port}/viewer (WS at /ws)\n`);
} else {
  // startViewerServer has already logged the specific bind failure. Surface a
  // clear user-facing line so a viewer-less server is never silent.
  process.stderr.write(
    `Cortex viewer: disabled (port bind failed); MCP server continues over stdio. ` +
      `Free the port (CORTEX_VIEWER_PORT, default 3333) and restart to enable the viewer.\n`,
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Bind this process's lifetime to the stdio pipe. A stdio MCP server has no
// "done" signal of its own, and the viewer HTTP/WS servers + worker thread keep
// the event loop alive forever. When the parent (Claude Code / VSCode) goes
// away — window closed, session ended — we must exit, otherwise we linger as an
// orphan still holding CORTEX_VIEWER_PORT (default 3333). Accumulated orphans
// are the root cause of ERR_CONNECTION_REFUSED on the viewer after a VSCode
// restart: the next session races a port-squatting zombie and gives up.
//
// Closing the DBs/worker before exit is best-effort cleanliness (flush SQLite
// WAL); process exit itself is what frees the port.
const shutdown = createGracefulShutdown({
  log: (msg) => process.stderr.write(msg + "\n"),
  exit: (code) => process.exit(code),
  // The freed-port guarantee must not hinge on every resource closing cleanly:
  // if a close() stalls, force the exit so we never re-orphan on the port.
  forceExitAfterMs: 3000,
  closables: [
    // Free the port first: stop accepting viewer/WS connections promptly.
    ...(httpServer ? [{ name: "viewer-http", close: () => httpServer.close() }] : []),
    { name: "worker-supervisor", close: () => supervisor.stop() },
    { name: "events-persister", close: () => mainPersister.close() },
    { name: "decisions-db", close: () => decisionsDb.close() },
    { name: "graph-store", close: () => store.close() },
  ],
});

// stdin EOF = parent closed the pipe (the canonical "parent is gone" signal for
// a stdio server). SIGTERM/SIGINT cover orderly termination by a supervisor.
process.stdin.on("end", () => void shutdown("stdin-close"));
process.stdin.on("close", () => void shutdown("stdin-close"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
