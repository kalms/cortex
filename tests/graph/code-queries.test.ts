import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../../src/graph/store.js";
import { searchGraph, tracePath, getGraphSchema, listProjects, indexStatus } from "../../src/graph/code-queries.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "cortex-indexer");

describe("code-queries against unified cortex.db", () => {
  let workDir: string;
  let store: GraphStore;
  let project: string;

  beforeAll(() => {
    if (!existsSync(BINARY)) {
      throw new Error(`bin/cortex-indexer not found — run npm install first`);
    }
    workDir = mkdtempSync(join(tmpdir(), "cortex-code-queries-"));
    const fixture = join(workDir, "sample-project");
    cpSync(FIXTURE_SRC, fixture, { recursive: true });

    const cortexDbPath = resolve(join(workDir, "cortex.db"));
    execFileSync(BINARY, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, CORTEX_DB: cortexDbPath },
    });

    store = new GraphStore(cortexDbPath);
    const row = store.queryRaw<{ name: string }>(
      "SELECT name FROM cbm_projects WHERE root_path = ?",
      [fixture]
    )[0];
    if (!row) throw new Error("no cbm_projects row");
    project = row.name;
  }, 60_000);

  afterAll(() => {
    store?.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("searchGraph returns matches by name pattern", () => {
    const results = searchGraph(store, project, { name_pattern: "handleRequest" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toContain("handleRequest");
  });

  it("getGraphSchema returns label and edge type counts", () => {
    const schema = getGraphSchema(store, project);
    expect(schema.labels.length).toBeGreaterThan(0);
    expect(schema.edgeTypes.length).toBeGreaterThan(0);
  });

  it("tracePath returns reachable nodes for a known function", () => {
    const trace = tracePath(store, project, { function_name: "handleRequest", mode: "calls" });
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0]).toHaveProperty("depth");
  });

  it("listProjects returns the indexed project", () => {
    const projects = listProjects(store);
    expect(projects.find((p) => p.name === project)).toBeDefined();
  });

  it("indexStatus returns the project for the fixture root", () => {
    const all = listProjects(store);
    const proj = all.find((p) => p.name === project);
    expect(proj).toBeDefined();
    const status = indexStatus(store, proj!.root_path);
    expect(status).not.toBeNull();
    expect(status!.name).toBe(project);
  });

  it("getAllNodesUnified returns merged Cortex + indexer rows", () => {
    const all = store.getAllNodesUnified(project);
    const hasIndexerRows = all.some((n) => n.id.startsWith("cbm-"));
    expect(hasIndexerRows).toBe(true);
  });
});
