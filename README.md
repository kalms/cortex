# Cortex

Knowledge graph MCP server with decision provenance. Combines a native structural code indexer with decision tracking on a unified SQLite knowledge graph, plus a 3D WebGL graph viewer. The indexer is bundled in-tree under `internal/indexer/` and writes directly to Cortex's SQLite database — there is no separate codebase-memory subprocess or external dependency. (Indexer lineage: originally [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), absorbed via git subtree on 2026-05-04.)

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

Register Cortex in your `.mcp.json` (project-level) or `~/.claude.json` (user-level):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "bash",
      "args": ["/path/to/cortex/bin/cortex-mcp.sh"]
    }
  }
}
```

The `bin/cortex-mcp.sh` wrapper resolves its own install path and `cd`s into it before exec'ing `npx tsx src/index.ts`. It exists because Claude Code's MCP spawn does not reliably honor the `cwd` field — child processes inherit the host session's working directory, which usually has no `tsx` and no `src/index.ts`. The wrapper sidesteps that with a single line of bash.

If you'd rather invoke a built bundle, run `npm run build` then point at it:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/index.js"]
    }
  }
}
```

### Development Mode

```bash
npm run dev
```

Starts the MCP server (stdio) and the 2D graph viewer at [http://localhost:3334/viewer](http://localhost:3334/viewer) (the legacy 3D viewer is at `/viewer/3d`). Port 3333 is reserved for the MCP plugin instance.

### Troubleshooting

**`/mcp` shows `cortex` as `✘ failed` with `-32000 connection closed`**

Check three locations for stale `cortex` entries in this order — the first match wins and silently overrides everything below it:

1. `<your-project>/.mcp.json` — project-level override
2. `~/.claude.json` under `projects["<your-project>"].mcpServers` — per-project user config (added by `claude mcp add`)
3. `~/.claude/plugins/cache/cortex-local/cortex/<ver>/.mcp.json` — the canonical plugin config

`/mcp` displays which file it loaded under `Config location`. If a stale `cwd: "/path/to/cortex"` entry is being read instead of the wrapper-based config, remove it and re-open the Claude Code window.

**`Error: Could not locate the bindings file` (better-sqlite3)**

The native addon wasn't compiled in the plugin cache. Rebuild it in place:

```bash
cd ~/.claude/plugins/cache/cortex-local/cortex/<ver>
npm rebuild better-sqlite3
```

## Graph UI

Cortex emits structured events for every decision change and git commit, persists them to an append-only SQLite log at `.cortex/events.db`, and broadcasts them + derived graph mutations over a WebSocket at `ws://localhost:3333/ws`. The 2D browser viewer and activity stream (Plans B and C) will consume this stream. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) for the two-thread event pipeline, the WebSocket protocol, and extension recipes.

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
│  DecisionService  │  Code Queries (SQL)       │
│  DecisionSearch   │  SELECT FROM nodes/edges  │
│  DecisionPromotion│  WHERE kind != decision   │
├──────────────────────────────────────────────┤
│  Cortex GraphStore (SQLite/WAL)               │
│  Single file: <install>/.cortex/graph.db      │
│   ├─ nodes   (decisions + code, kind disc.)   │
│   ├─ edges   (governance + code-graph)        │
│   ├─ edge_annotations                         │
│   ├─ decisions_fts                            │
│   └─ ctx_*  (indexer bookkeeping —            │
│              projects, file_hashes,           │
│              project_summaries, nodes_fts,    │
│              node_vectors, token_vectors)     │
└──────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  HTTP Server     │
│  :3333/api/graph │  ← unified nodes/edges (MCP plugin)
│  :3333/viewer    │  ← 2D canvas graph (dev: :3334; 3D at /viewer/3d)
└─────────────────┘
```

The indexer subprocess writes directly into Cortex's `nodes`/`edges` tables (post-Phase-4 schema fold) using `'ctx-<int>'` text IDs and lowercase `kind` values. SQLite ATTACH is no longer used; both the indexer and Cortex's TS layer operate on the same single `cortex.db` file with WAL concurrency.

**Tech stack:** TypeScript, Node.js 20+, better-sqlite3, @modelcontextprotocol/sdk, zod, d3-force + Canvas 2D (viewer), 3d-force-graph + Three.js (legacy 3D viewer)

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

These query the unified `nodes`/`edges` tables directly (no subprocess, millisecond response). Code-entity rows are distinguished from decision/PR/TODO rows by `kind`:

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

These spawn the `bin/cortex-indexer` binary (write operations):

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

## Native Indexer

Cortex builds and bundles its own structural indexer at `bin/cortex-indexer`. The indexer source lives in-tree at `internal/indexer/` (lineage: originally [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), absorbed via git subtree on 2026-05-04). `npm install` runs `scripts/build-indexer.sh` (postinstall) which compiles the indexer locally — no network download, no separate install, and no longer any separate codebase-memory-mcp process.

The indexer and Cortex share a single SQLite file (`<install>/.cortex/graph.db` by default; override via `CORTEX_DB_PATH`). The indexer writes code entities into Cortex's `nodes`/`edges` tables directly (with `'ctx-<int>'` text IDs and lowercase `kind` values like `function`, `class`, `method`); decisions/PRs/TODOs use the same tables with their own kinds. Indexer-internal bookkeeping (project metadata, file hashes, FTS5 over names, semantic vectors) lives in `ctx_*`-prefixed tables alongside.

- **Single-file architecture:** no SQLite ATTACH, no separate cache file. The indexer and Cortex's TS layer operate on the same `cortex.db` with WAL concurrency.
- **Bulk-write fast path:** `internal/indexer/extract/sqlite_writer.c` constructs the SQLite file via raw B-tree page writes for full-index runs. Schema-aware after Phase 4 (writes Cortex's `nodes`/`edges` directly). Linear extrapolation: ~3 minutes for a Linux-scale (~180k LOC) repo.
- **Subprocess invocation:** Cortex spawns `bin/cortex-indexer cli index_repository …` with `CORTEX_DB` env pointing at the same SQLite file.

The historical `~/.cache/codebase-memory-mcp/` cache directory (from pre-absorption versions) is gone (Phase 3a/3b/4). Migration paths for v0.2/v0.3 legacy DBs were dropped under a "break-away" decision — there is no automatic upgrade. Delete your existing `cortex.db` and re-run `index_repository` to pick up the new schema.

## Seeding Test Data

```bash
npx tsx scripts/seed.ts
```

Seeds 6 code entities, 5 decisions (with supersession + promotions), and 1 reference.

## Testing

```bash
npm test                                          # 360 tests, 48 files
npm run test:watch                                # Watch mode
npx vitest run tests/graph/code-queries.test.ts   # Single file
```

Major suites:

| Suite | Tests | Covers |
|-------|-------|--------|
| `tests/graph/store.test.ts` | 15 | Schema, node/edge CRUD, annotations, FTS |
| `tests/graph/code-queries.test.ts` | 6 | End-to-end: indexer → unified `nodes`/`edges` → query |
| `tests/decisions/service.test.ts` | 14 | Decision CRUD with GOVERNS/REFERENCES edges |
| `tests/mcp-contract/code-tools.test.ts` | 19 | All 10 code-tool MCP contract scenarios |
| `tests/mcp-contract/decision-tools.test.ts` | 11 | All 8 decision-tool MCP contracts |
| `tests/viewer/*.test.ts` | ~120 | Viewer layout, projection, sizing, camera, etc. |
| `tests/events/*.test.ts` | ~40 | Event pipeline + mutation derivation |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DB_PATH` | `.cortex/graph.db` | Cortex SQLite database (TS-side connection string) |
| `CORTEX_DB` | _(set by Cortex)_ | Same path, passed to the indexer subprocess so it writes to the same file |
| `CORTEX_VIEWER_PORT` | `3333` (MCP), `3334` (dev) | HTTP viewer port |
| `CORTEX_INDEXER_PATH` | `bin/cortex-indexer` | Path to the indexer binary (for index/detect_changes/delete) |
| `CBM_BINARY_PATH` | _(deprecated)_ | Backwards-compat fallback for `CORTEX_INDEXER_PATH` |

## License & Attribution

Cortex is split into two licensing zones:

- **`internal/indexer/`** — derivative of
  [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp).
  Governed by the **MIT License** (see [`internal/indexer/LICENSE`](./internal/indexer/LICENSE)).
- **Everything else** — Cortex's TypeScript code, viewer, MCP server, decision
  tooling, build scripts, plugin manifest, and documentation. **Proprietary,
  all rights reserved** (see the root [`LICENSE`](./LICENSE)).

The indexer additionally vendors several C libraries (mimalloc, SQLite, TRE,
xxHash, yyjson, tree-sitter runtime + grammars, LZ4, simplecpp, nomic
embedding vocabulary), each retaining its own upstream license. Full
attribution, upstream licenses, and per-component sources are documented in
[`THIRD_PARTY.md`](./THIRD_PARTY.md).

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
  index.ts                          # Entry point — MCP + HTTP servers, project resolution
  graph/
    schema.ts                       # SQL DDL (tables, indexes, FTS5) — single-file schema
    store.ts                        # GraphStore — CRUD, unified getAllNodes/Edges
    query.ts                        # Traversal helpers (getConnected, findPath)
    code-queries.ts                 # SQL queries against the unified nodes/edges
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
  graph/                            # Store, FTS, query, code-query tests
  decisions/                        # Service, search, promotion tests
```
