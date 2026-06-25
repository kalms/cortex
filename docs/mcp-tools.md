# Cortex MCP Tools — Reference

The complete catalog of MCP tools the Cortex server exposes, what each one
does, how to call it, and why it exists. This is the contract-level reference;
for routing/usage guidance read [`CLAUDE.md`](../CLAUDE.md), and for the
storage model behind these tools read the
[architecture docs](architecture/README.md).

---

## Where the tools live

The MCP server is assembled in [`src/mcp-server/server.ts`](../src/mcp-server/server.ts),
which constructs a single `McpServer` and registers tool groups against a
shared `RepoContextResolver`:

| Group | Source file | Registrar |
|---|---|---|
| Code / graph + index lifecycle | [`src/mcp-server/tools/code-tools.ts`](../src/mcp-server/tools/code-tools.ts) | `registerCodeTools` |
| Decisions (action-dispatched) | [`src/mcp-server/tools/decision-tools.ts`](../src/mcp-server/tools/decision-tools.ts) | `registerDecisionTools` |
| Pull requests (action-dispatched) | [`src/mcp-server/tools/pr-tools.ts`](../src/mcp-server/tools/pr-tools.ts) | `registerPRTools` |
| Todos (action-dispatched) | [`src/mcp-server/tools/todo-tools.ts`](../src/mcp-server/tools/todo-tools.ts) | `registerTodoTools` |

Every tool's input schema is a paired `…Shape` (raw Zod shape the MCP SDK
requires) + `…Schema` (`z.object(shape)` consumed by the `registerTool`
wrapper). Tool handlers never touch the filesystem or DB paths directly — they
receive a resolved `RepoContext` (open graph DB + decisions DB + repositories)
from the wrapper.

---

## The `repo_path` contract

**Every tool requires an absolute `repo_path`** naming the git root the call is
about — except the two `crossRepo` tools (`list_projects`, `delete_project`),
which operate on the machine-wide registry rather than a single repo.

`repo_path` is declared optional at the Zod layer on purpose: that lets the
`registerTool` wrapper run its own pre-check and throw a *friendly* error
carrying the list of available projects, instead of the SDK rejecting the call
with an opaque validation message. The wrapper
([`registerTool` in `repo-context.ts`](../src/mcp-server/repo-context.ts)) has
three modes:

- **default** — requires `repo_path`, resolves it to a `RepoContext`, throws
  `RepoNotIndexedError` if the repo has no `.cortex/db`. Handler signature
  `(ctx, args)`.
- **`crossRepo: true`** — skips the `repo_path` pre-check; handler receives the
  `resolver` instead of a single-repo context. Used by `list_projects` and
  `delete_project`.
- **`allowUnindexed: true`** — still requires `repo_path` but does **not**
  throw `RepoNotIndexedError`, so the tool that brings a repo online
  (`index_repository`) and the tool whose job includes answering "no, not
  indexed" (`index_status`) can run on an unindexed path.

### Why this contract exists

Before per-call routing, the server pinned one `repoPath` at startup, so every
write (especially decision writes) pooled into whichever repo the server
process happened to start in — regardless of which project the agent was
reasoning about. Per-call `repo_path` fixes that. See the
[multi-project routing design](superpowers/specs/2026-06-03-mcp-multi-project-routing-design.md).

### Error shapes

| Error | Meaning | Payload |
|---|---|---|
| `MissingRepoPathError` | Tool called without `repo_path` | `available_projects: { name, path, indexed }[]` |
| `RepoNotIndexedError` | Valid git root but no `.cortex/db` | same `available_projects` payload |
| `PathNotFoundError` | Path doesn't exist | — |
| `NotAGitRepoError` | Path is inside a repo but not the root | inferred `gitRoot` |

`available_projects` lets an agent self-correct without a second
`list_projects` round-trip.

---

## Response envelope & freshness

All tools return MCP content blocks via three helpers
([`src/mcp-server/response.ts`](../src/mcp-server/response.ts)):

- **`ok(text)`** — success with payload.
- **`empty(queryDesc)`** — no results (not an error; e.g. a search that matched
  nothing).
- **`error(code, message)`** — a structured failure (e.g. `ambiguous_input`,
  `internal_error`, `project_not_found`).

Read tools marked **freshness-aware** (`search_graph`, `get_code_snippet`,
`trace_path`, `context_pack`, `query_graph`, `search_code`, `get_architecture`,
`decision({action:"why"})`) append a freshness verdict to their result when the graph
no longer matches HEAD + working tree:

- `fresh` — trust the graph fully.
- `stale:dirty` / `stale:commits` / `stale:both` — working tree or HEAD moved;
  re-index (don't fall back to grep).
- `empty` — DB degraded/empty; re-index before trusting reads.
- `unknown` — indexed before freshness tracking, or not a git repo.

See [graph-storage.md](architecture/graph-storage.md) for the freshness model.

---

## Code & graph tools

Read-path tools for navigating the indexed knowledge graph. Prefer these over
`Grep`/`Read` for any structural question (see the routing table in
[`CLAUDE.md`](../CLAUDE.md)).

### `search_graph`
Find code entities by name, label, or qualified-name pattern.
- **Params:** `repo_path`, `name_pattern?`, `label?`, `qn_pattern?`,
  `kinds?` (string[]), `limit?` (default 30, max 100), `offset?` (default 0).
- **Returns:** results **ranked by relevance** (kind priority × name-match
  quality — exact > prefix > substring), led by a header line
  `showing A–B of N · offset M`, then matching nodes as
  `kind qualified-name (file:start-end)`.
- **Sections excluded by default:** doc/plan/markdown `section` nodes (the
  largest, noisiest kind) are omitted from name/qn results. **Only when no
  explicit `kinds`/`label` is given** (i.e. the default filter is in effect),
  the header reports `· K section nodes suppressed` and how to opt in. Pass
  `kinds: ["section"]` (or a list containing it) to include them. An explicit
  `kinds` list *replaces* the default filter — e.g. `kinds: ["route","function"]`
  narrows to those (and emits no suppression note, since you chose the scope).
  The legacy `label` param is a single-kind alias folded into `kinds`.
- **Pagination:** `limit`/`offset` page the ranked results; `total_matches`
  is the `N` in the header, so pages = `ceil(N / limit)`. Ranking is
  deterministic, so a given query yields a stable order across pages. An
  `offset` past the end returns `showing 0 of N · offset M`.
- **Search syntax** (each provided param is AND-ed):
  - `name_pattern` — **case-insensitive substring** (SQL `LIKE '%pattern%'`).
    `%` (any run) and `_` (one char) inside the pattern act as wildcards.
    Example: `name_pattern="serve"` matches `serveViewer`, `httpServe`,
    `ServerMsg`.
  - `qn_pattern` — `LIKE` against the (normalized) qualified name, **not**
    auto-wrapped: a bare value matches the *whole* qn, so add `%` yourself for
    a partial match (`qn_pattern="%::handle%"`). Both `::` and dotted forms are
    accepted (normalized before matching).
  - `kinds` / `label` — **exact** kind match (case-insensitive); `kinds` is an
    allow-list of node kinds (`function`, `class`, `method`, `interface`,
    `type`, `route`, `module`, `file`, `folder`, `variable`, `section`, …).
- **Why:** the entry point for "where is X" — replaces `Grep`/`Glob` for
  symbol lookup with structural, ranked, code-first results.

### `get_code_snippet`
Read the source for a known symbol.
- **Params:** `repo_path`, `qualified_name` (qn, file path, dotted suffix, or
  bare name).
- **Returns:** the source slice; `ambiguous_input` with candidates when a bare
  name matches more than one symbol.
- **Why:** replaces `Read`/`cat` for a symbol you can already name — resolves
  fuzzy input through the shared resolver.

### `trace_path`
Trace call chains from a function.
- **Params:** `repo_path`, `function_name`, `mode` (`calls` = outbound,
  `callers` = inbound), `max_depth?` (1–10).
- **Returns:** depth-annotated nodes (`[d=N] kind qn (file:lines)`);
  `ambiguous_input` if the name is not unique.
- **Why:** answers "who calls X / what does X call" without grepping call
  sites — the core impact-analysis primitive.

### `context_pack`
Full context bundle for a symbol in **one** call — the preferred first call when
orienting on an unfamiliar symbol.
- **Params:** `repo_path`, `qualified_name` (qn, file path, dotted suffix, or
  bare name).
- **Returns:** five labeled text sections — `## SNIPPET` (source), `## CALLERS`
  (direct, cap 10), `## CALLEES` (direct, cap 10), `## GOVERNING DECISIONS`
  (cap 5), `## RECENT COMMITS` (last 5 touching the file). Capped lists show
  `(showing N of M)` when truncated. `ambiguous_input` with candidates when a
  bare name matches more than one symbol; `empty` when it matches none.
- **Behavior:** resolves the name **once**, then composes `get_code_snippet` +
  `trace_path` (callers & callees, depth 1) + `decision({action:"why"})` + `git log`.
  Each section is best-effort: a failing source degrades to `- (none)` /
  `(unavailable)` rather than sinking the pack. Freshness-aware.
- **Why:** collapses the 4-roundtrip symbol-exploration loop into one turn. Use
  `trace_path` directly when you need a deeper call chain than depth 1.

### `search_code`
Graph-enriched text search.
- **Params:** `repo_path`, `pattern`.
- **Returns:** ripgrep-style `file:line:` hits, each annotated with the
  enclosing function/class. Anchored to `repo_path` (not the server cwd).
- **Why:** `Grep` that tells you *which symbol* each match belongs to. Uses the
  bundled `@vscode/ripgrep` binary (falls back to `grep`) so a stripped server
  PATH can't hide it.

### `query_graph`
Run a Cypher-style query against the graph.
- **Params:** `repo_path`, `query` (Cypher string), `project?` (in-graph
  filter, auto-derived), `max_rows?`.
- **Returns:** raw query rows.
- **Why:** the escape hatch for graph questions the named tools don't cover
  (joins, aggregates, dead-code, fan-out). Note `repo_path` selects *which DB*;
  `project` filters *rows within* it.

### `get_graph_schema`
List node labels, edge types, and their counts.
- **Params:** `repo_path`.
- **Why:** orient before writing a `query_graph` Cypher query — tells you what
  labels and edges exist.

### `get_architecture`
Architectural overview by aspect.
- **Params:** `repo_path`, `aspects?` (e.g. `["all"]`, `structure`,
  `dependencies`, `routes`).
- **Why:** understand project shape without manual `ls`/`find`.

### `check_contracts`
Report cross-language RPC contract mismatches.
- **Params:** `repo_path`.
- **Returns:** arg-key mismatches between providers/consumers + coverage,
  rebuilt from persisted `BINDS_KEY` edges
  ([contract-tools.ts](../src/mcp-server/tools/contract-tools.ts)).
- **Why:** catch drift where a caller and callee disagree on RPC argument keys
  across a language boundary.

---

## Index lifecycle tools

Manage the `.cortex/db` graph store and the machine-wide project registry.

### `index_repository`
Build (or incrementally update) the knowledge graph for a repo.
- **Params:** `repo_path`, `mode?` (`fast` | `moderate` | `full`, default
  `full`).
- **Behavior:** builds into a private staging DB (`.cortex/db.stage-<pid>`),
  runs frame + contract extraction against it, then **atomically publishes**
  into `.cortex/db` via a single WAL transaction (`publishStagedDb`) so the
  live file is never truncated under the server's open handle. Uses a
  content-hash build cache and serializes concurrent CLI/MCP indexing with
  `withIndexLock`. Registered `allowUnindexed`.
- **Why:** this is the tool that brings a repo's graph online and keeps it
  current. See [graph-storage.md](architecture/graph-storage.md#write-path-staging-build--transactional-publish).

### `detect_changes`
Map a git diff to affected symbols.
- **Params:** `repo_path`, `base_branch?` (default `main`), `scope?`
  (`files` | `symbols` | `impact`, default `symbols`), `depth?` (impact BFS
  depth).
- **Why:** before an incremental re-index, see what changed and what it
  impacts.

### `index_status`
Check whether a repo is indexed.
- **Params:** `repo_path`. Registered `allowUnindexed` (answering "no" is a
  valid result).
- **Why:** the SessionStart check and the first thing to run in a new repo.

### `list_projects` *(crossRepo)*
List every indexed project the server can address.
- **Params:** none.
- **Why:** discover the right `repo_path` for any other call. Reads the
  machine-wide registry, not just the startup repo.

### `delete_project` *(crossRepo)*
Remove a project from the index + registry.
- **Params:** `project` (slug-form name, e.g. `Users-rka-Development-cortex`).
- **Why:** addresses by name rather than path so a stale entry whose on-disk
  repo has moved/been deleted can still be cleaned up. Removes both the legacy
  cache row and the registry row (the latter is what makes it disappear from
  listings).

### `ingest_traces`
Enrich the graph with runtime traces.
- **Params:** `repo_path`, `traces` (array of trace records).
- **Why:** layer runtime observations onto the static graph for a specific
  repo.

---

## `decision` tool

Action-dispatched tool for capturing and querying architectural decisions.
Decisions live in the durable out-of-repo sidecar `~/.cortex/<repoId>/decisions.db`
(never overwritten by re-indexing) and link to code via string qualified-names /
file paths. See
[decisions-storage.md](architecture/decisions-storage.md).

**Params common to all actions:** `repo_path`, `action`.

### `action: "create"`
Create a decision node.
- **Params:** `title`, `description`, `rationale`,
  `alternatives?` (`{name, reason_rejected}[]`), `governs?` (qns/paths),
  `references?`, `problem?`, `resolution?`.
- **Why:** the proactive capture primitive — record a non-obvious choice with
  its rationale and the alternatives you rejected.

### `action: "propose"`
Create a decision in `status: "proposed"`.
- **Params:** as `create`, plus `pr_number?`, `author?` (e.g.
  `cortex:seed`), `provenance?` (machine-derived source for review).
- **Why:** for candidates that need human ratification before becoming active —
  including cold-start seeded decisions.

### `action: "supersede"`
Atomically create a new decision that supersedes an existing one.
- **Params:** `old_decision_id`, `title`, `problem`, `resolution`,
  `rationale`, `alternatives?`, `governs?`, `references?`.
- **Why:** record a direction change without losing the history of what it
  replaced.

### `action: "update"`
Edit an existing decision's fields.
- **Params:** `id`, plus any of `title?`, `description?`,
  `rationale?`, `alternatives?`, `status?` (`active`/`superseded`/`deprecated`),
  `superseded_by?`, `problem?`, `resolution?`, `governs?`, `references?`.
- **Note:** `governs` and `references` are **full-set replacements** when
  provided (`[]` clears all).
- **Why:** ratify a proposed decision (→ `active`), correct prose, or re-target
  governance.

### `action: "delete"`
Delete a decision and all its edges.
- **Params:** `id`.

### `action: "get"`
Fetch a decision with all resolved relationships.
- **Params:** `id`.
- **Returns:** the decision plus `governs`, `references`, `related_decisions`,
  `depends_on`, PR back-refs (`introduced_in`, `implemented_by`,
  `challenged_by`, `discussed_in`), reconciliation fields, and a derived
  `display_state`.

### `action: "search"`
Full-text search over decision titles, descriptions, and rationale.
- **Params:** `query` (FTS5 syntax), `scope?` (qn/path to filter to
  governing decisions).
- **Why:** check for duplicates before creating a decision; explore why an area
  was built a certain way.

### `action: "why"`
Find decisions governing a code entity. Freshness-aware.
- **Params:** `qualified_name` (qn, file path, or bare name).
- **Behavior:** walks up the file/directory hierarchy if there's no direct
  match; returns `ambiguous_input` for non-unique bare names.
- **Why:** before modifying code, check whether a decision governs it (and
  whether your change contradicts it).

### `action: "link"`
Attach an edge from a decision to a target.
- **Params:** `decision_id`, `target` (node id or file path),
  `relation?` (`GOVERNS` | `REFERENCES` | `RELATED_TO` | `DEPENDS_ON`, default
  `GOVERNS`).
- **Why:** add governance/reference edges after a decision exists.

### `action: "candidates"`
Read-only: frame cold-start decision candidates from git history + ADR docs.
- **Params:** `max_candidates?` (default 20).
- **Returns:** a manifest the `seed-decisions` skill turns into proposed
  decisions. **Writes nothing.**
- **Why:** bootstrap a freshly-indexed repo that has zero decisions.

### `action: "promote"`
Promote a decision to a visibility tier.
- **Params:** `id`, `tier` (`team` | `public`).
- **Why:** raise a decision's visibility once it's been validated for a wider
  audience.

### `action: "pending"`
List active decisions whose governed code drifted since their last verdict (or
were never judged). Gated behind `CORTEX_RECONCILE=1`.
- **Params:** `limit?` (default 25).
- **Returns:** each entry carries the decision prose + current governed source,
  ready for a batch judgment pass. Declarative (no-`GOVERNS`) decisions are
  skipped.
- **Why:** find everything that needs re-judging in one call.

### `action: "reconcile"`
Record a code-alignment verdict for a decision. Gated behind `CORTEX_RECONCILE=1`.
- **Params:** `decision_id`, `verdict` (`match` | `partial` |
  `drift`), `nonconformant?` (`{ref, note}[]`), `note?`.
- **Behavior:** the server recomputes the governed-source hash itself; returns
  `not_reconcilable` if the decision has no `GOVERNS` links (it's declarative).
- **Why:** persist the agent's judgment after comparing prose against governed
  source, so the next drift check has a baseline.

---

## `pr` tool

Action-dispatched tool for pull-request entities. PR entities live in the graph
DB; the merge flow ratifies decisions in the same repo's decisions sidecar.

**Params common to all actions:** `repo_path`, `action`.

### `action: "open"`
Create a pull-request entity in the graph.
- **Params:** `title`, `author`, plus optional `description`,
  `branch`, `state` (`draft`/`open`/`merged`/`closed`), `introduces_frame`,
  `additions`, `source` (`native`/`mirror`/`scenario`), `external_ref`
  (`{provider, repo, number, url}`).

### `action: "touch"`
Record that a PR touches (adds/modifies) a file.
- **Params:** `pr_number`, `frame_id`, `node_name`, `change`
  (`added` | `modified`).
- **Note:** the inner field is `change` (not `action`) to avoid collision with
  the outer dispatch field.

### `action: "merge"`
Mark a PR merged.
- **Params:** `pr_number`.
- **Behavior:** ratifies any decisions the PR *introduces* from `proposed` to
  `active`.
- **Why:** ties decision ratification to the merge event.

### `action: "get"`
Fetch a PR with resolved decision refs and linked PRs.
- **Params:** `pr_number`.

---

## `todo` tool

Action-dispatched tool for TODO entities — trackable work items stored in the
durable sidecar, linked to decisions and code. The `/api/todos` HTTP endpoint
exposes the same data for the viewer via the `AdaptedTodo` contract.

**Params common to all actions:** `repo_path`, `action`.

### `action: "propose"`
Propose a new TODO entity.
- **Params:** `title`, `description?`, `status?` (default `"open"`),
  `governs?` (qns/paths), `references?`.
- **Returns:** the created TODO with its assigned ID.

### `action: "get"`
Fetch a TODO by ID with resolved links.
- **Params:** `id`.
- **Returns:** the TODO plus linked decisions and code entities.

### `action: "list"`
List TODOs, optionally filtered by status.
- **Params:** `status?` (`open` | `in_progress` | `done` | `wont_do`),
  `limit?` (default 25), `offset?` (default 0).

### `action: "search"`
Full-text search over TODO titles and descriptions.
- **Params:** `query` (FTS5 syntax), `scope?` (qn/path to filter to linked TODOs).

### `action: "update"`
Update TODO fields.
- **Params:** `id`, plus any of `title?`, `description?`, `status?`,
  `governs?`, `references?`.
- **Note:** `governs` and `references` are **full-set replacements** when
  provided (`[]` clears all).

### `action: "link"`
Attach an edge from a TODO to a decision, code entity, or another TODO.
- **Params:** `todo_id`, `target` (decision ID, qn, or file path),
  `relation?` (`GOVERNS` | `REFERENCES` | `RELATED_TO`, default `RELATED_TO`).

### `action: "transition"`
Transition a TODO to a new state.
- **Params:** `id`, `status` (`open` | `in_progress` | `done` | `wont_do`),
  `note?`.
- **Why:** explicit state machine transitions keep the audit trail clean.

---

## Quick reference — tool ↔ mode

| Tool | Mode | Freshness-aware |
|---|---|---|
| `search_graph`, `get_code_snippet`, `trace_path`, `context_pack`, `search_code`, `query_graph`, `get_architecture`, `decision({action:"why"})` | default | ✅ |
| `get_graph_schema`, `check_contracts`, `detect_changes`, `ingest_traces` | default | — |
| `index_repository`, `index_status` | allowUnindexed | — |
| `list_projects`, `delete_project` | crossRepo | — |
| `decision` (all other actions), `pr` (all actions), `todo` (all actions) | default | — |
