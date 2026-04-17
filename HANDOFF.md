# Cortex — Session Handoff (2026-04-13)

## What Was Done This Session

### 3D WebGL Graph Viewer
- Replaced the 2D D3/SVG viewer with 3d-force-graph + Three.js
- Neon color palette: amber decisions, teal functions, mint components, violet references, grey paths
- Custom shapes: octahedrons (decisions), cubes (references), spheres (others)
- Click-to-focus camera, orbit controls, Cmd+drag pan
- Detail panel with clickable connections (fly to linked node)
- Search highlighting, kind filter toggles
- Mobile responsive: bottom half-sheet panel, collapsed toolbar at <768px
- Fixed Three.js CDN loading (0.183+ dropped UMD build — uses ES module → window.THREE → dynamic script loading)
- Spec: `docs/superpowers/specs/2026-04-12-3d-graph-viewer-design.md`
- Plan: `docs/superpowers/plans/2026-04-12-3d-graph-viewer.md`

### CBM Integration — Unified Graph via SQLite ATTACH
- Cortex now ATTACHes codebase-memory-mcp's SQLite database read-only on startup
- 6 code tools rewritten as direct SQL queries (search_graph, trace_path, get_code_snippet, get_graph_schema, list_projects, index_status)
- 1 tool as grep + graph enrichment (search_code)
- 3 tools remain subprocess (index_repository, detect_changes, delete_project)
- 4 tools dropped (query_graph, manage_adr, ingest_traces, get_architecture)
- Unified `/api/graph` returns merged nodes/edges from both stores (349 nodes when indexed)
- Schema mapping: `cbm-` prefixed IDs, CBM labels mapped to Cortex kinds
- WAL visibility — no re-attach needed after re-indexing
- Spec: `docs/superpowers/specs/2026-04-13-cbm-integration-design.md`
- Plan: `docs/superpowers/plans/2026-04-13-cbm-integration.md`

### Other
- Suggest-capture hook wired in `.claude/settings.local.json` (fires on git commit)
- README updated for 3D viewer, seed script, hook installation
- All pushed to `origin/main`

## Current State

- **Branch:** main, up to date with origin
- **Tests:** 70 passing (7 test files)
- **TypeScript:** compiles clean
- **MCP tools:** 18 total (8 decision + 10 code)
- **Viewer:** http://localhost:3334/viewer (run `npm run dev`); MCP plugin uses :3333

## What's Next

### 1. VSCode Sidebar Extension (next priority)
- Streaming log of latest decisions, memories
- Embedded 3D graph viewer in a webview panel
- Needs brainstorm → spec → plan → implementation cycle
- This was identified as "sub-project B" during Phase 2 scoping

### 2. Native Tree-Sitter Indexing (parked)
- Replace CBM C binary with lightweight TypeScript pipeline using `web-tree-sitter` WASM
- Focus on common languages: TS, JS, Vue, Svelte, Python, Go
- Eliminates binary dependency and abandonment risk
- Details in memory: `memory/project_native_indexing.md`

### 3. External Connectors (deferred)
- Jira, Confluence, Git integration
- Connector interface stub exists at `src/connectors/types.ts`
- Deferred until core functionality is solid

### 4. Plugin Packaging & Adoption (high priority)

The read/write loop for decisions needs three things:

**Read path (automatic, ambient):**
- `PreToolUse` hook on `Edit|Write` — queries `why_was_this_built` for the file being modified, surfaces governing decisions as context. Silent when no decisions exist. Low token cost, high signal.
- `explain-architecture` skill — on-demand narrative combining `why_was_this_built` + `trace_path` + `search_decisions`

**Write path (guided):**
- `capture-decision` skill — guided workflow for creating decisions with rationale, alternatives, governed code links
- `suggest-capture` hook — already wired (PostToolUse on git commit)

**Distribution:**
- Full `plugin.json` with MCP server, skills, hooks
- `.mcp.json` template for adopting projects
- CLAUDE.md snippet for agent awareness

The PreToolUse hook on Edit/Write is the highest-leverage item — it makes decisions ambient without bloating SessionStart context.

## Key Files

| File | What it does |
|------|-------------|
| `src/index.ts` | Entry point — creates store, discovers CBM DB, starts MCP + HTTP |
| `src/graph/store.ts` | GraphStore — SQLite CRUD, ATTACH, unified queries |
| `src/graph/cbm-queries.ts` | SQL queries against attached CBM database |
| `src/graph/cbm-discovery.ts` | Finds CBM database by scanning ~/.cache/codebase-memory-mcp/ |
| `src/mcp-server/tools/code-tools.ts` | 10 code tools (6 SQL, 1 file read, 3 subprocess) |
| `src/mcp-server/tools/decision-tools.ts` | 8 decision tools |
| `src/viewer/graph-viewer.js` | 3D WebGL viewer (3d-force-graph) |
| `scripts/seed.ts` | Seeds sample data for development |

## Quick Start for Next Session

```bash
cd ~/Development/cortex
npm run dev          # Starts MCP server + viewer on :3334
# Or re-seed first:
rm -f .cortex/graph.db && npx tsx scripts/seed.ts && npm run dev
```
