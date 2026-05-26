# Cortex

**The pre-frontal cortex for your codebase.**

An agentic substrate — a knowledge graph of decisions, code, and the *why* behind both. Cortex lets agents and humans collaborate from shared understanding instead of constant re-explanation, with a native structural indexer, decision tracking on a unified SQLite graph, and a 2D canvas (Cortex) that renders code as semantic *frames*.

Answers the question agents can't today: **"why was this built this way?"** — not just "what does this code do."

The indexer ships in-tree under `internal/indexer/` and writes directly to Cortex's SQLite database — no external dependency, no separate subprocess. Cortex is the substrate underneath **Mesh** — the IDE built to harness it.

## Installation

### As a Claude Code Plugin

```bash
claude plugin add github:kalms/cortex
```

This registers the MCP server, skills, and hooks automatically.

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

Starts the MCP server (stdio) and the 2D frames viewer at [http://localhost:3334/viewer](http://localhost:3334/viewer). Port 3333 is reserved for the MCP plugin instance.

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

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                MCP Server (stdio, main thread)            │
│                                                           │
│  Code (13)    Decisions (10)   PRs (4)   Promotion (1)    │
│  ──────────   ─────────────   ───────    ──────────       │
│  index_*       create, get,    open_pr   promote          │
│  search_*      update, delete, add_pr_   _decision        │
│  trace_path    search,         touch,                     │
│  query_graph,  why_was_this_   merge_pr,                  │
│  get_*         built, link,    get_pr                     │
│                propose,                                   │
│                supersede                                  │
├──────────────────────────────────────────────────────────┤
│ GraphStore  │ DecisionService │ PRService │ EventBus      │
├──────────────────────────────────────────────────────────┤
│  .cortex/db          .cortex/decisions.db   .cortex/      │
│  (graph: nodes,      (sidecar — durable,    events.db     │
│   edges, ctx_*       outlives reindex)      (append log,  │
│   bookkeeping)                              worker-owned) │
└──────────────────────────────────────────────────────────┘
       │                                            │
       │                       ┌────────────────────┘
       ▼                       ▼
┌─────────────────────────────────────────┐
│ HTTP :3333 (plugin) / :3334 (dev)        │
│   /viewer        2D frames viewer         │
│   /api/graph     unified nodes+edges      │
│   /api/projects  list indexed projects    │
│   /api/decisions adapted decision payload │
│   /api/aggregates auxiliary-path groups   │
│   /ws            event stream + mutations │
└─────────────────────────────────────────┘
```

**Three SQLite files, three lifecycles.** `.cortex/db` is the indexer-owned graph (derived, can be wiped and rebuilt). `.cortex/decisions.db` is the user-authored sidecar (durable, survives every reindex). `.cortex/events.db` is the append-only event log (worker-owned, drives the WebSocket stream). The three are coupled at query time by stable string keys (qualified names, file paths, PR numbers) — never by graph node IDs, which the indexer regenerates per run.

**Two threads.** MCP tool handlers run on the main thread and write to `.cortex/db` / `.cortex/decisions.db`. A worker thread owns `.cortex/events.db` and the WebSocket fan-out: each `DecisionService` / `PRService` write emits an `Event` on the bus, the worker persists it, derives `GraphMutation`s, and broadcasts both over `/ws`. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) for the full event pipeline.

**Tech stack:** TypeScript, Node.js 20+, better-sqlite3, `@modelcontextprotocol/sdk`, zod, `ulid`, `ws`, chokidar (git watcher), Canvas 2D (viewer). Frame extraction adds a Python 3.9+ venv with scikit-learn + hdbscan.

## MCP Tools

### Code tools (13)

These query the unified `nodes`/`edges` tables directly (SQL, no subprocess):

| Tool | Description |
|------|-------------|
| `search_graph` | Find code entities by name, label, or qualified name pattern |
| `trace_path` | Trace call chains via recursive CTE (mode: `calls` or `callers`) |
| `get_code_snippet` | Read source code for a fully qualified name |
| `get_graph_schema` | List node labels and edge types with counts |
| `search_code` | Grep with graph enrichment — annotates matches with enclosing function/class |
| `query_graph` | Run a Cypher-flavoured query against the unified graph |
| `get_architecture` | One-shot architectural histogram (label/edge counts) |
| `list_projects` | List all indexed projects |
| `index_status` | Check if the current repository is indexed |
| `ingest_traces` | Bulk-ingest runtime traces (experimental) |

These spawn `bin/cortex-indexer` (write operations):

| Tool | Description |
|------|-------------|
| `index_repository` | Run the 7-pass indexing pipeline |
| `detect_changes` | Map git diff to affected symbols |
| `delete_project` | Remove a project from the index |

### Decision tools (10)

| Tool | Description |
|------|-------------|
| `create_decision` | Create a decision with rationale, alternatives, and governed code links |
| `propose_decision` | Create a `proposed`-status decision pending review |
| `supersede_decision` | Mark one decision as superseded by another |
| `update_decision` | Update decision fields (title, description, rationale, status) |
| `delete_decision` | Delete a decision and cascade-delete its links |
| `get_decision` | Get a decision with resolved GOVERNS and REFERENCES links |
| `search_decisions` | FTS5 search over decision content, optionally scoped to a code path |
| `why_was_this_built` | Find decisions governing a code entity — walks up file/directory hierarchy |
| `link_decision` | Attach GOVERNS, REFERENCES, or SUPERSEDES links to an existing decision |
| `promote_decision` | Promote a decision to team or public visibility tier |

### PR tools (4)

| Tool | Description |
|------|-------------|
| `open_pr` | Create a PR entity in the graph (state: draft/open/merged/closed) |
| `add_pr_touch` | Record that a PR adds or modifies a file inside a frame |
| `merge_pr` | Transition a PR to `merged` state |
| `get_pr` | Get a PR with its decision links and touches |

## Frames viewer

The viewer at `/viewer` renders the codebase as semantic *frames* — clusters of files that belong together by topic and co-change behaviour. It's derived from the visual prototype at [docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html](docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html), wired to live data, and reduced to a static-fetch model (no WebSocket consumption in this iteration).

- **Frames** come from cluster output (`data.frame_id` / `data.frame_label` on file nodes, written by `scripts/frame-extraction/inject-frames.ts`).
- **Decisions** come from `.cortex/decisions.db` via `/api/decisions`, surfaced as governance pills attached to the focused frame.
- **Edges** are real CALLS edges from the indexer, filtered to intra- and inter-frame pairs.
- **Aggregates** (auxiliary content like `locales/`, `vendored/`, `__snapshots__/`) are rendered as bare dots in a bottom strip — present but visually de-emphasised.
- **Project switcher** in the toolbar reads `/api/projects` and re-fetches `/api/graph?project=<name>` on change.

Pure modules (`adapters.js`, `layout.js`, `data-fetch.js`) are unit-tested in vitest. The render loop in `viewer.js` is hand-verified against the running dev server.

The simulation features in the prototype (multi-agent demo, synapse animations, PR floating nodes, presence avatars, merge animation, cursor traversal) are explicit non-goals in this iteration. See [docs/architecture/graph-ui.md#frames-viewer](docs/architecture/graph-ui.md#frames-viewer) for the module layout and extension recipes.

## Native indexer

Cortex builds and bundles its own structural indexer at `bin/cortex-indexer`. The indexer source lives in-tree at `internal/indexer/`. `npm install` runs `scripts/build-indexer.sh` (postinstall) which compiles the indexer locally — no network download and no separate subprocess.

The indexer and Cortex's TypeScript layer share a single SQLite file (`.cortex/db` by default; override via `CORTEX_DB_PATH`). The indexer writes code entities into Cortex's `nodes`/`edges` tables directly (with `'ctx-<int>'` text IDs and lowercase `kind` values like `function`, `class`, `method`); PRs use the same tables with their own kinds. Indexer-internal bookkeeping (project metadata, file hashes, FTS5 over names, semantic vectors) lives in `ctx_*`-prefixed tables alongside.

- **Single-file architecture:** no SQLite ATTACH, no separate cache file. The indexer and TS layer operate on the same DB with WAL concurrency.
- **Bulk-write fast path:** `internal/indexer/extract/sqlite_writer.c` constructs the SQLite file via raw B-tree page writes for full-index runs. Linear extrapolation: ~3 minutes for a Linux-scale (~180k LOC) repo.
- **Subprocess invocation:** Cortex spawns `bin/cortex-indexer cli index_repository …` with `CORTEX_DB` pointing at the same SQLite file.

There is **no decision data in `.cortex/db`** — decisions live in the sidecar `.cortex/decisions.db` and are never overwritten by reindexing. See [docs/architecture/decisions-storage.md](docs/architecture/decisions-storage.md) for the rationale.

### Known limitations

The C indexer has two open issues that affect multi-project workflows: the dump pass replaces the entire `nodes`/`edges` tables (not project-scoped), and IDs collide across DBs because they restart at `ctx-1` for each indexed repo. See [docs/architecture/known-limitations.md](docs/architecture/known-limitations.md) for the canonical multi-project workflow using `scripts/frame-extraction/merge-indexed-db.ts`.

## Frame extraction pipeline

A multi-phase pipeline that derives *frames* (semantic file clusters) from an indexed repo and writes them back into `nodes.data` for the viewer. Lives under `scripts/frame-extraction/` (TS orchestrators) and `scripts/frame-extraction/python/` (Python ML).

Pipeline stages:

```
indexed repo (.cortex/db)
   │
   ├──► co-change.ts       — 180-day git log → file-pair counts (JSONL)
   │
   ├──► text-blob.ts       — per-file path tokens + symbol names → blob JSONL
   │
   ├──► tfidf_hdbscan.py   — TF-IDF + HDBSCAN with combined topical + co-change
   │                         distance (γ-weighted). Emits cluster JSON +
   │                         silhouette + top tokens per cluster.
   │
   ├──► eval.ts            — co-change agreement, import agreement, cluster
   │                         count, noise rate → markdown report
   │
   └──► inject-frames.ts   — writes frame_id / frame_label / frame_confidence
                             into nodes.data for the viewer
```

NPM scripts:

| Script | What it runs |
|--------|--------------|
| `npm run survey:phase1` | Phase 1 corpus survey: clone N repos, index, collect index-size stats |
| `npm run survey:report` | Generate `phase-1-results.md` from the survey JSONL |
| `npm run co-change` | Build co-change JSONL from the local repo's git log |
| `npm run cluster:tfidf` | TF-IDF + HDBSCAN clustering (optionally `--gamma <0..1>` to mix in co-change) |
| `npm run eval:phase2` | Evaluate a cluster output against co-change + CALLS edges |
| `npm run setup-python` | Bootstrap the Python venv (`scripts/frame-extraction/python/.venv/`) |

Cluster outputs land in `.tmp/frame-extraction/clusters/<repo-slug>.json`; eval reports in `docs/specs/cortex-v0.3/phase-2-eval/<repo-slug>.md`. See [docs/architecture/frame-extraction.md](docs/architecture/frame-extraction.md) for the full data flow and design rationale.

## Eval harness

A separate eval harness lives under `evals/` and is invoked via `npm run eval`. Unlike the frame-extraction eval (which scores cluster quality), this harness scores Cortex's tool surface against real-world target repos defined in [`evals/targets.json`](evals/targets.json) (currently Nuxt UI, NuxtHub starter, anthill-cloud).

The harness produces a **scorecard** per target: `nodes_by_label` + `edges_by_type` + a fixed list of "killer queries" exercising the queries that the [field assessment](docs/architecture/field-assessment-nuxt-monorepo.md) showed Cortex falling short on (high-degree functions in Vue/Nuxt repos, `HTTP_CALLS` edges, composables called, Nitro handlers, etc.). Each query has a baseline_expected `pass`/`fail` and the harness reports anything surprising relative to the baseline.

The harness is scaffolded; the CLI entry point (`evals/src/cli.ts`) is still a stub. See [docs/architecture/eval-harness.md](docs/architecture/eval-harness.md) for the design.

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
| Check index | SessionStart | Prints `Repo`, `Index state` so the agent knows whether to reindex |

## Testing

```bash
npm test                                          # full vitest suite
npm run test:watch                                # watch mode
npx vitest run tests/graph/code-queries.test.ts   # single file
```

Major suites:

| Suite | Covers |
|-------|--------|
| `tests/graph/` | Schema, node/edge CRUD, annotations, FTS, code queries |
| `tests/decisions/` | Decision CRUD + GOVERNS/REFERENCES, search, promotion, sidecar migration |
| `tests/prs/` | PR open/touch/merge with decision link side-effects |
| `tests/events/` | EventBus, persister, mutation deriver, git log parser, ULID monotonicity |
| `tests/ws/` | Client registry, protocol encode/decode |
| `tests/db/` | Path resolution, cache helpers |
| `tests/api/` | HTTP routes (`/api/graph`, `/api/projects`, `/api/decisions`, `/api/aggregates`) |
| `tests/viewer/` | Layout, projection, adapter pure functions |
| `tests/integration/` | Worker thread, git watcher, full WS server roundtrip |
| `tests/mcp-contract/` | MCP tool-input/-output contracts for every registered tool |
| `tests/frame-extraction/` | Path tokenisation, co-change, TF-IDF orchestrator, inject, eval metrics |
| `tests/evals/` | Scorecard + assertion runner |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DB_PATH` | `<git-root>/.cortex/db` | Graph DB path (TS connection string and indexer target) |
| `CORTEX_DECISIONS_DB` | `<git-root>/.cortex/decisions.db` | Sidecar decisions DB path |
| `CORTEX_EVENTS_DB_PATH` | `.cortex/events.db` | Event log path (worker-owned) |
| `CORTEX_VIEWER_PORT` | `3333` (plugin), `3334` (dev) | HTTP viewer port |
| `CORTEX_INDEXER_PATH` | `bin/cortex-indexer` | Path to the indexer binary |
| `CORTEX_DB` | _(set by Cortex)_ | Same as `CORTEX_DB_PATH`, passed to the indexer subprocess |

## Seeding test data

```bash
npx tsx scripts/seed.ts
```

Seeds a small set of code entities + decisions for development.

## License & attribution

Cortex is split into two licensing zones:

- **`internal/indexer/`** — the native structural indexer. **MIT-licensed** (see [`internal/indexer/LICENSE`](./internal/indexer/LICENSE)); upstream attribution and full provenance in [`THIRD_PARTY.md`](./THIRD_PARTY.md).
- **Everything else** — Cortex's TypeScript code, viewer, MCP server, decision tooling, build scripts, plugin manifest, and documentation. **Proprietary, all rights reserved** (see the root [`LICENSE`](./LICENSE)).

The indexer additionally vendors several C libraries (mimalloc, SQLite, TRE, xxHash, yyjson, tree-sitter runtime + grammars, LZ4, simplecpp, nomic embedding vocabulary), each retaining its own upstream license. Full attribution, upstream licenses, and per-component sources are documented in [`THIRD_PARTY.md`](./THIRD_PARTY.md).

## Project structure

```
plugin.json                         # Claude Code plugin manifest
.mcp.json                           # MCP server configuration
CLAUDE.md                           # Agent instructions (cortex-routing rules)
.claude/rules/workflow.md           # Branching + review + QA gates

bin/                                # cortex-indexer binary + MCP-launch wrapper
internal/indexer/                   # Native C indexer (MIT-licensed subtree)

src/
  index.ts                          # Entry: MCP server, viewer HTTP, event worker boot
  graph/
    schema.ts                       # SQL DDL for nodes / edges / ctx_* / FTS5
    store.ts                        # GraphStore — CRUD + unified getAllNodes/Edges
    query.ts                        # Traversal helpers (getConnected, findPath)
    code-queries.ts                 # SQL queries against the unified nodes/edges
  decisions/
    db.ts                           # Sidecar schema + idempotent open
    repository.ts                   # DecisionsRepository (CRUD + FTS)
    links-repository.ts             # DecisionLinksRepository (governance, supersession, PR links)
    service.ts                      # DecisionService (uses both repositories + EventBus)
    search.ts                       # FTS search + whyWasThisBuilt walking
    promotion.ts                    # Tier promotion
    migration.ts                    # One-shot legacy graph-DB → sidecar migration
  prs/
    types.ts                        # PullRequest, PRTouch, etc.
    service.ts                      # open / add_pr_touch / merge / get with decision links
  events/
    bus.ts                          # In-process EventBus (sync dispatch)
    types.ts                        # Event + GraphMutation union
    ulid.ts                         # Monotonic ULID factory
    worker.ts                       # Worker entry — persist + derive + broadcast loop
    worker-supervisor.ts            # Worker lifecycle + restart with backoff
    worker-bootstrap.mjs            # Worker thread bootstrap (tsx loader)
    worker/
      persister.ts                  # events.db SQLite writer + backfill reader
      mutation-deriver.ts           # event → GraphMutation[] (pure)
      git-watcher.ts                # chokidar on .git/logs/HEAD → commit events
      git-log-parser.ts             # Parses `git log --name-status` output
  ws/
    server.ts                       # /ws upgrade, hello, ping, backfill
    client-registry.ts              # Connected-client set + broadcast fan-out
    protocol.ts                     # ServerMsg / ClientMsg encode/decode
    types.ts                        # Wire types
  db/
    resolve-path.ts                 # CORTEX_DB_PATH / decisions DB path resolution
    cache.ts                        # Read-side helpers
  frame-extraction/
    auxiliary-detection.ts          # Path-pattern auxiliary-content detection
  mcp-server/
    server.ts                       # MCP server factory + tool wiring
    api.ts                          # HTTP server: /viewer, /api/graph, /api/projects,
    api-decisions.ts                #   /api/decisions, /api/aggregates
    api-edges.ts
    response.ts                     # MCP tool response helpers
    tools/
      code-tools.ts                 # 13 code MCP tools
      decision-tools.ts             # 9 decision MCP tools
      promotion-tools.ts            # promote_decision
      pr-tools.ts                   # 4 PR tools
  viewer/
    index.html                      # Frames viewer scaffold
    style.css                       # Toolbar + canvas theme (dark + light)
    viewer.js                       # Canvas render loop + interactions (side-effectful)
    data-fetch.js                   # /api/* fetchers (pure)
    adapters.js                     # groupNodesIntoFrames, basenames, governance (pure)
    layout.js                       # gridLayout(frames, w, h) (pure)

scripts/
  build-indexer.sh                  # Postinstall: builds bin/cortex-indexer
  seed.ts                           # Seeds development data
  corpus/
    run-survey.ts                   # Phase 1 corpus survey driver (high-level wrapper)
  frame-extraction/
    corpus.json / phase2-corpus.json  # Repo lists for Phase 1 / Phase 2
    clone.ts / indexer.ts             # Cloning + indexer-CLI envelope wrappers
    survey.ts / report.ts             # Phase 1 survey runner + markdown reporter
    fs-stats.ts / graph-stats.ts      # Per-repo filesystem and graph stats
    co-change.ts                      # 180-day git log → file-pair JSONL
    path-tokenize.ts                  # Framework-aware path/symbol tokeniser
    text-blob.ts                      # Per-file blob: path tokens + symbol names
    cluster-tfidf-hdbscan.ts          # TS orchestrator — spawns Python
    inject-frames.ts                  # Write frame_id back into nodes.data
    merge-indexed-db.ts               # Multi-project merge (re-keys ctx-N IDs)
    eval-edges.ts / eval-metrics.ts   # Cross-signal eval over CALLS + co-change
    eval-report.ts / eval.ts          # Markdown reporter + CLI orchestrator
    python/
      requirements.txt                # scikit-learn + hdbscan + numpy (pinned)
      setup-venv.sh                   # Idempotent venv bootstrap
      tfidf_hdbscan.py                # TF-IDF + HDBSCAN, combined distance, top tokens

evals/                                # Tool-surface eval harness (npm run eval)
  targets.json                        # Real-world target repos
  src/cli.ts                          # CLI entry (stub)
  src/scorecard.ts                    # Bulk counts + killer queries
  src/queries.ts                      # Killer-query SQL definitions
  src/assertions/                     # Assertion type + runner
  baselines/ fixtures/                # Captured baseline scorecards

docs/
  architecture/                       # Living architecture docs (read these first)
  specs/cortex-v0.3/                  # Authoritative v0.3 design notes + prototype
  superpowers/                        # Implementation plans (executed task lists)
  corpus/                             # Phase 1 corpus survey results

tests/                                # vitest — see "Testing" above
```
