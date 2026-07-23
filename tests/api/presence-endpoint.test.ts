// tests/api/presence-endpoint.test.ts
// Integration test for POST /api/presence: canonical repo gate, bus emit, and
// the 405 contract for other routes/methods (mirrors todos-route.test.ts harness).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import type { PresencePost } from "../../src/mcp-server/api-schemas.js";

let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;
const emitted: PresencePost[] = [];

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  dir = mkdtempSync(join(tmpdir(), "cortex-presence-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null, undefined, undefined, undefined, undefined, {
    homeRoot: "/canonical/home",
    emit: (p) => emitted.push(p),
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/api/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/presence", () => {
  const good = { session_id: "s-1", repo_path: "/canonical/home", workspace: "home", activity: "studied", refs: ["src/a.ts"] };

  it("accepts a matching repo and emits", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ session_id: "s-1", activity: "studied" });
  });

  it("drops a non-matching repo without emitting", async () => {
    const res = await post({ ...good, repo_path: "/somewhere/else" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: false });
    expect(emitted).toHaveLength(1); // unchanged
  });

  it("400s an invalid body", async () => {
    const res = await post({ nope: true });
    expect(res.status).toBe(400);
  });

  it("405s POST to any other API path", async () => {
    const res = await fetch(`${base}/api/graph`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("405s GET /api/presence", async () => {
    const res = await fetch(`${base}/api/presence`);
    expect(res.status).toBe(405);
  });
});
