import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphStore } from "../../src/graph/store.js";
import { registerCodeTools } from "../../src/mcp-server/tools/code-tools.js";
import { registerDecisionTools } from "../../src/mcp-server/tools/decision-tools.js";
import { registerPromotionTools } from "../../src/mcp-server/tools/promotion-tools.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface HarnessContext {
  client: Client;
  store: GraphStore;
  project: string;
  fixtureDir: string;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<HarnessContext> {
  if (process.env.CORTEX_CONTRACT_BINARY_MISSING === "1") {
    throw new Error(
      "Harness unavailable: bin/codebase-memory-mcp not found during globalSetup. Install the binary and re-run."
    );
  }

  const fixtureDir = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
  const project = process.env.CORTEX_CONTRACT_PROJECT;
  const cbmDbPath = process.env.CORTEX_CONTRACT_CBM_DB;
  if (!fixtureDir || !project || !cbmDbPath) {
    throw new Error("Harness: globalSetup did not populate env vars (did it run?).");
  }

  // Each test gets its own Cortex graph.db (decision storage) to avoid cross-test pollution.
  const cortexDbDir = mkdtempSync(join(tmpdir(), "cortex-harness-"));
  const cortexDbPath = join(cortexDbDir, "graph.db");
  const store = new GraphStore(cortexDbPath);
  store.attachCbm(cbmDbPath);

  const service = new DecisionService(store);
  const search = new DecisionSearch(store);
  const promotion = new DecisionPromotion(store);

  const server = new McpServer({ name: "cortex-test", version: "0.0.0" });
  registerCodeTools(server, store, project);
  registerDecisionTools(server, service, search);
  registerPromotionTools(server, promotion);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "cortex-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    store,
    project,
    fixtureDir,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      try { rmSync(cortexDbDir, { recursive: true }); } catch { /* ignore */ }
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
