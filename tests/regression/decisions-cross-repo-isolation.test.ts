import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rmSync } from "node:fs";
import { createServer } from "../../src/mcp-server/server.js";
import { makeIndexedRepoFixture, countDecisions } from "../mcp-contract/harness.js";

/**
 * Load-bearing acceptance gate for the per-call routing migration.
 *
 * Before Phase 5: `createServer` took a startup `repoPath` and every
 * decision-write closed over a DecisionsRepository bound to that one DB.
 * `create_decision({ repo_path: B })` silently wrote to A.
 *
 * After Phase 5: `createServer()` has no cwd binding. Every write must route
 * through the per-call resolver, landing in the addressed repo's
 * `.cortex/decisions.db`.
 *
 * This test fails against the pre-migration codebase (writes leak into A or
 * into process.cwd()'s decisions DB) and passes against the post-migration
 * codebase. It lives under tests/regression/ to flag that a future
 * refactor must not regress this property.
 */
describe("regression: decisions don't leak across repos", () => {
  let repoA: string;
  let repoB: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    repoA = makeIndexedRepoFixture();
    repoB = makeIndexedRepoFixture();

    // Construct an MCP server with no cwd binding (post-Phase-5 signature).
    // The server's only state is the per-call resolver and the event bus
    // (unused here). Any cross-repo leakage would necessarily come from
    // startup-bound handles — which is exactly what this test guards against.
    const server = createServer();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "regression-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    try { await close?.(); } catch { /* ignore */ }
    try { rmSync(repoA, { recursive: true }); } catch { /* ignore */ }
    try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
  });

  it("decision({ action: 'create', repo_path: B }) writes to B, never to A", async () => {
    // Sanity: both repos start with zero decisions.
    expect(countDecisions(repoA)).toBe(0);
    expect(countDecisions(repoB)).toBe(0);

    const res = await client.callTool({
      name: "decision",
      arguments: {
        action: "create",
        repo_path: repoB,
        title: "scoped to B",
        description: "x",
        rationale: "y",
      },
    }) as { content: Array<{ text: string }>; isError?: boolean };

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.id).toMatch(/^D-/);

    // The decision must have landed in repoB's sidecar, not in repoA's.
    expect(countDecisions(repoA)).toBe(0);
    expect(countDecisions(repoB)).toBe(1);
  });
});
