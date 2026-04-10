# Anthill Cortex Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Anthill Cortex Phase 1 — a TypeScript MCP server that combines structural code indexing (via codebase-memory-mcp) with decision provenance on a SQLite knowledge graph, plus a D3 graph viewer.

**Architecture:** TypeScript MCP server running on stdio. `better-sqlite3` for storage using a nodes+edges+annotations schema. Decision CRUD, full-text search (FTS5), and tier promotion built natively. Code indexing tools proxied to the existing `codebase-memory-mcp` C binary via CLI. A lightweight HTTP server serves the D3 force-directed graph viewer and a `/api/graph` JSON endpoint.

**Tech Stack:** TypeScript, Node.js 20+, better-sqlite3, @modelcontextprotocol/sdk, zod, vitest, D3.js v7

**Design Spec:** `docs/superpowers/specs/2026-04-10-anthill-cortex-phase1-design.md`

---

## File Structure

```
anthill-cortex/
  package.json
  tsconfig.json
  vitest.config.ts
  .gitignore
  src/
    index.ts                         # Entry point — starts MCP + HTTP servers
    graph/
      schema.ts                      # SQL table definitions (DDL strings)
      store.ts                       # GraphStore class — SQLite connection, migrations, CRUD
      query.ts                       # Graph traversal helpers (getConnected, findPath)
    decisions/
      types.ts                       # Decision interfaces + nodeToDecision converter
      service.ts                     # Decision CRUD + link operations
      search.ts                      # search_decisions + why_was_this_built
      promotion.ts                   # Tier promotion logic
    mcp-server/
      server.ts                      # MCP server factory, wires tools to services
      api.ts                         # HTTP server for /api/graph + viewer static files
      tools/
        decision-tools.ts            # MCP wrappers for decision CRUD + search
        promotion-tools.ts           # MCP wrapper for promote_decision
        code-tools.ts                # Proxy to codebase-memory-mcp binary
    connectors/
      types.ts                       # Phase 2 connector interface (stub)
    viewer/
      index.html                     # Graph viewer page
      style.css                      # Anthill theme (black/white/Geist Mono)
      graph-viewer.js                # D3 force graph + interactions
    hooks/
      suggest-capture.sh             # Post-commit nudge to capture decisions
    skills/
      search-decisions.md            # Skill teaching agents to query decisions
  tests/
    helpers.ts                       # createTestStore() factory
    graph/
      store.test.ts                  # Node/edge/annotation CRUD tests
      fts.test.ts                    # FTS5 search tests
      query.test.ts                  # Traversal helper tests
    decisions/
      service.test.ts                # Decision create/update/delete/get tests
      search.test.ts                 # search_decisions + why_was_this_built tests
      promotion.test.ts              # Tier promotion tests
  .cortex/                           # Runtime data (gitignored)
    graph.db                         # SQLite database
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder)
- Create: `tests/helpers.ts`

- [ ] **Step 1: Create config files**

`package.json`:
```json
{
  "name": "anthill-cortex",
  "version": "0.1.0",
  "description": "Knowledge graph MCP server with decision provenance",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.8.1",
    "zod": "^3.24.4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.15.2",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.1.2"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

`vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
```

`.gitignore` — append these entries (keep existing content):
```
node_modules/
dist/
.cortex/
*.db
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`

Expected: `node_modules/` created, `package-lock.json` generated, no errors.

- [ ] **Step 3: Create placeholder source and test helper**

`src/index.ts`:
```typescript
console.error("Anthill Cortex starting...");
```

`tests/helpers.ts`:
```typescript
import { GraphStore } from "../src/graph/store.js";

export function createTestStore(): GraphStore {
  return new GraphStore(":memory:");
}
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit --pretty 2>&1 || true`

Expected: Errors about missing `src/graph/store.ts` — that's correct, we haven't created it yet. The TypeScript compiler itself runs, which confirms the toolchain works.

Run: `npx vitest run 2>&1 || true`

Expected: "No test files found" or similar — confirms vitest is installed and runs.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/index.ts tests/helpers.ts
git commit -m "feat: scaffold project with TypeScript, vitest, MCP SDK dependencies"
```

---

## Task 2: Graph Schema & Store — Connection and Migration

**Files:**
- Create: `src/graph/schema.ts`
- Create: `src/graph/store.ts`
- Create: `tests/graph/store.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/graph/store.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";

describe("GraphStore", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates all tables on initialization", () => {
    store = new GraphStore(":memory:");

    const tables = store.listTables();
    expect(tables).toContain("nodes");
    expect(tables).toContain("edges");
    expect(tables).toContain("edge_annotations");
    expect(tables).toContain("decisions_fts");
  });

  it("creates indexes on initialization", () => {
    store = new GraphStore(":memory:");

    const indexes = store.listIndexes();
    expect(indexes).toContain("idx_nodes_kind");
    expect(indexes).toContain("idx_nodes_name");
    expect(indexes).toContain("idx_nodes_qualified_name");
    expect(indexes).toContain("idx_nodes_file_path");
    expect(indexes).toContain("idx_nodes_tier");
    expect(indexes).toContain("idx_edges_source");
    expect(indexes).toContain("idx_edges_target");
    expect(indexes).toContain("idx_edges_relation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/store.test.ts`

Expected: FAIL — cannot resolve `../../src/graph/store.js`

- [ ] **Step 3: Create schema.ts**

`src/graph/schema.ts`:
```typescript
export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  qualified_name TEXT,
  file_path   TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  tier        TEXT NOT NULL DEFAULT 'personal',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edge_annotations (
  id          TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_id     TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
`;

export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tier);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
`;

export const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale,
  node_id UNINDEXED
);
`;
```

- [ ] **Step 4: Create store.ts with connection and migration**

`src/graph/store.ts`:
```typescript
import Database from "better-sqlite3";
import { CREATE_TABLES, CREATE_INDEXES, CREATE_FTS } from "./schema.js";

export interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  data: string;
  tier: string;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  data: string;
  created_at: string;
}

export interface EdgeAnnotationRow {
  id: string;
  decision_id: string;
  edge_id: string;
  created_at: string;
}

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLES);
    this.db.exec(CREATE_INDEXES);
    this.db.exec(CREATE_FTS);
  }

  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  listIndexes(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/graph/store.test.ts`

Expected: 2 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/graph/schema.ts src/graph/store.ts tests/graph/store.test.ts
git commit -m "feat: add graph storage schema and SQLite store with migration"
```

---

## Task 3: Node CRUD

**Files:**
- Modify: `src/graph/store.ts`
- Modify: `tests/graph/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/graph/store.test.ts`:
```typescript
describe("Node CRUD", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves a node", () => {
    store = new GraphStore(":memory:");

    const node = store.createNode({
      kind: "function",
      name: "handleRequest",
      qualified_name: "src/api.ts::handleRequest",
      file_path: "src/api.ts",
      data: { params: ["req", "res"], return_type: "void" },
    });

    expect(node.id).toBeDefined();
    expect(node.kind).toBe("function");
    expect(node.name).toBe("handleRequest");
    expect(node.qualified_name).toBe("src/api.ts::handleRequest");
    expect(node.file_path).toBe("src/api.ts");
    expect(JSON.parse(node.data)).toEqual({ params: ["req", "res"], return_type: "void" });
    expect(node.tier).toBe("personal");
    expect(node.created_at).toBeDefined();
    expect(node.updated_at).toBeDefined();

    const retrieved = store.getNode(node.id);
    expect(retrieved).toEqual(node);
  });

  it("returns undefined for non-existent node", () => {
    store = new GraphStore(":memory:");
    expect(store.getNode("non-existent")).toBeUndefined();
  });

  it("updates a node", () => {
    store = new GraphStore(":memory:");

    const node = store.createNode({ kind: "function", name: "old" });
    const updated = store.updateNode(node.id, { name: "new", tier: "team" });

    expect(updated.name).toBe("new");
    expect(updated.tier).toBe("team");
    expect(updated.updated_at).not.toBe(node.updated_at);
  });

  it("throws when updating non-existent node", () => {
    store = new GraphStore(":memory:");
    expect(() => store.updateNode("fake", { name: "x" })).toThrow("Node not found: fake");
  });

  it("deletes a node", () => {
    store = new GraphStore(":memory:");

    const node = store.createNode({ kind: "function", name: "temp" });
    store.deleteNode(node.id);

    expect(store.getNode(node.id)).toBeUndefined();
  });

  it("finds nodes by filter", () => {
    store = new GraphStore(":memory:");

    store.createNode({ kind: "function", name: "a", file_path: "src/a.ts" });
    store.createNode({ kind: "function", name: "b", file_path: "src/b.ts" });
    store.createNode({ kind: "component", name: "c", file_path: "src/c.vue" });

    expect(store.findNodes({ kind: "function" })).toHaveLength(2);
    expect(store.findNodes({ file_path: "src/a.ts" })).toHaveLength(1);
    expect(store.findNodes({ kind: "component" })).toHaveLength(1);
    expect(store.findNodes({})).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/store.test.ts`

Expected: FAIL — `store.createNode is not a function`

- [ ] **Step 3: Implement node CRUD in store.ts**

Add these methods to the `GraphStore` class in `src/graph/store.ts`:
```typescript
import { randomUUID } from "node:crypto";

// Inside GraphStore class:

  createNode(input: {
    kind: string;
    name: string;
    qualified_name?: string;
    file_path?: string;
    data?: Record<string, unknown>;
    tier?: string;
  }): NodeRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO nodes (id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.name,
        input.qualified_name ?? null,
        input.file_path ?? null,
        JSON.stringify(input.data ?? {}),
        input.tier ?? "personal",
        now,
        now
      );
    return this.getNode(id)!;
  }

  getNode(id: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  }

  updateNode(
    id: string,
    updates: Partial<Pick<NodeRow, "kind" | "name" | "qualified_name" | "file_path" | "data" | "tier">>
  ): NodeRow {
    const node = this.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE nodes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getNode(id)!;
  }

  deleteNode(id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  }

  findNodes(filter: {
    kind?: string;
    name?: string;
    qualified_name?: string;
    file_path?: string;
    tier?: string;
  }): NodeRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM nodes ${where}`).all(...values) as NodeRow[];
  }
```

Add the `randomUUID` import at the top of `src/graph/store.ts`:
```typescript
import { randomUUID } from "node:crypto";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/store.test.ts`

Expected: All tests PASS (2 schema + 6 node CRUD = 8 total)

- [ ] **Step 5: Commit**

```bash
git add src/graph/store.ts tests/graph/store.test.ts
git commit -m "feat: add node CRUD operations to graph store"
```

---

## Task 4: Edge & Annotation CRUD

**Files:**
- Modify: `src/graph/store.ts`
- Modify: `tests/graph/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/graph/store.test.ts`:
```typescript
describe("Edge CRUD", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves an edge", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "caller" });
    const b = store.createNode({ kind: "function", name: "callee" });

    const edge = store.createEdge({
      source_id: a.id,
      target_id: b.id,
      relation: "CALLS",
    });

    expect(edge.id).toBeDefined();
    expect(edge.source_id).toBe(a.id);
    expect(edge.target_id).toBe(b.id);
    expect(edge.relation).toBe("CALLS");

    const retrieved = store.getEdge(edge.id);
    expect(retrieved).toEqual(edge);
  });

  it("deletes an edge", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    store.deleteEdge(edge.id);
    expect(store.getEdge(edge.id)).toBeUndefined();
  });

  it("cascade-deletes edges when a node is deleted", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    store.deleteNode(a.id);
    expect(store.findEdges({ source_id: a.id })).toHaveLength(0);
  });

  it("finds edges by filter", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });

    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: a.id, target_id: c.id, relation: "IMPORTS" });

    expect(store.findEdges({ source_id: a.id })).toHaveLength(2);
    expect(store.findEdges({ relation: "CALLS" })).toHaveLength(1);
    expect(store.findEdges({ target_id: b.id })).toHaveLength(1);
  });
});

describe("Edge Annotation CRUD", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves an annotation", () => {
    store = new GraphStore(":memory:");
    const decision = store.createNode({ kind: "decision", name: "Use REST" });
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const annotation = store.createAnnotation({
      decision_id: decision.id,
      edge_id: edge.id,
    });

    expect(annotation.id).toBeDefined();
    expect(annotation.decision_id).toBe(decision.id);
    expect(annotation.edge_id).toBe(edge.id);
  });

  it("finds annotations by decision_id", () => {
    store = new GraphStore(":memory:");
    const decision = store.createNode({ kind: "decision", name: "d" });
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createAnnotation({ decision_id: decision.id, edge_id: edge.id });

    expect(store.findAnnotations({ decision_id: decision.id })).toHaveLength(1);
  });

  it("cascade-deletes annotations when edge is deleted", () => {
    store = new GraphStore(":memory:");
    const decision = store.createNode({ kind: "decision", name: "d" });
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const edge = store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createAnnotation({ decision_id: decision.id, edge_id: edge.id });

    store.deleteEdge(edge.id);
    expect(store.findAnnotations({ decision_id: decision.id })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/store.test.ts`

Expected: FAIL — `store.createEdge is not a function`

- [ ] **Step 3: Implement edge and annotation CRUD in store.ts**

Add these methods to the `GraphStore` class in `src/graph/store.ts`:
```typescript
  // --- Edge CRUD ---

  createEdge(input: {
    source_id: string;
    target_id: string;
    relation: string;
    data?: Record<string, unknown>;
  }): EdgeRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO edges (id, source_id, target_id, relation, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.source_id, input.target_id, input.relation, JSON.stringify(input.data ?? {}), now);
    return this.getEdge(id)!;
  }

  getEdge(id: string): EdgeRow | undefined {
    return this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow | undefined;
  }

  deleteEdge(id: string): void {
    this.db.prepare("DELETE FROM edges WHERE id = ?").run(id);
  }

  findEdges(filter: { source_id?: string; target_id?: string; relation?: string }): EdgeRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM edges ${where}`).all(...values) as EdgeRow[];
  }

  // --- Edge Annotations ---

  createAnnotation(input: { decision_id: string; edge_id: string }): EdgeAnnotationRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO edge_annotations (id, decision_id, edge_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, input.decision_id, input.edge_id, now);
    return this.db.prepare("SELECT * FROM edge_annotations WHERE id = ?").get(id) as EdgeAnnotationRow;
  }

  deleteAnnotation(id: string): void {
    this.db.prepare("DELETE FROM edge_annotations WHERE id = ?").run(id);
  }

  findAnnotations(filter: { decision_id?: string; edge_id?: string }): EdgeAnnotationRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM edge_annotations ${where}`).all(...values) as EdgeAnnotationRow[];
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/store.test.ts`

Expected: All tests PASS (8 prior + 7 new = 15 total)

- [ ] **Step 5: Commit**

```bash
git add src/graph/store.ts tests/graph/store.test.ts
git commit -m "feat: add edge and annotation CRUD to graph store"
```

---

## Task 5: FTS5 Full-Text Search

**Files:**
- Modify: `src/graph/store.ts`
- Create: `tests/graph/fts.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/graph/fts.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";

describe("FTS5 Search", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("indexes and searches decision content", () => {
    store = new GraphStore(":memory:");
    const node = store.createNode({ kind: "decision", name: "Use Redis for caching" });
    store.indexDecisionContent(node.id, "Use Redis for caching", "We need a fast cache layer", "Redis supports TTL and pub/sub");

    const results = store.searchDecisionContent("caching");
    expect(results).toHaveLength(1);
    expect(results[0].node_id).toBe(node.id);
  });

  it("searches across title, description, and rationale", () => {
    store = new GraphStore(":memory:");
    const n1 = store.createNode({ kind: "decision", name: "d1" });
    const n2 = store.createNode({ kind: "decision", name: "d2" });
    const n3 = store.createNode({ kind: "decision", name: "d3" });

    store.indexDecisionContent(n1.id, "authentication with JWT", "desc1", "rationale1");
    store.indexDecisionContent(n2.id, "title2", "authentication flow described here", "rationale2");
    store.indexDecisionContent(n3.id, "title3", "desc3", "authentication is critical for security");

    const results = store.searchDecisionContent("authentication");
    expect(results).toHaveLength(3);
  });

  it("updates indexed content", () => {
    store = new GraphStore(":memory:");
    const node = store.createNode({ kind: "decision", name: "d1" });
    store.indexDecisionContent(node.id, "old title", "old desc", "old rationale");
    store.updateDecisionContent(node.id, "new title about Redis", "new desc", "new rationale");

    expect(store.searchDecisionContent("old")).toHaveLength(0);
    expect(store.searchDecisionContent("Redis")).toHaveLength(1);
  });

  it("removes indexed content", () => {
    store = new GraphStore(":memory:");
    const node = store.createNode({ kind: "decision", name: "d1" });
    store.indexDecisionContent(node.id, "searchable", "desc", "rationale");
    store.removeDecisionContent(node.id);

    expect(store.searchDecisionContent("searchable")).toHaveLength(0);
  });

  it("returns empty array for no matches", () => {
    store = new GraphStore(":memory:");
    expect(store.searchDecisionContent("nonexistent")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/fts.test.ts`

Expected: FAIL — `store.indexDecisionContent is not a function`

- [ ] **Step 3: Add FTS methods to store.ts**

Add these methods to the `GraphStore` class in `src/graph/store.ts`:
```typescript
  // --- FTS ---

  indexDecisionContent(nodeId: string, title: string, description: string, rationale: string): void {
    this.db
      .prepare("INSERT INTO decisions_fts (node_id, title, description, rationale) VALUES (?, ?, ?, ?)")
      .run(nodeId, title, description, rationale);
  }

  updateDecisionContent(nodeId: string, title: string, description: string, rationale: string): void {
    this.removeDecisionContent(nodeId);
    this.indexDecisionContent(nodeId, title, description, rationale);
  }

  removeDecisionContent(nodeId: string): void {
    this.db.prepare("DELETE FROM decisions_fts WHERE node_id = ?").run(nodeId);
  }

  searchDecisionContent(query: string): Array<{ node_id: string; rank: number }> {
    return this.db
      .prepare(
        `SELECT node_id, rank
         FROM decisions_fts
         WHERE decisions_fts MATCH ?
         ORDER BY rank`
      )
      .all(query) as Array<{ node_id: string; rank: number }>;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/fts.test.ts`

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/graph/store.ts tests/graph/fts.test.ts
git commit -m "feat: add FTS5 full-text search for decision content"
```

---

## Task 6: Graph Query Helpers

**Files:**
- Create: `src/graph/query.ts`
- Create: `tests/graph/query.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/graph/query.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { getConnected, findPath } from "../../src/graph/query.js";

describe("getConnected", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("returns outgoing connections", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: a.id, target_id: c.id, relation: "CALLS" });

    const results = getConnected(store, a.id, { direction: "outgoing" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.node.name)).toContain("b");
    expect(results.map((r) => r.node.name)).toContain("c");
  });

  it("returns incoming connections", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const results = getConnected(store, b.id, { direction: "incoming" });
    expect(results).toHaveLength(1);
    expect(results[0].node.name).toBe("a");
  });

  it("filters by relation type", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: a.id, target_id: c.id, relation: "IMPORTS" });

    const results = getConnected(store, a.id, { direction: "outgoing", relation: "CALLS" });
    expect(results).toHaveLength(1);
    expect(results[0].node.name).toBe("b");
  });
});

describe("findPath", () => {
  let store: GraphStore;

  afterEach(() => {
    store?.close();
  });

  it("finds a direct path between two nodes", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const path = findPath(store, a.id, b.id);
    expect(path).not.toBeNull();
    expect(path!).toHaveLength(2);
    expect(path![0].node.name).toBe("a");
    expect(path![1].node.name).toBe("b");
  });

  it("finds a multi-hop path", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: b.id, target_id: c.id, relation: "CALLS" });

    const path = findPath(store, a.id, c.id);
    expect(path).not.toBeNull();
    expect(path!).toHaveLength(3);
  });

  it("returns null when no path exists", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });

    expect(findPath(store, a.id, b.id)).toBeNull();
  });

  it("respects maxDepth", () => {
    store = new GraphStore(":memory:");
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    const c = store.createNode({ kind: "function", name: "c" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    store.createEdge({ source_id: b.id, target_id: c.id, relation: "CALLS" });

    expect(findPath(store, a.id, c.id, 1)).toBeNull();
    expect(findPath(store, a.id, c.id, 2)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/query.test.ts`

Expected: FAIL — cannot resolve `../../src/graph/query.js`

- [ ] **Step 3: Implement query helpers**

`src/graph/query.ts`:
```typescript
import { GraphStore, NodeRow, EdgeRow } from "./store.js";

export function getConnected(
  store: GraphStore,
  nodeId: string,
  options?: { relation?: string; direction?: "outgoing" | "incoming" | "both" }
): Array<{ node: NodeRow; edge: EdgeRow }> {
  const direction = options?.direction ?? "both";
  const results: Array<{ node: NodeRow; edge: EdgeRow }> = [];

  if (direction === "outgoing" || direction === "both") {
    const filter: { source_id: string; relation?: string } = { source_id: nodeId };
    if (options?.relation) filter.relation = options.relation;
    for (const edge of store.findEdges(filter)) {
      const node = store.getNode(edge.target_id);
      if (node) results.push({ node, edge });
    }
  }

  if (direction === "incoming" || direction === "both") {
    const filter: { target_id: string; relation?: string } = { target_id: nodeId };
    if (options?.relation) filter.relation = options.relation;
    for (const edge of store.findEdges(filter)) {
      const node = store.getNode(edge.source_id);
      if (node) results.push({ node, edge });
    }
  }

  return results;
}

export function findPath(
  store: GraphStore,
  fromId: string,
  toId: string,
  maxDepth: number = 5
): Array<{ node: NodeRow; edge: EdgeRow | null }> | null {
  const startNode = store.getNode(fromId);
  if (!startNode) return null;

  const visited = new Set<string>([fromId]);
  const queue: Array<{
    nodeId: string;
    path: Array<{ node: NodeRow; edge: EdgeRow | null }>;
  }> = [{ nodeId: fromId, path: [{ node: startNode, edge: null }] }];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.nodeId === toId) return current.path;
    if (current.path.length > maxDepth) continue;

    for (const edge of store.findEdges({ source_id: current.nodeId })) {
      if (!visited.has(edge.target_id)) {
        visited.add(edge.target_id);
        const targetNode = store.getNode(edge.target_id);
        if (targetNode) {
          queue.push({
            nodeId: edge.target_id,
            path: [...current.path, { node: targetNode, edge }],
          });
        }
      }
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/query.test.ts`

Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/graph/query.ts tests/graph/query.test.ts
git commit -m "feat: add graph traversal helpers (getConnected, findPath)"
```

---

## Task 7: Decision Types & Create

**Files:**
- Create: `src/decisions/types.ts`
- Create: `src/decisions/service.ts`
- Create: `tests/decisions/service.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/decisions/service.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService.create", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("creates a basic decision", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Use PostgreSQL",
      description: "We need a relational database",
      rationale: "PostgreSQL supports JSONB and has strong ecosystem",
    });

    expect(decision.id).toBeDefined();
    expect(decision.title).toBe("Use PostgreSQL");
    expect(decision.description).toBe("We need a relational database");
    expect(decision.rationale).toBe("PostgreSQL supports JSONB and has strong ecosystem");
    expect(decision.status).toBe("active");
    expect(decision.tier).toBe("personal");
    expect(decision.alternatives).toEqual([]);
  });

  it("creates a decision with alternatives", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Use PostgreSQL",
      description: "Database choice",
      rationale: "Best fit",
      alternatives: [
        { name: "MySQL", reason_rejected: "Weaker JSON support" },
        { name: "MongoDB", reason_rejected: "Need relational queries" },
      ],
    });

    expect(decision.alternatives).toHaveLength(2);
    expect(decision.alternatives[0].name).toBe("MySQL");
  });

  it("creates GOVERNS edges to existing nodes", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const target = store.createNode({
      kind: "function",
      name: "dbConnect",
      qualified_name: "src/db.ts::dbConnect",
    });

    const decision = service.create({
      title: "Use connection pooling",
      description: "desc",
      rationale: "rationale",
      governs: [target.id],
    });

    const edges = store.findEdges({ source_id: decision.id, relation: "GOVERNS" });
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(target.id);
  });

  it("creates path nodes for file path governs targets", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "API routing structure",
      description: "desc",
      rationale: "rationale",
      governs: ["src/api/routes/"],
    });

    const edges = store.findEdges({ source_id: decision.id, relation: "GOVERNS" });
    expect(edges).toHaveLength(1);

    const pathNode = store.getNode(edges[0].target_id);
    expect(pathNode).toBeDefined();
    expect(pathNode!.kind).toBe("path");
    expect(pathNode!.file_path).toBe("src/api/routes/");
  });

  it("creates REFERENCES edges", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const ref = store.createNode({ kind: "reference", name: "JIRA-123" });

    const decision = service.create({
      title: "d1",
      description: "desc",
      rationale: "rationale",
      references: [ref.id],
    });

    const edges = store.findEdges({ source_id: decision.id, relation: "REFERENCES" });
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(ref.id);
  });

  it("indexes decision in FTS", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    service.create({
      title: "Use Redis for caching",
      description: "Need a fast cache layer",
      rationale: "Redis supports TTL",
    });

    const results = store.searchDecisionContent("caching");
    expect(results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/service.test.ts`

Expected: FAIL — cannot resolve modules

- [ ] **Step 3: Create types.ts**

`src/decisions/types.ts`:
```typescript
import type { NodeRow } from "../graph/store.js";

export interface Alternative {
  name: string;
  reason_rejected: string;
}

export type Tier = "personal" | "team" | "public";
export type DecisionStatus = "active" | "superseded" | "deprecated";

export interface Decision {
  id: string;
  title: string;
  description: string;
  rationale: string;
  alternatives: Alternative[];
  tier: Tier;
  status: DecisionStatus;
  superseded_by?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDecisionInput {
  title: string;
  description: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
}

export interface UpdateDecisionInput {
  title?: string;
  description?: string;
  rationale?: string;
  alternatives?: Alternative[];
  status?: DecisionStatus;
  superseded_by?: string;
}

export function nodeToDecision(node: NodeRow): Decision {
  const data = JSON.parse(node.data);
  return {
    id: node.id,
    title: data.title,
    description: data.description,
    rationale: data.rationale,
    alternatives: data.alternatives ?? [],
    tier: node.tier as Tier,
    status: data.status ?? "active",
    superseded_by: data.superseded_by,
    created_by: data.created_by,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}
```

- [ ] **Step 4: Create service.ts with create method**

`src/decisions/service.ts`:
```typescript
import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision, CreateDecisionInput, UpdateDecisionInput } from "./types.js";
import { nodeToDecision } from "./types.js";

export class DecisionService {
  constructor(private store: GraphStore) {}

  create(input: CreateDecisionInput): Decision {
    const data = {
      title: input.title,
      description: input.description,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      status: "active" as const,
    };

    const node = this.store.createNode({
      kind: "decision",
      name: input.title,
      data,
      tier: "personal",
    });

    this.store.indexDecisionContent(node.id, input.title, input.description, input.rationale);

    if (input.governs) {
      for (const target of input.governs) {
        this.linkGoverns(node.id, target);
      }
    }

    if (input.references) {
      for (const ref of input.references) {
        this.store.createEdge({
          source_id: node.id,
          target_id: ref,
          relation: "REFERENCES",
        });
      }
    }

    return nodeToDecision(node);
  }

  linkGoverns(decisionId: string, target: string): void {
    const existingNode = this.store.getNode(target);
    if (existingNode) {
      this.store.createEdge({
        source_id: decisionId,
        target_id: target,
        relation: "GOVERNS",
      });
      return;
    }

    const pathNodes = this.store.findNodes({ file_path: target, kind: "path" });
    let pathNode: NodeRow;
    if (pathNodes.length > 0) {
      pathNode = pathNodes[0];
    } else {
      pathNode = this.store.createNode({
        kind: "path",
        name: target.split("/").pop() || target,
        file_path: target,
        tier: "public",
      });
    }

    this.store.createEdge({
      source_id: decisionId,
      target_id: pathNode.id,
      relation: "GOVERNS",
    });
  }

  linkReference(decisionId: string, targetId: string): void {
    this.store.createEdge({
      source_id: decisionId,
      target_id: targetId,
      relation: "REFERENCES",
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/decisions/service.test.ts`

Expected: All 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/decisions/types.ts src/decisions/service.ts tests/decisions/service.test.ts
git commit -m "feat: add decision types and create operation with GOVERNS/REFERENCES edges"
```

---

## Task 8: Decision Update, Delete, Get

**Files:**
- Modify: `src/decisions/service.ts`
- Modify: `tests/decisions/service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/decisions/service.test.ts`:
```typescript
describe("DecisionService.update", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("updates decision fields", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Original",
      description: "desc",
      rationale: "rationale",
    });

    const updated = service.update(decision.id, {
      title: "Updated Title",
      rationale: "New rationale",
    });

    expect(updated.title).toBe("Updated Title");
    expect(updated.rationale).toBe("New rationale");
    expect(updated.description).toBe("desc");
  });

  it("updates status and superseded_by", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const d1 = service.create({ title: "Old", description: "d", rationale: "r" });
    const d2 = service.create({ title: "New", description: "d", rationale: "r" });

    const updated = service.update(d1.id, {
      status: "superseded",
      superseded_by: d2.id,
    });

    expect(updated.status).toBe("superseded");
    expect(updated.superseded_by).toBe(d2.id);
  });

  it("updates FTS index on update", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Old keyword",
      description: "desc",
      rationale: "rationale",
    });

    service.update(decision.id, { title: "New keyword" });

    expect(store.searchDecisionContent("Old")).toHaveLength(0);
    expect(store.searchDecisionContent("New")).toHaveLength(1);
  });

  it("throws for non-existent decision", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    expect(() => service.update("fake", { title: "x" })).toThrow("Decision not found");
  });
});

describe("DecisionService.delete", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("deletes a decision and its FTS entry", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "To be deleted",
      description: "desc",
      rationale: "rationale",
    });

    service.delete(decision.id);

    expect(store.getNode(decision.id)).toBeUndefined();
    expect(store.searchDecisionContent("deleted")).toHaveLength(0);
  });

  it("cascade-deletes GOVERNS edges", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const target = store.createNode({ kind: "function", name: "fn" });
    const decision = service.create({
      title: "d1",
      description: "d",
      rationale: "r",
      governs: [target.id],
    });

    service.delete(decision.id);
    expect(store.findEdges({ relation: "GOVERNS" })).toHaveLength(0);
  });
});

describe("DecisionService.get", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("returns decision with resolved governs and references", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const fn = store.createNode({ kind: "function", name: "handleReq" });
    const ref = store.createNode({ kind: "reference", name: "JIRA-456" });

    const decision = service.create({
      title: "Request handling",
      description: "desc",
      rationale: "rationale",
      governs: [fn.id],
      references: [ref.id],
    });

    const result = service.get(decision.id);

    expect(result.title).toBe("Request handling");
    expect(result.governs).toHaveLength(1);
    expect(result.governs[0].name).toBe("handleReq");
    expect(result.references).toHaveLength(1);
    expect(result.references[0].name).toBe("JIRA-456");
  });

  it("throws for non-existent decision", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    expect(() => service.get("fake")).toThrow("Decision not found");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/decisions/service.test.ts`

Expected: FAIL — `service.update is not a function`

- [ ] **Step 3: Add update, delete, get to service.ts**

Add these methods to the `DecisionService` class in `src/decisions/service.ts`:
```typescript
  update(id: string, input: UpdateDecisionInput): Decision {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const existingData = JSON.parse(node.data);
    const newData = { ...existingData };

    if (input.title !== undefined) newData.title = input.title;
    if (input.description !== undefined) newData.description = input.description;
    if (input.rationale !== undefined) newData.rationale = input.rationale;
    if (input.alternatives !== undefined) newData.alternatives = input.alternatives;
    if (input.status !== undefined) newData.status = input.status;
    if (input.superseded_by !== undefined) newData.superseded_by = input.superseded_by;

    const updatedNode = this.store.updateNode(id, {
      name: newData.title,
      data: JSON.stringify(newData),
    });

    this.store.updateDecisionContent(id, newData.title, newData.description, newData.rationale);

    return nodeToDecision(updatedNode);
  }

  delete(id: string): void {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    this.store.removeDecisionContent(id);
    this.store.deleteNode(id);
  }

  get(id: string): Decision & { governs: NodeRow[]; references: NodeRow[] } {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const decision = nodeToDecision(node);

    const governsEdges = this.store.findEdges({ source_id: id, relation: "GOVERNS" });
    const governs = governsEdges
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => n !== undefined);

    const referencesEdges = this.store.findEdges({ source_id: id, relation: "REFERENCES" });
    const references = referencesEdges
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => n !== undefined);

    return { ...decision, governs, references };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/decisions/service.test.ts`

Expected: All tests PASS (6 create + 4 update + 2 delete + 2 get = 14 total)

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts tests/decisions/service.test.ts
git commit -m "feat: add decision update, delete, and get operations"
```

---

## Task 9: Decision Search

**Files:**
- Create: `src/decisions/search.ts`
- Create: `tests/decisions/search.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/decisions/search.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";

describe("DecisionSearch.search", () => {
  let store: GraphStore;
  let service: DecisionService;
  let search: DecisionSearch;

  afterEach(() => {
    store?.close();
  });

  it("finds decisions by keyword", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    service.create({ title: "Use Redis for caching", description: "Cache layer needed", rationale: "Fast" });
    service.create({ title: "Use PostgreSQL", description: "Database choice", rationale: "Relational" });

    const results = search.search("caching");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Use Redis for caching");
  });

  it("scopes search to governed entities", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    const fn = store.createNode({
      kind: "function",
      name: "dbConnect",
      qualified_name: "src/db.ts::dbConnect",
    });

    service.create({
      title: "Connection pooling strategy",
      description: "Pool database connections",
      rationale: "Performance",
      governs: [fn.id],
    });

    service.create({
      title: "API pooling strategy",
      description: "Pool API connections",
      rationale: "Performance",
    });

    const scoped = search.search("pooling", "src/db.ts::dbConnect");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe("Connection pooling strategy");
  });

  it("returns empty array for no matches", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    expect(search.search("nonexistent")).toHaveLength(0);
  });
});

describe("DecisionSearch.whyWasThisBuilt", () => {
  let store: GraphStore;
  let service: DecisionService;
  let search: DecisionSearch;

  afterEach(() => {
    store?.close();
  });

  it("finds decisions governing a specific entity by qualified_name", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    const fn = store.createNode({
      kind: "function",
      name: "validate",
      qualified_name: "src/auth/validate.ts::validate",
      file_path: "src/auth/validate.ts",
    });

    service.create({
      title: "Input validation approach",
      description: "d",
      rationale: "r",
      governs: [fn.id],
    });

    const results = search.whyWasThisBuilt("src/auth/validate.ts::validate");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Input validation approach");
  });

  it("walks up to file path when no direct QN match", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    service.create({
      title: "Auth module design",
      description: "d",
      rationale: "r",
      governs: ["src/auth/"],
    });

    const results = search.whyWasThisBuilt("src/auth/validate.ts");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Auth module design");
  });

  it("walks up directory hierarchy", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    service.create({
      title: "Source structure",
      description: "d",
      rationale: "r",
      governs: ["src/"],
    });

    const results = search.whyWasThisBuilt("src/auth/middleware/jwt.ts");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Source structure");
  });

  it("returns empty when nothing governs the entity", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    expect(search.whyWasThisBuilt("src/unrelated.ts")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/search.test.ts`

Expected: FAIL — cannot resolve `../../src/decisions/search.js`

- [ ] **Step 3: Implement search.ts**

`src/decisions/search.ts`:
```typescript
import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision } from "./types.js";
import { nodeToDecision } from "./types.js";
import { dirname } from "node:path";

export class DecisionSearch {
  constructor(private store: GraphStore) {}

  search(query: string, scope?: string): Decision[] {
    const ftsResults = this.store.searchDecisionContent(query);
    const nodeIds = ftsResults.map((r) => r.node_id);

    if (!scope) {
      return nodeIds
        .map((id) => this.store.getNode(id))
        .filter((n): n is NodeRow => n !== undefined)
        .map((n) => nodeToDecision(n));
    }

    return nodeIds
      .filter((id) => this.governsScope(id, scope))
      .map((id) => this.store.getNode(id))
      .filter((n): n is NodeRow => n !== undefined)
      .map((n) => nodeToDecision(n));
  }

  whyWasThisBuilt(qualifiedName: string): Decision[] {
    // 1. Try qualified_name match
    const qnNodes = this.store.findNodes({ qualified_name: qualifiedName });
    if (qnNodes.length > 0) {
      const decisions = this.findGoverningDecisions(qnNodes[0].id);
      if (decisions.length > 0) return decisions;
    }

    // 2. Try file_path match
    const fileNodes = this.store.findNodes({ file_path: qualifiedName });
    for (const fileNode of fileNodes) {
      const decisions = this.findGoverningDecisions(fileNode.id);
      if (decisions.length > 0) return decisions;
    }

    // 3. Walk up directory hierarchy via path nodes
    let currentPath = qualifiedName;
    while (currentPath.includes("/")) {
      currentPath = dirname(currentPath);
      if (currentPath === ".") break;
      const trailingSlash = currentPath + "/";

      // Check both with and without trailing slash
      for (const searchPath of [currentPath, trailingSlash]) {
        const dirNodes = this.store.findNodes({ file_path: searchPath });
        for (const dirNode of dirNodes) {
          const decisions = this.findGoverningDecisions(dirNode.id);
          if (decisions.length > 0) return decisions;
        }
      }
    }

    return [];
  }

  private findGoverningDecisions(nodeId: string): Decision[] {
    const edges = this.store.findEdges({ target_id: nodeId, relation: "GOVERNS" });
    return edges
      .map((e) => this.store.getNode(e.source_id))
      .filter((n): n is NodeRow => n !== undefined && n.kind === "decision")
      .map((n) => nodeToDecision(n));
  }

  private governsScope(decisionId: string, scope: string): boolean {
    const edges = this.store.findEdges({ source_id: decisionId, relation: "GOVERNS" });
    for (const edge of edges) {
      const target = this.store.getNode(edge.target_id);
      if (!target) continue;
      if (target.qualified_name === scope) return true;
      if (target.file_path === scope) return true;
      if (target.file_path && scope.startsWith(target.file_path)) return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/decisions/search.test.ts`

Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/decisions/search.ts tests/decisions/search.test.ts
git commit -m "feat: add decision search with FTS5 and why_was_this_built hierarchy walk"
```

---

## Task 10: Decision Promotion

**Files:**
- Create: `src/decisions/promotion.ts`
- Create: `tests/decisions/promotion.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/decisions/promotion.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";

describe("DecisionPromotion", () => {
  let store: GraphStore;
  let service: DecisionService;
  let promotion: DecisionPromotion;

  afterEach(() => {
    store?.close();
  });

  it("promotes a decision to team tier", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    promotion = new DecisionPromotion(store);

    const decision = service.create({
      title: "Logging standard",
      description: "desc",
      rationale: "rationale",
    });

    expect(decision.tier).toBe("personal");

    const promoted = promotion.promote(decision.id, "team");
    expect(promoted.tier).toBe("team");
    expect(promoted.title).toBe("Logging standard");
  });

  it("promotes a decision to public tier", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    promotion = new DecisionPromotion(store);

    const decision = service.create({
      title: "API versioning",
      description: "desc",
      rationale: "rationale",
    });

    const promoted = promotion.promote(decision.id, "public");
    expect(promoted.tier).toBe("public");
  });

  it("throws for non-existent decision", () => {
    store = new GraphStore(":memory:");
    promotion = new DecisionPromotion(store);

    expect(() => promotion.promote("fake", "team")).toThrow("Decision not found");
  });

  it("throws for non-decision nodes", () => {
    store = new GraphStore(":memory:");
    promotion = new DecisionPromotion(store);

    const fn = store.createNode({ kind: "function", name: "fn" });
    expect(() => promotion.promote(fn.id, "team")).toThrow("is not a decision");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/promotion.test.ts`

Expected: FAIL — cannot resolve `../../src/decisions/promotion.js`

- [ ] **Step 3: Implement promotion.ts**

`src/decisions/promotion.ts`:
```typescript
import { GraphStore } from "../graph/store.js";
import type { Decision } from "./types.js";
import { nodeToDecision } from "./types.js";

export class DecisionPromotion {
  constructor(private store: GraphStore) {}

  promote(id: string, tier: "team" | "public"): Decision {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const updatedNode = this.store.updateNode(id, { tier });
    return nodeToDecision(updatedNode);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/decisions/promotion.test.ts`

Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/decisions/promotion.ts tests/decisions/promotion.test.ts
git commit -m "feat: add decision tier promotion"
```

---

## Task 11: MCP Server Core

**Files:**
- Create: `src/mcp-server/server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create server.ts**

`src/mcp-server/server.ts`:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../graph/store.js";
import { DecisionService } from "../decisions/service.js";
import { DecisionSearch } from "../decisions/search.js";
import { DecisionPromotion } from "../decisions/promotion.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerPromotionTools } from "./tools/promotion-tools.js";
import { registerCodeTools } from "./tools/code-tools.js";

export function createServer(store: GraphStore): McpServer {
  const server = new McpServer({
    name: "anthill-cortex",
    version: "0.1.0",
  });

  const decisionService = new DecisionService(store);
  const decisionSearch = new DecisionSearch(store);
  const decisionPromotion = new DecisionPromotion(store);

  registerDecisionTools(server, decisionService, decisionSearch);
  registerPromotionTools(server, decisionPromotion);
  registerCodeTools(server);

  return server;
}
```

- [ ] **Step 2: Create stub tool files so server.ts compiles**

`src/mcp-server/tools/decision-tools.ts`:
```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionService } from "../../decisions/service.js";
import type { DecisionSearch } from "../../decisions/search.js";

export function registerDecisionTools(
  _server: McpServer,
  _service: DecisionService,
  _search: DecisionSearch
): void {
  // Implemented in Task 12
}
```

`src/mcp-server/tools/promotion-tools.ts`:
```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionPromotion } from "../../decisions/promotion.js";

export function registerPromotionTools(_server: McpServer, _promotion: DecisionPromotion): void {
  // Implemented in Task 12
}
```

`src/mcp-server/tools/code-tools.ts`:
```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCodeTools(_server: McpServer): void {
  // Implemented in Task 13
}
```

- [ ] **Step 3: Update src/index.ts**

Replace the content of `src/index.ts` with:
```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);
const server = createServer(store);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors (clean compile)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/mcp-server/server.ts src/mcp-server/tools/decision-tools.ts src/mcp-server/tools/promotion-tools.ts src/mcp-server/tools/code-tools.ts
git commit -m "feat: add MCP server core with tool registration skeleton"
```

---

## Task 12: Decision MCP Tools

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`
- Modify: `src/mcp-server/tools/promotion-tools.ts`

- [ ] **Step 1: Implement decision-tools.ts**

Replace the content of `src/mcp-server/tools/decision-tools.ts` with:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";

const AlternativeSchema = z.object({
  name: z.string(),
  reason_rejected: z.string(),
});

export function registerDecisionTools(
  server: McpServer,
  service: DecisionService,
  search: DecisionSearch
): void {
  server.tool(
    "create_decision",
    "Create a new decision node with rationale, alternatives, and links to governed code",
    {
      title: z.string().describe("Short name for the decision"),
      description: z.string().describe("What was decided"),
      rationale: z.string().describe("Why this decision was made"),
      alternatives: z.array(AlternativeSchema).optional().describe("Rejected alternatives with reasons"),
      governs: z.array(z.string()).optional().describe("Node IDs or file paths this decision governs"),
      references: z.array(z.string()).optional().describe("Node IDs of external reference nodes"),
    },
    async (params) => {
      try {
        const decision = service.create(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(decision, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );

  server.tool(
    "update_decision",
    "Update an existing decision's fields",
    {
      id: z.string().describe("Decision node ID"),
      title: z.string().optional(),
      description: z.string().optional(),
      rationale: z.string().optional(),
      alternatives: z.array(AlternativeSchema).optional(),
      status: z.enum(["active", "superseded", "deprecated"]).optional(),
      superseded_by: z.string().optional().describe("ID of the superseding decision"),
    },
    async ({ id, ...updates }) => {
      try {
        const decision = service.update(id, updates);
        return { content: [{ type: "text" as const, text: JSON.stringify(decision, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );

  server.tool(
    "delete_decision",
    "Delete a decision and all its edges",
    {
      id: z.string().describe("Decision node ID"),
    },
    async ({ id }) => {
      try {
        service.delete(id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: id }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );

  server.tool(
    "get_decision",
    "Get a decision with its resolved GOVERNS and REFERENCES links",
    {
      id: z.string().describe("Decision node ID"),
    },
    async ({ id }) => {
      try {
        const result = service.get(id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );

  server.tool(
    "search_decisions",
    "Full-text search over decision titles, descriptions, and rationale",
    {
      query: z.string().describe("Search query (FTS5 syntax)"),
      scope: z.string().optional().describe("Qualified name or file path to scope results"),
    },
    async ({ query, scope }) => {
      try {
        const results = search.search(query, scope);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );

  server.tool(
    "why_was_this_built",
    "Find decisions governing a code entity — walks up file/directory hierarchy if no direct match",
    {
      qualified_name: z.string().describe("Qualified name or file path of the code entity"),
    },
    async ({ qualified_name }) => {
      try {
        const results = search.whyWasThisBuilt(qualified_name);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );

  server.tool(
    "link_decision",
    "Attach additional GOVERNS or REFERENCES edges to an existing decision",
    {
      decision_id: z.string().describe("Decision node ID"),
      target: z.string().describe("Target node ID or file path"),
      relation: z.enum(["GOVERNS", "REFERENCES"]).optional().describe("Edge type (default: GOVERNS)"),
    },
    async ({ decision_id, target, relation }) => {
      try {
        const rel = relation ?? "GOVERNS";
        if (rel === "GOVERNS") {
          service.linkGoverns(decision_id, target);
        } else {
          service.linkReference(decision_id, target);
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ linked: true, decision_id, target, relation: rel }) },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );
}
```

- [ ] **Step 2: Implement promotion-tools.ts**

Replace the content of `src/mcp-server/tools/promotion-tools.ts` with:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionPromotion } from "../../decisions/promotion.js";

export function registerPromotionTools(server: McpServer, promotion: DecisionPromotion): void {
  server.tool(
    "promote_decision",
    "Promote a decision to team or public visibility tier",
    {
      id: z.string().describe("Decision node ID"),
      tier: z.enum(["team", "public"]).describe("Target visibility tier"),
    },
    async ({ id, tier }) => {
      try {
        const decision = promotion.promote(id, tier);
        return { content: [{ type: "text" as const, text: JSON.stringify(decision, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts src/mcp-server/tools/promotion-tools.ts
git commit -m "feat: register all 8 decision MCP tools (CRUD, search, promote, link)"
```

---

## Task 13: Code Tools Proxy

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts`

- [ ] **Step 1: Implement code-tools.ts**

Replace the content of `src/mcp-server/tools/code-tools.ts` with:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CBM_BINARY = process.env.CBM_BINARY_PATH || "codebase-memory-mcp";

async function callCbm(tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(CBM_BINARY, ["cli", tool, JSON.stringify(args)], {
      timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      error: `codebase-memory-mcp call failed: ${message}. Set CBM_BINARY_PATH if the binary is not in PATH.`,
    });
  }
}

export function registerCodeTools(server: McpServer): void {
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
    "search_graph",
    "Search the knowledge graph for code entities by name, label, or qualified name pattern",
    {
      name_pattern: z.string().optional(),
      label: z.string().optional(),
      qn_pattern: z.string().optional(),
    },
    async (params) => {
      const result = await callCbm("search_graph", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "trace_path",
    "Trace call chains, data flow, or cross-service paths from a function",
    {
      function_name: z.string(),
      mode: z.string().describe("Trace mode: calls, data_flow, or cross_service"),
    },
    async (params) => {
      const result = await callCbm("trace_path", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "get_code_snippet",
    "Get source code for a fully qualified name",
    {
      qualified_name: z.string(),
    },
    async (params) => {
      const result = await callCbm("get_code_snippet", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "query_graph",
    "Run a Cypher query against the knowledge graph",
    {
      query: z.string(),
    },
    async (params) => {
      const result = await callCbm("query_graph", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "get_architecture",
    "Get architecture overview for specified aspects of the codebase",
    {
      aspects: z.string().describe("Comma-separated aspects to analyze"),
    },
    async (params) => {
      const result = await callCbm("get_architecture", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "search_code",
    "Full-text search across repository source code",
    {
      pattern: z.string(),
    },
    async (params) => {
      const result = await callCbm("search_code", params);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat: proxy 7 code indexing tools to codebase-memory-mcp binary"
```

---

## Task 14: Graph Viewer API

**Files:**
- Create: `src/mcp-server/api.ts`
- Modify: `src/index.ts`
- Modify: `src/graph/store.ts`

- [ ] **Step 1: Add bulk-read methods to store.ts**

Add these methods to the `GraphStore` class in `src/graph/store.ts`:
```typescript
  getAllNodes(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes").all() as NodeRow[];
  }

  getAllEdges(): EdgeRow[] {
    return this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
  }
```

- [ ] **Step 2: Create api.ts**

`src/mcp-server/api.ts`:
```typescript
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../graph/store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const VIEWER_DIR = join(PROJECT_ROOT, "src", "viewer");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

export function startViewerServer(store: GraphStore): Promise<number> {
  return new Promise((resolve) => {
    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url === "/api/graph") {
        const nodes = store.getAllNodes();
        const rawEdges = store.getAllEdges();
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

      if (url === "/" || url.startsWith("/viewer")) {
        const filePath =
          url === "/" || url === "/viewer" || url === "/viewer/"
            ? join(VIEWER_DIR, "index.html")
            : join(VIEWER_DIR, url.replace("/viewer/", ""));

        try {
          const content = await readFile(filePath);
          const ext = extname(filePath);
          res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }

      res.writeHead(302, { Location: "/viewer" });
      res.end();
    });

    const port = parseInt(process.env.CORTEX_VIEWER_PORT || "3333", 10);
    httpServer.listen(port, () => {
      resolve(port);
    });
  });
}
```

- [ ] **Step 3: Update src/index.ts to start the viewer server**

Replace the content of `src/index.ts` with:
```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);
const server = createServer(store);

const viewerPort = await startViewerServer(store);
process.stderr.write(`Anthill Cortex viewer: http://localhost:${viewerPort}/viewer\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/graph/store.ts src/mcp-server/api.ts src/index.ts
git commit -m "feat: add HTTP server for graph viewer and /api/graph endpoint"
```

---

## Task 15: Graph Viewer UI

**Files:**
- Create: `src/viewer/index.html`
- Create: `src/viewer/style.css`
- Create: `src/viewer/graph-viewer.js`

- [ ] **Step 1: Create index.html**

`src/viewer/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Anthill Cortex</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/viewer/style.css">
</head>
<body>
  <div id="toolbar">
    <span id="logo">anthill cortex</span>
    <input type="text" id="search" placeholder="Search nodes...">
    <div id="filters">
      <label><input type="checkbox" data-kind="function" checked> functions</label>
      <label><input type="checkbox" data-kind="component" checked> components</label>
      <label><input type="checkbox" data-kind="decision" checked> decisions</label>
      <label><input type="checkbox" data-kind="path" checked> paths</label>
      <label><input type="checkbox" data-kind="reference" checked> references</label>
    </div>
  </div>
  <div id="graph-container"></div>
  <div id="detail-panel" class="hidden">
    <button id="close-panel">&times;</button>
    <div id="detail-content"></div>
  </div>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script src="/viewer/graph-viewer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create style.css (Anthill theme)**

`src/viewer/style.css`:
```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #000;
  color: #ccc;
  font-family: "Geist Mono", monospace;
  font-size: 13px;
  overflow: hidden;
}

#toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.92);
  border-bottom: 1px solid #1a1a1a;
}

#logo {
  color: #555;
  font-size: 12px;
  font-weight: 300;
  letter-spacing: 1px;
  white-space: nowrap;
}

#search {
  background: #0a0a0a;
  border: 1px solid #222;
  color: #ccc;
  font-family: "Geist Mono", monospace;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 3px;
  width: 220px;
}

#search:focus {
  outline: none;
  border-color: #444;
}

#filters {
  display: flex;
  gap: 12px;
}

#filters label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: #555;
  font-size: 11px;
}

#filters input[type="checkbox"] {
  accent-color: #fff;
}

#graph-container {
  width: 100vw;
  height: 100vh;
}

#detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 340px;
  height: 100vh;
  background: rgba(8, 8, 8, 0.96);
  border-left: 1px solid #1a1a1a;
  padding: 48px 16px 16px;
  overflow-y: auto;
  z-index: 20;
  transition: transform 0.2s ease;
}

#detail-panel.hidden {
  transform: translateX(100%);
}

#close-panel {
  position: absolute;
  top: 10px;
  right: 12px;
  background: none;
  border: none;
  color: #444;
  font-size: 18px;
  cursor: pointer;
  font-family: "Geist Mono", monospace;
}

#close-panel:hover {
  color: #fff;
}

#detail-content h2 {
  color: #ddd;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 14px;
  word-break: break-word;
}

.field {
  margin-bottom: 12px;
}

.field-label {
  color: #555;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 3px;
}

.field-value {
  color: #999;
  font-size: 12px;
  word-break: break-word;
  line-height: 1.5;
}

.edge-line {
  stroke: #1a1a1a;
  stroke-width: 0.5;
}

.edge-line:hover {
  stroke: #444;
  stroke-width: 1;
}

.edge-line.highlighted {
  stroke: #555;
  stroke-width: 1;
}

.node-shape {
  fill: #444;
  stroke: none;
  cursor: pointer;
}

.node-shape.kind-decision {
  fill: #777;
}

.node-shape.kind-reference {
  fill: #333;
  stroke: #555;
  stroke-width: 0.5;
  stroke-dasharray: 2, 2;
}

.node-shape:hover {
  fill: #ccc;
}

.node-shape.selected {
  fill: #fff;
  filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.4));
}

.node-label {
  fill: #444;
  font-family: "Geist Mono", monospace;
  font-size: 9px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.node-group:hover .node-label {
  opacity: 1;
  fill: #999;
}

.node-group.selected .node-label {
  opacity: 1;
  fill: #ccc;
}
```

- [ ] **Step 3: Create graph-viewer.js**

`src/viewer/graph-viewer.js`:
```javascript
(async function () {
  const container = document.getElementById("graph-container");
  const searchInput = document.getElementById("search");
  const detailPanel = document.getElementById("detail-panel");
  const detailContent = document.getElementById("detail-content");
  const closePanel = document.getElementById("close-panel");

  const response = await fetch("/api/graph");
  const { nodes, edges } = await response.json();

  if (nodes.length === 0) {
    container.innerHTML =
      '<div style="color:#333;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;font-size:13px">' +
      "No nodes in graph.<br>Use create_decision or index_repository to add data.</div>";
    return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;

  const svg = d3.select(container).append("svg").attr("width", width).attr("height", height);

  const g = svg.append("g");
  svg.call(
    d3.zoom().scaleExtent([0.05, 10]).on("zoom", (event) => {
      g.attr("transform", event.transform);
    })
  );

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(edges)
        .id((d) => d.id)
        .distance(80)
    )
    .force("charge", d3.forceManyBody().strength(-100))
    .force("center", d3.forceCenter(width / 2, height / 2));

  const linkGroup = g.append("g");
  const link = linkGroup
    .selectAll("line")
    .data(edges)
    .join("line")
    .attr("class", "edge-line");

  link.append("title").text((d) => d.relation);

  const nodeGroup = g.append("g");
  const node = nodeGroup
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node-group")
    .call(
      d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended)
    )
    .on("click", (event, d) => showDetail(d));

  node.each(function (d) {
    const el = d3.select(this);

    if (d.kind === "decision") {
      const s = 8;
      const hex = d3.range(6).map((i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        return [s * Math.cos(a), s * Math.sin(a)];
      });
      el.append("polygon")
        .attr("points", hex.map((p) => p.join(",")).join(" "))
        .attr("class", "node-shape kind-decision");
    } else if (d.kind === "reference") {
      el.append("rect")
        .attr("x", -4)
        .attr("y", -4)
        .attr("width", 8)
        .attr("height", 8)
        .attr("class", "node-shape kind-reference");
    } else {
      el.append("circle").attr("r", 4).attr("class", "node-shape");
    }
  });

  node
    .append("text")
    .attr("class", "node-label")
    .attr("dx", 10)
    .attr("dy", 3)
    .text((d) => d.name);

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  let selectedNode = null;

  function showDetail(d) {
    selectedNode = d;

    node.classed("selected", (n) => n === d);
    node.selectAll(".node-shape").classed("selected", (n) => n === d);
    link.classed("highlighted", (e) => e.source === d || e.target === d);

    const data = typeof d.data === "string" ? JSON.parse(d.data) : d.data;
    let html = "<h2>" + escapeHtml(d.name) + "</h2>";
    html += field("Kind", d.kind);
    html += field("Tier", d.tier);

    if (d.kind === "decision") {
      if (data.description) html += field("Description", data.description);
      if (data.rationale) html += field("Rationale", data.rationale);
      if (data.status) html += field("Status", data.status);
      if (data.alternatives && data.alternatives.length > 0) {
        const altText = data.alternatives
          .map((a) => escapeHtml(a.name) + ": " + escapeHtml(a.reason_rejected))
          .join("<br>");
        html += field("Alternatives", altText);
      }
    }

    if (d.qualified_name) html += field("Qualified Name", d.qualified_name);
    if (d.file_path) html += field("File", d.file_path);

    const connected = edges
      .filter((e) => e.source.id === d.id || e.target.id === d.id)
      .map((e) => {
        const other = e.source.id === d.id ? e.target : e.source;
        const dir = e.source.id === d.id ? "\u2192" : "\u2190";
        return escapeHtml(dir + " " + e.relation + " " + other.name);
      });

    if (connected.length > 0) {
      html += field("Connections", connected.join("<br>"));
    }

    html += field("ID", d.id);
    detailContent.innerHTML = html;
    detailPanel.classList.remove("hidden");
  }

  function field(label, value) {
    return (
      '<div class="field"><div class="field-label">' +
      escapeHtml(label) +
      '</div><div class="field-value">' +
      value +
      "</div></div>"
    );
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  closePanel.addEventListener("click", () => {
    detailPanel.classList.add("hidden");
    selectedNode = null;
    node.classed("selected", false);
    node.selectAll(".node-shape").classed("selected", false);
    link.classed("highlighted", false);
  });

  searchInput.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    node.style("opacity", (d) => (q === "" || d.name.toLowerCase().includes(q) ? 1 : 0.1));
    link.style("opacity", q === "" ? 1 : 0.05);
  });

  document.querySelectorAll("#filters input").forEach((cb) => {
    cb.addEventListener("change", applyFilters);
  });

  function applyFilters() {
    const activeKinds = new Set();
    document.querySelectorAll("#filters input:checked").forEach((cb) => {
      activeKinds.add(cb.dataset.kind);
    });

    node.style("display", (d) => {
      const has = document.querySelector('#filters input[data-kind="' + d.kind + '"]');
      return !has || activeKinds.has(d.kind) ? null : "none";
    });

    link.style("display", (e) => {
      const sv = isVisible(e.source);
      const tv = isVisible(e.target);
      return sv && tv ? null : "none";
    });
  }

  function isVisible(d) {
    const cb = document.querySelector('#filters input[data-kind="' + d.kind + '"]');
    return !cb || cb.checked;
  }
})();
```

- [ ] **Step 4: Manual verification**

Run: `CORTEX_DB_PATH=":memory:" npx tsx src/index.ts &`

Then open `http://localhost:3333/viewer` in a browser. Verify:
- Page loads with black background, Geist Mono font
- Empty state message shows (no nodes yet)
- No JavaScript console errors

Kill the background process after verification.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/graph-viewer.js
git commit -m "feat: add D3 force-directed graph viewer with Anthill theme"
```

---

## Task 16: Connector Interface Stub

**Files:**
- Create: `src/connectors/types.ts`

- [ ] **Step 1: Create the Phase 2 interface stub**

`src/connectors/types.ts`:
```typescript
/**
 * Connector interface for Phase 2 external system integration (Jira, Confluence, etc.).
 * Phase 1 only defines the interface — no implementations.
 */
export interface ExternalConnector {
  readonly name: string;
  search(query: string): Promise<ExternalReference[]>;
  resolve(id: string): Promise<ExternalReference | null>;
}

export interface ExternalReference {
  id: string;
  source: string;
  title: string;
  url: string;
  metadata: Record<string, unknown>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/connectors/types.ts
git commit -m "feat: add Phase 2 external connector interface stub"
```

---

## Task 17: Hooks & Skills

**Files:**
- Create: `src/hooks/suggest-capture.sh`
- Create: `src/skills/search-decisions.md`

- [ ] **Step 1: Create the suggest-capture hook**

`src/hooks/suggest-capture.sh`:
```bash
#!/usr/bin/env bash
# Hook: suggest-capture
#
# Fires after commits or plan completion to nudge the agent
# into considering whether any decisions should be captured.
#
# Install in .claude/settings.local.json:
# {
#   "hooks": {
#     "PostToolUse": [{
#       "matcher": "Bash",
#       "hooks": ["bash src/hooks/suggest-capture.sh"]
#     }]
#   }
# }

echo ""
echo "---"
echo "Were any architectural or design decisions made during this work?"
echo "If so, use create_decision to capture the decision with its rationale and alternatives."
echo "Use search_decisions first to check if a similar decision already exists."
echo "---"
```

Run: `chmod +x src/hooks/suggest-capture.sh`

- [ ] **Step 2: Create the search-decisions skill**

`src/skills/search-decisions.md`:
```markdown
---
name: search-decisions
description: Search the Anthill Cortex knowledge graph for architectural and design decisions
---

# Search Decisions

Use the Anthill Cortex MCP tools to find and query existing decisions in the knowledge graph.

## When to use

- Before creating a new decision — check if one already exists
- When trying to understand why code was built a certain way
- When evaluating whether to change an architectural pattern

## Tools

### Search by keyword

```
search_decisions({ query: "authentication middleware" })
```

### Scope to specific code

```
search_decisions({ query: "caching", scope: "src/api/routes" })
```

### Find decisions for a code entity

```
why_was_this_built({ qualified_name: "src/auth/middleware.ts::validateToken" })
```

`why_was_this_built` walks up the file hierarchy if no direct match is found — checking the file, then parent directories.

### Get full decision details

```
get_decision({ id: "<decision-id>" })
```

Returns the decision with resolved GOVERNS and REFERENCES links.

## Tips

- Use domain-specific keywords, not generic terms
- Scope narrows results to decisions that GOVERNS a specific code path
- Check search results before creating duplicates
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/suggest-capture.sh src/skills/search-decisions.md
git commit -m "feat: add decision capture hook and search-decisions skill"
```

---

## Task 18: Plugin Manifest & Final Integration

**Files:**
- Create: `plugin.json`
- Verify end-to-end

- [ ] **Step 1: Create plugin.json**

`plugin.json`:
```json
{
  "name": "anthill-cortex",
  "description": "Knowledge graph MCP server with decision provenance — code indexing, decision CRUD, full-text search, tier promotion, and graph viewer",
  "version": "0.1.0"
}
```

- [ ] **Step 2: Build the project**

Run: `npx tsc`

Expected: `dist/` directory created with compiled `.js` files, no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`

Expected: All tests pass. Summary should show:
- `tests/graph/store.test.ts` — 15 tests
- `tests/graph/fts.test.ts` — 5 tests
- `tests/graph/query.test.ts` — 7 tests
- `tests/decisions/service.test.ts` — 14 tests
- `tests/decisions/search.test.ts` — 7 tests
- `tests/decisions/promotion.test.ts` — 4 tests

Total: 52 tests, all passing.

- [ ] **Step 4: Commit**

```bash
git add plugin.json dist/
git commit -m "feat: add plugin manifest and build artifacts for Anthill Cortex Phase 1"
```

Note: if the project `.gitignore` excludes `dist/`, commit only `plugin.json`. The build step confirms compilation works.

---

## Parallelization Guide

For subagent-driven execution, these tasks can run in parallel:

| Parallel Group | Tasks | Reason |
|---|---|---|
| A | 2, 3, 4, 5 | All modify the graph store — run sequentially within group |
| B | 6 | Depends on Task 4 (needs edge CRUD) |
| C | 7, 8 | Depends on Tasks 3, 5 (needs node + FTS) — run sequentially |
| D | 9 | Depends on Tasks 7, 8 |
| E | 10 | Depends on Task 7 |
| F | 11 | Depends on Task 10 (needs all services) |
| G | 12, 13 | Depends on Task 11 — can run in parallel with each other |
| H | 14, 15 | Depends on Task 3. Can run in parallel with each other and with D-G |
| I | 16, 17 | No code dependencies — can run anytime after Task 1 |
| J | 18 | Depends on all other tasks |
