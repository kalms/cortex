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

## Tool routing — READ THIS BEFORE REACHING FOR GREP OR READ

| If you want to… | Use | Not |
|---|---|---|
| Find a function/class/route by name | `search_graph(name_pattern="…")` | `Grep`, `Glob` |
| Read source for a known symbol | `get_code_snippet(qualified_name="…")` | `Read`, `cat`, `head` |
| Get full context for a symbol (code + callers + callees + decisions + commits) | `context_pack(qualified_name="…")` | 3–4 separate calls |
| Find who calls X / what X calls | `trace_path(function_name, mode="callers"\|"calls")` | `Grep` for call sites |
| Understand project shape | `get_architecture(aspects=…)` | manual `ls`/`find` |
| Text search across code with structural annotation | `search_code(pattern="…")` | `Grep` |
| Complex graph query | `query_graph(query=Cypher)` | grep + manual joins |
| Check why code looks the way it does | `decision({action:"why", qualified_name:"…"})` | guessing |

Fall back to `Grep`/`Glob`/`Read` only when:
- the target is a non-code file (config, JSON, Markdown, log)
- you need a regex feature `search_code` doesn't support
- the Cortex tool returned empty AND you've confirmed the index is current

### This routing is hook-enforced, not just advisory

On an **indexed** repo, a `PreToolUse` hook
([hooks/prefer-cortex.sh](hooks/prefer-cortex.sh), wired in
[hooks/hooks.json](hooks/hooks.json) on `Grep`, `Glob`, and `Bash`) **blocks
code-targeted searches** and redirects you to the Cortex tool — the redirect
text comes back as the tool-denial reason, so re-issue with the named tool. The
policy is **block code, allow non-code**:

- **Denied:** `Grep`/`Glob` over code, and `Bash` code searches (`grep`/`rg`/
  `ag`/`ack`, including `git grep`, `xargs grep`, etc.) — including a bare,
  unscoped `Grep(pattern=…)`. Use `search_code` / `search_graph` / `trace_path`
  instead.
- **Allowed:** searches scoped to non-code files (a non-code `glob`/`type`/path,
  e.g. `*.md`, `*.json`); greps that only filter a pipe (`ps aux | grep node`);
  anything whose **search target** repo is **unindexed** (Cortex can't answer
  there).
- **Escape hatch** for a genuine code grep Cortex can't do (a regex feature
  `search_code` lacks, or Cortex already returned empty on a current index):
  run it as a `Bash` `grep`/`rg` command containing the token `cortex:grep-ok`.

**Target-aware gate + sibling auto-index.** The index check keys on the
**search target** repo, not the cwd — the target is resolved from the
`Grep`/`Glob` `path` arg or the first path-like token of a `Bash` command (cwd
for a bare pattern). So a code grep against an **unindexed sibling** repo is
allowed (the cwd's index no longer wrongly blocks it), while a grep against a
*second indexed* repo still redirects. When that unindexed target is a
high-certainty git repo (real root, not under `.tmp`/`node_modules`/
`vendor`/`dist`/`build`/`.cache`), the hook **fires a detached background
`cortex index`** for it — so the next query gets the graph — and allows the
current grep immediately. Guards: deduped by a 60-min sentinel
(`<root>/.cortex/.auto-index-attempted`), logged to
`<root>/.cortex/auto-index.log`, the CLI resolved via `CORTEX_BIN` →
`command -v cortex` (no-op if unresolvable). Opt out with `CORTEX_AUTO_INDEX=0`.
Rationale + alternatives: decisions `D-sq61` (original gate) and `D-mmtb`
(target-aware + sibling auto-index).

The hook is degrade-safe (missing `jq` / any failure → allows; a failed/absent
indexer just skips the background index) and loads at **session start**, so
changes to it take effect on the next session. It does *not* touch `Read`/`Edit`
or MCP tools.

### Freshness signal — trust the graph, don't pre-emptively grep

Every read tool above (`search_graph`, `get_code_snippet`, `trace_path`,
`query_graph`, `search_code`, `get_architecture`, `decision({action:"why"})`) now
carries a **freshness verdict**. When the graph is current, results are
returned unchanged. When it isn't, a one-line note is appended to the result
and a structured `freshness` field is attached:

- `fresh` — graph matches HEAD + working tree; trust it fully.
- `stale:dirty` / `stale:commits` / `stale:both` — the working tree or HEAD
  moved since the last index. Results may be slightly behind. This is **not**
  a cue to fall back to grep — it's a cue to run `index_repository` (or let the
  SessionStart auto-refresh catch it) to bring the graph current.
- `empty` — the DB is degraded/empty (0-byte or fallback). **Reindex**
  (`index_repository`) before trusting any read.
- `unknown` — indexed before freshness tracking, or not a git repo. Reindex to
  enable the signal.

A `stale`/`empty` signal means **reindex**, not "abandon Cortex for grep."
The SessionStart banner (`cortex freshness`) shows the same verdict; auto-refresh
runs out-of-band at SessionStart (full for empty/unknown, incremental for stale)
**and after every `git commit`** (incremental, via a `PostToolUse` hook). Mid-session
post-commit refresh is safe because indexing now **builds into a private staging
DB (`.cortex/db.stage-<pid>`) and publishes into `.cortex/db` through a single
libsqlite3 WAL transaction** (`publishStagedDb`): the canonical file is never
truncated out-of-band, so the MCP server's open handle is never corrupted and
sees the new committed snapshot with no reopen. This **supersedes** the former
in-place/inode-preserving truncate (decision `04c848f0`), whose out-of-band
`fopen("wb")` under an open WAL handle corrupted the index b-trees. See
[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md#write-path-staging-build--transactional-publish).
Gates: `CORTEX_FRESHNESS=0` disables the signal; `CORTEX_AUTO_REFRESH=0` keeps
the signal but disables auto-refresh.

### Briefing signal — study-time pre-edit context

`get_code_snippet` and `trace_path` now also carry a **briefing headline** when
the fetched symbol is *gated*: governed by a decision, or with a blast radius
above `CORTEX_BRIEF_FANOUT` (default 12). The headline names the governing
decision + its reconciliation verdict and the caller count, and points to
`context_pack` for the full body. A `partial`/`drift`/`unreconciled` verdict marks
the area as drifting — treat it as a cue to read the decision before editing.
Gate off with `CORTEX_BRIEF=0`. The same headline is available on demand via
`cortex brief <path-or-qn>`.

### Architecture hotspots — ranked-by-risk modules

`get_architecture(aspects=["hotspots"])` returns `{ project, hotspots:
HotspotArea[] }` — source modules ranked by **external inbound fan-in**
(distinct CALLS/IMPORTS callers from outside the module). It's computed
TS-side (no indexer round-trip); `nodes`, `governing_decisions` (distinct
active decisions governing refs in the module) and `open_todos` (distinct
non-terminal todos governing refs in the module) are display annotations,
not part of the ranking. Other aspects (`all`/`structure`/…)
still route to the indexer unchanged. Use it before touching a module you
don't know well — a high fan-in module is the one most apt to break other
things.

The same ranking is available from the CLI: `cortex code arch --hotspots`
prints the ranked table, and `cortex code arch --headline` prints the bounded
(≤8-line) onboarding summary (scale + top hotspots + entrypoints) — empty on
an empty graph. The onboarding headline also fires **once per session** from
the SessionStart hook (session-id-sentinel-gated, inside the `CORTEX_BRIEF`
block); set `CORTEX_ONBOARD=0` to disable it.

## MCP tool routing — always pass repo_path

**Contract:** every Cortex MCP tool **requires an absolute `repo_path`**
naming the git root the call is about. The two exceptions are
`list_projects` and `delete_project` (`crossRepo: true`) — they operate
on the master registry, not a single repo, and accept `project` instead.

The SessionStart banner (`hooks/check-index.sh`) prints `Repo path:
<abs>` so you have the current cwd's repo path ready to paste. **For
multi-repo work, pass the path of the repo the call is actually about,
not the cwd repo.** A `decision({action:"search"})` about `anthill-cloud-sales`
should be `repo_path: "/Users/rka/Development/anthill-cloud-sales"`,
even if your shell cwd is in `cortex`.

### Error shapes you'll see if `repo_path` is wrong

- **`MissingRepoPathError`** — tool called without `repo_path`. The
  payload includes `available_projects: AvailableProject[]` where
  `AvailableProject = { name: string; path: string; indexed: boolean }`
  — every indexed repo this server knows about, so you can pick the
  right one without a second `list_projects` round-trip.
- **`RepoNotIndexedError`** — path is a real git root but
  `.cortex/db` is missing. Same `available_projects` payload; the
  message tells you to run `cortex index . <path>` first (the `.` is the
  command, `<path>` the positional target — `index <path>` without it errors).
- **`PathNotFoundError`** / **`NotAGitRepoError`** — bad path or
  subdirectory; the latter carries the inferred `gitRoot` so you can
  re-issue without a second lookup.

## Decision capture — when to use it

Capture a decision **proactively** when:
- You picked one library / pattern / approach over another and the choice wasn't obvious
- You introduced or changed a public API contract
- You merged a non-trivial branch (anything not pure docs/typo)
- You found a latent bug and chose a specific fix shape over alternatives
- You changed a default that affects behavior on real workloads

The shape:

```
decision({ action: "search", query: "relevant keywords" })   # Check for duplicates first
decision({ action: "create", title, description, rationale, alternatives, governs: ["path/or/qn"] })
decision({ action: "link", decision_id: "…", target: "…", relation: "GOVERNS" })
```

Before modifying existing code, check whether an existing decision governs
that area:

```
decision({ action: "why", qualified_name: "src/path/to/file.ts::functionName" })
```

If a decision exists and your change contradicts it, that's a signal to
either update the decision (with reasoning for the new direction) or
reconsider the change.

## Decision reconciliation

Reconciliation detects drift by hashing the **current working-tree** source of
the files a decision governs — not git HEAD — so in-session edits flip a
governed decision to stale-pending immediately, before any commit. When drift is
detected, the agent judges whether the decision's prose still matches the code
(match/partial/drift) and records the verdict via `decision({action:"reconcile"})`. It is
agent-delegated and gated behind `CORTEX_RECONCILE=1` (default off in v1). When
on, `decision({action:"why"})` and `decision({action:"get"})` emit a separate "reconcile this"
content block whenever governed code has drifted; judge the alignment and call
`decision({action:"reconcile", decision_id, verdict})`. `decision({action:"pending"})` lists
every drifted decision for a batch pass. `decision({action:"get"})` exposes a derived
`display_state` ("active" / "stale" / "active · drifting" / "active ·
unreconciled") that reflects the latest verdict against the current source.

## Decision storage

The durable decisions store lives **out of the repo** at
`~/.cortex/<repoId>/decisions.db`, resolved by `resolveDecisionsDbPath` from the
`repoId` in the repo's committed `cortex.json` (so every worktree/clone of a repo
shares one store; `$CORTEX_DECISIONS_DB` overrides, `$CORTEX_HOME` relocates the
base). The in-repo `<repo>/.cortex/decisions.db` is **only the pre-relocation
legacy migration source**, read once. Either way the decisions store is durable —
decoupled from the fully-replaceable derived graph DB (`.cortex/db`), which
`index_repository` cache imports and full reindexes copy or recreate freely;
decisions survive every indexing operation.

> ⚠️ Don't inspect decisions with raw `sqlite3` on the in-repo
> `.cortex/decisions.db` — that reads the **stale legacy** store. Use the MCP
> decision tools (they route via `resolveDecisionsDbPath`), or sqlite the
> `~/.cortex/<repoId>/decisions.db` path named in `cortex.json`.

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

## The indexer binary (prebuilt, fetched — not in-tree)

The native code indexer is **no longer in this repo**. It lives in the separate
**cortex-indexer** repo and ships as a prebuilt binary. `npm install` runs
`scripts/fetch-indexer.mjs` (postinstall), which downloads the platform binary
from the cortex-indexer GitHub release pinned by `CORTEX_INDEXER_VERSION` in
[src/indexer/version.ts](src/indexer/version.ts) (checksum-verified, cached under
`~/.cache/cortex-indexer/bin/`), installing it at `bin/cortex-indexer`. The MCP
server resolves + version-checks it lazily via `ensureIndexer()` in
[src/indexer/binary.ts](src/indexer/binary.ts); `CORTEX_INDEXER_PATH` overrides
to a locally built binary for dev. Don't look for `internal/indexer/` or
`scripts/build-indexer.sh` — they were removed when the indexer was split out
(decision `D-chfd`). To change the indexer, work in the cortex-indexer repo, cut
a release, and bump `CORTEX_INDEXER_VERSION`.

## Graph storage & the project registry

The canonical graph store is **`<repo>/.cortex/db`** (per repo). Both writers —
the CLI `cortex index` and the MCP `index_repository` tool — write it (via the
indexer binary's `CORTEX_DB` env), checkpoint the WAL, and then register the
repo in a single machine-wide **registry** at
`~/.local/share/cortex-indexer/registry.db` (XDG data home, `name → root_path →
indexed_at`; honors `$XDG_DATA_HOME`, overridable with `CORTEX_REGISTRY_DB`).
Durable metadata lives under the XDG *data* home, not `~/.cache` (which means
"regenerable"). Enumeration (`list_projects`, the viewer
project switcher) reads the registry; per-repo reads resolve `root_path` from
the registry and open via `resolveGraphDbForRead`, which prefers `.cortex/db`
and falls back to the legacy `~/.cache/cortex-indexer/<slug>.db` cache only for
repos not yet re-indexed. A one-shot idempotent migration seeds the registry
from that legacy cache at viewer startup. `register()` rejects `.tmp/` paths so
eval-corpus clones never pollute enumeration.

`.cortex/db` is the only graph write target; `.cortex/graph.db` and the
`<slug>.db` cache are read-only fallbacks. (Separately, `~/.cache/cortex/<hash>.db`
is the unrelated content-hash *build* cache — not the project graph store.)

See [docs/architecture/graph-storage.md](docs/architecture/graph-storage.md) for
the full model, the read/write paths, and the single path-resolution chokepoint.

## Cold-start decision seeding

A freshly-indexed repo has zero decisions. The `check-index` hook detects this
(`cortex decision count == 0`) and prompts running the `seed-decisions` skill,
which frames candidates from git + docs via the read-only `decision({action:"candidates"})`
MCP tool call and proposes them with machine-derived provenance. Seeded decisions are
`status: "proposed"`, `author: "cortex:seed"`, and never become `active` without
explicit user ratification (`decision({action:"update"})`). See the "Cold-start
seeding" section of [decisions-storage.md](docs/architecture/decisions-storage.md).

## Tools Available

For the full per-tool reference — params, return shapes, the `repo_path`
routing contract, and error shapes — see
[docs/mcp-tools.md](docs/mcp-tools.md).

### Decision tool
`decision` — action-dispatched: `create` | `update` | `delete` | `get` | `search` | `why` | `candidates` | `link` | `promote` | `propose` | `supersede` | `reconcile` | `pending`

### Code & graph tools
`search_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `search_code`, `query_graph`, `get_architecture`, `check_contracts`

### Index lifecycle tools
`index_repository`, `detect_changes`, `index_status`, `list_projects`, `delete_project`, `ingest_traces`

### Pull-request tool
`pr` — action-dispatched: `open` | `touch` | `merge` | `get`

### Todo tool
`todo` — action-dispatched: `propose` | `get` | `list` | `search` | `update` | `link` | `transition`

## Viewer

The frames viewer runs at http://localhost:3334/viewer during development (`npm run dev`), or http://localhost:3333/viewer when running as an MCP plugin. The viewer is derived from [docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html](docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html) and wired to live data via `/api/graph`, `/api/projects`, `/api/decisions`. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md#frames-viewer) for module layout.

The viewer's HTTP endpoints are a **versioned, Zod-enforced contract** (`src/mcp-server/api-schemas.ts` is the single source of truth). To change an endpoint, edit the Zod schema and run `npm run gen:api-schemas` — **never hand-edit `docs/api/*.schema.json`** (a drift-guard test enforces this). See [docs/architecture/http-api-contract.md](docs/architecture/http-api-contract.md). Hardening is env-gated and off by default for local use: `CORTEX_BIND_HOST`, `CORTEX_API_TOKEN`, `CORTEX_CORS_ORIGINS`, `CORTEX_API_STRICT`.

## Architecture docs

When working on the event pipeline, WebSocket server, or graph/stream viewers, read [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) first. It documents the two-thread model, event flow, design rationale, and extension recipes.
