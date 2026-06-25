# Cortex

**The pre-frontal cortex for your codebase.**

An agentic substrate — a knowledge graph of decisions, code, and the *why* behind both. Cortex lets agents and humans collaborate from shared understanding instead of constant re-explanation, with a native structural indexer, decision tracking on a unified SQLite graph, and a 2D canvas (Cortex) that renders code as semantic *frames*.

Answers the question agents can't today: **"why was this built this way?"** — not just "what does this code do."

The indexer is a prebuilt native binary — maintained as the separate **cortex-indexer** project and fetched at install — that writes directly to Cortex's SQLite database (a single shared file, no separate cache). Cortex is the substrate underneath **Mesh** — the IDE built to harness it.

## Installation

### Claude Code Plugin (recommended)

The canonical install. One command, and every Claude Code session in every repo on the machine picks up cortex's MCP server, skills, hooks, and slash commands.

```bash
claude plugin add github:ruevu/cortex
```

This single install registers, in one go:

- **MCP tools** routed per-call (`search_graph`, `get_code_snippet`, `trace_path`, `context_pack`, `decision({action:"why"})`, `decision({action:"create"})`, `query_graph`, `index_repository`, `decision({action:"candidates"})`, `check_contracts`, the `pr` and `todo` action-dispatched tools, etc.). `list_projects` and `delete_project` are cross-repo; everything else takes a `repo_path` argument so a single server can serve work across many repos in one session.
- **The SessionStart hook** (`hooks/check-index.sh`) — prints the active repo, its index state, and routing reminders into every new conversation.
- **The skill library** under `skills/` — `seed-decisions` (cold-start bootstrap), `capture-decision`, `search-decisions`, `explain-architecture`.
- **The decision-capture flow** under `bin/` — `cortex decision create / link / why / list / rehome / propose / supersede / update / delete / show / candidates`, plus `cortex code find / show / where / why`.

After the install, `/mcp` lists cortex as connected and `cortex decision --help` works from any indexed repo. There is no per-project `.mcp.json` to edit, no environment variable to set.

#### Plugin contract — passing `repo_path`

Every routed MCP tool (everything except `list_projects` / `delete_project`) requires an absolute `repo_path` argument naming the git root the call is about. The session-start banner prints this path for the active session; agents working across multiple repos pass the explicit path of the repo each call concerns. Calls without `repo_path` return a structured `MissingRepoPathError` payload listing every indexed repo the resolver knows about — agents can paste the right value back without a second tool call.

The full contract — routing modes, the `repo_path` requirement, and the error shapes — is documented in [`docs/mcp-tools.md`](docs/mcp-tools.md#the-repo_path-contract).

### Manual setup (advanced / development)

For hacking on cortex itself, or for MCP clients that aren't Claude Code (Cursor, custom agents, etc.):

```bash
git clone git@github.com:ruevu/cortex.git
cd cortex
npm install
```

Then point your MCP client at the launcher script:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "bash",
      "args": ["/absolute/path/to/cortex/bin/cortex-mcp.sh"]
    }
  }
}
```

The `bin/cortex-mcp.sh` wrapper resolves its own install path via `BASH_SOURCE` and `cd`s into it before exec'ing `npx tsx src/index.ts`. This is what the plugin install wires up automatically — manual users are doing the same thing by hand.

> **Note.** If you maintain a project-scoped `.mcp.json` and Claude Code's trust prompt sets `enabledMcpjsonServers: ["cortex"]` in `.claude/settings.local.json`, deleting the `.mcp.json` later (intentionally or via a stash/branch switch) leaves the setting dangling and `/mcp` then fails with `MCP error -32000: Connection closed`. The plugin install avoids this entire failure class because there is no project-level file to lose track of.

### Development mode

```bash
npm run dev
```

Starts the MCP server (stdio) and the 2D frames viewer at [http://localhost:3334/viewer](http://localhost:3334/viewer). Port 3333 is reserved for the MCP plugin instance.

### Troubleshooting

**`/mcp` shows `cortex` as `✘ failed` with `-32000 connection closed`**

Most common cause: a project-scoped `.mcp.json` is referenced by `enabledMcpjsonServers` in `.claude/settings.local.json` but the file itself is missing. Either restore the file or remove `"cortex"` from `enabledMcpjsonServers` and rely on the plugin install instead.

If you're on the plugin path and still see this, the plugin cache may have an unbuilt native addon — see the better-sqlite3 entry below.

`/mcp` displays which config file it loaded under `Config location`. Three locations are searched in order — the first match wins:

1. `<your-project>/.mcp.json` — project-level override
2. `~/.claude.json` under `projects["<your-project>"].mcpServers` — per-project user config (added by `claude mcp add`)
3. `~/.claude/plugins/cache/cortex-local/cortex/<ver>/.mcp.json` — the plugin's own config

**The plugin runs an old version of cortex**

The plugin cache at `~/.claude/plugins/cache/cortex-local/cortex/<ver>/` is a snapshot taken at install time. Bumping cortex's `plugin.json` version (and `marketplace.json` version) forces a re-sync on the next Claude Code session. For a force-refresh today:

```bash
rm -rf ~/.claude/plugins/cache/cortex-local/cortex/<old-ver>
# restart Claude Code; the marketplace re-syncs from /Users/<you>/.../cortex on next session
```

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
│  Code (13)    decision (1)       pr (1)    todo (1)       │
│  ──────────   ────────────────   ──────    ──────────     │
│  index_*      action-dispatched: open,     propose,       │
│  search_*     create/update/     touch,    get/list/      │
│  trace_path   delete/get/search/ merge,    search/        │
│  query_graph, why/candidates/    get       update/link/   │
│  get_*        link/promote/                transition     │
│               propose/supersede/                          │
│               reconcile/pending                           │
├──────────────────────────────────────────────────────────┤
│ GraphStore  │ DecisionService │ PRService │ EventBus      │
├──────────────────────────────────────────────────────────┤
│  .cortex/db          ~/.cortex/<id>/        .cortex/       │
│  (graph: nodes,      decisions.db           events.db      │
│   edges, ctx_*       (sidecar — durable,    (append log,   │
│   bookkeeping)        out-of-repo)          worker-owned)  │
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

**Three SQLite files, three lifecycles.** `.cortex/db` (in-repo) is the indexer-owned graph (derived, can be wiped and rebuilt). The user-authored decisions sidecar is durable and lives **out of the repo** at `~/.cortex/<repoId>/decisions.db` — resolved from the `repoId` in the repo's committed `cortex.json`, so every worktree/clone shares one store and reindexing never touches it (the in-repo `.cortex/decisions.db` is now only a not-a-git-repo fallback and a one-time legacy migration source). `.cortex/events.db` is the append-only event log (worker-owned, drives the WebSocket stream). The DBs are coupled at query time by stable string keys (qualified names, file paths, PR numbers) — never by graph node IDs, which the indexer regenerates per run.

**Two threads.** MCP tool handlers run on the main thread and write to `.cortex/db` and the decisions sidecar (`~/.cortex/<repoId>/decisions.db`). A worker thread owns `.cortex/events.db` and the WebSocket fan-out: each `DecisionService` / `PRService` write emits an `Event` on the bus, the worker persists it, derives `GraphMutation`s, and broadcasts both over `/ws`. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) for the full event pipeline.

**Tech stack:** TypeScript, Node.js 20+, better-sqlite3, `@modelcontextprotocol/sdk`, zod, `ulid`, `ws`, chokidar (git watcher), Canvas 2D (viewer). Frame extraction adds a Python 3.9+ venv with scikit-learn + hdbscan.

## MCP Tools

### Code tools (15)

These query the unified `nodes`/`edges` tables directly (SQL, no subprocess):

| Tool | Description |
|------|-------------|
| `search_graph` | Find code entities by name, label, or qualified name pattern |
| `trace_path` | Trace call chains via recursive CTE (mode: `calls` or `callers`) |
| `get_code_snippet` | Read source code for a fully qualified name |
| `context_pack` | One-call symbol bundle: snippet + callers + callees + governing decisions + recent commits |
| `get_graph_schema` | List node labels and edge types with counts |
| `search_code` | Grep with graph enrichment — annotates matches with enclosing function/class |
| `query_graph` | Run a Cypher-flavoured query against the unified graph |
| `get_architecture` | One-shot architectural histogram (label/edge counts) |
| `check_contracts` | Report cross-language RPC contract mismatches (arg-key diffs) + coverage, from persisted `BINDS_KEY` edges |
| `list_projects` | List all indexed projects |
| `index_status` | Check if the current repository is indexed |
| `ingest_traces` | Bulk-ingest runtime traces (experimental) |

These spawn `bin/cortex-indexer` (write operations):

| Tool | Description |
|------|-------------|
| `index_repository` | Run the 7-pass indexing pipeline |
| `detect_changes` | Map git diff to affected symbols |
| `delete_project` | Remove a project from the index |

### `decision` tool — action-dispatched

| Action | Description |
|--------|-------------|
| `create` | Create a decision with rationale, alternatives, and governed code links |
| `candidates` | Read-only: frame cold-start decision candidates from git history + docs |
| `propose` | Create a `proposed`-status decision pending review |
| `supersede` | Mark one decision as superseded by another |
| `update` | Update decision fields (title, description, rationale, status) |
| `delete` | Delete a decision and cascade-delete its links |
| `get` | Get a decision with resolved GOVERNS and REFERENCES links |
| `search` | FTS5 search over decision content, optionally scoped to a code path |
| `why` | Find decisions governing a code entity — walks up file/directory hierarchy |
| `link` | Attach GOVERNS, REFERENCES, or SUPERSEDES links to an existing decision |
| `promote` | Promote a decision to team or public visibility tier |
| `reconcile` | Record a code-alignment verdict for a decision |
| `pending` | List active decisions whose governed code drifted since last verdict |

### `pr` tool — action-dispatched

| Action | Description |
|--------|-------------|
| `open` | Create a PR entity in the graph (state: draft/open/merged/closed) |
| `touch` | Record that a PR adds or modifies a file inside a frame (`change`: `added`\|`modified`) |
| `merge` | Transition a PR to `merged` state |
| `get` | Get a PR with its decision links and touches |

### `todo` tool — action-dispatched

| Action | Description |
|--------|-------------|
| `propose` | Propose a new TODO entity with title and description |
| `get` | Get a TODO by ID |
| `list` | List TODOs, optionally filtered by status |
| `search` | Full-text search over TODO content |
| `update` | Update TODO fields (title, description, status) |
| `link` | Attach links from a TODO to decisions or code entities |
| `transition` | Transition a TODO to a new state |

## Command-line interface (`cortex`)

The same graph and decision surface is available from the terminal via the `cortex` CLI (installed on `PATH` by `cortex install`, or run from a checkout via `bin/cortex`). It's organised into namespaces:

| Namespace | Commands | Purpose |
|-----------|----------|---------|
| `cortex code` | `find`, `search`, `show`, `where`, `calls`, `arch`, `schema` | Find symbols, read source, trace callers/callees, dump architecture |
| `cortex decision` | `create`, `propose`, `supersede`, `update`, `delete`, `get`/`show`, `list`, `search`, `why`, `link`, `promote`, `candidates`, `count`, `rehome`, `reconcile` | Author and query architectural decisions |
| `cortex index` | _(bare = index cwd)_, `status`, `changes`, `list`, `delete` | Manage which repos are indexed; `--mode=fast\|moderate\|full` |
| `cortex graph` | `query` (Cypher), `sql` (raw) | Advanced graph queries |
| `cortex eval` | `run`, `baseline`, `report` | Run the eval harness |

Meta commands: `cortex tour` (guided walkthrough), `cortex help <topic>`, `cortex install`, `cortex setup frames`, `cortex freshness`. Run `cortex --help` or `cortex <namespace> --help` for the full reference, and `--version` for the version.

**Output formatting.** List commands accept `--format=table|json|plain` (`--limit` / `--offset` for paging). On an interactive terminal, output is styled — colored table headers with dimmed secondary columns, red `✗` errors with a dim `→` hint, colored help, and an animated braille spinner during `cortex index`. **When output isn't a TTY** (pipes, redirection, `--format json`/`plain`), it is plain, ANSI-free, and stable for scripting. Color follows the standard `NO_COLOR` opt-out plus the `--color`/`--no-color` flags and `CORTEX_COLOR`/`CORTEX_NO_COLOR`/`CORTEX_ASCII` env vars (see [Environment variables](#environment-variables)); a non-UTF-8 locale falls back to ASCII glyphs.

## Frames viewer

The viewer at `/viewer` renders the codebase as semantic *frames* — clusters of files that belong together by topic and co-change behaviour. It's derived from the visual prototype at [docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html](docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html), wired to live data, and reduced to a static-fetch model (no WebSocket consumption in this iteration).

- **Frames** come from cluster output (`data.frame_id` / `data.frame_label` on file nodes, written by `scripts/frame-extraction/inject-frames.ts`).
- **Decisions** come from the decisions sidecar (`~/.cortex/<repoId>/decisions.db`) via `/api/decisions`, surfaced as governance pills attached to the focused frame.
- **Edges** are real CALLS edges from the indexer, filtered to intra- and inter-frame pairs.
- **Aggregates** (auxiliary content like `locales/`, `vendored/`, `__snapshots__/`) are positioned server-side at a gravity centroid near the frames they relate to (edge→path→margin tie cascade) and rendered as bare dots — present but visually de-emphasised.
- **Project switcher** in the toolbar reads `/api/projects` and re-fetches `/api/graph?project=<name>` on change.

Pure modules (`adapters.js`, `layout.js`, `data-fetch.js`) are unit-tested in vitest. The render loop in `viewer.js` is hand-verified against the running dev server.

The simulation features in the prototype (multi-agent demo, synapse animations, PR floating nodes, presence avatars, merge animation, cursor traversal) are explicit non-goals in this iteration. See [docs/architecture/graph-ui.md#frames-viewer](docs/architecture/graph-ui.md#frames-viewer) for the module layout and extension recipes.

## Native indexer

Cortex consumes a prebuilt structural indexer at `bin/cortex-indexer`. The indexer is maintained as a separate project, **cortex-indexer** (MIT-licensed). `npm install` runs `scripts/fetch-indexer.mjs` (postinstall), which downloads the platform binary from the cortex-indexer GitHub release pinned in `src/indexer/version.ts` (checksum-verified and cached). A runtime guard (`ensureIndexer`) asserts the binary's `--version` matches the pin; set `CORTEX_INDEXER_PATH` to point at a locally built binary for development.

The indexer and Cortex's TypeScript layer share a single SQLite file (`.cortex/db` by default; override via `CORTEX_DB_PATH`). The indexer writes code entities into Cortex's `nodes`/`edges` tables directly (with `'ctx-<int>'` text IDs and lowercase `kind` values like `function`, `class`, `method`); PRs use the same tables with their own kinds. Indexer-internal bookkeeping (project metadata, file hashes, FTS5 over names, semantic vectors) lives in `ctx_*`-prefixed tables alongside.

- **Single-file architecture:** no SQLite ATTACH, no separate cache file. The indexer and TS layer operate on the same DB with WAL concurrency.
- **Bulk-write fast path:** the indexer's `extract/sqlite_writer.c` (in the cortex-indexer repo) constructs the SQLite file via raw B-tree page writes for full-index runs. Linear extrapolation: ~3 minutes for a Linux-scale (~180k LOC) repo.
- **Subprocess invocation:** Cortex spawns `bin/cortex-indexer cli index_repository …` with `CORTEX_DB` pointing at the same SQLite file.

There is **no decision data in `.cortex/db`** — decisions live in the durable out-of-repo sidecar `~/.cortex/<repoId>/decisions.db` and are never overwritten by reindexing. See [docs/architecture/decisions-storage.md](docs/architecture/decisions-storage.md) for the rationale.

### Known limitations

The C indexer has two open issues that affect multi-project workflows: the dump pass replaces the entire `nodes`/`edges` tables (not project-scoped), and IDs collide across DBs because they restart at `ctx-1` for each indexed repo. See [docs/architecture/known-limitations.md](docs/architecture/known-limitations.md) for the canonical multi-project workflow using `scripts/frame-extraction/merge-indexed-db.ts`.

## Cross-language contracts

A post-index extraction pass walks the RPC seam between languages and records
**contract edges** (`Anchor` nodes + `BINDS_KEY` edges) linking a caller's
argument keys to the handler that consumes them across a language boundary —
for example a TypeScript consumer calling into the C indexer. The pass runs
automatically as part of `index_repository` (and the `cortex index` CLI); no
extra step is needed.

Once a repo is indexed, the `check_contracts` MCP tool reports any
**argument-key mismatches** between the two sides of each RPC seam, plus a
coverage figure for how much of the seam is bound. This catches a class of
bug that single-language tooling can't see — a caller passing `repoPath` to a
handler that reads `repo_path`, say — without running the code.

```
check_contracts(repo_path="/abs/path/to/repo")
  → { mismatches: [...], coverage: 0.92, ... }
```

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

The harness produces a **scorecard** per target: `nodes_by_label` + `edges_by_type` + a fixed list of "killer queries" exercising the queries that the [field assessment](docs/field%20reports/field-assessment-nuxt-monorepo.md) showed Cortex falling short on (high-degree functions in Vue/Nuxt repos, `HTTP_CALLS` edges, composables called, Nitro handlers, etc.). Each query has a baseline_expected `pass`/`fail` and the harness reports anything surprising relative to the baseline.

The harness is scaffolded; the CLI entry point (`evals/src/cli.ts`) is still a stub. See [docs/architecture/eval-harness.md](docs/architecture/eval-harness.md) for the design.

## Skills

| Skill | Description |
|-------|-------------|
| `/search-decisions` | Find existing architectural decisions before making changes |
| `/capture-decision` | Guided workflow for recording new decisions with rationale and alternatives |
| `/explain-architecture` | Narrative explanation combining decisions, call chains, and code structure |
| `/seed-decisions` | Bootstrap decisions for a freshly-indexed repo from git + docs (cold-start seeding) |

- **Cold-start decision seeding** — fresh repos auto-detect zero decisions
  and offer to bootstrap them from git + docs via the `seed-decisions` skill;
  see [the decisions-storage architecture doc](docs/architecture/decisions-storage.md#cold-start-seeding-machine-proposed-decisions).

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
| `CORTEX_DECISIONS_DB` | `~/.cortex/<repoId>/decisions.db` | Sidecar decisions DB path (out of repo; resolved from `cortex.json`'s `repoId`). `CORTEX_HOME` relocates the base; falls back to `<cwd>/.cortex/decisions.db` outside a git repo |
| `CORTEX_EVENTS_DB_PATH` | `.cortex/events.db` | Event log path (worker-owned) |
| `CORTEX_VIEWER_PORT` | `3333` (plugin), `3334` (dev) | HTTP viewer port |
| `CORTEX_BIND_HOST` | `127.0.0.1` | HTTP bind interface; `0.0.0.0` to deliberately expose on the LAN |
| `CORTEX_API_TOKEN` | _(unset)_ | When set, every `/api/*` path except `/api/health` requires `Authorization: Bearer <token>` |
| `CORTEX_CORS_ORIGINS` | _(unset)_ | Comma-separated browser-origin allowlist for `/api/*` (CORS) |
| `CORTEX_API_STRICT` | _(unset)_ | `1` → HTTP response-validation failures return 500 in production too |
| `CORTEX_INDEXER_PATH` | `bin/cortex-indexer` | Path to the indexer binary |
| `CORTEX_DB` | _(set by Cortex)_ | Same as `CORTEX_DB_PATH`, passed to the indexer subprocess |
| `NO_COLOR` | _(unset)_ | Standard opt-out — any value disables all CLI color |
| `CORTEX_NO_COLOR` | _(unset)_ | `1` disables CLI color (cortex-specific opt-out) |
| `CORTEX_COLOR` | _(unset)_ | `always` forces CLI color even when output isn't a TTY (e.g. `less -R`) |
| `CORTEX_ASCII` | _(unset)_ | `1` forces ASCII glyphs/spinner instead of unicode (braille `⠋`, `✓`/`✗`, `→`) |

## Seeding test data

```bash
npx tsx scripts/seed.ts
```

Seeds a small set of code entities + decisions for development.

## License & attribution

Cortex is **proprietary, all rights reserved** (see the root [`LICENSE`](./LICENSE)) —
its TypeScript code, viewer, MCP server, decision tooling, build scripts,
plugin manifest, and documentation.

The native structural indexer Cortex consumes at runtime is maintained as a
separate project, **cortex-indexer** (MIT-licensed), with its own third-party
attributions (vendored C libraries: mimalloc, SQLite, TRE, xxHash, yyjson,
tree-sitter runtime + grammars, LZ4, simplecpp, nomic embedding vocabulary).
Cortex downloads its prebuilt binary at install time; see
[`scripts/fetch-indexer.mjs`](./scripts/fetch-indexer.mjs).
