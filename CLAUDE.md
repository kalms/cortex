# Cortex — Agent Instructions

## First thing every session

1. Run `index_status` against the cwd. If the repo is not indexed, run
   `index_repository` before any code exploration. Without an index,
   `search_graph` / `get_code_snippet` / `trace_path` return empty and
   you'll be forced back to `Grep`/`Read` — which loses all the structural
   context Cortex provides.
2. After a non-trivial commit on a code file, run `detect_changes` and
   then incremental `index_repository` to keep the graph current.

The plugin's SessionStart hook (`hooks/check-index.sh`) will tell you the
current index state; act on it.

## Tool routing — read this before reaching for Grep or Read

| If you want to… | Use | Not |
|---|---|---|
| Find a function/class/route by name | `search_graph(name_pattern="…")` | `Grep`, `Glob` |
| Read source for a known symbol | `get_code_snippet(qualified_name="…")` | `Read`, `cat`, `head` |
| Find who calls X / what X calls | `trace_path(function_name, mode="callers"\|"calls")` | `Grep` for call sites |
| Understand project shape | `get_architecture(aspects=…)` | manual `ls`/`find` |
| Text search across code with structural annotation | `search_code(pattern="…")` | `Grep` |
| Complex graph query | `query_graph(query=Cypher)` | grep + manual joins |
| Check why code looks the way it does | `why_was_this_built(qualified_name="…")` | guessing |

Fall back to `Grep`/`Glob`/`Read` only when:
- the target is a non-code file (config, JSON, Markdown, log)
- you need a regex feature `search_code` doesn't support
- the Cortex tool returned empty AND you've confirmed the index is current

## Decision capture — when to use it

Capture a decision **proactively** when:
- You picked one library / pattern / approach over another and the choice wasn't obvious
- You introduced or changed a public API contract
- You merged a non-trivial branch (anything not pure docs/typo)
- You found a latent bug and chose a specific fix shape over alternatives
- You changed a default that affects behavior on real workloads

The shape:

```
search_decisions({ query: "relevant keywords" })   # Check for duplicates first
create_decision({ title, description, rationale, alternatives, governs: ["path/or/qn"] })
link_decision({ decision_id: "…", target: "…", relation: "GOVERNS" })
```

Before modifying existing code, check whether an existing decision governs
that area:

```
why_was_this_built({ qualified_name: "src/path/to/file.ts::functionName" })
```

If a decision exists and your change contradicts it, that's a signal to
either update the decision (with reasoning for the new direction) or
reconsider the change.

## Decision storage

Decisions live in `.cortex/decisions.db`, a sibling of the graph DB
(`.cortex/graph.db`). The graph DB is a fully replaceable derived artifact —
`index_repository` cache imports and full reindexes copy or recreate it
freely. The decisions DB is durable: it survives every indexing operation.

Decision links to code use **string qualified-names or file paths**, not
graph node IDs. `DecisionSearch.findGoverning(target)` walks up the qn/path
hierarchy when no direct link matches. PR ↔ decision links key on PR number
(stable across re-indexes) rather than graph node id.

If you find yourself working in `src/decisions/`, the schema and repositories
live in:
- `src/decisions/db.ts` — schema + idempotent open
- `src/decisions/repository.ts` — `DecisionsRepository` (CRUD + FTS)
- `src/decisions/links-repository.ts` — `DecisionLinksRepository` (governance, supersession, PR links)
- `src/decisions/migration.ts` — one-shot migration from legacy graph-DB decisions,
  runs idempotently at server startup AND defensively at the top of
  `index_repository`.

See [docs/architecture/decisions-storage.md](docs/architecture/decisions-storage.md)
for the full architecture rationale.

## Tools Available

### Decision tools
`create_decision`, `update_decision`, `delete_decision`, `get_decision`, `search_decisions`, `why_was_this_built`, `link_decision`, `promote_decision`, `propose_decision`, `supersede_decision`

### Code tools
`search_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `search_code`, `query_graph`, `get_architecture`, `list_projects`, `index_status`, `index_repository`, `detect_changes`, `delete_project`

## Viewer

The frames viewer runs at http://localhost:3334/viewer during development (`npm run dev`), or http://localhost:3333/viewer when running as an MCP plugin. The viewer is derived from [docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html](docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html) and wired to live data via `/api/graph`, `/api/projects`, `/api/decisions`. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md#frames-viewer) for module layout.

## Architecture docs

When working on the event pipeline, WebSocket server, or graph/stream viewers, read [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) first. It documents the two-thread model, event flow, design rationale, and extension recipes.
