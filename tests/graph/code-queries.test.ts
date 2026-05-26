import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../../src/graph/store.js";
import { searchGraph, tracePath, getGraphSchema, listProjects, listProjectsUnified, indexStatus } from "../../src/graph/code-queries.js";

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
      "SELECT name FROM ctx_projects WHERE root_path = ?",
      [fixture]
    )[0];
    if (!row) throw new Error("no ctx_projects row");
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
    const hasIndexerRows = all.some((n) => n.id.startsWith("ctx-"));
    expect(hasIndexerRows).toBe(true);
  });

  it("listProjectsUnified includes bound-store projects + cache-resident projects", () => {
    // listProjects on the bound store knows about exactly this fixture project.
    const bound = listProjects(store);
    expect(bound.find((p) => p.name === project)).toBeDefined();

    // listProjectsUnified must include it too (passthrough) AND ideally surface
    // every other cache-resident project so the viewer / project-switcher can
    // see across the indexer's full registry. We can't assert cache size here
    // (the test machine may have an empty cache), but we can verify the bound
    // project is still present and that the function doesn't throw when the
    // cache dir is missing or has unreadable .db files.
    const unified = listProjectsUnified(store);
    expect(unified.find((p) => p.name === project)).toBeDefined();
    expect(unified.length).toBeGreaterThanOrEqual(bound.length);

    // Bound store wins on name conflict — the fixture project's root_path
    // must match the bound row, not be overwritten by any stale cache entry.
    const fixtureRow = unified.find((p) => p.name === project)!;
    expect(fixtureRow.root_path).toBe(bound.find((p) => p.name === project)!.root_path);
  });
});
