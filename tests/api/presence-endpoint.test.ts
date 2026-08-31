// tests/api/presence-endpoint.test.ts
// Integration test for POST /api/presence: registry gate, bus emit, and the 405
// contract for other routes/methods (mirrors todos-route.test.ts harness).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { Registry } from "../../src/db/registry.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import type { PresencePost } from "../../src/mcp-server/api-schemas.js";
import type { BeaconTarget } from "../../src/mcp-server/beacon-target.js";

let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;
let home: string;
let wt: string;
const emitted: Array<{ post: PresencePost; target: BeaconTarget }> = [];

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-presence-")));
  // Isolate the registry: startViewerServer opens defaultRegistryPath(), which
  // would otherwise be the developer's real one (todo T-zkfx).
  process.env.CORTEX_REGISTRY_DB = join(dir, "registry.db");
  home = join(dir, "home");
  wt = join(dir, "home-wt");
  mkdirSync(home); mkdirSync(wt);
  const reg = new Registry(process.env.CORTEX_REGISTRY_DB);
  reg.register("home", home, "t");
  reg.register("home-wt", wt, "t", { worktree_of: home, branch: "feature/x" });
  reg.close();

  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null, undefined, undefined, undefined, undefined, undefined, undefined, {
    emit: (post, target) => emitted.push({ post, target }),
    emitFocus: () => {},
    emitAdvance: () => {},
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
  delete process.env.CORTEX_REGISTRY_DB;
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/api/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/presence", () => {
  const good = () => ({ session_id: "s-1", repo_path: home, workspace: "home", activity: "studied", refs: ["src/a.ts"] });

  it("accepts a registered checkout and emits with its target", async () => {
    const res = await post(good());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.post).toMatchObject({ session_id: "s-1", activity: "studied" });
    expect(emitted[0]!.target).toEqual({ name: "home", root_path: home });
  });

  it("accepts a registered worktree and targets the worktree, not its parent", async () => {
    const res = await post({ ...good(), repo_path: wt });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.target).toEqual({ name: "home-wt", root_path: wt });
  });

  it("drops an unregistered repo without emitting", async () => {
    const res = await post({ ...good(), repo_path: "/somewhere/else" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: false });
    expect(emitted).toHaveLength(2); // unchanged
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
