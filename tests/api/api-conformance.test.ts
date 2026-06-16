import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import {
  GraphResponseSchema, ProjectsResponseSchema, FramesResponseSchema,
  FileEdgesResponseSchema, AggregatesResponseSchema, FreshnessResponseSchema, HealthResponseSchema,
} from "../../src/mcp-server/api-schemas.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handle: ViewerServerHandle, base: string, store: GraphStore, dir: string;
beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  dir = mkdtempSync(join(tmpdir(), "cortex-conf-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => {
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const CASES: [string, { safeParse: (d: unknown) => { success: boolean } }][] = [
  ["/api/health", HealthResponseSchema],
  ["/api/freshness", FreshnessResponseSchema],
  ["/api/projects", ProjectsResponseSchema],
  ["/api/graph", GraphResponseSchema],
  ["/api/frames", FramesResponseSchema],
  ["/api/file-edges", FileEdgesResponseSchema],
  ["/api/aggregates", AggregatesResponseSchema],
];

describe("live responses conform to their schema", () => {
  for (const [path, schema] of CASES) {
    it(`${path} conforms`, async () => {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(200);
      expect(schema.safeParse(await r.json()).success).toBe(true);
    });
  }
});
