import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handle: ViewerServerHandle, base: string, store: GraphStore, dir: string;
beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  process.env.CORTEX_API_TOKEN = "test-token";
  process.env.CORTEX_CORS_ORIGINS = "https://mesh.dev";
  dir = mkdtempSync(join(tmpdir(), "cortex-hard-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => {
  delete process.env.CORTEX_API_TOKEN;
  delete process.env.CORTEX_CORS_ORIGINS;
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("401 without a token", async () => {
    expect((await fetch(`${base}/api/graph`)).status).toBe(401);
  });
  it("200 with the bearer token", async () => {
    const r = await fetch(`${base}/api/graph`, { headers: { Authorization: "Bearer test-token" } });
    expect(r.status).toBe(200);
  });
  it("/api/health is exempt", async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
  it("/api/projects is NOT exempt (root_path is sensitive)", async () => {
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  });
});

describe("CORS allowlist", () => {
  it("reflects an allowlisted origin", async () => {
    const r = await fetch(`${base}/api/health`, { headers: { Origin: "https://mesh.dev" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://mesh.dev");
  });
  it("ignores a non-allowlisted origin", async () => {
    const r = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.dev" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("input validation", () => {
  it("400 on empty project param", async () => {
    const r = await fetch(`${base}/api/graph?project=`, { headers: { Authorization: "Bearer test-token" } });
    expect(r.status).toBe(400);
  });
});
