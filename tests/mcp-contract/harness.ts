import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphStore } from "../../src/graph/store.js";
import { registerCodeTools } from "../../src/mcp-server/tools/code-tools.js";
import { registerDecisionTools } from "../../src/mcp-server/tools/decision-tools.js";
import { registerPromotionTools } from "../../src/mcp-server/tools/promotion-tools.js";
import { registerPRTools } from "../../src/mcp-server/tools/pr-tools.js";
import { registerReconciliationTools } from "../../src/mcp-server/tools/reconciliation-tools.js";
import { registerTodoTools } from "../../src/mcp-server/tools/todo-tools.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";
import { PRService } from "../../src/prs/service.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../../src/decisions/migration.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

export interface HarnessContext {
  client: Client;
  store: GraphStore;
  project: string;
  fixtureDir: string;
  /** Absolute path the per-call resolver accepts for migrated tools.
   * `callTool` injects this as `repo_path` when the caller hasn't supplied
   * one — so existing contract tests continue to work unmodified. The
   * directory is a real git root with `.cortex/db` populated from the
   * global fixture, so `RepoContextResolver.resolve(repoPath)` succeeds. */
  repoPath: string;
  service: DecisionService;
  prService: PRService;
  resolver: RepoContextResolver;
  close: () => Promise<void>;
}

/**
 * Create a standalone indexed repo fixture suitable for the per-call
 * RepoContextResolver. Returns the absolute repo path. The repo contains a
 * fresh `.git` and a `.cortex/db` populated from the global fixture cortex.db.
 *
 * Tests that need a second repo to verify routing (e.g. "writes go to the
 * repo the caller addressed, not the cwd") use this helper. The returned
 * dir must be cleaned up by the caller via `rmSync(repoPath, { recursive: true })`.
 */
export function makeIndexedRepoFixture(opts?: { sourceCortexDb?: string }): string {
  const sourceDb = opts?.sourceCortexDb ?? process.env.CORTEX_CONTRACT_CORTEX_DB;
  if (!sourceDb) {
    throw new Error("makeIndexedRepoFixture: no source cortex.db (set CORTEX_CONTRACT_CORTEX_DB or pass sourceCortexDb).");
  }
  const root = mkdtempSync(join(tmpdir(), "cortex-repo-"));
  // git init: required by the resolver's git-root check.
  execSync(`git init -q "${root}"`, { stdio: "ignore" });
  mkdirSync(join(root, ".cortex"));
  copyFileSync(sourceDb, join(root, ".cortex", "db"));
  return root;
}

/**
 * Count decisions present in a repo's sidecar decisions.db. Used by routing
 * contract tests to assert that writes landed in the addressed repo (and not
 * in some other repo).
 */
export function countDecisions(repoPath: string): number {
  const decisionsDbPath = resolveDecisionsDbPath(repoPath);
  // The resolver creates the decisions.db lazily on first access; before
  // that, the file doesn't exist and the count is trivially zero.
  if (!existsSync(decisionsDbPath)) return 0;
  const db = openDecisionsDb(decisionsDbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
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

  // Contract tests exercise the index_repository tool *contract*, not frame
  // extraction. The server runs in-process here, so index_repository would
  // otherwise trigger runFrameExtraction (spawning Python) — slow and flaky
  // under parallel test load. Disable it for the harness lifetime; frame
  // extraction has its own coverage in run-frames.test.ts.
  const prevFrames = process.env.CORTEX_FRAMES;
  process.env.CORTEX_FRAMES = "0";

  // Per-test harness layout — a real indexed git repo so the per-call
  // resolver can resolve(repoPath) successfully. Phase 2 migrated tools
  // route through `<repoPath>/.cortex/db` and `<repoPath>/.cortex/decisions.db`;
  // legacy (unmigrated) tools also use these same files via the closure-
  // bound service/store below, so both code paths share state per-test.
  const harnessDir = mkdtempSync(join(tmpdir(), "cortex-harness-"));
  const repoPath = join(harnessDir, "repo");
  mkdirSync(repoPath);
  execSync(`git init -q "${repoPath}"`, { stdio: "ignore" });
  mkdirSync(join(repoPath, ".cortex"));
  const cortexDbPath = join(repoPath, ".cortex", "db");
  copyFileSync(sharedDbPath, cortexDbPath);

  const store = new GraphStore(cortexDbPath);

  // Sidecar decisions DB at the canonical location next to the per-test
  // cortex.db copy. The resolver lazily opens this same path when migrated
  // tools route here, so legacy + migrated handlers share state.
  const decisionsDbPath = join(repoPath, ".cortex", "decisions.db");
  const decisionsDb = openDecisionsDb(decisionsDbPath);
  migrateDecisionsFromGraphDb(decisionsDb, cortexDbPath);
  const decisionsRepo = new DecisionsRepository(decisionsDb);
  const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);

  // Legacy startup-bound services. After Phase 3 Group B, all tools route
  // per-call through the resolver — but the harness still exposes these on
  // HarnessContext for older tests that exercise the services directly
  // (e.g. seeding decisions outside the MCP surface).
  const service = new DecisionService({
    db: decisionsDb,
    decisions: decisionsRepo,
    links: decisionLinksRepo,
    project_id: project,
  });
  const promotion = new DecisionPromotion(decisionsRepo);
  const prService = new PRService(store, {
    default_actor: "tester",
    project_id: project,
    decisions: service,
    links: decisionLinksRepo,
  });

  // Per-call repo context resolver, mirroring server.ts's wiring. Tests
  // that need to exercise multi-repo routing pass a different repoPath
  // when calling migrated tools; the resolver opens that repo's DBs on
  // demand and caches them in its LRU pool.
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  const server = new McpServer({ name: "cortex-test", version: "0.0.0" });
  registerCodeTools(server, resolver);
  registerDecisionTools(server, resolver, project);
  registerPromotionTools(server, resolver, project);
  registerPRTools(server, resolver, project);
  registerReconciliationTools(server, resolver);
  registerTodoTools(server, resolver);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "cortex-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    store,
    project,
    fixtureDir,
    repoPath,
    service,
    prService,
    resolver,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      try { decisionsDb.close(); } catch { /* ignore */ }
      try { resolver.shutdown(); } catch { /* ignore */ }
      try { rmSync(harnessDir, { recursive: true }); } catch { /* ignore */ }
      if (prevFrames === undefined) delete process.env.CORTEX_FRAMES;
      else process.env.CORTEX_FRAMES = prevFrames;
    },
  };
}

/**
 * Call a tool by name. Auto-injects `repo_path` from the harness's primary
 * repo unless the caller already supplied one (set `repo_path: undefined`
 * explicitly to force omission — used by the "rejects when repo_path is
 * missing" contract test).
 *
 * As tools migrate through Phase 2 they begin requiring `repo_path`. This
 * default-injection keeps existing tests untouched while migrated tools
 * still validate routing on opt-in.
 */
export async function callTool(
  h: HarnessContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  let effective = args;
  if (!("repo_path" in args)) {
    effective = { repo_path: h.repoPath, ...args };
  } else if (args.repo_path === undefined) {
    // Caller explicitly opted out (sentinel for "rejects when missing" tests).
    const { repo_path: _omit, ...rest } = args;
    effective = rest;
  }
  const result = await h.client.callTool({ name, arguments: effective });
  return result as any;
}
