# Anthill Cortex — Phase 1 Design Spec

## Overview

Anthill Cortex is a knowledge graph MCP server forked from `codebase-memory-mcp`. It combines structural code indexing with decision provenance, tiered visibility, and external system links into a single queryable graph.

**Phase 1 scope:** Fork + Foundation — decision node schema, full decision CRUD, query tools, local-only SQLite storage, graph viewer.

**Runtime:** TypeScript / Node.js
**Storage:** SQLite with graph abstraction layer (nodes + edges)
**Fork strategy:** Hard fork from codebase-memory-mcp. No upstream sync.

---

## Architecture

### Layered Modules

The codebase is organized into internal modules with clear boundaries. Each module owns its logic and exposes a clean interface. All modules share the same SQLite database through the graph layer.

```
anthill-cortex/
  package.json
  tsconfig.json
  plugin.json                    # Claude Code plugin manifest
  src/
    index.ts                     # Entry point — starts MCP server
    mcp-server/
      server.ts                  # MCP server setup, tool registration
      api.ts                     # /api/graph endpoint for the viewer
      tools/
        code-tools.ts            # Existing: search_graph, trace_path, etc.
        decision-tools.ts        # New: create/update/delete/search/why_was_this_built
        promotion-tools.ts       # promote_decision
      graph/
        store.ts                 # SQLite connection, migrations, generic node/edge CRUD
        schema.ts                # Table definitions (nodes, edges, metadata)
        query.ts                 # Graph traversal helpers (hop, filter, path)
      indexers/
        index.ts                 # Indexer registry + orchestration
        vue.ts                   # Vue SFC indexer
        typescript.ts            # TS/JS indexer
        nitro.ts                 # Nitro server routes
        drizzle.ts               # Drizzle schema indexer
        pinia.ts                 # Pinia store indexer
        composables.ts           # Composable dependency tracking
      decisions/
        service.ts               # Decision CRUD logic
        search.ts                # search_decisions, why_was_this_built
        promotion.ts             # Tier promotion logic
        types.ts                 # Decision types/interfaces
      connectors/                # Phase 2 — interface only
        types.ts                 # Connector interface definition
    viewer/
      index.html                 # Graph viewer — single page
      style.css                  # Anthill theme (black/white/grayscale, Geist Mono)
      graph-viewer.js            # D3 force graph + interactions
    skills/
      search-decisions.md        # Skill for searching decisions
    hooks/
      suggest-capture.sh         # Nudge agent to capture decisions
  .cortex/                       # Runtime data (gitignored)
    graph.db                     # SQLite database
```

### Module Boundaries

- **`graph/`** — Generic node+edge store. Knows nothing about decisions or code entities. Provides CRUD for nodes, edges, and edge annotations. Manages schema migrations. Exposes traversal helpers.
- **`indexers/`** — Writes code entity nodes into the graph. Carried over from codebase-memory-mcp. Each indexer understands a specific file type (Vue SFC, TypeScript, Nitro routes, etc.).
- **`decisions/`** — Writes decision nodes and their edges into the graph. Owns all decision business logic (CRUD, search, promotion).
- **`connectors/`** — Phase 2. Only the interface definition exists in Phase 1.
- **`tools/`** — Thin MCP wrappers. Validate input, call a service, format output. No business logic.
- **`viewer/`** — Static HTML/CSS/JS served by the MCP server. Read-only graph exploration.

---

## Graph Storage Schema

Three core tables in SQLite:

```sql
-- Every entity in the system: code entities, decisions, references
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,       -- 'function', 'component', 'route', 'decision', 'reference', etc.
  name        TEXT NOT NULL,       -- Human-readable name
  qualified_name TEXT,             -- Fully qualified (e.g., 'src/components/Button.vue::setup')
  file_path   TEXT,                -- Source file (null for decisions/references)
  data        TEXT NOT NULL DEFAULT '{}',  -- JSON blob for kind-specific fields
  tier        TEXT NOT NULL DEFAULT 'personal',  -- 'personal' | 'team' | 'public'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Relationships between any two nodes
CREATE TABLE edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES nodes(id),
  target_id   TEXT NOT NULL REFERENCES nodes(id),
  relation    TEXT NOT NULL,       -- 'calls', 'imports', 'governs', 'references', 'supersedes', etc.
  data        TEXT NOT NULL DEFAULT '{}',  -- JSON for edge metadata
  created_at  TEXT NOT NULL
);

-- For EXPLAINS_RELATIONSHIP: links a decision to an edge
CREATE TABLE edge_annotations (
  id          TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES nodes(id),
  edge_id     TEXT NOT NULL REFERENCES edges(id),
  created_at  TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX idx_nodes_file_path ON nodes(file_path);
CREATE INDEX idx_nodes_tier ON nodes(tier);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_relation ON edges(relation);
```

### Full-Text Search

SQLite FTS5 virtual table for searching decision content:

```sql
CREATE VIRTUAL TABLE decisions_fts USING fts5(
  title, description, rationale,
  content='nodes',
  content_rowid='rowid'
);
```

Kept in sync via triggers on INSERT/UPDATE/DELETE of decision nodes.

### Schema Design Notes

- **`data` column (JSON)** — Kind-specific fields live here. For decisions: `{ title, description, rationale, alternatives, status, superseded_by, created_by }`. For code entities: `{ params, return_type, line_start, line_end }`. The graph layer doesn't parse this — consumers do.
- **`tier` on nodes** — Every node has a visibility tier. Code entities default to `'public'` (derived from source). Decisions default to `'personal'`. Phase 1 stores the value; Phase 3 enforces filtering.
- **`edge_annotations`** — Separate table because EXPLAINS_RELATIONSHIP links a decision to an *edge* (not a node). Keeps the edges table clean.
- **Existing relationships** (calls, imports, extends) map directly to the edges table with no schema changes from upstream.

---

## Decision Node Schema

```typescript
interface Decision {
  id: string;
  title: string;
  description: string;
  rationale: string;
  alternatives: Alternative[];
  tier: 'personal' | 'team' | 'public';
  status: 'active' | 'superseded' | 'deprecated';
  superseded_by?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

interface Alternative {
  name: string;
  reason_rejected: string;
}
```

### Edge Types from Decisions

| Edge | Source | Target | Purpose |
|---|---|---|---|
| `GOVERNS` | Decision | Code entity or file/directory path | This decision affects this code |
| `EXPLAINS_RELATIONSHIP` | Decision | Edge (via edge_annotations) | Why two entities are connected |
| `REFERENCES` | Decision | External ref node | Links to Jira, Confluence, etc. |
| `SUPERSEDES` | Decision | Decision | Decision evolution chain |

**GOVERNS target resolution:** Accepts either a node ID (for indexed code entities) or a raw file/directory path. If a path target isn't already in the graph, a lightweight "path" node is created so the edge has something to point at. No type discrimination between code entities and paths.

---

## Decision Service

### CRUD Operations

```typescript
// decisions/service.ts

create(input: CreateDecisionInput): Decision
  // 1. Create decision node (kind='decision', tier='personal')
  // 2. Create GOVERNS edges for each target in governs[]
  //    - If target matches an existing node ID, link to it
  //    - If target looks like a file path, create/find a path node and link
  // 3. Create REFERENCES edges for each ref
  // 4. Return the decision

update(id: string, input: UpdateDecisionInput): Decision
  // Update the node's data JSON, bump updated_at

delete(id: string): void
  // Remove the decision node and all its edges

get(id: string): Decision & { governs: Node[], references: Node[] }
  // Return decision with resolved linked entities
```

### Query Operations

```typescript
// decisions/search.ts

search_decisions(query: string, scope?: string): Decision[]
  // Full-text search via FTS5 over title + description + rationale
  // If scope is a qualified_name or file path, filter to decisions
  // that GOVERNS that entity (or its children)

why_was_this_built(qualified_name: string): Decision[]
  // Find all decisions linked via GOVERNS to this entity
  // Hierarchy walk: if no direct match on the entity,
  // check the containing file, then the containing directory
```

### Promotion

```typescript
// decisions/promotion.ts

promote(id: string, tier: 'team' | 'public'): Decision
  // Update the tier field on the decision node
  // Phase 1: just stores the value
  // Phase 3: will trigger sync to shared backend
```

### Creation Inputs

```typescript
interface CreateDecisionInput {
  title: string;
  description: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];        // Node IDs or file paths
  references?: string[];     // Node IDs of external ref nodes
}

interface UpdateDecisionInput {
  title?: string;
  description?: string;
  rationale?: string;
  alternatives?: Alternative[];
  status?: 'active' | 'superseded' | 'deprecated';
  superseded_by?: string;
}
```

---

## MCP Tool Surface

### Carried Over (unchanged from codebase-memory-mcp)

| Tool | Parameters |
|---|---|
| `search_graph` | `name_pattern?, label?, qn_pattern?` |
| `trace_path` | `function_name, mode` |
| `get_code_snippet` | `qualified_name` |
| `query_graph` | `query` |
| `get_architecture` | `aspects` |
| `search_code` | `pattern` |
| `index_repository` | `path?` |

### New Decision Tools

| Tool | Parameters | Returns |
|---|---|---|
| `create_decision` | `title, description, rationale, alternatives?, governs?, references?` | Created decision with ID |
| `update_decision` | `id, title?, description?, rationale?, alternatives?, status?, superseded_by?` | Updated decision |
| `delete_decision` | `id` | Confirmation |
| `get_decision` | `id` | Decision with resolved links |
| `search_decisions` | `query, scope?` | Array of matching decisions |
| `why_was_this_built` | `qualified_name` | Array of decisions governing entity |
| `promote_decision` | `id, tier` | Updated decision |
| `link_decision` | `decision_id, target, relation?` | Created edge |

### Tool Behavior

- All tools return structured JSON, not prose
- Error cases return `{ error: string }` with a descriptive message
- `query_graph` works for decisions — they're nodes in the graph, queryable with the same syntax
- `link_decision` attaches additional GOVERNS or REFERENCES edges to an existing decision

---

## Decision Capture Strategy

Decisions are created **explicitly only** via the `create_decision` tool. Agents will not spontaneously capture decisions without prompting.

**Hooks and skills provide the nudge:**
- A hook fires at key moments (after commits, after plan completion) and prompts the agent to consider whether any decisions should be captured
- A skill (`search-decisions`) teaches agents how to query existing decisions

This separates the "when to capture" concern (hooks — deterministic) from the "how to structure" concern (the agent — already an LLM that can fill in structured fields when asked).

---

## Graph Viewer

A local web UI served by the MCP server for read-only exploration of the knowledge graph.

**Endpoint:** `http://localhost:<port>/viewer`

### Visual Design — Anthill Theme

- **Background:** Black
- **Nodes and edges:** White/gray — like tunnels in an ant colony
- **Font:** Geist Mono throughout (loaded from CDN)
- **Node shapes by kind:**
  - Code entities: circles (small)
  - Decisions: hexagons (medium, slightly brighter white)
  - References: squares (small, dashed border)
- **Edges:** Thin gray lines, subtle pulse animation on hover
- **Labels:** Light gray, monospace, shown on hover to reduce clutter
- **Selected node:** White glow/halo, connected edges brighten
- **Aesthetic:** Terminal/minimal — clean, information-dense, no decorative elements

### Interactions

- Pan and zoom
- Click a node to see details in a side panel (properties, linked nodes, decision rationale/alternatives)
- Filter by node kind (toggle code/decisions/references)
- Search bar to find nodes by name
- Hover an edge to see its relation type

### Tech

- Static HTML/CSS/JS — no build step, no framework
- D3.js for the force-directed layout (loaded from CDN)
- Data fetched from `/api/graph` endpoint that returns all nodes and edges as JSON
- Served from `src/viewer/` as static files

---

## What's Deferred

| Feature | Phase |
|---|---|
| Staleness detection | Phase 2 |
| Jira + Confluence connectors | Phase 2 |
| `stale_decisions` tool | Phase 2 |
| `search_references` tool | Phase 2 |
| `link_external` tool | Phase 2 |
| Tiered visibility enforcement | Phase 3 |
| Shared backend for team/public sync | Phase 3 |
| Auth (Auth0) | Phase 3 |
| Plugin distribution / install flow | Phase 4 |
| Auto-promotion heuristics | Phase 4 |
| Conversation ingestion | Phase 4 |

---

## Open Questions (Resolved for Phase 1)

| Question | Decision |
|---|---|
| Graph storage engine | SQLite with nodes+edges abstraction layer |
| Sync protocol for team decisions | Deferred to Phase 3 |
| Auto-promotion heuristics | Deferred to Phase 4 |
| Conversation ingestion | Deferred — explicit capture only, hooks for nudging |
| Fork strategy | Hard fork, no upstream sync |
| Runtime | TypeScript / Node.js |
