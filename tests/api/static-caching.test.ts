import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated, empty store on a temp db so the server starts deterministically.
let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0"; // ephemeral port
  dir = mkdtempSync(join(tmpdir(), "cortex-api-cache-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => {
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("viewer static caching headers", () => {
  it("GET /viewer serves HTML with no-cache so a new build is picked up on next load", async () => {
    const r = await fetch(`${base}/viewer`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("GET a content-hashed asset gets an immutable, long-lived cache header", async () => {
    // Read the actual current build's hashed asset filename rather than hardcoding
    // a hash — the build changes hashes on every rebuild.
    const assetsDir = join(process.cwd(), "src", "viewer", "dist", "assets");
    const files = readdirSync(assetsDir);
    const jsAsset = files.find((f) => f.endsWith(".js"));
    expect(jsAsset).toBeTruthy();

    const r = await fetch(`${base}/viewer/assets/${jsAsset}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });
});
