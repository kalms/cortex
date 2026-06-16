import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated, empty store on a temp db so the server starts deterministically.
let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0"; // ephemeral port (see Step 3(d))
  dir = mkdtempSync(join(tmpdir(), "cortex-api-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => {
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("viewer HTTP contract", () => {
  it("GET /api/health is unauthenticated and versioned", async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Cortex-API-Version")).toBe("1");
    expect(await r.json()).toEqual({ version: 1, ok: true });
  });

  it("GET /api/graph carries version + ETag + freshness headers", async () => {
    const r = await fetch(`${base}/api/graph`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe(1);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(r.headers.get("ETag")).toBeTruthy();
    expect(r.headers.get("X-Cortex-Freshness")).toBeTruthy();
  });

  it("If-None-Match returns 304", async () => {
    const r1 = await fetch(`${base}/api/graph`);
    const etag = r1.headers.get("ETag")!;
    const r2 = await fetch(`${base}/api/graph`, { headers: { "If-None-Match": etag } });
    expect(r2.status).toBe(304);
  });

  it("GET /api/freshness returns a verdict", async () => {
    const r = await fetch(`${base}/api/freshness`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe(1);
    expect(typeof body.state).toBe("string");
  });

  it("rejects non-GET with 405", async () => {
    const r = await fetch(`${base}/api/graph`, { method: "POST" });
    expect(r.status).toBe(405);
  });

  it("rejects a path-traversal static request", async () => {
    // Encoded slashes so the traversal survives client/Node URL normalization and
    // actually reaches the server's safeStaticPath guard. A literal
    // `/viewer/../../etc/passwd` is collapsed to `/etc/passwd` before transmission
    // (the attack never leaves the client), so it can't exercise the guard.
    const r = await fetch(`${base}/viewer/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    expect([400, 404]).toContain(r.status);
  });

  it("HEAD /api/graph returns headers + ETag with no body", async () => {
    const r = await fetch(`${base}/api/graph`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("ETag")).toBeTruthy();
    expect(await r.text()).toBe("");
  });

  it("rejects an oversized request target with 414", async () => {
    const r = await fetch(`${base}/api/graph?project=${"a".repeat(3000)}`);
    expect(r.status).toBe(414);
  });
});
