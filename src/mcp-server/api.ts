import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../graph/store.js";

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
  cbmProject?: string | null,
): Promise<ViewerServerHandle> {
  return new Promise((resolve) => {
    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url === "/api/graph") {
        const nodes = store.getAllNodesUnified(cbmProject ?? undefined);
        const rawEdges = store.getAllEdgesUnified(cbmProject ?? undefined);
        const edges = rawEdges.map((e) => ({
          ...e,
          source: e.source_id,
          target: e.target_id,
        }));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ nodes, edges }));
        return;
      }

      if (url === "/" || url.startsWith("/viewer")) {
        // Map URL → disk file under VIEWER_DIR.
        // /            → index.html (2D viewer, the new default)
        // /viewer      → index.html
        // /viewer/     → index.html
        // /viewer/3d   → 3d/index.html
        // /viewer/3d/  → 3d/index.html
        // /viewer/<p>  → <p>  (e.g., /viewer/graph-viewer-2d.js, /viewer/shared/state.js, /viewer/style.css, /viewer/3d/graph-viewer.js)
        let rel: string;
        if (url === "/" || url === "/viewer" || url === "/viewer/") {
          rel = "index.html";
        } else if (url === "/viewer/3d" || url === "/viewer/3d/") {
          rel = "3d/index.html";
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
