/**
 * Regression — cross-repo decision search must not return one repo's decisions
 * once per registered CHECKOUT.
 *
 * Every worktree of a repo resolves to the SAME decisions store (`repoId` comes
 * from the committed `cortex.json`, on the repo-identity axis). The
 * per-worktree-index work both registers worktree rows and stops collapsing
 * them in `resolve()`, so a naive fan-out over registry rows searches the same
 * decisions store once per checkout and reports the same decision N times under
 * N different repo names.
 *
 * Both directions matter: addressing the MAIN checkout (the worktree row is the
 * duplicate) and addressing the WORKTREE (the main row is the duplicate).
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

let base: string;
let main: string;
let wt: string;
let registryDir: string;
let savedRegistryEnv: string | undefined;
let client: Client;
let server: McpServer;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] });

/** Production layout: a zero-byte `.cortex/db` satisfies the resolver's
 *  indexed-repo check (GraphStore runs idempotent migrations on it). */
function seedStore(root: string): void {
  mkdirSync(join(root, ".cortex"), { recursive: true });
  writeFileSync(join(root, ".cortex", "db"), "");
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function call(args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "decision", arguments: args })) as ToolResult;
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-xrepo-wt-")));
  main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "--initial-branch=main");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  writeFileSync(join(main, "README.md"), "# fixture\n");
  git(main, "add", ".");
  git(main, "commit", "--no-gpg-sign", "-m", "chore: seed");
  wt = join(base, "wt");
  git(main, "worktree", "add", "-b", "feature/x", wt);
  seedStore(main);
  seedStore(wt);

  registryDir = mkdtempSync(join(tmpdir(), "cortex-xrepo-wt-registry-"));
  savedRegistryEnv = process.env.CORTEX_REGISTRY_DB;
  process.env.CORTEX_REGISTRY_DB = join(registryDir, "registry.db");
  const registry = new Registry();
  registry.register("xrepo-wt-main", main);
  registry.register("xrepo-wt-feature", wt, new Date().toISOString(), {
    worktree_of: main,
    branch: "feature/x",
  });
  registry.close();

  server = new McpServer({ name: "cortex-xrepo-wt-test", version: "0.0.0" });
  registerDecisionDispatcher(server, new RepoContextResolver({ poolCapacity: 4 }), "test-xrepo-wt");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "cortex-xrepo-wt-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const created = await call({
    action: "create",
    repo_path: main,
    title: "Use gammastore for storage",
    description: "We adopt gammastore as the storage engine.",
    rationale: "gammastore fits the workload.",
  });
  expect(created.isError).toBeFalsy();
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  if (savedRegistryEnv === undefined) delete process.env.CORTEX_REGISTRY_DB;
  else process.env.CORTEX_REGISTRY_DB = savedRegistryEnv;
  for (const p of [base, registryDir]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Every decision id across every repo group, duplicates included. */
function allIds(text: string): string[] {
  const payload = JSON.parse(text) as {
    repos: Array<{ decisions: Array<{ id: string }> }>;
  };
  return payload.repos.flatMap((r) => r.decisions.map((d) => d.id));
}

describe("cross_repo search dedupes registered worktrees", () => {
  it("addressed from the MAIN checkout, each decision appears exactly once", async () => {
    const res = await call({
      action: "search", repo_path: main, query: "gammastore", cross_repo: true,
    });
    expect(res.isError).toBeFalsy();
    const ids = allIds(res.content[0].text);
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("addressed from the WORKTREE, each decision appears exactly once", async () => {
    const res = await call({
      action: "search", repo_path: wt, query: "gammastore", cross_repo: true,
    });
    expect(res.isError).toBeFalsy();
    const ids = allIds(res.content[0].text);
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the worktree row does not appear as its own repo group", async () => {
    const res = await call({
      action: "search", repo_path: main, query: "gammastore", cross_repo: true,
    });
    const payload = JSON.parse(res.content[0].text) as { repos: Array<{ path: string }> };
    expect(payload.repos.map((r) => r.path)).not.toContain(wt);
  });
});
