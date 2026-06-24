// tests/api/todos-route.test.ts
// Integration test for GET /api/todos: verifies the route returns the correct
// version + a list of todos from the home repo, and 503 when repos are absent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import type { TodoRecord } from "../../src/todos/types.js";
import { CONTRACT_VERSION } from "../../src/mcp-server/api-schemas.js";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

function todoRec(id: string, summary: string): TodoRecord {
  const now = new Date().toISOString();
  return {
    id, seq: 1, summary, description: null,
    state: "open", state_reason: null, proposed_by: null,
    proposed_at: now, started_at: null, closed_at: null, assignee: null,
    created_at: now, updated_at: now,
  };
}

// ── server WITH todos repos ──────────────────────────────────────────────────
let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let todoId: string;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";

  const dir = makeTempDir("cortex-todos-route-");
  store = new GraphStore(join(dir, "db"));

  // Open a decisions DB (todos live in the same DB) and insert one todo.
  const db = openDecisionsDb(join(dir, "decisions.db"));
  const todosRepo = new TodosRepository(db);
  const todoLinksRepo = new TodoLinksRepository(db);
  todoId = "T-test01";
  todosRepo.insert(todoRec(todoId, "Test todo summary"));

  // Decisions repos (needed as positional args before todos repos).
  const decisionsRepo = new DecisionsRepository(db);
  const decisionLinksRepo = new DecisionLinksRepository(db);

  handle = await startViewerServer(store, null, decisionsRepo, decisionLinksRepo, todosRepo, todoLinksRepo);
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
});

describe("GET /api/todos — with repos", () => {
  it("returns 200 with the correct version", async () => {
    const r = await fetch(`${base}/api/todos`);
    expect(r.status).toBe(200);
    const body = await r.json() as { version: number; todos: { id: string; summary: string; state: string }[] };
    expect(body.version).toBe(CONTRACT_VERSION);
  });

  it("returns the inserted todo in the list", async () => {
    const r = await fetch(`${base}/api/todos`);
    const body = await r.json() as { version: number; todos: { id: string; summary: string; state: string }[] };
    const found = body.todos.find((t) => t.id === todoId);
    expect(found).toBeDefined();
    expect(found!.summary).toBe("Test todo summary");
    expect(found!.state).toBe("open");
  });

  it("carries X-Cortex-API-Version header", async () => {
    const r = await fetch(`${base}/api/todos`);
    expect(r.headers.get("X-Cortex-API-Version")).toBe(String(CONTRACT_VERSION));
  });
});

// ── server WITHOUT todos repos ────────────────────────────────────────────────
let handle503: ViewerServerHandle;
let base503: string;
let store503: GraphStore;

beforeAll(async () => {
  const dir = makeTempDir("cortex-todos-503-");
  store503 = new GraphStore(join(dir, "db"));
  // Start with NO todos repos (omit the last two optional params).
  handle503 = await startViewerServer(store503, null);
  base503 = `http://127.0.0.1:${handle503.port}`;
});

afterAll(() => {
  handle503?.close();
  store503?.close();
});

describe("GET /api/todos — without repos (503)", () => {
  it("returns 503 when todos repos are not provided", async () => {
    const r = await fetch(`${base503}/api/todos`);
    expect(r.status).toBe(503);
  });
});
