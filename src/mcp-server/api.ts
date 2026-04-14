import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
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

export function startViewerServer(store: GraphStore, cbmProject?: string | null): Promise<number> {
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
        const filePath =
          url === "/" || url === "/viewer" || url === "/viewer/"
            ? join(VIEWER_DIR, "index.html")
            : join(VIEWER_DIR, url.replace("/viewer/", ""));

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
    httpServer.listen(port, () => {
      resolve(port);
    });
  });
}
