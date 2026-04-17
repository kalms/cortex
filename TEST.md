# Testing Cortex

## Quick Start

```bash
npm install
npm test                    # 70 unit tests via vitest
npm run dev                 # Starts MCP server (stdio) + viewer (http://localhost:3334)
```

## Unit Tests

```bash
npm test                              # Run all 70 tests
npm run test:watch                    # Watch mode
npx vitest run tests/graph/store.test.ts   # Single file
```

### Test Coverage

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `tests/graph/store.test.ts` | 15 | Schema migration, node/edge CRUD, annotations, FTS |
| `tests/graph/fts.test.ts` | 5 | FTS5 index, search, update, remove |
| `tests/graph/query.test.ts` | 7 | getConnected (out/in/filtered), findPath (direct/multi-hop/maxDepth) |
| `tests/graph/cbm-attach.test.ts` | 18 | CBM ATTACH, discovery, searchGraph, tracePath, schema, unified queries |
| `tests/decisions/service.test.ts` | 14 | Decision create/update/delete/get with GOVERNS/REFERENCES edges |
| `tests/decisions/search.test.ts` | 7 | FTS keyword search, scoped search, whyWasThisBuilt hierarchy walk |
| `tests/decisions/promotion.test.ts` | 4 | Tier promotion (personal → team → public) |

## Testing the MCP Server

### Option 1: Via Claude Code (recommended)

Add Cortex as an MCP server in your project's `.mcp.json`:

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

Then in Claude Code, you can call the tools directly:

```
create_decision({ name: "Use Redis for caching", description: "...", rationale: "..." })
search_decisions({ query: "caching" })
why_was_this_built({ qualified_name: "src/cache/redis.ts::RedisClient" })
search_graph({ name_pattern: "auth" })
trace_path({ function_name: "handleRequest", mode: "calls" })
```

### Option 2: Via MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

This opens a web UI where you can browse tools, call them interactively, and inspect responses.

### Option 3: Via the seed script + viewer

```bash
rm -f .cortex/graph.db && npx tsx scripts/seed.ts
npm run dev
open http://localhost:3334/viewer
```

The viewer shows the full graph — decisions, code entities, and all edges. Click nodes to see detail panels, use search and kind filters, test mobile layout at narrow viewport.

## Testing the CBM Integration

### Prerequisites

Cortex needs an indexed CBM database. If you've used `codebase-memory-mcp` before, databases are at `~/.cache/codebase-memory-mcp/`.

```bash
# Check if current project is indexed
ls ~/.cache/codebase-memory-mcp/*.db

# Index the current project (requires codebase-memory-mcp binary)
codebase-memory-mcp cli index_repository '{"path":"'$(pwd)'"}'
```

### Verifying the ATTACH works

```bash
# Start the server — stderr should show:
# "Cortex: attached CBM database (project: ...)"
npm run dev

# Check unified node count (should be much higher than seed-only 14)
curl -s http://localhost:3334/api/graph | python3 -c "
import sys, json
d = json.load(sys.stdin)
cbm = sum(1 for n in d['nodes'] if str(n['id']).startswith('cbm-'))
ctx = len(d['nodes']) - cbm
print(f'CBM: {cbm} nodes, Cortex: {ctx} nodes, Total: {len(d[\"nodes\"])} nodes, {len(d[\"edges\"])} edges')
"
```

### Verifying tools work

Once Cortex is configured as an MCP server (see Option 1 above):

```
# Search code entities
search_graph({ name_pattern: "handleRequest" })

# Trace call chain
trace_path({ function_name: "handleRequest", mode: "calls" })

# Get source code
get_code_snippet({ qualified_name: "src/index.ts::store" })

# Graph-enriched grep
search_code({ pattern: "GraphStore" })

# Check index status
index_status({})
list_projects({})
get_graph_schema({})
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CORTEX_DB_PATH` | `.cortex/graph.db` | Cortex SQLite database |
| `CORTEX_VIEWER_PORT` | `3333` (MCP), `3334` (dev) | HTTP viewer port |
| `CBM_BINARY_PATH` | `codebase-memory-mcp` | Path to CBM binary (for index/detect_changes/delete) |
| `CBM_DB_PATH` | Auto-discovered | Explicit path to CBM database (skips discovery) |

---

## Plugin & Adoption Considerations

### Current State

Cortex has the building blocks for a Claude Code plugin but isn't packaged as one yet:

| Component | Status | Location |
|-----------|--------|----------|
| MCP server | Working | `src/index.ts` (stdio) |
| Plugin manifest | Minimal | `plugin.json` (name + version only) |
| Skill: search-decisions | Working | `src/skills/search-decisions.md` |
| Hook: suggest-capture | Working | `src/hooks/suggest-capture.sh` |
| Viewer | Working | `http://localhost:3334/viewer` (dev) |

### What's Missing for Plugin Distribution

**For agents (MCP adoption):**

1. **`.mcp.json` template** — A ready-to-copy config block so any project can add Cortex as an MCP server. Should be documented and tested.

2. **More skills beyond search-decisions:**
   - `capture-decision` — guided workflow for creating a new decision (prompts for rationale, alternatives, governed code)
   - `review-decisions` — show stale or unlinked decisions for a code path
   - `explain-architecture` — combine `why_was_this_built` + `trace_path` to give a narrative explanation of a code area

3. **CLAUDE.md instructions** — A snippet projects can add to their CLAUDE.md to tell agents "Cortex is available, use it for architectural decisions."

**For humans (UI adoption):**

4. **VSCode sidebar** — Streaming decision log + embedded graph viewer (sub-project B, planned)

5. **Better onboarding** — Currently requires manual seed/index. A first-run experience that indexes the current project and shows the viewer would lower the bar.

**For distribution:**

6. **Full `plugin.json`** — Needs `mcpServers`, `skills`, `hooks` entries per the Claude Code plugin spec. Currently only has name/version.

7. **npm package or GitHub release** — So other projects can install via `npx` or plugin marketplace.

### Recommended Next Steps for Adoption

1. Write proper `plugin.json` with MCP server, skills, and hooks
2. Create the `capture-decision` skill (highest value — it's the primary write path)
3. Build the VSCode sidebar (sub-project B)
4. Add CLAUDE.md template snippet for adopting projects
