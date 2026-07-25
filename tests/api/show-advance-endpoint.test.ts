// tests/api/show-advance-endpoint.test.ts
// Integration test for POST /api/show-advance: canonical repo gate, bus emit,
// and the 400/405 contract (mirrors show-focus-endpoint.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import type { ShowAdvancePost } from "../../src/mcp-server/api-schemas.js";

let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;
const emitted: ShowAdvancePost[] = [];

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  dir = mkdtempSync(join(tmpdir(), "cortex-show-advance-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null, undefined, undefined, undefined, undefined, undefined, undefined, {
    homeRoot: "/canonical/home",
    emit: () => {},
    emitFocus: () => {},
    emitAdvance: (p) => emitted.push(p),
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/api/show-advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/show-advance", () => {
  const good = { repo_path: "/canonical/home", story_id: "S-abcd", step: 1 };

  it("accepts a matching repo and emits", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ story_id: "S-abcd", step: 1 });
  });

  it("drops a non-matching repo without emitting", async () => {
    const res = await post({ ...good, repo_path: "/somewhere/else" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: false });
    expect(emitted).toHaveLength(1); // unchanged
  });

  it("400s on step 0 (out of range floor)", async () => {
    const res = await post({ ...good, step: 0 });
    expect(res.status).toBe(400);
  });

  it("400s on a missing story_id", async () => {
    const res = await post({ repo_path: "/canonical/home", step: 1 });
    expect(res.status).toBe(400);
  });

  it("405s POST to any other API path", async () => {
    const res = await fetch(`${base}/api/graph`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("405s GET /api/show-advance", async () => {
    const res = await fetch(`${base}/api/show-advance`);
    expect(res.status).toBe(405);
  });
});
