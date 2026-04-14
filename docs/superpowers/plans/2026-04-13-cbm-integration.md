# CBM Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque subprocess proxy to codebase-memory-mcp with a unified query surface using SQLite ATTACH, making code tools first-class SQL queries and merging code entities into the 3D viewer.

**Architecture:** Cortex ATTACHes CBM's SQLite database read-only via `ATTACH ... AS cbm`. Six code tools are rewritten as direct SQL queries against `cbm.*` tables. Three tools remain as subprocess calls (index, detect_changes, delete). The `/api/graph` endpoint returns a UNION ALL across both stores.

**Tech Stack:** TypeScript, better-sqlite3 (ATTACH), Node.js child_process (3 remaining tools)

**Spec:** `docs/superpowers/specs/2026-04-13-cbm-integration-design.md`

**CBM Schema Reference** (queried from live database):
```sql
-- CBM nodes
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects(name),
  label TEXT NOT NULL,        -- Function, Method, Class, Module, File, Folder, etc.
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT DEFAULT '',
  start_line INTEGER DEFAULT 0,
  end_line INTEGER DEFAULT 0,
  properties TEXT DEFAULT '{}',
  UNIQUE(project, qualified_name)
);

-- CBM edges
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects(name),
  source_id INTEGER NOT NULL REFERENCES nodes(id),
  target_id INTEGER NOT NULL REFERENCES nodes(id),
  type TEXT NOT NULL,          -- CALLS, IMPORTS, DEFINES, CONTAINS_FILE, etc.
  properties TEXT DEFAULT '{}',
  UNIQUE(source_id, target_id, type)
);

-- CBM projects
CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  indexed_at TEXT NOT NULL,
  root_path TEXT NOT NULL
);
```

**CBM DB location:** `~/.cache/codebase-memory-mcp/` with files named like `Users-rka-Development-cortex.db`

---

### Task 1: ATTACH infrastructure in GraphStore

**Files:**
- Modify: `src/graph/store.ts`
- Create: `tests/graph/cbm-attach.test.ts`

- [ ] **Step 1: Write failing test — attachCbm and isCbmAttached**

```typescript
// tests/graph/cbm-attach.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestCbmDb(dir: string): string {
  const dbPath = join(dir, "test-cbm.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE projects (
      name TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL,
      root_path TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      label TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      start_line INTEGER DEFAULT 0,
      end_line INTEGER DEFAULT 0,
      properties TEXT DEFAULT '{}'
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      properties TEXT DEFAULT '{}'
    );
    INSERT INTO projects VALUES ('test', '2026-04-13T00:00:00Z', '/test/repo');
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Function', 'handleRequest', 'src/server.ts::handleRequest', 'src/server.ts', 10, 25);
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Function', 'parseBody', 'src/server.ts::parseBody', 'src/server.ts', 30, 45);
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Class', 'Router', 'src/router.ts::Router', 'src/router.ts', 1, 80);
    INSERT INTO edges (project, source_id, target_id, type)
      VALUES ('test', 1, 2, 'CALLS');
    INSERT INTO edges (project, source_id, target_id, type)
      VALUES ('test', 3, 1, 'CALLS');
  `);
  db.close();
  return dbPath;
}

describe("CBM ATTACH", () => {
  let store: GraphStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches a CBM database and reports attached state", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    expect(store.isCbmAttached()).toBe(false);
    store.attachCbm(cbmPath);
    expect(store.isCbmAttached()).toBe(true);
  });

  it("returns false for isCbmAttached when no db attached", () => {
    expect(store.isCbmAttached()).toBe(false);
  });

  it("handles missing CBM database gracefully", () => {
    expect(() => store.attachCbm("/nonexistent/path.db")).not.toThrow();
    expect(store.isCbmAttached()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: FAIL with "store.attachCbm is not a function"

- [ ] **Step 3: Implement attachCbm and isCbmAttached in GraphStore**

Add to `src/graph/store.ts`, inside the `GraphStore` class, after the `close()` method:

```typescript
  private cbmAttached = false;

  isCbmAttached(): boolean {
    return this.cbmAttached;
  }

  attachCbm(dbPath: string): void {
    try {
      this.db.exec(`ATTACH DATABASE '${dbPath}' AS cbm`);
      // Verify it has the expected tables
      const tables = this.db
        .prepare("SELECT name FROM cbm.sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      if (tableNames.includes("nodes") && tableNames.includes("edges") && tableNames.includes("projects")) {
        this.cbmAttached = true;
      } else {
        this.db.exec("DETACH DATABASE cbm");
      }
    } catch {
      this.cbmAttached = false;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/graph/store.ts tests/graph/cbm-attach.test.ts
git commit -m "feat(graph): add CBM database ATTACH infrastructure"
```

---

### Task 2: CBM query module — searchGraph and getGraphSchema

**Files:**
- Create: `src/graph/cbm-queries.ts`
- Modify: `tests/graph/cbm-attach.test.ts`

- [ ] **Step 1: Write failing tests for searchGraph and getGraphSchema**

Add to `tests/graph/cbm-attach.test.ts`, inside the `describe("CBM ATTACH")` block:

```typescript
  it("searchGraph finds nodes by name pattern", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { searchGraph } = require("../../src/graph/cbm-queries.js");
    const results = searchGraph(store, "test", { name_pattern: "handle" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("handleRequest");
    expect(results[0].label).toBe("Function");
  });

  it("searchGraph finds nodes by label", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { searchGraph } = require("../../src/graph/cbm-queries.js");
    const results = searchGraph(store, "test", { label: "Class" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Router");
  });

  it("searchGraph finds nodes by qualified name pattern", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { searchGraph } = require("../../src/graph/cbm-queries.js");
    const results = searchGraph(store, "test", { qn_pattern: "src/router%" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Router");
  });

  it("getGraphSchema returns distinct labels and edge types", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { getGraphSchema } = require("../../src/graph/cbm-queries.js");
    const schema = getGraphSchema(store, "test");
    expect(schema.labels).toContain("Function");
    expect(schema.labels).toContain("Class");
    expect(schema.edgeTypes).toContain("CALLS");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: FAIL with "Cannot find module '../../src/graph/cbm-queries.js'"

- [ ] **Step 3: Implement cbm-queries.ts with searchGraph and getGraphSchema**

Create `src/graph/cbm-queries.ts`:

```typescript
import { GraphStore } from "./store.js";

export interface CbmNode {
  id: number;
  project: string;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  properties: string;
}

export interface CbmEdge {
  id: number;
  project: string;
  source_id: number;
  target_id: number;
  type: string;
  properties: string;
}

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string }
): CbmNode[] {
  const conditions: string[] = ["project = ?"];
  const values: unknown[] = [project];

  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.label) {
    conditions.push("label = ?");
    values.push(params.label);
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }

  return store.queryRaw<CbmNode>(
    `SELECT * FROM cbm.nodes WHERE ${conditions.join(" AND ")} LIMIT 100`,
    values
  );
}

export function getGraphSchema(
  store: GraphStore,
  project: string
): { labels: string[]; edgeTypes: string[] } {
  const labels = store
    .queryRaw<{ label: string }>(
      "SELECT DISTINCT label FROM cbm.nodes WHERE project = ?",
      [project]
    )
    .map((r) => r.label);

  const edgeTypes = store
    .queryRaw<{ type: string }>(
      "SELECT DISTINCT type FROM cbm.edges WHERE project = ?",
      [project]
    )
    .map((r) => r.type);

  return { labels, edgeTypes };
}
```

- [ ] **Step 4: Add queryRaw helper to GraphStore**

Add to `src/graph/store.ts` inside the `GraphStore` class:

```typescript
  queryRaw<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/graph/cbm-queries.ts src/graph/store.ts tests/graph/cbm-attach.test.ts
git commit -m "feat(graph): add searchGraph and getGraphSchema CBM queries"
```

---

### Task 3: CBM queries — tracePath, listProjects, indexStatus

**Files:**
- Modify: `src/graph/cbm-queries.ts`
- Modify: `tests/graph/cbm-attach.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/graph/cbm-attach.test.ts`:

```typescript
  it("tracePath follows CALLS edges outbound", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { tracePath } = require("../../src/graph/cbm-queries.js");
    // handleRequest (id=1) CALLS parseBody (id=2)
    const results = tracePath(store, "test", { function_name: "handleRequest", mode: "calls" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.name === "parseBody")).toBe(true);
  });

  it("tracePath follows CALLS edges inbound", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { tracePath } = require("../../src/graph/cbm-queries.js");
    // Router (id=3) CALLS handleRequest (id=1)
    const results = tracePath(store, "test", { function_name: "handleRequest", mode: "callers" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.name === "Router")).toBe(true);
  });

  it("listProjects returns all CBM projects", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { listProjects } = require("../../src/graph/cbm-queries.js");
    const projects = listProjects(store);
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe("test");
    expect(projects[0].root_path).toBe("/test/repo");
  });

  it("indexStatus returns project info for matching path", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { indexStatus } = require("../../src/graph/cbm-queries.js");
    const status = indexStatus(store, "/test/repo");
    expect(status).not.toBeNull();
    expect(status!.name).toBe("test");
  });

  it("indexStatus returns null for unindexed path", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);
    const { indexStatus } = require("../../src/graph/cbm-queries.js");
    const status = indexStatus(store, "/nonexistent");
    expect(status).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: FAIL with "tracePath is not a function"

- [ ] **Step 3: Implement tracePath, listProjects, indexStatus**

Add to `src/graph/cbm-queries.ts`:

```typescript
export interface CbmProject {
  name: string;
  indexed_at: string;
  root_path: string;
}

export function tracePath(
  store: GraphStore,
  project: string,
  params: { function_name: string; mode: string }
): CbmNode[] {
  // Find the starting node by name
  const startNodes = store.queryRaw<CbmNode>(
    "SELECT * FROM cbm.nodes WHERE project = ? AND name = ? LIMIT 1",
    [project, params.function_name]
  );
  if (startNodes.length === 0) return [];

  const startId = startNodes[0].id;
  const direction = params.mode === "callers" ? "inbound" : "outbound";

  // Recursive CTE to walk edges
  const sql =
    direction === "outbound"
      ? `WITH RECURSIVE trace(node_id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT e.target_id, t.depth + 1
           FROM cbm.edges e
           JOIN trace t ON e.source_id = t.node_id
           WHERE e.project = ? AND e.type IN ('CALLS', 'IMPORTS') AND t.depth < 5
         )
         SELECT DISTINCT n.* FROM cbm.nodes n
         JOIN trace t ON n.id = t.node_id
         WHERE n.id != ?`
      : `WITH RECURSIVE trace(node_id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT e.source_id, t.depth + 1
           FROM cbm.edges e
           JOIN trace t ON e.target_id = t.node_id
           WHERE e.project = ? AND e.type IN ('CALLS', 'IMPORTS') AND t.depth < 5
         )
         SELECT DISTINCT n.* FROM cbm.nodes n
         JOIN trace t ON n.id = t.node_id
         WHERE n.id != ?`;

  return store.queryRaw<CbmNode>(sql, [startId, project, startId]);
}

export function listProjects(store: GraphStore): CbmProject[] {
  return store.queryRaw<CbmProject>("SELECT * FROM cbm.projects");
}

export function indexStatus(store: GraphStore, rootPath: string): CbmProject | null {
  const results = store.queryRaw<CbmProject>(
    "SELECT * FROM cbm.projects WHERE root_path = ?",
    [rootPath]
  );
  return results[0] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/graph/cbm-queries.ts tests/graph/cbm-attach.test.ts
git commit -m "feat(graph): add tracePath, listProjects, indexStatus CBM queries"
```

---

### Task 4: CBM discovery — find the right database file

**Files:**
- Create: `src/graph/cbm-discovery.ts`
- Modify: `tests/graph/cbm-attach.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/graph/cbm-attach.test.ts`:

```typescript
  it("discoverCbmDb finds database by root_path match", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    const { discoverCbmDb } = require("../../src/graph/cbm-discovery.js");
    const found = discoverCbmDb("/test/repo", tmpDir);
    expect(found).toBe(cbmPath);
  });

  it("discoverCbmDb returns null when no match", () => {
    createTestCbmDb(tmpDir);
    const { discoverCbmDb } = require("../../src/graph/cbm-discovery.js");
    const found = discoverCbmDb("/nonexistent", tmpDir);
    expect(found).toBeNull();
  });

  it("discoverCbmDb uses CBM_DB_PATH env if set", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    const { discoverCbmDb } = require("../../src/graph/cbm-discovery.js");
    const found = discoverCbmDb("/whatever", tmpDir, cbmPath);
    expect(found).toBe(cbmPath);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: FAIL with "Cannot find module '../../src/graph/cbm-discovery.js'"

- [ ] **Step 3: Implement cbm-discovery.ts**

Create `src/graph/cbm-discovery.ts`:

```typescript
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CBM_DIR = join(homedir(), ".cache", "codebase-memory-mcp");

export function discoverCbmDb(
  rootPath: string,
  cbmDir: string = DEFAULT_CBM_DIR,
  explicitPath?: string
): string | null {
  // Explicit path takes priority
  if (explicitPath) {
    try {
      const db = new Database(explicitPath, { readonly: true });
      db.close();
      return explicitPath;
    } catch {
      return null;
    }
  }

  // Scan cbmDir for .db files
  let files: string[];
  try {
    files = readdirSync(cbmDir).filter((f) => f.endsWith(".db"));
  } catch {
    return null;
  }

  for (const file of files) {
    const dbPath = join(cbmDir, file);
    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare("SELECT root_path FROM projects WHERE root_path = ?")
        .all(rootPath) as Array<{ root_path: string }>;
      db.close();
      if (rows.length > 0) return dbPath;
    } catch {
      continue;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: 15 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/graph/cbm-discovery.ts tests/graph/cbm-attach.test.ts
git commit -m "feat(graph): add CBM database discovery by root_path"
```

---

### Task 5: Unified graph queries for `/api/graph`

**Files:**
- Modify: `src/graph/store.ts`
- Modify: `tests/graph/cbm-attach.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/graph/cbm-attach.test.ts`:

```typescript
  it("getAllNodesUnified returns nodes from both stores", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);

    // Create a decision node in Cortex's store
    store.createNode({ kind: "decision", name: "Use Express", data: { description: "test" } });

    const nodes = store.getAllNodesUnified("test");
    const cortexNodes = nodes.filter((n) => !n.id.startsWith("cbm-"));
    const cbmNodes = nodes.filter((n) => n.id.startsWith("cbm-"));

    expect(cortexNodes.length).toBe(1);
    expect(cortexNodes[0].name).toBe("Use Express");
    expect(cbmNodes.length).toBe(3); // handleRequest, parseBody, Router
    expect(cbmNodes[0].kind).toBe("function"); // lowercase mapped
  });

  it("getAllEdgesUnified returns edges from both stores", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    store.attachCbm(cbmPath);

    const edges = store.getAllEdgesUnified("test");
    const cbmEdges = edges.filter((e) => e.id.startsWith("cbm-"));

    expect(cbmEdges.length).toBe(2); // two CALLS edges
    expect(cbmEdges[0].source_id.startsWith("cbm-")).toBe(true);
    expect(cbmEdges[0].relation).toBe("CALLS");
  });

  it("getAllNodesUnified works without CBM attached", () => {
    store.createNode({ kind: "decision", name: "Test decision" });
    const nodes = store.getAllNodesUnified();
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe("Test decision");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: FAIL with "store.getAllNodesUnified is not a function"

- [ ] **Step 3: Implement getAllNodesUnified and getAllEdgesUnified**

Add to `src/graph/store.ts` inside the `GraphStore` class:

```typescript
  private static readonly CBM_LABEL_MAP: Record<string, string> = {
    Function: "function",
    Method: "function",
    Class: "component",
    Module: "component",
    Interface: "component",
    File: "path",
    Package: "path",
    Folder: "path",
  };

  getAllNodesUnified(cbmProject?: string): NodeRow[] {
    const cortexNodes = this.getAllNodes();

    if (!this.cbmAttached || !cbmProject) return cortexNodes;

    const cbmNodes = this.db
      .prepare(
        `SELECT
          'cbm-' || CAST(id AS TEXT) AS id,
          LOWER(label) AS kind,
          name,
          qualified_name,
          file_path,
          properties AS data,
          'personal' AS tier,
          (SELECT indexed_at FROM cbm.projects WHERE name = ?) AS created_at,
          (SELECT indexed_at FROM cbm.projects WHERE name = ?) AS updated_at
        FROM cbm.nodes WHERE project = ?`
      )
      .all(cbmProject, cbmProject, cbmProject) as NodeRow[];

    // Apply label-to-kind mapping
    for (const node of cbmNodes) {
      const mapped = GraphStore.CBM_LABEL_MAP[node.kind.charAt(0).toUpperCase() + node.kind.slice(1)];
      if (mapped) node.kind = mapped;
    }

    return [...cortexNodes, ...cbmNodes];
  }

  getAllEdgesUnified(cbmProject?: string): EdgeRow[] {
    const cortexEdges = this.getAllEdges();

    if (!this.cbmAttached || !cbmProject) return cortexEdges;

    const cbmEdges = this.db
      .prepare(
        `SELECT
          'cbm-' || CAST(id AS TEXT) AS id,
          'cbm-' || CAST(source_id AS TEXT) AS source_id,
          'cbm-' || CAST(target_id AS TEXT) AS target_id,
          type AS relation,
          properties AS data,
          (SELECT indexed_at FROM cbm.projects WHERE name = ?) AS created_at
        FROM cbm.edges WHERE project = ?`
      )
      .all(cbmProject, cbmProject) as EdgeRow[];

    return [...cortexEdges, ...cbmEdges];
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/cbm-attach.test.ts`
Expected: 18 tests PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All tests PASS (52 existing + 18 new = 70)

- [ ] **Step 6: Commit**

```bash
git add src/graph/store.ts tests/graph/cbm-attach.test.ts
git commit -m "feat(graph): unified getAllNodesUnified/getAllEdgesUnified across stores"
```

---

### Task 6: Rewrite code-tools.ts — SQL-based tools

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts`

- [ ] **Step 1: Rewrite code-tools.ts**

Replace the entire contents of `src/mcp-server/tools/code-tools.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { GraphStore } from "../graph/store.js";
import {
  searchGraph,
  tracePath,
  getGraphSchema,
  listProjects,
  indexStatus,
  CbmNode,
} from "../graph/cbm-queries.js";

const execFileAsync = promisify(execFile);
const CBM_BINARY = process.env.CBM_BINARY_PATH || "codebase-memory-mcp";

async function callCbm(tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(CBM_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      error: `codebase-memory-mcp call failed: ${message}. Set CBM_BINARY_PATH if the binary is not in PATH.`,
    });
  }
}

function formatNodes(nodes: CbmNode[]): string {
  if (nodes.length === 0) return "No results found.";
  return nodes
    .map((n) => `${n.label} ${n.qualified_name} (${n.file_path}:${n.start_line}-${n.end_line})`)
    .join("\n");
}

export function registerCodeTools(server: McpServer, store: GraphStore, cbmProject: string | null): void {
  // --- Subprocess tools (3) ---

  server.tool(
    "index_repository",
    "Index a repository into the knowledge graph",
    {
      path: z.string().optional().describe("Repository path (default: current directory)"),
    },
    async ({ path }) => {
      const result = await callCbm("index_repository", path ? { path } : {});
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "detect_changes",
    "Map git diff to affected symbols in the knowledge graph",
    {
      path: z.string().optional().describe("Repository path"),
    },
    async ({ path }) => {
      const result = await callCbm("detect_changes", path ? { path } : {});
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "delete_project",
    "Remove a project from the code index",
    {
      project: z.string().describe("Project name to delete"),
    },
    async ({ project }) => {
      const result = await callCbm("delete_project", { project });
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // --- SQL-based tools (6) ---

  server.tool(
    "search_graph",
    "Search the knowledge graph for code entities by name, label, or qualified name pattern",
    {
      name_pattern: z.string().optional(),
      label: z.string().optional(),
      qn_pattern: z.string().optional(),
    },
    async (params) => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const results = searchGraph(store, cbmProject, params);
      return { content: [{ type: "text" as const, text: formatNodes(results) }] };
    }
  );

  server.tool(
    "trace_path",
    "Trace call chains from a function (mode: calls, callers)",
    {
      function_name: z.string(),
      mode: z.string().describe("Trace mode: calls (outbound) or callers (inbound)"),
    },
    async (params) => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const results = tracePath(store, cbmProject, params);
      return { content: [{ type: "text" as const, text: formatNodes(results) }] };
    }
  );

  server.tool(
    "get_code_snippet",
    "Get source code for a fully qualified name",
    {
      qualified_name: z.string(),
    },
    async ({ qualified_name }) => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const nodes = searchGraph(store, cbmProject, { qn_pattern: qualified_name });
      if (nodes.length === 0) {
        return { content: [{ type: "text" as const, text: `No code entity found for: ${qualified_name}` }] };
      }
      const node = nodes[0];
      try {
        const content = await readFile(node.file_path, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, node.start_line - 1);
        const end = Math.min(lines.length, node.end_line);
        const snippet = lines.slice(start, end).join("\n");
        return {
          content: [{
            type: "text" as const,
            text: `// ${node.qualified_name} (${node.file_path}:${node.start_line}-${node.end_line})\n${snippet}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error reading file: ${msg}` }] };
      }
    }
  );

  server.tool(
    "get_graph_schema",
    "List node labels, edge types, and their counts in the knowledge graph",
    {},
    async () => {
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
      }
      const schema = getGraphSchema(store, cbmProject);
      return {
        content: [{
          type: "text" as const,
          text: `Labels: ${schema.labels.join(", ")}\nEdge types: ${schema.edgeTypes.join(", ")}`,
        }],
      };
    }
  );

  server.tool(
    "list_projects",
    "List all indexed projects",
    {},
    async () => {
      if (!store.isCbmAttached()) {
        return { content: [{ type: "text" as const, text: "No CBM database attached." }] };
      }
      const projects = listProjects(store);
      if (projects.length === 0) {
        return { content: [{ type: "text" as const, text: "No projects indexed." }] };
      }
      const text = projects
        .map((p) => `${p.name} — ${p.root_path} (indexed: ${p.indexed_at})`)
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "index_status",
    "Check if a repository is indexed",
    {
      path: z.string().optional().describe("Repository path to check (default: current directory)"),
    },
    async ({ path }) => {
      if (!store.isCbmAttached()) {
        return { content: [{ type: "text" as const, text: "No CBM database attached." }] };
      }
      const cwd = path || process.cwd();
      const status = indexStatus(store, cwd);
      if (!status) {
        return { content: [{ type: "text" as const, text: `Not indexed: ${cwd}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Indexed: ${status.name} at ${status.root_path} (last: ${status.indexed_at})`,
        }],
      };
    }
  );

  server.tool(
    "search_code",
    "Search source code with graph-enriched results (shows which function/class each match belongs to)",
    {
      pattern: z.string(),
    },
    async ({ pattern }) => {
      // Run ripgrep
      let grepOutput: string;
      try {
        const { stdout } = await execFileAsync("rg", [
          "--no-heading", "--line-number", "--color=never", pattern, ".",
        ], { timeout: 10_000 });
        grepOutput = stdout;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          // Fallback to grep
          try {
            const { stdout } = await execFileAsync("grep", [
              "-rn", pattern, ".",
            ], { timeout: 10_000 });
            grepOutput = stdout;
          } catch {
            return { content: [{ type: "text" as const, text: "No matches found." }] };
          }
        } else if (error.stdout) {
          grepOutput = error.stdout;
        } else {
          return { content: [{ type: "text" as const, text: "No matches found." }] };
        }
      }

      if (!grepOutput.trim()) {
        return { content: [{ type: "text" as const, text: "No matches found." }] };
      }

      // Enrich with graph context if CBM is attached
      if (!store.isCbmAttached() || !cbmProject) {
        return { content: [{ type: "text" as const, text: grepOutput }] };
      }

      const lines = grepOutput.trim().split("\n").slice(0, 50);
      const enriched = lines.map((line) => {
        const match = line.match(/^\.\/(.+?):(\d+):/);
        if (!match) return line;
        const [, filePath, lineNum] = match;
        const lineNumber = parseInt(lineNum, 10);
        const enclosing = store.queryRaw<CbmNode>(
          `SELECT * FROM cbm.nodes
           WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
           ORDER BY (end_line - start_line) ASC LIMIT 1`,
          [cbmProject, filePath, lineNumber, lineNumber]
        );
        if (enclosing.length > 0) {
          return `${line}  // in ${enclosing[0].label} ${enclosing[0].qualified_name}`;
        }
        return line;
      });

      return { content: [{ type: "text" as const, text: enriched.join("\n") }] };
    }
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat(tools): rewrite code tools — 6 SQL-based, 1 file read, 3 subprocess"
```

---

### Task 7: Update server wiring — pass store and cbmProject to code tools

**Files:**
- Modify: `src/mcp-server/server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Read server.ts to understand current wiring**

Read `src/mcp-server/server.ts` to see how `registerCodeTools` is currently called.

- [ ] **Step 2: Update server.ts to pass store and cbmProject**

The `registerCodeTools` signature changed from `(server)` to `(server, store, cbmProject)`. Update the call in `server.ts` accordingly. The `createServer` function already receives `store` — just pass it through along with a `cbmProject` parameter.

Update `src/mcp-server/server.ts` — change the `registerCodeTools(server)` call to `registerCodeTools(server, store, cbmProject)` and add `cbmProject` as a parameter to `createServer`.

- [ ] **Step 3: Update index.ts — add CBM discovery and attach**

Update `src/index.ts` to discover and attach the CBM database before creating the server:

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";
import { discoverCbmDb } from "./graph/cbm-discovery.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);

// Discover and attach CBM database
const cwd = process.cwd();
const cbmDbPath = discoverCbmDb(cwd, undefined, process.env.CBM_DB_PATH);
let cbmProject: string | null = null;

if (cbmDbPath) {
  store.attachCbm(cbmDbPath);
  if (store.isCbmAttached()) {
    // Find the project name for this root path
    const projects = store.queryRaw<{ name: string }>(
      "SELECT name FROM cbm.projects WHERE root_path = ?",
      [cwd]
    );
    cbmProject = projects[0]?.name ?? null;
    process.stderr.write(`Cortex: attached CBM database (project: ${cbmProject})\n`);
  }
}

const server = createServer(store, cbmProject);

const viewerPort = await startViewerServer(store, cbmProject);
process.stderr.write(`Cortex viewer: http://localhost:${viewerPort}/viewer\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Update startViewerServer signature in api.ts**

Update `src/mcp-server/api.ts` — change `startViewerServer(store: GraphStore)` to `startViewerServer(store: GraphStore, cbmProject?: string | null)`, and update `/api/graph` to use `store.getAllNodesUnified(cbmProject)` and `store.getAllEdgesUnified(cbmProject)`:

```typescript
export function startViewerServer(store: GraphStore, cbmProject?: string | null): Promise<number> {
  return new Promise((resolve) => {
    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url === "/api/graph") {
        const nodes = store.getAllNodesUnified(cbmProject ?? undefined);
        const rawEdges = store.getAllEdgesUnified(cbmProject ?? undefined);
        const edges = rawEdges.map((e) => ({
          ...e,
          source: e.source_id,
          target: e.target_id,
        }));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ nodes, edges }));
        return;
      }

      // ... rest unchanged
```

- [ ] **Step 5: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/mcp-server/server.ts src/mcp-server/api.ts
git commit -m "feat: wire CBM discovery and ATTACH into server startup"
```

---

### Task 8: Manual integration test

**Files:**
- No file changes — verification only.

- [ ] **Step 1: Ensure Cortex repo is indexed in CBM**

```bash
codebase-memory-mcp cli index_repository '{"path":"/Users/rka/Development/cortex"}'
```

If CBM binary is not in PATH, use the full path from `CBM_BINARY_PATH`.

- [ ] **Step 2: Start Cortex dev server**

```bash
npm run dev
```

Check stderr output — expect to see:
```
Cortex: attached CBM database (project: ...)
Cortex viewer: http://localhost:3333/viewer
```

- [ ] **Step 3: Open viewer and verify unified graph**

Open `http://localhost:3333/viewer` in a browser. Expect to see:
- Decision nodes (from seed data) in amber octahedrons
- Code entities from CBM (functions, classes, files) as teal/green/grey spheres
- CALLS/IMPORTS edges from CBM alongside GOVERNS/SUPERSEDES edges from Cortex

- [ ] **Step 4: Test MCP tools via the viewer API**

```bash
# Test search_graph
curl -s http://localhost:3333/api/graph | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Nodes: {len(d[\"nodes\"])}, Edges: {len(d[\"edges\"])}')"
```

Expect node count to be significantly higher than the 14 seed nodes (should include CBM's ~300 nodes).

- [ ] **Step 5: Commit any final adjustments**

```bash
git add -A
git commit -m "feat: CBM integration — unified graph via ATTACH (complete)"
```
