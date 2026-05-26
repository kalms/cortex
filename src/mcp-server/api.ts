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
import { listProjects, listProjectsUnified } from "../graph/code-queries.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { buildAdaptedDecision, buildAdaptedDecisions, type FrameInfo } from "./api-decisions.js";
import { buildFileEdges } from "./api-edges.js";
import { groupAuxiliaryPaths } from "../frame-extraction/auxiliary-detection.js";

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
}

export function startViewerServer(
  store: GraphStore,
  indexerProject?: string | null,
  decisionsRepo?: DecisionsRepository,
  decisionLinksRepo?: DecisionLinksRepository,
): Promise<ViewerServerHandle> {
  return new Promise((resolve) => {
    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url.startsWith("/api/graph")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const nodes = store.getAllNodesUnified(project ?? undefined);
        const rawEdges = store.getAllEdgesUnified(project ?? undefined);
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
        const pathname = new NodeURL(url, "http://localhost").pathname;
        const id = decodeURIComponent(pathname.slice("/api/decisions/".length));
        const rec = decisionsRepo.get(id);
        if (!rec) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "decision not found" }));
          return;
        }
        const links = decisionLinksRepo.findByDecision(id);
        const { nodesByPath, framesByPath } = buildPathIndices(
          store.getAllNodesUnified(indexerProject ?? undefined),
        );
        const adapted = buildAdaptedDecision(rec, links, nodesByPath, framesByPath);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(adapted));
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
        const records = decisionsRepo.list();
        const allLinks = records.flatMap((r) => decisionLinksRepo.findByDecision(r.id));
        const { nodesByPath, framesByPath } = buildPathIndices(
          store.getAllNodesUnified(project ?? undefined),
        );
        const decisions = buildAdaptedDecisions(records, allLinks, nodesByPath, framesByPath);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ decisions }));
        return;
      }

      if (url.startsWith("/api/aggregates")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const nodes = store.getAllNodesUnified(project ?? undefined);
        const paths: string[] = [];
        for (const n of nodes) {
          if (n.kind === "file" && n.file_path) paths.push(n.file_path);
        }
        const aggregates = groupAuxiliaryPaths(paths);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ aggregates }));
        return;
      }

      if (url.startsWith("/api/file-edges")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const nodes = store.getAllNodesUnified(project ?? undefined);
        const edges = store.getAllEdgesUnified(project ?? undefined);
        const file_edges = buildFileEdges(nodes, edges);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ file_edges }));
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

    httpServer.once("error", () => {
      resolve({ port: -1, httpServer: null });
    });

    httpServer.listen(port, () => {
      resolve({ port, httpServer });
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
