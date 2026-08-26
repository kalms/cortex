// tests/api/provenance-filters.test.ts
// Integration test for the `?branch=`/`?thread=` query filters on
// GET /api/decisions, /api/todos, /api/stories (Task 10). Filter semantics,
// per spec: exact match on origin_branch/origin_thread; an absent filter
// preserves today's (unfiltered) behavior exactly; a filter never matches a
// NULL origin — a row with no recorded origin is not "on" any branch/thread.
//
// Harness mirrors tests/api/decisions-routing.test.ts (resolveDecisionsDbPath
// + openDecisionsDb against a non-git temp dir — the sidecar store, never the
// stale in-repo .cortex/decisions.db) and tests/api/todos-route.test.ts /
// stories-route.test.ts (repositories inserted directly, then a real
// startViewerServer + fetch).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";
import { DecisionsRepository, type DecisionRecord } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import type { TodoRecord } from "../../src/todos/types.js";
import { StoriesRepository, StoryStepsRepository } from "../../src/stories/repository.js";
import type { StoryRecord } from "../../src/stories/types.js";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

function decRec(id: string, title: string, origin_branch: string | null): DecisionRecord {
  const now = "2026-01-01T00:00:00Z";
  return {
    id, seq: 1, title, description: null, rationale: null, problem: null,
    resolution: null, alternatives: null, tier: "personal", status: "active",
    superseded_by: null, author: null, provenance: null,
    created_at: now, updated_at: now,
    origin_branch, origin_commit: null, origin_thread: null,
  };
}

function todoRec(id: string, summary: string, origin_thread: string | null): TodoRecord {
  const now = "2026-01-01T00:00:00Z";
  return {
    id, seq: 1, summary, description: null,
    state: "open", state_reason: null, proposed_by: null,
    proposed_at: now, started_at: null, closed_at: null, assignee: null,
    created_at: now, updated_at: now,
    origin_branch: null, origin_commit: null, origin_thread,
  };
}

function storyRec(id: string, title: string, origin_thread: string | null): StoryRecord {
  const now = "2026-01-01T00:00:00Z";
  return {
    id, seq: 1, title, description: null, status: "open",
    created_by: null, created_at: now, updated_at: now,
    origin_branch: null, origin_commit: null, origin_thread,
  };
}

let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";

  // A non-git temp dir → resolveDecisionsDbPath returns <dir>/.cortex/decisions.db
  // (the sidecar store), same sandbox construction as decisions-routing.test.ts.
  const dir = makeTempDir("cortex-provenance-filters-");
  const db = openDecisionsDb(resolveDecisionsDbPath(dir));

  const decisionsRepo = new DecisionsRepository(db);
  const decisionLinksRepo = new DecisionLinksRepository(db);
  decisionsRepo.insert(decRec("D-a", "Decision on feature/a", "feature/a"));
  decisionsRepo.insert(decRec("D-b", "Decision on feature/b", "feature/b"));
  decisionsRepo.insert(decRec("D-null", "Decision with no origin", null));

  const todosRepo = new TodosRepository(db);
  const todoLinksRepo = new TodoLinksRepository(db);
  todosRepo.insert(todoRec("T-a", "Todo on thread t-1", "t-1"));
  todosRepo.insert(todoRec("T-b", "Todo on thread t-2", "t-2"));
  todosRepo.insert(todoRec("T-null", "Todo with no thread", null));

  const storiesRepo = new StoriesRepository(db);
  const storyStepsRepo = new StoryStepsRepository(db);
  storiesRepo.insert(storyRec("S-a", "Story on thread t-1", "t-1"));
  storiesRepo.insert(storyRec("S-b", "Story on thread t-2", "t-2"));
  storiesRepo.insert(storyRec("S-null", "Story with no thread", null));

  store = new GraphStore(join(dir, "db"));

  handle = await startViewerServer(
    store, null, decisionsRepo, decisionLinksRepo, todosRepo, todoLinksRepo, storiesRepo, storyStepsRepo,
  );
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
});

describe("GET /api/decisions?branch=", () => {
  it("returns only the row whose origin_branch matches exactly", async () => {
    const body = await (await fetch(`${base}/api/decisions?branch=feature/a`)).json() as { decisions: { id: string }[] };
    const ids = body.decisions.map((d) => d.id);
    expect(ids).toContain("D-a");
    expect(ids).not.toContain("D-b");
    expect(ids).not.toContain("D-null");
  });

  it("never matches a NULL origin, even for a branch that matches nothing", async () => {
    const body = await (await fetch(`${base}/api/decisions?branch=feature/none`)).json() as { decisions: { id: string }[] };
    expect(body.decisions).toEqual([]);
  });

  it("preserves unfiltered behavior exactly — all three rows, including the NULL-origin one", async () => {
    const body = await (await fetch(`${base}/api/decisions`)).json() as { decisions: { id: string }[] };
    const ids = body.decisions.map((d) => d.id);
    expect(ids.length).toBe(3);
    expect(ids).toEqual(expect.arrayContaining(["D-a", "D-b", "D-null"]));
  });

  it("400s an empty branch value (fail-closed, mirrors ?project=)", async () => {
    const res = await fetch(`${base}/api/decisions?branch=`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/todos?thread=", () => {
  it("returns only the row whose origin_thread matches exactly, never a NULL origin, and preserves the unfiltered baseline", async () => {
    const filtered = await (await fetch(`${base}/api/todos?thread=t-1`)).json() as { todos: { id: string; originThread: string | null }[] };
    expect(filtered.todos.length).toBeGreaterThan(0);
    expect(filtered.todos.every((t) => t.originThread === "t-1")).toBe(true);
    const filteredIds = filtered.todos.map((t) => t.id);
    expect(filteredIds).toContain("T-a");
    expect(filteredIds).not.toContain("T-b");
    expect(filteredIds).not.toContain("T-null");

    const all = await (await fetch(`${base}/api/todos`)).json() as { todos: { id: string }[] };
    const allIds = all.todos.map((t) => t.id);
    expect(allIds.length).toBe(3);
    expect(allIds).toEqual(expect.arrayContaining(["T-a", "T-b", "T-null"]));
  });
});

describe("GET /api/stories?thread=", () => {
  it("returns only the row whose origin_thread matches exactly, never a NULL origin, and preserves the unfiltered baseline", async () => {
    const filtered = await (await fetch(`${base}/api/stories?thread=t-1`)).json() as { stories: { id: string; originThread: string | null }[] };
    expect(filtered.stories.length).toBeGreaterThan(0);
    expect(filtered.stories.every((s) => s.originThread === "t-1")).toBe(true);
    const filteredIds = filtered.stories.map((s) => s.id);
    expect(filteredIds).toContain("S-a");
    expect(filteredIds).not.toContain("S-b");
    expect(filteredIds).not.toContain("S-null");

    const all = await (await fetch(`${base}/api/stories`)).json() as { stories: { id: string }[] };
    const allIds = all.stories.map((s) => s.id);
    expect(allIds.length).toBe(3);
    expect(allIds).toEqual(expect.arrayContaining(["S-a", "S-b", "S-null"]));
  });
});
