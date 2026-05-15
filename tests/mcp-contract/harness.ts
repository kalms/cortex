import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphStore } from "../../src/graph/store.js";
import { registerCodeTools } from "../../src/mcp-server/tools/code-tools.js";
import { registerDecisionTools } from "../../src/mcp-server/tools/decision-tools.js";
import { registerPromotionTools } from "../../src/mcp-server/tools/promotion-tools.js";
import { registerPRTools } from "../../src/mcp-server/tools/pr-tools.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";
import { PRService } from "../../src/prs/service.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../../src/decisions/migration.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface HarnessContext {
  client: Client;
  store: GraphStore;
  project: string;
  fixtureDir: string;
  service: DecisionService;
  prService: PRService;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<HarnessContext> {
  if (process.env.CORTEX_CONTRACT_BINARY_MISSING === "1") {
    throw new Error(
      "Harness unavailable: bin/cortex-indexer not found during globalSetup. Build the indexer (npm install runs scripts/build-indexer.sh) and re-run."
    );
  }

  const fixtureDir = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
  const project = process.env.CORTEX_CONTRACT_PROJECT;
  const sharedDbPath = process.env.CORTEX_CONTRACT_CORTEX_DB;
  if (!fixtureDir || !project || !sharedDbPath) {
    throw new Error("Harness: globalSetup did not populate env vars (did it run?).");
  }

  // Each test gets a per-test copy of the unified cortex.db so decision/PR
  // mutations from one test don't leak into the next. The indexer's
  // nodes/edges and ctx_* bookkeeping tables come along for the ride, so
  // search_graph / trace_path / etc. see the same indexed fixture across
  // all tests.
  const harnessDir = mkdtempSync(join(tmpdir(), "cortex-harness-"));
  const cortexDbPath = join(harnessDir, "cortex.db");
  copyFileSync(sharedDbPath, cortexDbPath);

  const store = new GraphStore(cortexDbPath);

  // Sidecar decisions DB lives next to the per-test cortex.db copy so the
  // tests are fully isolated. We run the migration against the graph DB so
  // any pre-existing decisions in the fixture come along.
  const decisionsDbPath = join(harnessDir, "decisions.db");
  const decisionsDb = openDecisionsDb(decisionsDbPath);
  migrateDecisionsFromGraphDb(decisionsDb, cortexDbPath);
  const decisionsRepo = new DecisionsRepository(decisionsDb);
  const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);

  const service = new DecisionService({
    decisions: decisionsRepo,
    links: decisionLinksRepo,
    project_id: project,
  });
  const search = new DecisionSearch(decisionsRepo, decisionLinksRepo);
  const promotion = new DecisionPromotion(store);
  const prService = new PRService(store, {
    default_actor: "tester",
    project_id: project,
    decisions: service,
  });

  const server = new McpServer({ name: "cortex-test", version: "0.0.0" });
  registerCodeTools(server, store, project);
  registerDecisionTools(server, service, search, decisionLinksRepo);
  registerPromotionTools(server, promotion);
  registerPRTools(server, prService);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "cortex-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    store,
    project,
    fixtureDir,
    service,
    prService,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      try { decisionsDb.close(); } catch { /* ignore */ }
      try { rmSync(harnessDir, { recursive: true }); } catch { /* ignore */ }
    },
  };
}

export async function callTool(
  h: HarnessContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const result = await h.client.callTool({ name, arguments: args });
  return result as any;
}
