/**
 * MCP contract test for the `decision` dispatcher's `candidates` action
 * (formerly the standalone `decision_candidates` tool).
 *
 * The tool walks `repo_path`'s git history + docs, so the fixture must be a
 * real git repo with at least one conventional commit and an ADR-shaped doc.
 * After the per-call routing migration the tool also requires `.cortex/db`
 * to exist (the resolver's `RepoNotIndexedError` guard) — the fixture
 * touches a zero-byte file at that path to satisfy the check without
 * needing to populate a real graph DB.
 *
 * This test builds its own minimal in-process McpServer + Client over
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
import { registerDecisionDispatcher } from "../../src/mcp-server/tools/decision-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

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
  // The sidecar decisions DB is opened so we can close it cleanly during
  // teardown; the per-call resolver opens its own handle on demand.
  const decisionsDb = openDecisionsDb(decisionsDbPath);

  const server = new McpServer({ name: "cortex-candidates-test", version: "0.0.0" });
  // Phase 2 dropped the closure-bound service/search/links/dbPath params from
  // registerDecisionTools — every tool routes through `resolver.resolve(ctx)`.
  const resolver = new RepoContextResolver({ poolCapacity: 1 });
  registerDecisionDispatcher(server, resolver, "test-candidates");

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

    // 5. Create the sidecar decisions DB at the production location and a
    //    zero-byte `.cortex/db` so the per-call resolver's existsSync check
    //    passes. The graph DB isn't read by frameCandidates() — but the
    //    resolver constructs a GraphStore from it (which runs idempotent
    //    schema migrations on the empty file, producing a valid SQLite DB).
    const cortexDir = join(repoRoot, ".cortex");
    mkdirSync(cortexDir, { recursive: true });
    const decisionsDbPath = join(cortexDir, "decisions.db");
    writeFileSync(join(cortexDir, "db"), "");

    // 6. Build the in-process MCP server with this dbPath (real MCP boundary).
    harness = await buildMinimalHarness(decisionsDbPath);
  });

  afterAll(async () => {
    if (harness) await harness.close();
    try { rmSync(repoRoot, { recursive: true }); } catch { /* ignore */ }
  });

  it("returns a non-empty array with at least one adr and one commit_cluster candidate", async () => {
    const result = await harness.client.callTool({
      name: "decision",
      arguments: { action: "candidates", repo_path: repoRoot, max_candidates: 5 },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(ResponseSchema.safeParse(res).success).toBe(true);
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
      name: "decision",
      arguments: { action: "candidates", repo_path: repoRoot, max_candidates: 1 },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
    const candidates = JSON.parse(res.content[0].text);
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeLessThanOrEqual(1);
  });

  it("works with no max_candidates (uses default)", async () => {
    const result = await harness.client.callTool({
      name: "decision",
      arguments: { action: "candidates", repo_path: repoRoot },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
    const candidates = JSON.parse(res.content[0].text);
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("rejects when repo_path is missing", async () => {
    const result = await harness.client.callTool({
      name: "decision",
      arguments: { action: "candidates" },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });

  it("base scopes candidates to base..HEAD (warm path)", async () => {
    // Add a branch commit on top of the fixture's single main commit, then
    // ask for candidates with base=main — only the branch cluster may appear.
    execFileSync("git", ["-C", repoRoot, "checkout", "-b", "feature/warm"]);
    writeFileSync(join(repoRoot, "warm.ts"), "export const warm = 1;\n");
    execFileSync("git", ["-C", repoRoot, "add", "."]);
    execFileSync("git", ["-C", repoRoot, "commit", "--no-gpg-sign", "-m", "feat(warm): branch-only change"]);
    try {
      const result = await harness.client.callTool({
        name: "decision",
        arguments: { action: "candidates", repo_path: repoRoot, base: "main" },
      });
      const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(res.isError).toBeFalsy();
      const candidates = JSON.parse(res.content[0].text);
      const text = JSON.stringify(candidates);
      expect(text).toContain("branch-only change");
      // The pre-base commit and untouched ADR are out of scope.
      expect(text).not.toContain("use SQLite for decision storage");
      expect(text).not.toContain("sqlite-decisions");
    } finally {
      execFileSync("git", ["-C", repoRoot, "checkout", "main"]);
      execFileSync("git", ["-C", repoRoot, "branch", "-D", "feature/warm"]);
    }
  });

  it("an invalid base ref is malformed_input", async () => {
    const result = await harness.client.callTool({
      name: "decision",
      arguments: { action: "candidates", repo_path: repoRoot, base: "no-such-ref" },
    });
    const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input: invalid base ref/);
  });

  it("routes to the addressed repo (a different repoB returns its own manifest)", async () => {
    // Build a second fixture repo with a different ADR title so we can
    // distinguish its manifest from `repoRoot`'s. Routing-correctness check:
    // calling with repoB must NOT return content from repoRoot.
    const repoB = mkdtempSync(join(tmpdir(), "cortex-candidates-fixture-B-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main", repoB]);
      execFileSync("git", ["-C", repoB, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repoB, "config", "user.name", "Test"]);

      const bAdrDir = join(repoB, "docs", "adr");
      mkdirSync(bAdrDir, { recursive: true });
      writeFileSync(
        join(bAdrDir, "0001-distinctive-b-title.md"),
        "# ADR 0001: distinctive-b-title-marker\n\n## Context\n\nx\n\n## Decision\n\ny\n",
      );
      execFileSync("git", ["-C", repoB, "add", "."]);
      execFileSync("git", ["-C", repoB, "commit", "--no-gpg-sign", "-m", "feat(b): seed distinctive ADR"]);
      const bCortexDir = join(repoB, ".cortex");
      mkdirSync(bCortexDir, { recursive: true });
      writeFileSync(join(bCortexDir, "db"), "");

      const result = await harness.client.callTool({
        name: "decision",
        arguments: { action: "candidates", repo_path: repoB, max_candidates: 5 },
      });
      const res = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(res.isError).toBeFalsy();
      const candidates = JSON.parse(res.content[0].text);
      expect(Array.isArray(candidates)).toBe(true);
      // The manifest must reference repoB's content, not repoRoot's.
      const text = JSON.stringify(candidates);
      expect(text).toContain("distinctive-b-title-marker");
      expect(text).not.toContain("sqlite-decisions");
    } finally {
      try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
    }
  });
});
