/**
 * MCP contract test for the `decision` dispatcher's `search` action in
 * `cross_repo: true` mode (P5 — cross-repo decision search).
 *
 * Fixture: TWO real git repos, each with the production `.cortex` layout
 * (zero-byte `.cortex/db` the resolver migrates, sidecar decisions created
 * through the real MCP boundary). Repo A is the addressed repo; repo B is
 * discoverable only through the master Registry, which is redirected to a
 * temp file via CORTEX_REGISTRY_DB so the real XDG registry is never read
 * or polluted. A third registry row points at a path that is not a repo at
 * all — it must land in `skipped`, never fail the call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { registerDecisionDispatcher } from "../../src/mcp-server/tools/decision-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { Registry } from "../../src/db/registry.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

interface MinimalHarness {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

let repoA: string;
let repoB: string;
let ghostPath: string;
let registryDir: string;
let harness: MinimalHarness;
let savedRegistryEnv: string | undefined;

function makeRepo(prefix: string): string {
  // realpathSync: macOS tmpdir is a symlink (/var → /private/var); the
  // resolver canonicalizes, so fixture paths must be canonical too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "--initial-branch=main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "--no-gpg-sign", "-m", "chore: seed"]);
  // Production layout: zero-byte .cortex/db satisfies the resolver's
  // indexed-repo check (GraphStore runs idempotent migrations on it).
  mkdirSync(join(root, ".cortex"), { recursive: true });
  writeFileSync(join(root, ".cortex", "db"), "");
  return root;
}

async function buildHarness(): Promise<MinimalHarness> {
  const server = new McpServer({ name: "cortex-crossrepo-test", version: "0.0.0" });
  const resolver = new RepoContextResolver({ poolCapacity: 4 });
  registerDecisionDispatcher(server, resolver, "test-crossrepo");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "cortex-crossrepo-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  const result = await harness.client.callTool({ name: "decision", arguments: args });
  return result as ToolResult;
}

describe("decision search cross_repo mode", () => {
  beforeAll(async () => {
    repoA = makeRepo("cortex-crossrepo-A-");
    repoB = makeRepo("cortex-crossrepo-B-");
    ghostPath = join(mkdtempSync(join(tmpdir(), "cortex-crossrepo-ghost-")), "not-a-repo");

    // Redirect the master registry to a temp file BEFORE any fan-out runs.
    registryDir = mkdtempSync(join(tmpdir(), "cortex-crossrepo-registry-"));
    savedRegistryEnv = process.env.CORTEX_REGISTRY_DB;
    process.env.CORTEX_REGISTRY_DB = join(registryDir, "registry.db");
    const registry = new Registry();
    registry.register("crossrepo-fixture-b", repoB);
    registry.register("crossrepo-fixture-ghost", ghostPath);
    registry.close();

    harness = await buildHarness();

    // Seed one distinctive decision per repo through the real MCP boundary.
    const mkDecision = async (repo_path: string, marker: string) => {
      const res = await call({
        action: "create",
        repo_path,
        title: `Use ${marker} for storage`,
        description: `We adopt ${marker} as the storage engine.`,
        rationale: `${marker} fits the workload.`,
      });
      expect(res.isError).toBeFalsy();
    };
    await mkDecision(repoA, "alphastore");
    await mkDecision(repoB, "betastore");
  });

  afterAll(async () => {
    if (harness) await harness.close();
    if (savedRegistryEnv === undefined) delete process.env.CORTEX_REGISTRY_DB;
    else process.env.CORTEX_REGISTRY_DB = savedRegistryEnv;
    for (const p of [repoA, repoB, registryDir]) {
      try { rmSync(p, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it("without cross_repo, a repo-B term is not found from repo A", async () => {
    const res = await call({ action: "search", repo_path: repoA, query: "betastore" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/^No results:/);
  });

  it("with cross_repo, hits from other registered repos come back tagged by repo", async () => {
    const res = await call({ action: "search", repo_path: repoA, query: "betastore", cross_repo: true });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();

    const payload = JSON.parse(res.content[0].text);
    expect(payload.query).toBe("betastore");
    expect(Array.isArray(payload.repos)).toBe(true);
    // Only repo B holds the term — exactly one repo group with one decision.
    expect(payload.repos.length).toBe(1);
    expect(payload.repos[0].path).toBe(repoB);
    expect(payload.repos[0].decisions.length).toBe(1);
    expect(payload.repos[0].decisions[0].title).toContain("betastore");
  });

  it("the addressed repo's hits come first when both repos match", async () => {
    const res = await call({ action: "search", repo_path: repoA, query: "storage", cross_repo: true });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.repos.length).toBe(2);
    expect(payload.repos[0].path).toBe(repoA);
    expect(payload.repos[1].path).toBe(repoB);
  });

  it("an unresolvable registry row lands in skipped, not an error", async () => {
    const res = await call({ action: "search", repo_path: repoA, query: "storage", cross_repo: true });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    const skippedPaths = (payload.skipped as Array<{ path: string }>).map((s) => s.path);
    expect(skippedPaths).toContain(ghostPath);
  });

  it("scope combined with cross_repo is malformed_input", async () => {
    const res = await call({
      action: "search", repo_path: repoA, query: "storage", cross_repo: true, scope: "src/a.ts",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input/);
  });

  it("cross_repo with zero hits but skipped repos returns the partial-answer payload", async () => {
    // A ghost registry row means the answer is PARTIAL — the caller must see
    // `skipped`, not a clean "No results" that implies full coverage.
    const res = await call({ action: "search", repo_path: repoA, query: "nonexistentterm", cross_repo: true });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.repos).toEqual([]);
    expect((payload.skipped as Array<{ path: string }>).map((s) => s.path)).toContain(ghostPath);
  });
});
