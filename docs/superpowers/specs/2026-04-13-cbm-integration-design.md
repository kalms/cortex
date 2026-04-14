# CBM Integration — Unified Graph via ATTACH

**Date:** 2026-04-13
**Status:** Approved
**Replaces:** Current `execFile` subprocess proxy to codebase-memory-mcp

## Goal

Eliminate the opaque subprocess proxy to codebase-memory-mcp (CBM). Replace it with a unified query surface where Cortex ATTACHes CBM's SQLite database read-only and queries it directly. Code tools become first-class SQL queries with proper error handling and structured responses. The 3D viewer shows both decisions and code entities in one graph.

This is an interim bridge. The long-term direction is a native TypeScript indexing pipeline using tree-sitter WASM (parked — see `memory/project_native_indexing.md`).

## Architecture

### Before

```
Cortex SQLite (.cortex/graph.db)     CBM SQLite (~/.cache/codebase-memory-mcp/)
├── decisions                         ├── code entities (nodes)
├── edges (GOVERNS, SUPERSEDES)       ├── edges (CALLS, IMPORTS)
└── references                        └── file_hashes, vectors
         │                                      │
         └── 7 tools shell out via execFile ────┘
             (opaque text passthrough, 60s timeout)
```

### After

```
Cortex SQLite (.cortex/graph.db)
├── decisions, references, GOVERNS/SUPERSEDES edges
│
├── ATTACH 'cbm.db' AS cbm READ ONLY
│   └── cbm.nodes, cbm.edges, cbm.projects, cbm.file_hashes
│
├── 6 code tools → direct SQL against cbm.*
├── 1 code tool → file read (get_code_snippet)
├── 3 code tools → subprocess (index, detect_changes, delete)
└── /api/graph → UNION ALL across main + cbm
```

### Key Properties

- **Zero lock contention.** CBM writes to its own file, Cortex reads it read-only. SQLite WAL MVCC ensures readers see committed data without blocking.
- **No sync step.** WAL visibility means Cortex sees CBM's latest commits automatically — no re-attach, no import, no copy.
- **Lazy attach.** ATTACH happens on first code tool call, not on startup. If CBM hasn't indexed anything, code tools return a helpful message.
- **Single attach, never re-attach.** WAL visibility handles freshness.

## CBM Database Discovery

1. Check `CBM_DB_PATH` env var (explicit path to a specific CBM database file)
2. Otherwise, scan `~/.cache/codebase-memory-mcp/` for `.db` files, query each `projects` table for a `root_path` matching the current working directory
3. If found: `ATTACH '/path/to/cbm.db' AS cbm READ ONLY`
4. If not found: code tools return `"Repository not indexed. Run index_repository first."`

## Tool Inventory

### Decision Tools (unchanged — 8 tools)

| Tool | Description |
|------|-------------|
| `create_decision` | Create a decision with rationale, alternatives, governed code links |
| `update_decision` | Update decision fields |
| `delete_decision` | Delete a decision and cascade-delete its edges |
| `get_decision` | Get a decision with resolved links |
| `search_decisions` | FTS5 search over decisions |
| `why_was_this_built` | Find decisions governing a code entity — hierarchy walk |
| `link_decision` | Attach GOVERNS or REFERENCES edges |
| `promote_decision` | Promote tier (personal → team → public) |

### Code Tools — SQL Rewrites (6 tools)

| Tool | Implementation |
|------|---------------|
| `search_graph` | `SELECT` on `cbm.nodes` with LIKE/glob on name, label, qualified_name. Filter by label, file_path. |
| `trace_path` | Recursive CTE walking `cbm.edges` by source_id/target_id + edge type. Supports inbound/outbound/both modes. Max depth parameter. |
| `get_graph_schema` | `SELECT DISTINCT label FROM cbm.nodes` + `SELECT DISTINCT type FROM cbm.edges` with counts. |
| `list_projects` | `SELECT * FROM cbm.projects` |
| `index_status` | `SELECT * FROM cbm.projects WHERE root_path = ?` |
| `search_code` | Spawn `rg` (ripgrep) or `grep` for pattern matching, parse output into file:line:match tuples. For each match, query `cbm.nodes WHERE file_path = ? AND start_line <= ? AND end_line >= ?` to find the enclosing function/class. Return each match annotated with its graph context (qualified_name, label, node ID). Falls back to plain grep output if CBM is not attached. |

### Code Tools — File Read (1 tool)

| Tool | Implementation |
|------|---------------|
| `get_code_snippet` | Look up `file_path`, `start_line`, `end_line` from `cbm.nodes` by qualified_name, then `fs.readFile` and slice to the line range. |

### Code Tools — Subprocess (3 tools)

| Tool | Why subprocess |
|------|---------------|
| `index_repository` | Drives CBM's 7-pass C indexing pipeline. Can't replicate in SQL. |
| `detect_changes` | Needs CBM's internal file_hash diffing + symbol mapping logic. |
| `delete_project` | Writes to CBM's database (deletes rows). |

These three continue using `execFile(CBM_BINARY, ["cli", tool, jsonArgs])`.

### Dropped Tools (4)

| Tool | Reason |
|------|--------|
| `query_graph` | Cypher is CBM's custom query language. SQL is more powerful. Not worth reimplementing. |
| `manage_adr` | Redundant with `create_decision` which has richer metadata. |
| `ingest_traces` | No runtime trace sources wired up. Not relevant to current goals. |
| `get_architecture` | Aggregation queries (count by label, top files by degree). Easy to add later as SQL if needed. |

### Total: 18 tools (8 decision + 10 code)

## Schema Mapping

CBM and Cortex have different node/edge schemas. Queries that span both (e.g., `/api/graph`, `why_was_this_built`) use a mapping layer.

### Nodes

| CBM column | Cortex column | Mapping |
|-----------|---------------|---------|
| `id` (integer) | `id` (uuid) | `'cbm-' \|\| CAST(id AS TEXT)` to avoid collisions |
| `label` (e.g., "Function") | `kind` | Lowercase: "Function" → "function" |
| `name` | `name` | Direct |
| `qualified_name` | `qualified_name` | Direct |
| `file_path` | `file_path` | Direct |
| `properties` (JSON) | `data` (JSON) | Direct passthrough |
| `start_line`, `end_line` | — | Merged into `data` JSON |
| — | `tier` | Default "personal" for all CBM nodes |
| — | `created_at`, `updated_at` | Use CBM's `indexed_at` from projects table |

### Edges

| CBM column | Cortex column | Mapping |
|-----------|---------------|---------|
| `source_id` (integer) | `source_id` (uuid) | `'cbm-' \|\| CAST(source_id AS TEXT)` |
| `target_id` (integer) | `target_id` (uuid) | `'cbm-' \|\| CAST(target_id AS TEXT)` |
| `type` (e.g., "CALLS") | `relation` | Direct (already uppercase) |
| `properties` (JSON) | `data` (JSON) | Direct passthrough |

### Node Kind Mapping

CBM uses labels like "Function", "Method", "Class", "Module", "File", "Package", "Folder". Map to Cortex's smaller set:

| CBM Label | Cortex Kind |
|-----------|-------------|
| Function, Method | `function` |
| Class, Module, Interface | `component` |
| File, Package, Folder | `path` |
| Everything else | `function` (fallback) |

## Unified `/api/graph`

The endpoint returns merged nodes and edges from both stores:

```sql
-- Nodes
SELECT id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at
FROM main.nodes
UNION ALL
SELECT 'cbm-' || CAST(id AS TEXT),
       LOWER(label),
       name, qualified_name, file_path, properties,
       'personal', created_at, updated_at
FROM cbm.nodes
WHERE project = ?

-- Edges
SELECT id, source_id, target_id, relation, data
FROM main.edges
UNION ALL
SELECT 'cbm-' || CAST(id AS TEXT),
       'cbm-' || CAST(source_id AS TEXT),
       'cbm-' || CAST(target_id AS TEXT),
       type, properties
FROM cbm.edges
WHERE project = ?
```

The viewer renders the merged result — code entities appear alongside decisions with no JS changes needed.

## Cross-Store Queries

`why_was_this_built` currently walks Cortex's graph looking for GOVERNS edges from decisions to code entities. After ATTACH, a code entity's `qualified_name` from CBM can match against GOVERNS edge targets in Cortex's store — enabling true cross-store traversal.

Similarly, `search_decisions` scoped to a file path can now validate that the file path corresponds to a real indexed code entity in CBM.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| CBM DB not found | Code tools return `"Repository not indexed. Run index_repository first."` |
| CBM DB exists but empty | Same message |
| CBM schema unexpected | Log warning, code tools return `"CBM database schema not recognized. Update codebase-memory-mcp."` |
| CBM binary not found | `index_repository`, `detect_changes`, `delete_project` return `"Set CBM_BINARY_PATH if the binary is not in PATH."` |
| SQL query error | Return error text with the specific query that failed |

## File Changes

| File | Change |
|------|--------|
| `src/graph/store.ts` | Add `attachCbm(dbPath)` method. Add `getAllNodesUnified(project)` and `getAllEdgesUnified(project)` that UNION across main + cbm. |
| `src/graph/cbm-queries.ts` | **New.** SQL query functions for the 6 rewritten code tools: searchGraph, tracePath, getGraphSchema, listProjects, indexStatus, searchCodeEnrich. |
| `src/mcp-server/tools/code-tools.ts` | Rewrite: 6 tools call cbm-queries, get_code_snippet reads files, 3 remain subprocess. Remove the generic `callCbm` proxy function. |
| `src/mcp-server/api.ts` | `/api/graph` returns unified nodes/edges via store methods. |
| `tests/graph/cbm-attach.test.ts` | **New.** Test ATTACH, schema mapping, graceful fallback when CBM DB missing, unified queries. |

### What doesn't change

All decision tools, DecisionService, DecisionSearch, DecisionPromotion, the viewer JS/HTML/CSS, the suggest-capture hook, the seed script.

## Testing

- ATTACH to a real CBM database (use the existing indexed `.cache` file or create a test fixture)
- Verify `search_graph` returns expected nodes
- Verify `trace_path` recursive CTE follows CALLS edges correctly
- Verify `get_code_snippet` reads the right file and line range
- Verify `/api/graph` returns merged nodes/edges with correct ID prefixes
- Verify graceful fallback when CBM DB doesn't exist
- Verify `index_repository` subprocess still works
- Verify `detect_changes` subprocess still works
- Verify viewer renders code entities from CBM alongside decisions

## Dependencies

- No new npm dependencies
- `codebase-memory-mcp` binary still required for `index_repository`, `detect_changes`, `delete_project`
- CBM database must be SQLite WAL mode (it is by default)
