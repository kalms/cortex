/**
 * MCP contract test for the `decision_candidates` tool.
 *
 * This test cannot use the shared `createHarness()` because the harness places
 * decisions.db at `<tmpdir>/cortex-harness-XXXX/decisions.db` — a flat layout
 * where `resolve(dirname(dbPath), "..")` yields the OS temp dir (not a git
 * repo). The tool derives `repoRoot` from `dbPath`, so the fixture must use the
 * production layout: `<repo-root>/.cortex/decisions.db`.
 *
 * Instead, this test creates its own minimal in-process McpServer + Client over
 * InMemoryTransport — the same transport the harness uses — so the actual MCP
 * boundary is fully exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";
import { registerDecisionTools } from "../../src/mcp-server/tools/decision-tools.js";

// ── Fixture layout ────────────────────────────────────────────────────────────
//
// <repoRoot>/               ← real git repo (git init here)
//   docs/adr/0001-x.md     ← ADR-shaped doc → kind:"adr"
//   .cortex/decisions.db   ← dbPath the tool reads; resolve(dirname,..) = repoRoot
//
// At least one conventional commit ensures clusterCommitCandidates returns
// at least one kind:"commit_cluster" entry.
// ─────────────────────────────────────────────────────────────────────────────

const ADR_CONTENT = `# ADR 0001: Use SQLite for decision storage

## Context

We need a lightweight, file-based database for storing decisions locally.

## Decision

We will use SQLite via better-sqlite3.

## Consequences

Single-file database, no daemon required.
`;

interface MinimalHarness {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

let repoRoot: string;
let harness: MinimalHarness;

async function buildMinimalHarness(decisionsDbPath: string): Promise<MinimalHarness> {
  const decisionsDb = openDecisionsDb(decisionsDbPath);
  const decisionsRepo = new DecisionsRepository(decisionsDb);
  const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);
  const service = new DecisionService({
    decisions: decisionsRepo,
    links: decisionLinksRepo,
    project_id: "test-candidates",
  });
  const search = new DecisionSearch(decisionsRepo, decisionLinksRepo);

  const server = new McpServer({ name: "cortex-candidates-test", version: "0.0.0" });
  registerDecisionTools(server, service, search, decisionLinksRepo, "test-candidates", decisionsDbPath);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "cortex-candidates-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
      try { decisionsDb.close(); } catch { /* ignore */ }
    },
  };
}

describe("decision_candidates MCP tool", () => {
  beforeAll(async () => {
    // 1. Create a temp git repo with the production .cortex layout.
    repoRoot = mkdtempSync(join(tmpdir(), "cortex-candidates-fixture-"));

    // 2. git init
    execFileSync("git", ["init", "--initial-branch=main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);

    // 3. Create an ADR file — matches both ADR_PATH (/adr/) and ADR_HEADINGS.
    const adrDir = join(repoRoot, "docs", "adr");
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(join(adrDir, "0001-sqlite-decisions.md"), ADR_CONTENT);

    // 4. Commit it with a conventional commit message so both doc AND commit
    //    paths produce candidates.
    execFileSync("git", ["-C", repoRoot, "add", "."]);
    execFileSync("git", ["-C", repoRoot, "commit", "--no-gpg-sign", "-m", "feat(db): use SQLite for decision storage"]);

    // 5. Create the sidecar decisions DB at the production location so the
    //    tool's path math resolves to repoRoot.
    //    dbPath = <repoRoot>/.cortex/decisions.db
    //    dirname(dbPath) = <repoRoot>/.cortex
    //    resolve(dirname, "..") = repoRoot  ✓
    const cortexDir = join(repoRoot, ".cortex");
    mkdirSync(cortexDir, { recursive: true });
    const decisionsDbPath = join(cortexDir, "decisions.db");

    // 6. Build the in-process MCP server with this dbPath (real MCP boundary).
    harness = await buildMinimalHarness(decisionsDbPath);
  });

  afterAll(async () => {
    if (harness) await harness.close();
    try { rmSync(repoRoot, { recursive: true }); } catch { /* ignore */ }
  });

  it("returns a non-empty array with at least one adr and one commit_cluster candidate", async () => {
    const result = await harness.client.callTool({
      name: "decision_candidates",
      arguments: { max_candidates: 5 },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(res.isError).toBeFalsy();

    const candidates = JSON.parse(res.content[0].text);
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThanOrEqual(2);

    // ADR-shaped doc must appear first (high confidence)
    expect(candidates[0].kind).toBe("adr");

    // At least one commit_cluster from the conventional commit
    const hasCluster = candidates.some((c: { kind: string }) => c.kind === "commit_cluster");
    expect(hasCluster).toBe(true);
  });

  it("respects max_candidates cap", async () => {
    const result = await harness.client.callTool({
      name: "decision_candidates",
      arguments: { max_candidates: 1 },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(res.isError).toBeFalsy();
    const candidates = JSON.parse(res.content[0].text);
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeLessThanOrEqual(1);
  });

  it("works with no max_candidates (uses default)", async () => {
    const result = await harness.client.callTool({
      name: "decision_candidates",
      arguments: {},
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(res.isError).toBeFalsy();
    const candidates = JSON.parse(res.content[0].text);
    expect(Array.isArray(candidates)).toBe(true);
  });
});
