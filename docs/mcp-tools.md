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
| `RepoNotIndexedError` | Canonical git root, or a non-git path, has no `.cortex/db` | same `available_projects` payload |
| `PathNotFoundError` | Path doesn't exist | — |
| `NotAGitRepoError` | Retained for back-compat; no longer thrown — subdirs/worktrees canonicalize to the repo root, non-git paths route to themselves (T-119) | inferred `gitRoot` |

`available_projects` lets an agent self-correct without a second
`list_projects` round-trip.

A subdirectory or linked worktree passed as `repo_path` canonicalizes to the
repo's main-worktree root before resolution, so it no longer raises
`NotAGitRepoError`; a genuinely non-git path resolves to its own store, or
`RepoNotIndexedError` if unindexed. `cortex doctor` audits the project
registry for orphan entries left over from before this collapse (dry-run by
default; `--fix` removes them).

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
  name matches more than one symbol. When the fetched symbol is *gated*
  (governed by a decision or with caller count above `CORTEX_BRIEF_FANOUT`,
  default 12), a **briefing headline** is appended naming the governing decision
  and its reconciliation verdict; pass `CORTEX_BRIEF=0` to disable.
- **Why:** replaces `Read`/`cat` for a symbol you can already name — resolves
  fuzzy input through the shared resolver.

### `trace_path`
Trace call chains from a function.
- **Params:** `repo_path`, `function_name`, `mode` (`calls` = outbound,
  `callers` = inbound), `max_depth?` (1–10).
- **Returns:** depth-annotated nodes (`[d=N] kind qn (file:lines)`);
  `ambiguous_input` if the name is not unique. When the fetched symbol is *gated*
  (governed by a decision or with caller count above `CORTEX_BRIEF_FANOUT`,
  default 12), a **briefing headline** is appended naming the governing decision
  and its reconciliation verdict; pass `CORTEX_BRIEF=0` to disable.
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
- **Params:** `repo_path`, `pattern`, `path?`, `glob?`, `files_only?`,
  `multiline?`, `max_count?`.
- **Returns:** ripgrep-style `file:line:` hits, each annotated with the
  enclosing function/class. Anchored to `repo_path` (not the server cwd).
  With `files_only`, returns matching file paths instead of lines.
- **Why:** `Grep` that tells you *which symbol* each match belongs to. Uses the
  bundled `@vscode/ripgrep` binary (falls back to `grep`) so a stripped server
  PATH can't hide it.
- **It *is* ripgrep.** The pattern is handed to the same `rg` binary verbatim —
  there is no regex feature it lacks — and the search covers non-code files too
  (configs, docs, JSON, Markdown, and dotfile dirs like `.github/`). Both facts
  are frequently mis-stated in agent guidance as reasons to reach for a raw
  `rg`; neither is true.
- **Blind spot:** `.gitignore` is honored, so build output and ignored files are
  not searched. A raw grep is the right tool for those.
- **`path` is validated:** it must be relative and inside the repo; an absolute
  or escaping path is rejected, as is one that does not exist (rather than
  silently answering "no results").
- **Scoping:** `path` restricts to a subtree or single file, `glob` filters by
  filename, `files_only` lists files rather than lines, `multiline` lets a
  pattern cross line boundaries, `max_count` overrides the 200-match per-file
  cap.
- **No context lines.** `-A/-B/-C` is deliberately absent: reading the code
  around a hit is `get_code_snippet`'s job, and context output would break the
  `path:line:text` parse every consumer depends on.

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
  `dependencies`, `routes`, `hotspots`).
- **Why:** understand project shape without manual `ls`/`find`.
- **`hotspots` aspect:** computed TS-side (no indexer round-trip). Returns
  `{ project, hotspots: HotspotArea[] }`, where each `HotspotArea` is
  `{ module, path, score, in_edges, nodes, governing_decisions, open_todos }`.
  Source modules are ranked by the composite **`score`** (0–100): each of
  `in_edges` (distinct external CALLS/IMPORTS callers — dependency risk),
  `governing_decisions` (distinct active decisions governing refs in the module),
  and `open_todos` (distinct non-terminal todos governing refs in the module) is
  max-normalized across the modules, then weighted-summed (equal weight by
  default). `nodes` is a display annotation only, not scored. Ties break on
  `in_edges`, then module path (deterministic). Also available from the
  CLI as `cortex code arch --hotspots` (ranked table) and
  `cortex code arch --headline` (bounded onboarding summary); the latter also
  fires once per session from the SessionStart hook unless `CORTEX_ONBOARD=0`.

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
- **Behavior:** canonicalizes `repo_path` to the repo's main-worktree root
  before deriving name/db/staging/registry, so indexing a subdirectory or a
  linked worktree collapses onto the one canonical index instead of creating
  an orphan sub-project (T-119); builds into a private staging DB
  (`.cortex/db.stage-<pid>`), runs frame + contract extraction against it,
  then **atomically publishes** into `.cortex/db` via a single WAL
  transaction (`publishStagedDb`) so the live file is never truncated under
  the server's open handle. Uses a content-hash build cache and serializes
  concurrent CLI/MCP indexing with `withIndexLock`. Registered
  `allowUnindexed`.
- **Why:** this is the tool that brings a repo's graph online and keeps it
  current. See [graph-storage.md](architecture/graph-storage.md#write-path-staging-build--transactional-publish).

### `detect_changes`
Map a git diff to affected symbols.
- **Params:** `repo_path`, `base_branch?` (default `main`), `scope?`
  (`files` | `symbols` | `impact`, default `symbols`), `depth?` (impact BFS
  depth).
- **Why:** before an incremental re-index, see what changed and what it
  impacts.

### `changes_since`
The temporal layer: what changed since a point in time, joined against the
graph and the decision sidecar. Computed TS-side (no indexer round-trip).
- **Params:** `repo_path`, `since` (a git ref, an ISO date, or a decision id
  — `D-xxxx` opens the window at that decision's capture time), `scope?`
  (repo-relative path prefix), `max_commits?` (default 100).
- **Returns:** `{ since: { input, kind, window_start }, commits, truncated,
  changed_files, affected_nodes, decisions: { created, reconciled,
  governing_changed } }` — `governing_changed` carries each decision's
  reconciliation `display_state` and the changed files it governs.
- **Errors:** an unresolvable `since` is `malformed_input` — it never
  degrades to an unbounded window.
- **Why:** "what changed in this subsystem since `D-2exa` was captured, and
  does it still hold?" without git spelunking. Pairs with reconciliation:
  drift *judgment* stays with `decision({action:"reconcile"})`.

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
  governing decisions), `cross_repo?` (boolean).
- **`cross_repo: true`:** fans out over every repo the resolver knows
  (pooled + master registry) and returns
  `{ query, repos: [{ repo, path, decisions }], skipped: [{ repo, path, reason }] }`
  — the addressed repo's hits first, then other repos with ≥1 hit. Results
  stay **grouped per repo** (FTS5 rank is not comparable across databases);
  registry rows that fail to resolve land in `skipped`, never fail the call.
  Cannot be combined with `scope` (`malformed_input`); reconciliation attach
  stays single-repo-only.
- **Why:** check for duplicates before creating a decision; explore why an area
  was built a certain way; answer "have I decided anything about X in *any*
  repo?" (`cross_repo`).

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
Read-only: frame decision candidates from git history + ADR docs.
- **Params:** `max_candidates?` (default 20), `base?` (git ref).
- **`base`:** scopes the manifest to the warm path — commit clusters cover
  only `base..HEAD` and doc candidates only markdown touched in
  `base...HEAD`. This is the post-merge drafting input (the suggest-capture
  hook prompts `base: "HEAD^1"` after a merge commit). An invalid ref is
  `malformed_input`, never a silent whole-history manifest. CLI:
  `cortex decision candidates --base=<ref>`.
- **Returns:** a manifest the `seed-decisions` skill (cold start) or the
  warm-path drafting flow turns into proposed decisions. **Writes nothing.**
- **Why:** bootstrap a freshly-indexed repo that has zero decisions (cold
  start), or draft the decisions a just-merged branch embodies (warm path).

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

## `show` tool

Action-dispatched tool spanning two families: `focus` is a delivery-only
**spotlight** posted to the local viewer's HTTP API — it never touches the
graph or the decisions store, and never throws for an unreachable viewer
("no viewer running" is a normal, expected result, not a tool failure).
`story` / `advance` / `get` / `list` / `close` / `delete` are durable
**story walkthroughs**, backed by `StoryService` (`src/stories/service.ts`)
and stored in the decisions sidecar — `story` persists a full walkthrough in
one atomic call, `advance` additionally pages a live viewer the same
delivery-only way `focus` does. See
[show-your-work.md](architecture/show-your-work.md#focus-spotlight-slice-2a)
for the focus transport and
[show-your-work.md#stories](architecture/show-your-work.md#stories-slice-2b) for the
story storage + delivery contract.

**Params common to all actions:** `repo_path`, `action`.

### `action: "focus"`
Hold a spotlight on `refs` in the connected viewer.
- **Params:** `refs?` (string[], max 50 — repo-relative paths,
  `"path::symbol"` qualified names, or `D-`/`T-` decision/todo ids; omitted
  or `[]` clears the spotlight), `note?` (string, max 2000 chars — shown on
  the viewer's caption card).
- **Behavior:** posts `{repo_path, refs, note}` to `POST /api/show-focus` via
  `postToViewer` ([`viewer-post.ts`](../src/mcp-server/tools/viewer-post.ts)).
  Port discovery: `CORTEX_VIEWER_PORT` env override, then `3333` (plugin
  default), then `3334` (dev-server default) — first responder wins, 800 ms
  timeout per candidate. Sends `Authorization: Bearer <CORTEX_API_TOKEN>`
  when that env var is set.
- **Delivery caveat:** requires a reachable viewer server (the MCP server's
  own HTTP port, or a separate `npm run dev` instance) — a spotlight call
  with no viewer running is a no-op, reported back as text, not an error.
- **Returns one of four result texts:**
  - `Spotlight set (<n> refs) — clear with refs: []` — delivered, accepted,
    non-empty refs.
  - `Spotlight cleared` — delivered, accepted, empty/omitted refs.
  - `Viewer rejected (different repo owns the viewer)` — delivered, but the
    viewer's home repo doesn't match `repo_path`
    (`canonicalRepoPath(repo_path) !== homeRoot`).
  - `No viewer reachable (start the MCP server / check CORTEX_VIEWER_PORT)` —
    every candidate port failed or timed out.
- **Why:** a discretionary presentation aid — point the live viewer at the
  code/decisions/todos an explanation or a pre-change walkthrough is about.
  See the [`show-your-work`](../skills/show-your-work/SKILL.md) skill for
  when to reach for it.

### `action: "story"`
Persist a durable, ordered walkthrough — one atomic call, no incremental
step-building (a half-built story can never dangle).
- **Params:** `title` (string, 1–300 chars), `description?` (string, max
  5000 chars), `steps` (array, 1–20 entries), `links?`
  (`{ decision_ids?: string[] (max 20), pr_number?: number }`), `closed?`
  (boolean — create already-closed; `explain-architecture` uses this so its
  emitted stories can't receive a stray `advance`).
  - Each step: `caption` (string, 1–2000 chars), `refs` (string[], max 50 —
    same three ref forms as `focus`: paths, `"path::symbol"` qns, `D-`/`T-`
    ids), `emphasis_edges?` (array of `[from, to]` ref-pair tuples, max 20 —
    edges to pulse on this step), `layout_hint?` (`"network"` | `"organic"`,
    slice 3).
- **Returns:** `{ story_id, step_count, status, viewer_url }` as JSON text —
  `story_id` is a canonical `S-xxxx` id, `viewer_url` is
  `http://localhost:<port>/viewer?story=<story_id>` (port via the same
  discovery `focus` uses, falling back to `CORTEX_VIEWER_PORT` or `3333`).
- **Errors:** missing `title`/`steps` or an empty `steps` array →
  `malformed_input` (`"story requires at least one step"` from
  `StoryService.create`, or the dispatcher's own `"show(story) requires
  '<field>'"`).
- **Why:** the durable counterpart to `focus` — see the
  [`show-your-work`](../skills/show-your-work/SKILL.md) skill's Stories
  section for when a story beats a run of `focus` calls, and its
  composition rules.

### `action: "advance"`
Page a live viewer to a step of an already-created story. **1-based** —
`step: 1` is the first step.
- **Params:** `story_id`, `step` (integer, 1–9999 — the schema cap; the
  actual valid range is `[1, story.step_count]`, enforced separately).
- **Behavior:** validates the story exists, is open, and `step` is in range
  (`StoryService.checkAdvance`), then posts `{repo_path, story_id, step}` to
  `POST /api/show-advance` via the same `postToViewer` transport `focus`
  uses. The story is already durably persisted before this call — delivery
  failure never loses it.
- **Returns one of these result texts:**
  - `` Story <id> → step <n>/<step_count> pushed to viewer `` — delivered,
    accepted.
  - `Viewer rejected (different repo owns the viewer)` — delivered, wrong
    repo.
  - `No viewer reachable — story persists; open it via its viewer_url` —
    every candidate port failed. **This is a normal outcome, not an
    error** — the story already exists and its `viewer_url` still opens it
    whenever a viewer is next reachable.
- **Errors:** unknown `story_id` → empty envelope (not found is treated as
  "nothing to advance", not a validation failure); a closed story
  (`"Story <id> is closed"`) or an out-of-range `step`
  (`"Step <n> out of range (story has <m> steps)"`) → `malformed_input`.
- **Why user paging wins:** the viewer only *moves the indicator* — if the
  user has paged away from the agent's step, it surfaces a "agent is on
  step N →" chip instead of yanking the view. Don't spam `advance` for
  every micro-step; call it at real checkpoints.

### `action: "get"`
Fetch one story with its steps.
- **Params:** `story_id` (accepts either the canonical `S-xxxx` id or the
  bare/`S-`-prefixed display seq, e.g. `S-12` or `12`).
- **Returns:** the full story (`id`, `seq`, `title`, `description`,
  `status`, `created_by`, `created_at`, `updated_at`, `step_count`, `steps`)
  as pretty-printed JSON, or an empty envelope if not found.

### `action: "list"`
List all stories (no filtering — the viewer's ⌘K "Open story…" list is the
same data).
- **Params:** none beyond `repo_path`/`action`.
- **Returns:** stories (without steps), newest `created_at` first, as
  pretty-printed JSON, or an empty envelope if there are none.

### `action: "close"`
End a story's live association — it stops being eligible for further
`advance` narration but stays listable/openable.
- **Params:** `story_id`.
- **Returns:** the updated story as JSON. Unknown `story_id` → empty
  envelope. Idempotent: closing an already-closed story is a no-op that
  still returns it.

### `action: "delete"`
Remove a story record entirely (steps and links cascade via `ON DELETE
CASCADE`).
- **Params:** `story_id`.
- **Returns:** `` Deleted <id> `` on success, or an empty envelope if
  `story_id` didn't resolve to an existing story.

---

## Quick reference — tool ↔ mode

| Tool | Mode | Freshness-aware |
|---|---|---|
| `search_graph`, `get_code_snippet`, `trace_path`, `context_pack`, `search_code`, `query_graph`, `get_architecture`, `changes_since`, `decision({action:"why"})` | default | ✅ |
| `get_graph_schema`, `check_contracts`, `detect_changes`, `ingest_traces` | default | — |
| `index_repository`, `index_status` | allowUnindexed | — |
| `list_projects`, `delete_project` | crossRepo | — |
| `decision` (all other actions), `pr` (all actions), `todo` (all actions), `show` (all actions) | default | — |
