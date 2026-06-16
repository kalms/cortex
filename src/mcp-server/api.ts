import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { GraphStore } from "../graph/store.js";
import { listProjects, listProjectsUnified, openProjectStore } from "../graph/code-queries.js";
import { Registry } from "../db/registry.js";
import { migrateCacheToRegistry, importLegacyRegistry } from "../db/registry-migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { openDecisionsDb } from "../decisions/db.js";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { buildAdaptedDecision, buildAdaptedDecisions, type FrameInfo } from "./api-decisions.js";
import { buildFileEdges } from "./api-edges.js";
import { buildFrameMap } from "./frame-map.js";
import { STAGE_W, STAGE_H } from "./frame-layout.js";
import { positionAggregates } from "./aggregate-positioning.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const VIEWER_DIR = join(PROJECT_ROOT, "src", "viewer");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

/**
 * Handle returned by {@link startViewerServer}.
 *
 * The caller needs the raw `HttpServer` so it can attach additional listeners
 * (notably the WebSocket server's `upgrade` handler). `port` is `-1` and
 * `httpServer` is `null` when the requested port was unavailable.
 */
export interface ViewerServerHandle {
  port: number;
  httpServer: HttpServer | null;
  /**
   * Release server-held resources (HTTP listener + the master Registry handle).
   * Intended for programmatic/embedded callers and tests. The long-running MCP
   * entrypoint (src/index.ts) does NOT call this — like its sibling resources
   * (graph store, decisions DB, resolver pool) the registry handle is
   * process-lifetime and reclaimed by the OS / better-sqlite3 atexit on exit.
   */
  close(): void;
}

/** Outcome of a single bind attempt. */
export type BindOutcome = { ok: true } | { ok: false; error: NodeJS.ErrnoException };

/** A decisions repo pair resolved for one viewer request, plus a `close` the
 *  caller MUST invoke (a no-op for the server-bound home repo). */
export interface ProjectDecisions {
  decisions: DecisionsRepository;
  links: DecisionLinksRepository;
  owned: boolean;
  close(): void;
}

const NOOP_CLOSE = () => {};

/**
 * Resolve the decisions repos for a viewer request's `project`, mirroring
 * {@link openProjectStore}.
 *
 * The server-bound (home) repos are returned for the bound project or a project
 * unknown to the registry; any OTHER registered project has its own durable
 * decisions DB (`~/.cortex/<repo-id>/decisions.db`, the same path the write
 * path resolves) opened, and the caller MUST `close()` it (`owned: true`).
 *
 * Without this, `/api/decisions` served the startup-bound home repo's decisions
 * for every project — the project switcher changed the graph but never the
 * decisions, so e.g. cortex-indexer's decisions were invisible in the viewer.
 */
export function openProjectDecisions(
  boundDecisions: DecisionsRepository,
  boundLinks: DecisionLinksRepository,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
  registry: { findByName(name: string): { root_path: string } | null },
): ProjectDecisions {
  if (!requestedProject || requestedProject === boundProject) {
    return { decisions: boundDecisions, links: boundLinks, owned: false, close: NOOP_CLOSE };
  }
  const rootPath = registry.findByName(requestedProject)?.root_path ?? null;
  if (!rootPath) {
    // Unknown to the registry — best-effort fall back to the bound repo rather
    // than fabricate an empty store. Registered projects (the switcher only
    // lists those) always resolve above.
    return { decisions: boundDecisions, links: boundLinks, owned: false, close: NOOP_CLOSE };
  }
  const db = openDecisionsDb(resolveDecisionsDbPath(rootPath), legacyDecisionsDbPath(rootPath));
  return {
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
    owned: true,
    close: () => db.close(),
  };
}

/** Default retry policy for the viewer port. Tuned for the common failure we
 *  hit in practice: a stale/dying sibling instance still holding the port for
 *  a moment after a VS Code reload. ~5 tries over a couple of seconds gives the
 *  old listener time to release the socket without floating the URL. */
export const VIEWER_BIND_RETRIES = 5;
export const VIEWER_BIND_DELAY_MS = 300;

/**
 * Attempt to bind a (fixed) port with bounded retry on contention.
 *
 * Why this exists: the viewer used to swallow `httpServer.listen` errors
 * silently (resolve port -1, no log), so a failed bind left zero trace and the
 * MCP server ran viewer-less with no signal. This loop surfaces every attempt
 * via `log` and self-heals across the EADDRINUSE window without changing the
 * port (a floating port would defeat a "consistent viewer" URL).
 *
 * Retries ONLY on `EADDRINUSE` (transient contention). Any other error
 * (EACCES, etc.) is logged and fails fast — retrying wouldn't help.
 *
 * @returns true if a bind succeeded, false if it gave up.
 */
export async function bindWithRetry(
  attempt: () => Promise<BindOutcome>,
  opts: {
    port: number;
    retries: number;
    delayMs: number;
    log: (msg: string) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i <= opts.retries; i++) {
    const outcome = await attempt();
    if (outcome.ok) return true;
    const err = outcome.error;
    if (err.code !== "EADDRINUSE") {
      opts.log(`Cortex viewer: FAILED to bind port ${opts.port}: ${err.message}`);
      return false;
    }
    if (i < opts.retries) {
      opts.log(`Cortex viewer: port ${opts.port} busy (EADDRINUSE), retrying ${i + 1}/${opts.retries}...`);
      await sleep(opts.delayMs * (i + 1)); // linear backoff
    } else {
      opts.log(
        `Cortex viewer: FAILED to bind port ${opts.port}: ${err.message} (gave up after ${opts.retries} retries)`,
      );
    }
  }
  return false;
}

export function startViewerServer(
  store: GraphStore,
  indexerProject?: string | null,
  decisionsRepo?: DecisionsRepository,
  decisionLinksRepo?: DecisionLinksRepository,
): Promise<ViewerServerHandle> {
  return new Promise((resolve) => {
    // Master registry, opened once for the server's lifetime. Seed it on first
    // run (idempotent, best-effort): carry over the pre-XDG registry, then any
    // legacy cache <slug>.db. A partial failure here recovers on next startup.
    const registry = new Registry();
    try { importLegacyRegistry(registry); } catch { /* best-effort */ }
    try { migrateCacheToRegistry(registry); } catch { /* best-effort; idempotent */ }

    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url.startsWith("/api/graph")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ nodes: [], edges: [], project: project ?? null }));
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const rawEdges = resolved.store.getAllEdgesUnified(project ?? undefined);
          const edges = rawEdges.map((e) => ({
            ...e,
            source: e.source_id,
            target: e.target_id,
          }));
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ nodes, edges, project: project ?? null }));
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

      if (url === "/api/projects") {
        // Union of bound store (Cortex-Vue's local .cortex/db) + indexer cache.
        // Previously only the bound store was queried, so cache-resident
        // projects (everything indexed via the cortex CLI from elsewhere)
        // were invisible to the viewer's project switcher.
        let projects: ReturnType<typeof listProjects> = [];
        try {
          projects = listProjectsUnified(store);
        } catch {
          // No ctx_projects table yet — return empty.
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({
          projects,
          active: indexerProject ?? null,
        }));
        return;
      }

      if (url.startsWith("/api/decisions/")) {
        if (!decisionsRepo || !decisionLinksRepo) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "decisions repos unavailable" }));
          return;
        }
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const id = decodeURIComponent(parsed.pathname.slice("/api/decisions/".length));
        // Project-scoped, same as the list endpoint: a decision id only exists
        // in its own project's store.
        const pd = openProjectDecisions(decisionsRepo, decisionLinksRepo, indexerProject, project, registry);
        try {
          const rec = pd.decisions.get(id);
          if (!rec) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "decision not found" }));
            return;
          }
          const links = pd.links.findByDecision(id);
          const resolved = openProjectStore(store, indexerProject, project, { registry });
          const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
          try {
            const { nodesByPath, framesByPath } = buildPathIndices(nodes);
            const adapted = buildAdaptedDecision(rec, links, nodesByPath, framesByPath);
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify(adapted));
          } finally {
            if (resolved?.owned) resolved.store.close();
          }
        } finally {
          pd.close();
        }
        return;
      }

      if (url.startsWith("/api/decisions")) {
        if (!decisionsRepo || !decisionLinksRepo) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "decisions repos unavailable" }));
          return;
        }
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        // Decisions are project-scoped: open the requested project's own store,
        // not the server-bound home repo's.
        const pd = openProjectDecisions(decisionsRepo, decisionLinksRepo, indexerProject, project, registry);
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
        try {
          const records = pd.decisions.list();
          const allLinks = records.flatMap((r) => pd.links.findByDecision(r.id));
          const { nodesByPath, framesByPath } = buildPathIndices(nodes);
          const decisions = buildAdaptedDecisions(records, allLinks, nodesByPath, framesByPath);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ decisions }));
        } finally {
          if (resolved?.owned) resolved.store.close();
          pd.close();
        }
        return;
      }

      if (url.startsWith("/api/aggregates")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
        try {
          const edges = resolved ? resolved.store.getAllEdgesUnified(project ?? undefined) : [];
          const frameMap = buildFrameMap(nodes, edges);
          const aggregates = positionAggregates(nodes, edges, frameMap);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ aggregates }));
        } finally {
          if (resolved?.owned) resolved.store.close();
        }
        return;
      }

      if (url.startsWith("/api/frames")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ frames: [], stage: { w: STAGE_W, h: STAGE_H } }));
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
          const map = buildFrameMap(nodes, edges);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(map));
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

      if (url.startsWith("/api/file-edges")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ file_edges: [] }));
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
          // Draw the same connectivity the force layout rolls up — CALLS +
          // USAGE + IMPORTS — not CALLS alone. USAGE (symbol references) is the
          // densest relation in a real graph; omitting it left the map looking
          // nearly edgeless. Weights from all three combine per file-pair.
          const file_edges = buildFileEdges(nodes, edges, {
            relations: ["CALLS", "USAGE", "IMPORTS"],
          });
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ file_edges }));
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

      if (url === "/" || url.startsWith("/viewer")) {
        // Map URL → disk file under VIEWER_DIR.
        // /            → index.html
        // /viewer      → index.html
        // /viewer/     → index.html
        // /viewer/<p>  → <p>  (e.g., /viewer/viewer.js, /viewer/style.css)
        let rel: string;
        if (url === "/" || url === "/viewer" || url === "/viewer/") {
          rel = "index.html";
        } else {
          rel = url.replace(/^\/viewer\//, "");
        }
        const filePath = join(VIEWER_DIR, rel);

        try {
          const content = await readFile(filePath);
          const ext = extname(filePath);
          res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }

      res.writeHead(302, { Location: "/viewer" });
      res.end();
    });

    const port = parseInt(process.env.CORTEX_VIEWER_PORT || "3333", 10);
    const log = (msg: string) => process.stderr.write(msg + "\n");

    // One bind attempt over the shared httpServer. listen() is retryable after
    // an 'error' (the server isn't closed by a failed bind), so each attempt
    // wires fresh one-shot listeners and re-issues listen(port).
    const attempt = (): Promise<BindOutcome> =>
      new Promise((res) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.removeListener("listening", onListening);
          res({ ok: false, error: err });
        };
        const onListening = () => {
          httpServer.removeListener("error", onError);
          res({ ok: true });
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port);
      });

    void bindWithRetry(attempt, { port, retries: VIEWER_BIND_RETRIES, delayMs: VIEWER_BIND_DELAY_MS, log })
      .then((ok) => {
        if (ok) {
          resolve({
            port,
            httpServer,
            close() {
              httpServer.close();
              registry.close();
            },
          });
        } else {
          // bindWithRetry has already logged WHY. Caller (src/index.ts) logs the
          // user-facing "viewer disabled" line off the port: -1 sentinel.
          resolve({
            port: -1,
            httpServer: null,
            close() {
              registry.close();
            },
          });
        }
      });
  });
}

function buildPathIndices(nodes: ReturnType<GraphStore["getAllNodesUnified"]>): {
  nodesByPath: Map<string, ReturnType<GraphStore["getAllNodesUnified"]>[number]>;
  framesByPath: Map<string, FrameInfo>;
} {
  const nodesByPath = new Map<string, ReturnType<GraphStore["getAllNodesUnified"]>[number]>();
  const framesByPath = new Map<string, FrameInfo>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    nodesByPath.set(n.file_path, n);
    if (!n.data) continue;
    try {
      const data = JSON.parse(n.data) as { frame_id?: number; frame_label?: string };
      if (typeof data.frame_id === "number" && typeof data.frame_label === "string") {
        framesByPath.set(n.file_path, { frame_id: data.frame_id, frame_label: data.frame_label });
      }
    } catch {
      /* ignore parse failures */
    }
  }
  return { nodesByPath, framesByPath };
}
