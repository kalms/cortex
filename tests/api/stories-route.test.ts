// tests/api/stories-route.test.ts
// Integration test for GET /api/stories(/:id): verifies the list route returns
// the correct version + stepCount, the detail route returns ordered steps and
// resolves both canonical and seq-form ids, and the 400/404/503 contracts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { StoriesRepository, StoryStepsRepository } from "../../src/stories/repository.js";
import { StoryService } from "../../src/stories/service.js";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { CONTRACT_VERSION } from "../../src/mcp-server/api-schemas.js";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

// ── server WITH stories repos ────────────────────────────────────────────────
let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let storyId: string;
let storySeq: number;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";

  const dir = makeTempDir("cortex-stories-route-");
  store = new GraphStore(join(dir, "db"));

  const db = openDecisionsDb(join(dir, "decisions.db"));
  const svc = new StoryService({ db });
  const created = svc.create({
    title: "Pipeline tour",
    created_by: "claude",
    steps: [
      { caption: "Entry", refs: ["src/index.ts"] },
      { caption: "Worker", refs: ["src/events/worker/persister.ts"], layout_hint: "network" },
    ],
  });
  storyId = created.id;
  storySeq = created.seq;
  // A second story so the list route has more than one row to shape-check.
  svc.create({ title: "Other story", steps: [{ caption: "Only", refs: [] }] });

  const storiesRepo = new StoriesRepository(db);
  const storyStepsRepo = new StoryStepsRepository(db);

  // Positional args before storiesRepo/storyStepsRepo: decisions + todos repos
  // (required even when unused, per startViewerServer's signature).
  const decisionsRepo = new DecisionsRepository(db);
  const decisionLinksRepo = new DecisionLinksRepository(db);
  const todosRepo = new TodosRepository(db);
  const todoLinksRepo = new TodoLinksRepository(db);

  handle = await startViewerServer(
    store, null, decisionsRepo, decisionLinksRepo, todosRepo, todoLinksRepo, storiesRepo, storyStepsRepo,
  );
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
});

describe("GET /api/stories — with repos", () => {
  it("returns 200 with the correct version and stepCount per story", async () => {
    const r = await fetch(`${base}/api/stories`);
    expect(r.status).toBe(200);
    const body = await r.json() as { version: number; stories: { id: string; title: string; stepCount: number }[] };
    expect(body.version).toBe(CONTRACT_VERSION);
    const tour = body.stories.find((s) => s.id === storyId);
    expect(tour).toBeDefined();
    expect(tour!.title).toBe("Pipeline tour");
    expect(tour!.stepCount).toBe(2);
    const other = body.stories.find((s) => s.title === "Other story");
    expect(other?.stepCount).toBe(1);
  });

  it("carries X-Cortex-API-Version header", async () => {
    const r = await fetch(`${base}/api/stories`);
    expect(r.headers.get("X-Cortex-API-Version")).toBe(String(CONTRACT_VERSION));
  });
});

describe("GET /api/stories/:id — with repos", () => {
  it("returns steps in order for a canonical id", async () => {
    const r = await fetch(`${base}/api/stories/${storyId}`);
    expect(r.status).toBe(200);
    const body = await r.json() as { version: number; story: { id: string; steps: { step_index: number; caption: string }[] } };
    expect(body.story.id).toBe(storyId);
    expect(body.story.steps.map((s) => s.caption)).toEqual(["Entry", "Worker"]);
    expect(body.story.steps.map((s) => s.step_index)).toEqual([1, 2]);
  });

  it("resolves a seq-form id (S-<n>)", async () => {
    const r = await fetch(`${base}/api/stories/S-${storySeq}`);
    expect(r.status).toBe(200);
    const body = await r.json() as { story: { id: string } };
    expect(body.story.id).toBe(storyId);
  });

  it("404s an unknown canonical id", async () => {
    const r = await fetch(`${base}/api/stories/S-zzzz`);
    expect(r.status).toBe(404);
  });

  it("400s an id over the length cap", async () => {
    const r = await fetch(`${base}/api/stories/${"a".repeat(300)}`);
    expect(r.status).toBe(400);
  });
});

// ── server WITHOUT stories repos ─────────────────────────────────────────────
let handle503: ViewerServerHandle;
let base503: string;
let store503: GraphStore;

beforeAll(async () => {
  const dir = makeTempDir("cortex-stories-503-");
  store503 = new GraphStore(join(dir, "db"));
  handle503 = await startViewerServer(store503, null);
  base503 = `http://127.0.0.1:${handle503.port}`;
});

afterAll(() => {
  handle503?.close();
  store503?.close();
});

describe("GET /api/stories(/:id) — without repos (503)", () => {
  it("returns 503 on the list route", async () => {
    const r = await fetch(`${base503}/api/stories`);
    expect(r.status).toBe(503);
  });

  it("returns 503 on the detail route", async () => {
    const r = await fetch(`${base503}/api/stories/S-abcd`);
    expect(r.status).toBe(503);
  });
});
