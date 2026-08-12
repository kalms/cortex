// tests/api/decisions-detail-route.test.ts
// Integration test for GET /api/decisions/:id — the route must accept the
// canonical id AND the per-repo sequence form for the same decision.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { GraphStore } from "../../src/graph/store.js";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";

const tmps: string[] = [];
let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let canonicalId: string;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";

  const dir = mkdtempSync(join(tmpdir(), "cortex-decisions-detail-"));
  tmps.push(dir);
  store = new GraphStore(join(dir, "db"));

  const db = openDecisionsDb(join(dir, "decisions.db"));
  const decisionsRepo = new DecisionsRepository(db);
  const decisionLinksRepo = new DecisionLinksRepository(db);

  // Create through the service so a seq is allocated (seq 1 ⇒ "D-1").
  const service = new DecisionService({ db, decisions: decisionsRepo, links: decisionLinksRepo });
  canonicalId = service.create({ title: "detail route", rationale: "r", governs: ["src/a.ts"] }).id;

  handle = await startViewerServer(
    store, null, decisionsRepo, decisionLinksRepo,
    new TodosRepository(db), new TodoLinksRepository(db),
  );
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle?.close();
  store?.close();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("GET /api/decisions/:id — ref forms", () => {
  it("serves a decision addressed by its canonical id", async () => {
    const res = await fetch(`${base}/api/decisions/${canonicalId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).decision.id).toBe(canonicalId);
  });

  it("serves the same decision addressed by the seq form", async () => {
    const res = await fetch(`${base}/api/decisions/D-1`);
    expect(res.status).toBe(200);
    expect((await res.json()).decision.id).toBe(canonicalId);
  });

  it("returns identical bodies for both ref forms", async () => {
    const a = await (await fetch(`${base}/api/decisions/${canonicalId}`)).text();
    const b = await (await fetch(`${base}/api/decisions/D-1`)).text();
    expect(b).toBe(a);
  });

  it("404s for an unknown ref in either form", async () => {
    expect((await fetch(`${base}/api/decisions/D-404`)).status).toBe(404);
    expect((await fetch(`${base}/api/decisions/D-zzzz`)).status).toBe(404);
  });
});
