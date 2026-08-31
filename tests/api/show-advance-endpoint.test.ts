// tests/api/show-advance-endpoint.test.ts
// Integration test for POST /api/show-advance: registry gate, bus emit,
// and the 400/405 contract (mirrors show-focus-endpoint.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { Registry } from "../../src/db/registry.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import type { ShowAdvancePost } from "../../src/mcp-server/api-schemas.js";
import type { BeaconTarget } from "../../src/mcp-server/beacon-target.js";

let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;
let home: string;
let wt: string;
const emitted: Array<{ post: ShowAdvancePost; target: BeaconTarget }> = [];

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-show-advance-")));
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
    emit: () => {},
    emitFocus: () => {},
    emitAdvance: (post, target) => emitted.push({ post, target }),
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
  fetch(`${base}/api/show-advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/show-advance", () => {
  const good = () => ({ repo_path: home, story_id: "S-abcd", step: 1 });

  it("accepts a registered checkout and emits with its target", async () => {
    const res = await post(good());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.post).toMatchObject({ story_id: "S-abcd", step: 1 });
    expect(emitted[0]!.target).toEqual({ name: "home", root_path: home });
  });

  it("accepts a registered worktree and targets the worktree, not its parent", async () => {
    const res = await post({ ...good(), repo_path: wt });
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(emitted[1]!.target).toEqual({ name: "home-wt", root_path: wt });
  });

  it("drops an unregistered repo without emitting", async () => {
    const res = await post({ ...good(), repo_path: "/somewhere/else" });
    expect(await res.json()).toMatchObject({ accepted: false });
    expect(emitted).toHaveLength(2); // unchanged
  });

  it("400s on step 0 (out of range floor)", async () => {
    const res = await post({ ...good(), step: 0 });
    expect(res.status).toBe(400);
  });

  it("400s on a missing story_id", async () => {
    const res = await post({ repo_path: home, step: 1 });
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
