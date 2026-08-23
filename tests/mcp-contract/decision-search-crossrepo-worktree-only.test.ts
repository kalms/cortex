/**
 * Regression — cross-repo decision search must not DROP a repo whose ONLY
 * registered checkout is a linked worktree.
 *
 * Per-worktree indexing means a repo can be indexed from a linked worktree
 * while its main checkout is never indexed at all — so the registry can
 * legitimately hold a worktree row with no canonical row alongside it. The
 * dedupe guard added for the worktree-fan-out regression
 * (`decision-search-crossrepo-worktree.test.ts`) skipped every row carrying
 * `worktree_of` unconditionally, on the assumption a canonical row always
 * covers it. When no canonical row is registered, that assumption is false:
 * the worktree row is the ONLY row that can ever search that repo's shared
 * decisions store, so skipping it unconditionally makes the repo invisible
 * to cross-repo search — with no `skipped` entry to signal the gap.
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
let seeker: string;
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

function makeRepo(prefix: string): string {
  // realpathSync: macOS tmpdir is a symlink (/var → /private/var); the
  // resolver canonicalizes, so fixture paths must be canonical too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, "add", ".");
  git(root, "commit", "--no-gpg-sign", "-m", "chore: seed");
  return root;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function call(args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "decision", arguments: args })) as ToolResult;
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-xrepo-wtonly-")));
  main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "--initial-branch=main");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  writeFileSync(join(main, "README.md"), "# fixture\n");
  git(main, "add", ".");
  git(main, "commit", "--no-gpg-sign", "-m", "chore: seed");
  wt = join(base, "wt");
  git(main, "worktree", "add", "-b", "feature/y", wt);
  // The main checkout is NEVER indexed — only the worktree is. This is
  // exactly the layout per-worktree indexing enables.
  seedStore(wt);

  seeker = makeRepo("cortex-xrepo-wtonly-seeker-");
  seedStore(seeker);

  registryDir = mkdtempSync(join(tmpdir(), "cortex-xrepo-wtonly-registry-"));
  savedRegistryEnv = process.env.CORTEX_REGISTRY_DB;
  process.env.CORTEX_REGISTRY_DB = join(registryDir, "registry.db");
  const registry = new Registry();
  // Only the worktree row is registered — no canonical row for `main` exists
  // anywhere in the registry.
  registry.register("xrepo-wtonly-feature", wt, new Date().toISOString(), {
    worktree_of: main,
    branch: "feature/y",
  });
  registry.close();

  server = new McpServer({ name: "cortex-xrepo-wtonly-test", version: "0.0.0" });
  registerDecisionDispatcher(server, new RepoContextResolver({ poolCapacity: 4 }), "test-xrepo-wtonly");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "cortex-xrepo-wtonly-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const created = await call({
    action: "create",
    repo_path: wt,
    title: "Use deltastore for storage",
    description: "We adopt deltastore as the storage engine.",
    rationale: "deltastore fits the workload.",
  });
  expect(created.isError).toBeFalsy();
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  if (savedRegistryEnv === undefined) delete process.env.CORTEX_REGISTRY_DB;
  else process.env.CORTEX_REGISTRY_DB = savedRegistryEnv;
  for (const p of [base, seeker, registryDir]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("cross_repo search does not drop a worktree-only registered repo", () => {
  it("finds the decision via its only (worktree) registry row", async () => {
    const res = await call({
      action: "search", repo_path: seeker, query: "deltastore", cross_repo: true,
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as {
      repos: Array<{ path: string; decisions: Array<{ title: string }> }>;
    };
    const allTitles = payload.repos.flatMap((r) => r.decisions.map((d) => d.title));
    expect(allTitles.some((t) => t.includes("deltastore"))).toBe(true);
  });
});
