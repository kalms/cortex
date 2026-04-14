# Cortex

Knowledge graph MCP server with decision provenance. Combines structural code indexing (via [codebase-memory-mcp](https://github.com/anthropics/codebase-memory-mcp)) with decision tracking on a unified SQLite knowledge graph, plus a 3D WebGL graph viewer.

Cortex answers the question agents can't today: **"why was this built this way?"** — not just "what does this code do."

## Installation

### As a Claude Code Plugin

```bash
claude plugin add github:kalms/cortex
```

This gives you all 18 MCP tools, 3 skills, and 2 hooks automatically.

### Manual Setup

```bash
git clone git@github.com:kalms/cortex.git
cd cortex
npm install
```

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/cortex"
    }
  }
}
```

Or for a built version:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/cortex"
    }
  }
}
```

### Development Mode

```bash
npm run dev
```

Starts the MCP server (stdio) and the 3D graph viewer at [http://localhost:3333/viewer](http://localhost:3333/viewer).

## Architecture

```
┌──────────────────────────────────────────────┐
│              MCP Server (stdio)               │
│                                               │
│  Decision Tools (8)      Code Tools (10)      │
│  create, update,         search_graph,        │
│  delete, get,            trace_path,          │
│  search, why_built,      get_snippet,         │
│  link, promote           get_schema,          │
│                          search_code,         │
│                          list/status/index,   │
│                          detect_changes,      │
│                          delete_project       │
├──────────────────────────────────────────────┤
│  DecisionService  │  CBM Queries (SQL)        │
│  DecisionSearch   │  ATTACH cbm.db READ ONLY  │
│  DecisionPromotion│                           │
├──────────────────────────────────────────────┤
│  Cortex GraphStore (SQLite/WAL)               │
│  nodes ─ edges ─ annotations ─ FTS5           │
│              ┌───────────────────┐            │
│              │ ATTACH cbm.db     │            │
│              │ (read-only)       │            │
│              └───────────────────┘            │
└──────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  HTTP Server     │
│  :3333/api/graph │  ← unified nodes/edges from both stores
│  :3333/viewer    │  ← 3D WebGL graph
└─────────────────┘
```

**Tech stack:** TypeScript, Node.js 20+, better-sqlite3, @modelcontextprotocol/sdk, zod, 3d-force-graph + Three.js (WebGL)

## MCP Tools (18)

### Decision Tools (8)

| Tool | Description |
|------|-------------|
| `create_decision` | Create a decision with rationale, alternatives, and governed code links |
| `update_decision` | Update decision fields (title, description, rationale, status) |
| `delete_decision` | Delete a decision and cascade-delete its edges |
| `get_decision` | Get a decision with resolved GOVERNS and REFERENCES links |
| `search_decisions` | FTS5 search over decision content, optionally scoped to a code path |
| `why_was_this_built` | Find decisions governing a code entity — walks up file/directory hierarchy |
| `link_decision` | Attach GOVERNS or REFERENCES edges to an existing decision |
| `promote_decision` | Promote a decision to team or public visibility tier |

### Code Tools — SQL (7)

These query codebase-memory-mcp's database directly via SQLite ATTACH (no subprocess, millisecond response):

| Tool | Description |
|------|-------------|
| `search_graph` | Find code entities by name, label, or qualified name pattern |
| `trace_path` | Trace call chains via recursive CTE (mode: calls or callers) |
| `get_code_snippet` | Read source code for a fully qualified name |
| `get_graph_schema` | List node labels and edge types with counts |
| `search_code` | Grep with graph enrichment — annotates matches with enclosing function/class |
| `list_projects` | List all indexed projects |
| `index_status` | Check if a repository is indexed |

### Code Tools — Subprocess (3)

These still spawn the codebase-memory-mcp binary (write operations):

| Tool | Description |
|------|-------------|
| `index_repository` | Run the 7-pass indexing pipeline |
| `detect_changes` | Map git diff to affected symbols |
| `delete_project` | Remove a project from the index |

## Skills

| Skill | Description |
|-------|-------------|
| `/search-decisions` | Find existing architectural decisions before making changes |
| `/capture-decision` | Guided workflow for recording new decisions with rationale and alternatives |
| `/explain-architecture` | Narrative explanation combining decisions, call chains, and code structure |

## Hooks

| Hook | Trigger | What it does |
|------|---------|-------------|
| Grep → search_code nudge | PreToolUse on Grep (code files only) | Suggests using `search_code` for graph-enriched results |
| Suggest capture | PostToolUse on git commit | Reminds agents to capture architectural decisions |

## Graph Viewer

The 3D viewer at `/viewer` renders the unified knowledge graph in WebGL using [3d-force-graph](https://github.com/vasturiano/3d-force-graph).

- **Node shapes by kind:** octahedrons (decisions), cubes (references), spheres (functions/components/paths)
- **Neon color palette:** amber decisions, teal functions, mint components, grey paths, violet references
- **Edge colors by relation:** grey (CALLS/IMPORTS), amber (GOVERNS), pink (SUPERSEDES), violet (REFERENCES)
- **Interactions:** orbit rotate, Cmd+drag pan, scroll zoom, click-to-focus camera, node drag
- **Detail panel:** click a node to see metadata; connections are clickable to fly to linked nodes
- **Search & filters:** real-time text search, kind filter checkboxes
- **Mobile:** responsive bottom half-sheet panel, collapsed toolbar toggles at < 768px

## CBM Integration

Cortex discovers and ATTACHes codebase-memory-mcp's SQLite database read-only on startup. Code entities and decisions live in separate database files but are queried as a unified graph.

- **Discovery:** Scans `~/.cache/codebase-memory-mcp/` for a database matching the current working directory
- **WAL visibility:** Cortex sees CBM's latest indexed data automatically — no re-attach needed
- **Zero lock contention:** CBM writes to its file, Cortex reads it. SQLite WAL MVCC handles concurrency.

Override the CBM database path with `CBM_DB_PATH` env var.

## Seeding Test Data

```bash
npx tsx scripts/seed.ts
```

Seeds 6 code entities, 5 decisions (with supersession + promotions), and 1 reference.

## Testing

```bash
npm test                                       # 70 tests
npm run test:watch                             # Watch mode
npx vitest run tests/graph/cbm-attach.test.ts  # Single file
```

| Suite | Tests | Covers |
|-------|-------|--------|
| `tests/graph/store.test.ts` | 15 | Schema, node/edge CRUD, annotations, FTS |
| `tests/graph/fts.test.ts` | 5 | FTS5 index/search/update/remove |
| `tests/graph/query.test.ts` | 7 | getConnected, findPath |
| `tests/graph/cbm-attach.test.ts` | 18 | ATTACH, discovery, CBM queries, unified graph |
| `tests/decisions/service.test.ts` | 14 | Decision CRUD with GOVERNS/REFERENCES edges |
| `tests/decisions/search.test.ts` | 7 | FTS search, scoped search, whyWasThisBuilt |
| `tests/decisions/promotion.test.ts` | 4 | Tier promotion |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DB_PATH` | `.cortex/graph.db` | Cortex SQLite database |
| `CORTEX_VIEWER_PORT` | `3333` | HTTP viewer port |
| `CBM_BINARY_PATH` | `codebase-memory-mcp` | Path to CBM binary (for index/detect_changes/delete) |
| `CBM_DB_PATH` | Auto-discovered | Explicit path to CBM database (skips discovery) |

## Project Structure

```
plugin.json                         # Claude Code plugin manifest
.mcp.json                           # MCP server configuration
CLAUDE.md                           # Agent instructions
skills/
  search-decisions/SKILL.md         # Find existing decisions
  capture-decision/SKILL.md         # Record new decisions
  explain-architecture/SKILL.md     # Narrative architecture explanations
hooks/
  hooks.json                        # Hook configuration (Grep nudge + commit capture)
  suggest-capture.sh                # Post-commit decision capture reminder
src/
  index.ts                          # Entry point — CBM discovery, MCP + HTTP servers
  graph/
    schema.ts                       # SQL DDL (tables, indexes, FTS5)
    store.ts                        # GraphStore — CRUD, ATTACH, unified queries
    query.ts                        # Traversal helpers (getConnected, findPath)
    cbm-queries.ts                  # SQL queries against attached CBM database
    cbm-discovery.ts                # Finds CBM database by scanning ~/.cache/
  decisions/
    types.ts                        # Decision interfaces
    service.ts                      # Decision CRUD + link operations
    search.ts                       # FTS search + whyWasThisBuilt
    promotion.ts                    # Tier promotion
  mcp-server/
    server.ts                       # MCP server factory
    api.ts                          # HTTP server for viewer + /api/graph
    tools/
      decision-tools.ts             # 8 decision MCP tools
      promotion-tools.ts            # promote_decision tool
      code-tools.ts                 # 10 code tools (6 SQL, 1 file read, 3 subprocess)
  connectors/
    types.ts                        # External connector interface (stub)
  viewer/
    index.html                      # 3D viewer (Three.js + 3d-force-graph)
    style.css                       # Neon theme, responsive mobile
    graph-viewer.js                 # WebGL graph — shapes, labels, camera, interactions
scripts/
  seed.ts                           # Seeds sample data for development
tests/
  graph/                            # Store, FTS, query, CBM attach tests
  decisions/                        # Service, search, promotion tests
```
