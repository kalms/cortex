# Cortex — Agent Instructions

## First thing every session

1. Run `index_status` against the cwd. If the repo is not indexed, run
   `index_repository` before any code exploration — without an index the
   Cortex read tools return empty.
2. After a non-trivial commit on a code file, run `detect_changes` and then
   incremental `index_repository` to keep the graph current.

The SessionStart hook (`hooks/check-index.sh`) prints the current index
state and the repo path; act on it.

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
| What changed since a ref/date/decision | `changes_since(since="…")` | git spelunking |
| Find decisions across ALL repos | `decision({action:"search", cross_repo:true})` | per-repo searches |

Finding a symbol is a **ladder** — descend only when the rung above came
back empty: `search_graph`/`trace_path`/`get_code_snippet` → `search_code`
→ `Grep`/`Glob`/`Read`. A `search_graph` miss is not proof the symbol is
absent: the graph holds named definitions, and a shape it carries no node
for reads exactly like one that does not exist, so `search_code` is the
next call. Fall back to `Grep`/`Glob`/`Read` only when the target is a
non-code file (config, JSON, Markdown, log) or you need a regex feature
`search_code` doesn't support.

An empty result is **not** a staleness signal — staleness has its own
(see below). An empty response on a fresh index cannot be fixed by
reindexing.

### Hook-enforced, not advisory

On an indexed repo, a `PreToolUse` hook ([hooks/prefer-cortex.sh](hooks/prefer-cortex.sh))
**blocks code-targeted searches** (`Grep`/`Glob` over code; `Bash`
`grep`/`rg`/`git grep`/etc.) and the denial text names the Cortex tool to
re-issue with. Non-code-scoped searches, pipe filters (`ps aux | grep node`),
and searches whose **target repo** is unindexed pass through — the gate keys
on the search target, not the cwd, and an unindexed sibling repo triggers a
detached background `cortex index` for it (opt out: `CORTEX_AUTO_INDEX=0`).
The `cortex:grep-ok` token no longer authorizes: it returns `ask`, so **the
user** approves a raw grep, never the agent itself. Denial text never mentions
the token — advertising the bypass at the moment of denial is what taught the
habit.

**Worktrees count as indexed — but that's now the hook's own reading, not the
graph's.** The gate still resolves its target through `--git-common-dir` (the
shell mirror of `mainWorktreeRoot`), so a linked worktree still collapses onto
the main checkout for gate purposes, unchanged this stage. What changed
underneath it: a linked worktree can now hold its own `.cortex/db` (per-worktree
indexing landed in the checkout-axis work — see
[graph-storage.md](docs/architecture/graph-storage.md#two-axes)), so "a
worktree never has its own `.cortex/db` by design" is no longer true of the
graph. The hook's collapse-onto-main behavior is a **deliberate, temporary
asymmetry**, not a bug: it still means the gate can pass in a worktree even
when that worktree's own index is stale or absent, because it's checking the
main checkout's index instead. A later stage moves the hook onto the checkout
axis to close that gap. Degrade-safe (any hook failure allows); loads at
session start. Rationale: decisions `D-sq61`, `D-mmtb`, `D-b248`, `D-7ca7`.

### Freshness signal — trust the graph, don't pre-emptively grep

Every Cortex read tool carries a freshness verdict: `fresh` (trust fully),
`stale:dirty`/`stale:commits`/`stale:both` (tree/HEAD moved since last index),
`empty` (degraded DB), `unknown` (pre-freshness index). A `stale`/`empty`
signal means **reindex** (`index_repository`), never "fall back to grep."
Auto-refresh runs at SessionStart and after every `git commit`; the staging-
build + transactional-publish write path makes mid-session refresh safe. See
[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md).
Gates: `CORTEX_FRESHNESS=0` (signal), `CORTEX_AUTO_REFRESH=0` (refresh).

### Briefing signal — study-time pre-edit context

`get_code_snippet`/`trace_path` add a briefing headline when the symbol is
*gated* (decision-governed, or blast radius above `CORTEX_BRIEF_FANOUT`,
default 12): governing decision + reconciliation verdict + caller count. A
`partial`/`drift`/`unreconciled` verdict = read the decision before editing.
On demand: `cortex brief <path-or-qn>`. Gate off: `CORTEX_BRIEF=0`.

### Architecture hotspots — ranked-by-risk modules

`get_architecture(aspects=["hotspots"])` returns `{ project, hotspots:
HotspotArea[] }` — source modules ranked by a composite **`score`** (0–100)
that blends three signals, each max-normalized across the modules then
weighted-summed (equal weight by default): **external inbound fan-in**
(`in_edges` — distinct CALLS/IMPORTS callers from outside the module,
dependency risk), **`governing_decisions`** (distinct active decisions
governing refs in the module), and **`open_todos`** (distinct non-terminal
todos governing refs in the module). This surfaces both *dependency* hotspots
(much depends on it) and *attention* hotspots (much governance / open work
lives there). `nodes` is a display annotation only, not scored. It's computed
TS-side (no indexer round-trip). Other aspects (`all`/`structure`/…)
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

Every Cortex MCP tool **requires an absolute `repo_path`** naming the git
root the call is about (exceptions: `list_projects`, `delete_project`). For
multi-repo work pass the path of the repo the call is *about*, not the cwd.
Error shapes (`MissingRepoPathError`, `RepoNotIndexedError`,
`PathNotFoundError`, `NotAGitRepoError`) carry an `available_projects`
payload or the inferred `gitRoot` so you can re-issue without a second
lookup — full contract in [docs/mcp-tools.md](docs/mcp-tools.md).

## Decision capture — when to use it

Capture a decision **proactively** when:
- You picked one library / pattern / approach over another and the choice wasn't obvious
- You introduced or changed a public API contract
- You merged a non-trivial branch (anything not pure docs/typo)
- You found a latent bug and chose a specific fix shape over alternatives
- You changed a default that affects behavior on real workloads

The shape:

```
decision({ action: "search", query: "…" })   # check for duplicates first
decision({ action: "create", title, description, rationale, alternatives, governs: ["path/or/qn"] })
decision({ action: "link", decision_id, target, relation: "GOVERNS" })
```

Before modifying existing code, check `decision({action:"why", qualified_name})`.
If your change contradicts a governing decision, either update the decision
(with reasoning) or reconsider the change.

## Decision reconciliation

Drift detection hashes the **current working tree** of governed files, so
in-session edits flip a governed decision stale-pending before any commit.
When drift is flagged, judge whether the decision's prose still matches the
code and record `decision({action:"reconcile", decision_id, verdict})` with
`match`/`partial`/`drift`; `decision({action:"pending"})` lists the backlog.
Gated behind `CORTEX_RECONCILE=1` (default off). Full flow in
[docs/mcp-tools.md](docs/mcp-tools.md).

## Storage — the one gotcha plus pointers

The durable decisions/todos store lives **out of the repo** at
`~/.cortex/<repoId>/decisions.db` (repoId from committed `cortex.json`; all
worktrees/clones share it). ⚠️ **Never inspect decisions via raw `sqlite3`
on the in-repo `.cortex/decisions.db`** — that's the stale legacy migration
source. Use the MCP decision tools, or sqlite the `~/.cortex/<repoId>` path.
Decision links use string qualified-names/paths (not graph node IDs); PR
links key on PR number. Details:
[docs/architecture/decisions-storage.md](docs/architecture/decisions-storage.md).

The canonical **graph** store is `<repo>/.cortex/db` (derived, fully
replaceable by reindex; decisions survive every indexing operation). Repo
enumeration lives in a machine-wide registry under the XDG data home.
Details + read/write path resolution:
[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md).
Root derivation is two independent axes — a checkout axis (`worktreeRoot`,
which graph paths use) and a repo-identity axis (`mainWorktreeRoot`, which
decisions use); a linked worktree now gets its own graph store instead of
collapsing onto the main checkout. See
[graph-storage.md#two-axes](docs/architecture/graph-storage.md#two-axes).

The native **indexer** is a prebuilt binary fetched at `npm install` from
the separate cortex-indexer repo (pinned by `CORTEX_INDEXER_VERSION` in
[src/indexer/version.ts](src/indexer/version.ts); `CORTEX_INDEXER_PATH`
overrides for dev). Don't look for indexer sources in-tree (decision
`D-chfd`); to change it, work in cortex-indexer, release, bump the pin.

A freshly-indexed repo has zero decisions — the check-index hook prompts the
`seed-decisions` skill (machine-proposed, `status: "proposed"`, never active
without user ratification). See the cold-start section of
[decisions-storage.md](docs/architecture/decisions-storage.md).

## Tools available

Full per-tool reference (params, return shapes, errors):
[docs/mcp-tools.md](docs/mcp-tools.md).

- `decision` — action-dispatched: `create|update|delete|get|search|why|candidates|link|promote|propose|supersede|reconcile|pending`
- `pr` — `open|touch|merge|get` · `todo` — `propose|get|list|search|update|link|transition`
- `show` — `focus` (held spotlight) · `story|advance|get|list|close|delete`
  (durable walkthroughs the viewer pages through; steps 1-based)
- Code & graph: `search_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `search_code`, `query_graph`, `get_architecture`, `check_contracts`, `changes_since`
- Index lifecycle: `index_repository`, `detect_changes`, `index_status`, `list_projects`, `delete_project`, `ingest_traces`

## Viewer

Frames viewer: http://localhost:3334/viewer in dev (`npm run dev`),
http://localhost:3333/viewer as a plugin. The HTTP endpoints are a
versioned, Zod-enforced contract — edit `src/mcp-server/api-schemas.ts` and
run `npm run gen:api-schemas`; **never hand-edit `docs/api/*.schema.json`**.
See [docs/architecture/http-api-contract.md](docs/architecture/http-api-contract.md)
and [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md#frames-viewer).

## Architecture docs

Read the matching doc before working in an area — the index is
[docs/architecture/README.md](docs/architecture/README.md). In particular:
[graph-ui.md](docs/architecture/graph-ui.md) before the event pipeline,
WebSocket server, or viewers.
