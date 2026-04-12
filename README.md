# Cortex

Knowledge graph MCP server with decision provenance. Combines structural code indexing (via [codebase-memory-mcp](https://github.com/anthropics/codebase-memory-mcp)) with decision tracking on a SQLite knowledge graph, plus a D3 graph viewer.

Cortex answers the question agents can't today: **"why was this built this way?"** — not just "what does this code do."

## Architecture

```
┌─────────────────────────────────────┐
│           MCP Server (stdio)        │
│                                     │
│  Decision Tools (8)   Code Tools (7)│
│  create, update,      index_repo,   │
│  delete, get,         search_graph, │
│  search, why_built,   trace_path,   │
│  link, promote        get_snippet,  │
│                       query_graph,  │
│                       get_arch,     │
│                       search_code   │
├─────────────────────────────────────┤
│  DecisionService  │  DecisionSearch │
│  DecisionPromotion│  (FTS5 + walk)  │
├─────────────────────────────────────┤
│         GraphStore (SQLite/WAL)     │
│  nodes ─ edges ─ edge_annotations   │
│  decisions_fts (FTS5)               │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  HTTP Server     │
│  :3333/api/graph │
│  :3333/viewer    │
└─────────────────┘
```

**Tech stack:** TypeScript, Node.js 20+, better-sqlite3, @modelcontextprotocol/sdk, zod, D3.js v7

## Getting Started

```bash
npm install
npm run build
```

## Running

Cortex runs as an MCP server over stdio. Configure it in your Claude settings:

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

Or run in development mode:

```bash
npm run dev
```

The graph viewer starts automatically at [http://localhost:3333/viewer](http://localhost:3333/viewer).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CORTEX_DB_PATH` | `.cortex/graph.db` | SQLite database path |
| `CORTEX_VIEWER_PORT` | `3333` | HTTP server port for the graph viewer |
| `CBM_BINARY_PATH` | `codebase-memory-mcp` | Path to the codebase-memory-mcp binary |

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Run a specific test file
npx vitest run tests/graph/store.test.ts
```

### Test Suite

| File | Tests | What it covers |
|---|---|---|
| `tests/graph/store.test.ts` | 15 | Schema migration, node CRUD, edge CRUD, annotation CRUD |
| `tests/graph/fts.test.ts` | 5 | FTS5 index/search/update/remove |
| `tests/graph/query.test.ts` | 7 | getConnected (outgoing/incoming/filtered), findPath (direct/multi-hop/maxDepth) |
| `tests/decisions/service.test.ts` | 14 | Decision create/update/delete/get with GOVERNS/REFERENCES edges |
| `tests/decisions/search.test.ts` | 7 | FTS keyword search, scoped search, whyWasThisBuilt hierarchy walk |
| `tests/decisions/promotion.test.ts` | 4 | Tier promotion (personal -> team -> public) |
| **Total** | **52** | |

## MCP Tools

### Decision Tools

| Tool | Description |
|---|---|
| `create_decision` | Create a decision with rationale, alternatives, and governed code links |
| `update_decision` | Update decision fields (title, description, rationale, status) |
| `delete_decision` | Delete a decision and cascade-delete its edges |
| `get_decision` | Get a decision with resolved GOVERNS and REFERENCES links |
| `search_decisions` | FTS5 search over decision content, optionally scoped to a code path |
| `why_was_this_built` | Find decisions governing a code entity — walks up file/directory hierarchy |
| `link_decision` | Attach GOVERNS or REFERENCES edges to an existing decision |
| `promote_decision` | Promote a decision to team or public visibility tier |

### Code Indexing Tools (proxied to codebase-memory-mcp)

| Tool | Description |
|---|---|
| `index_repository` | Index a repository into the knowledge graph |
| `search_graph` | Search for code entities by name, label, or qualified name |
| `trace_path` | Trace call chains, data flow, or cross-service paths |
| `get_code_snippet` | Get source code for a fully qualified name |
| `query_graph` | Run a Cypher query against the knowledge graph |
| `get_architecture` | Get architecture overview for specified aspects |
| `search_code` | Full-text search across repository source code |

## Project Structure

```
src/
  index.ts                          # Entry point — starts MCP + HTTP servers
  graph/
    schema.ts                       # SQL DDL (tables, indexes, FTS5)
    store.ts                        # GraphStore — SQLite connection, CRUD
    query.ts                        # Traversal helpers (getConnected, findPath)
  decisions/
    types.ts                        # Decision interfaces, nodeToDecision
    service.ts                      # Decision CRUD + link operations
    search.ts                       # search + whyWasThisBuilt
    promotion.ts                    # Tier promotion
  mcp-server/
    server.ts                       # MCP server factory
    api.ts                          # HTTP server for viewer + /api/graph
    tools/
      decision-tools.ts             # MCP wrappers for decision operations
      promotion-tools.ts            # MCP wrapper for promote_decision
      code-tools.ts                 # Proxy to codebase-memory-mcp binary
  connectors/
    types.ts                        # Phase 2 connector interface (stub)
  viewer/
    index.html                      # Graph viewer page
    style.css                       # Cortex theme (black/Geist Mono)
    graph-viewer.js                 # D3 force graph + interactions
  hooks/
    suggest-capture.sh              # Post-commit nudge to capture decisions
  skills/
    search-decisions.md             # Skill for agents to query decisions
tests/
  graph/                            # Store, FTS, query helper tests
  decisions/                        # Service, search, promotion tests
```
