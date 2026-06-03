# MCP Multi-Project Routing — Design

**Date:** 2026-06-03
**Status:** Design (not yet implemented). Approved via `/brainstorm` 2026-06-03.
**Scope:** Replace the cortex MCP server's startup-time, single-repo binding with a per-call routing layer covering both the graph DB and the decisions DB.
**Predecessors:**
- `docs/architecture/field reports/field-report-2026-05-26-mcp-multi-project-routing.md` — empirical symptoms on the graph-DB side.
- `HANDOFF_DECISIONS.md` Gap 3 — the analogous bind on the decisions DB.

---

## Problem

The MCP server resolves the target repo **once, at process startup**:

```ts
// src/mcp-server/server.ts
export function createServer(
  store: GraphStore,
  indexerProject: string | null = null,
  bus?: EventBus,
  repoPath: string = process.cwd(),  // ← bound here, never re-resolved
): McpServer {
  const decisionsDbPath = resolveDecisionsDbPath(repoPath);
  const graphDbPath     = resolveCortexDbPath(repoPath);
  // … every tool reads/writes this one pair forever
}
```

Two confirmed consequences:

1. **Graph side** (field report, 2026-05-26): the server's `list_projects` returns only the startup-cwd project. Per-call `project="X"` arguments are silently dropped against the same scoped registry, so the other nine indexed projects are unreachable. `search_code` falls through to a `grep -rn .` on the wrong cwd.
2. **Decisions side** (this design, 2026-06-03): spot-check of cortex's `.cortex/decisions.db` shows that **at least 14 of 26 decisions** govern paths under `apps/cloud/`, `apps/activator/`, `vercel.json`, `@anthill/*` — i.e., decisions captured via the cortex MCP server while the agent was reasoning about anthill or activator repos. They pooled into cortex's DB because cortex was the server's startup cwd.

These are the same bug shape: a single-bind at process boot that no tool call can override. Anything captured against the "wrong" repo gets silently mis-routed. The cost is a contaminated knowledge graph.

---

## Decisions

Captured in the 2026-06-03 brainstorm:

| # | Question | Decision |
|---|---|---|
| Q1 | Scope | **Unified.** Fix decisions DB and graph DB via one routing layer. |
| Q2 | How is the target repo signaled per call? | **Explicit `repo_path` on every routed tool.** Required field on the input schema. |
| Q3 | What happens when `repo_path` is omitted? | **Error.** Return a structured `MissingRepoPath` with `available_projects` in the payload. No implicit fallback to startup cwd. |
| Q4 | Historical mis-routed decisions | **Manual re-home via a new CLI verb.** Ship `cortex decision rehome <id> --to=<repo_path>`; no automated data migration. The spot-check/move workflow is human-driven. |

Implementation approach: **Approach A — resolver middleware layer.** Per-tool inline rewrites (Approach C) and per-tool decorators (Approach B) were considered and rejected; the middleware keeps validation and error-shaping in one place and aligns with how `query_graph`'s `project` param already works conceptually.

---

## Architecture

A single new module — `src/mcp-server/repo-context.ts` — owns all per-call repo resolution. Tools no longer reach into `process.cwd()` or accept a `repoPath` at construction; they receive a `RepoContext` argument that contains everything they need.

```
                    ┌──────────────────────────────────┐
  MCP client ─────► │ registerTool(name, schema, fn)   │
  (with repo_path)  │   ↓                              │
                    │   Zod validation                 │
                    │   ↓                              │
                    │   resolver.resolve(args.repo_path)
                    │   ↓                              │
                    │   ┌──────────────┐               │
                    │   │ RepoContext  │ ──►  fn(ctx, args)
                    │   │  - graphDb   │               │
                    │   │  - decisionsDb               │
                    │   │  - store     │               │
                    │   │  - repos     │               │
                    │   └──────────────┘               │
                    └──────────────────────────────────┘
```

There is no longer a "server's home repo." The resolver is the only thing that knows about repos, and it only knows what each tool call hands it. Silent mis-routing becomes structurally impossible.

---

## Components

All exports below carry full JSDoc explaining purpose, params, returns, thrown error classes, and the architectural reason the layer exists. Every tool migrated to `registerTool` also has its JSDoc updated to reflect the new `(context, args)` signature.

### `RepoContext` — frozen value type

```ts
/**
 * Everything a tool needs to act on one repo. Constructed by RepoContextResolver;
 * never instantiated by tool handlers directly. All DB handles are pooled — the
 * same RepoContext is returned for repeated calls against the same repo within
 * one server lifetime.
 */
interface RepoContext {
  readonly repoPath: string;            // absolute, validated git root
  readonly graphDb: Database;           // better-sqlite3 handle
  readonly decisionsDb: Database;       // better-sqlite3 handle (sidecar)
  readonly store: GraphStore;           // repo-scoped graph store
  readonly decisionsRepo: DecisionsRepository;
  readonly decisionLinksRepo: DecisionLinksRepository;
}
```

### `RepoContextResolver` — the only entry point tool handlers see

```ts
class RepoContextResolver {
  resolve(repoPath: string): RepoContext  // throws one of the error classes below
  listKnownRepos(): { name: string; path: string; indexed: boolean }[]
  shutdown(): void  // closes all pooled DB handles
}
```

Validation contract on `resolve`:
1. Path exists on disk.
2. `git rev-parse --show-toplevel` against that path returns the same path (i.e., it IS the git root, not a subdir).
3. `<path>/.cortex/graph.db` exists (indexed).
4. Pool hit returns cached. Pool miss opens the DBs, runs `migrateDecisionsFromGraphDb` (idempotent, gated by `schema_meta`), constructs the repositories, stores in pool, returns.

Errors thrown:

| Class | Condition | `error` field | `hint` field | Extra |
|---|---|---|---|---|
| `MissingRepoPath` | `repo_path` arg not provided to a non-crossRepo tool | `repo_path required for tool '<name>'` | `Pass an absolute path to an indexed git root. Use list_projects to discover indexed repos.` | `available_projects` |
| `PathNotFound` | Path doesn't exist on disk | `repo_path '<x>' does not exist` | `Check the path; was it just deleted or moved?` | — |
| `NotAGitRepo` | Path is not a git root | `repo_path '<x>' is not a git root` | `Pass the repository root, not a subdirectory or file.` | `git_root: <inferred>` if walking up finds one |
| `RepoNotIndexed` | Path is a git root but `.cortex/graph.db` is missing | `repo_path '<x>' has no .cortex/ — repo not indexed` | `Run cortex index repository --path=<x> first.` | `available_projects` |

`available_projects` payload shape, used wherever it appears (consistent with `RepoContextResolver.listKnownRepos()`):

```json
"available_projects": [
  { "name": "Users-rka-Development-cortex",            "path": "/Users/rka/Development/cortex",            "indexed": true },
  { "name": "Users-rka-Development-anthill-cloud",     "path": "/Users/rka/Development/anthill-cloud",     "indexed": true },
  ...
]
```

Both `name` and `path` are present so an agent that hit `MissingRepoPath` or `RepoNotIndexed` can paste the right `repo_path` back without a second tool call. `indexed: false` is included for repos the resolver knows about but whose `.cortex/graph.db` is missing — that's the Field Report's "indexed-but-unreachable" case made explicit (rec #4).

This taxonomy is the resolver's entire failure surface. Tool handlers never receive an invalid context; if a tool is running, validation has already succeeded.

### `RepoContextPool` — internal LRU cache

Internal to the module; not exported. Keyed by absolute repo path. Default capacity **8** (typical agents touch 1–2 repos per session; 8 caps DB-handle leak risk if an agent thrashes). On eviction, the evicted context's DB handles are closed. `shutdown()` closes all remaining handles.

LRU eviction is an implementation detail — not pinned by contract tests.

### `registerTool(name, schema, handler, options?)` — middleware wrapper

```ts
type ToolHandler<A> = (context: RepoContext, args: A) => Promise<unknown>
type CrossRepoHandler<A> = (resolver: RepoContextResolver, args: A) => Promise<unknown>

function registerTool<A>(
  name: string,
  schema: ZodSchema<A>,
  handler: ToolHandler<A>,
  options?: { crossRepo?: false }
): void

function registerTool<A>(
  name: string,
  schema: ZodSchema<A>,
  handler: CrossRepoHandler<A>,
  options: { crossRepo: true }
): void
```

Default mode (per-repo): extracts `args.repo_path`, calls `resolver.resolve`, passes `(context, args)` to handler.

`crossRepo: true` mode: skips path resolution; handler receives the resolver itself so cross-repo tools (`list_projects`, future "search across all indexed") can enumerate or address multiple repos through the same authoritative path. The schema for these tools does **not** include `repo_path`.

### `createServer(bus?, options?)` — composition root

No longer takes `repoPath` or `store`. Constructs the resolver, instantiates `registerTool` against every tool module, returns the MCP server. JSDoc on this function explicitly calls out the breaking-change for callers.

---

## Data flow

### Per-repo tool call (default)

```
MCP client → tool=create_decision, args={..., repo_path:"/Users/rka/Dev/anthill-cloud"}
  ↓
1. Zod schema validates args (repo_path: string required)
  ↓
2. registerTool wrapper extracts args.repo_path
  ↓
3. resolver.resolve("/Users/rka/Dev/anthill-cloud")
     ├─ pool.get(path) → hit? return cached RepoContext (fast path)
     └─ miss:
        ├─ validate path exists, is git root, .cortex/graph.db exists
        ├─ open .cortex/graph.db + .cortex/decisions.db
        ├─ run migrateDecisionsFromGraphDb (idempotent)
        ├─ construct GraphStore + DecisionsRepository + DecisionLinksRepository
        └─ pool.set(path, ctx)
  ↓
4. inner handler: createDecision(context, { title, ... })
     → writes to context.decisionsDb (the anthill-cloud one, never cortex's)
  ↓
5. MCP response sent
```

### Cross-repo tool call

```
MCP client → tool=list_projects, args={}
  ↓
1. Zod schema validates (no repo_path needed; crossRepo:true)
  ↓
2. registerTool wrapper passes (resolver, args) to handler
  ↓
3. handler queries the indexer's master project registry directly
  ↓
4. MCP response sent
```

### Server lifecycle

```
boot:
  createServer(bus?, options?)
    → instantiates resolver + pool
    → registers tools (most through registerTool default; list_projects et al. crossRepo:true)
    → no DBs opened, no migrations run

first tool call for repo X:
  → resolver.resolve(X) populates pool, runs lazy migration

shutdown (SIGTERM / process exit):
  → pool.shutdown() closes all open DB handles
```

---

## Testing

### Unit (new)

- `tests/mcp-server/repo-context-resolver.test.ts` — one case per error class above + happy path + pool-hit vs pool-miss + per-repo migration runs exactly once across repeated `resolve` calls.
- `tests/mcp-server/repo-context-pool.test.ts` — `get`/`set`/`shutdown()` closes handles. Eviction is **not** pinned.

### Contract (extend existing)

- Every existing tool's contract test under `tests/mcp-contract/` adds two cases:
  - Rejects with `MissingRepoPath` when `repo_path` is absent.
  - Routes to the passed repo (not cwd) when `repo_path` is given.
- Cross-repo tools (`list_projects` and any others flagged `crossRepo: true`): contract test that the response includes **every** indexed repo when multiple are registered (locks down Field Report rec #1).

### Regression (the bug we just confirmed)

- `tests/regression/decisions-cross-repo-isolation.test.ts` — fixture: two temp repos (A, B), both indexed. Construct an MCP server with no cwd binding. Call `create_decision({ repo_path: B, ... })`. Assert: B's `.cortex/decisions.db` has the row; A's does not. This test should fail against `main` today and pass after the routing layer ships.

### Test churn (called out so the plan accounts for it)

- All MCP contract test fixtures across ~20 files need `repo_path` added to every tool-call.
- CLI tests are unaffected — the CLI already routes per-cwd via `resolveDecisionsDbPath(cwd)`.

---

## `cortex decision rehome` — CLI verb

**Signature:** `cortex decision rehome <id> --to=<repo_path> [--dry-run]`

**Behavior:** moves a single decision (row + its `decision_links`) from the source repo (resolved from cwd, like every other decision verb) into the target repo's `.cortex/decisions.db`. Preserves `id`, `created_at`, `updated_at`, `status`, `tier`, `author`, `provenance`, all fields verbatim.

**Order of operations:**

1. Resolve source DB from cwd's git root.
2. Resolve target DB from `--to` (must be git root with `.cortex/decisions.db`).
3. Load decision + links from source.
4. If `--dry-run`: print what would move, exit.
5. Insert into target in one target-side transaction; verify by `SELECT id`.
6. Delete from source in one source-side transaction.
7. Print confirmation: `Moved abc-123 from cortex → anthill-cloud-sales (4 links).`

**Failure recovery:** No cross-file transaction is possible. If step 5 fails, source is untouched. If step 6 fails after step 5 succeeded, decision exists in both DBs — the CLI prints a `RehomePartialError` with the exact source `DELETE` statement the user can re-run manually. This is the chosen contract; insert-then-delete is preferred to delete-then-insert because the latter can lose data on a crash.

**Errors:**

| Condition | Error |
|---|---|
| `id` not in source | `no decision <id> in <source repo>; check with cortex decision list.` |
| `id` already in target | `<id> already exists in <target repo>; use update there if you want to modify it.` |
| Target has no `.cortex/decisions.db` | `target <path> isn't indexed; run cortex index repository --path=<path> first.` |

**Non-blocking warning:** if the moved decision is referenced by other decisions in the source DB (`related_decisions`, `depends_on`, `superseded_by`), the rehome leaves those references dangling. The CLI prints a warning listing the dangling references before exiting. Fixing them is out of scope for this design; the warning is the contract.

**Help integration:** add `rehome:` row to `src/cli/help.ts` under the `decision` namespace.

**MCP exposure:** none. Keeping it CLI-only per Q4's "manual re-home only" stance.

---

## Migration / rollout phases

Each phase lands as its own PR with green tests before the next starts.

1. **Infrastructure only.** Add `src/mcp-server/repo-context.ts` with `RepoContext`, `RepoContextResolver`, `RepoContextPool`, `registerTool`. Full JSDoc on every export. Unit tests for resolver + pool. `createServer` still takes the old `repoPath` parameter alongside — both paths coexist. No tool behavior changes yet.

2. **Migrate decision tools.** Switch `create_decision`, `propose_decision`, `supersede_decision`, `update_decision`, `delete_decision`, `get_decision`, `search_decisions`, `why_was_this_built`, `link_decision`, `promote_decision`, `decision_candidates` to use `registerTool`. Their input schemas gain required `repo_path`. Update `tests/mcp-contract/decision-*.test.ts` to pass `repo_path` and to include the new "rejects when missing" / "routes to passed repo" cases.

3. **Migrate code/graph tools.** `search_graph`, `get_code_snippet`, `trace_path`, `search_code`, `query_graph`, `get_architecture`, `index_status`, `index_repository`, `detect_changes`, `get_graph_schema`, `ingest_traces`. Same shape.

4. **Migrate cross-repo tools.** `list_projects`, `delete_project`, and any others where "the target repo" doesn't apply. These pass `crossRepo: true` to `registerTool`. **Open investigation:** identify the master project registry the indexer uses and make sure these tools read from it, not from any startup state. See [Open investigations](#open-investigations).

5. **Remove the old startup binding.** `createServer(bus?, options?)` — drop `repoPath`. Confirm no tool path reads `process.cwd()`. Update `src/index.ts` (server entrypoint) accordingly. The regression test from the Testing section gates merge.

6. **Add `cortex decision rehome`.** New file `src/cli/commands/decision-rehome.ts`. Update `src/cli/help.ts`. Tests under `tests/cli/commands/decision-rehome.test.ts`.

7. **Update agent-facing docs.** `CLAUDE.md` gains a section: "When calling cortex MCP tools, always pass `repo_path` (absolute path to the git root you're reasoning about). The session-start banner shows the current cwd's repo, but other repos must be addressed explicitly." `hooks/check-index.sh` updated to print the repo's absolute path so the agent has it ready to paste.

8. **Close out HANDOFF entries.** Strike Gap 3 from `HANDOFF_DECISIONS.md`. Note in Gap 4 that the `rehome` verb partially addresses re-homing; the spot-check/migration *workflow* is still a human task.

---

## Breaking-change impact

When phases 2–5 land, every existing MCP call that does not pass `repo_path` will fail with `MissingRepoPath`. This is the intended outcome of Q3, but the spec records it explicitly so anyone reading later understands the DX impact:

- Agents in mid-session at rollout will start seeing `MissingRepoPath` errors on the first tool call. The error payload tells them what to do.
- The CLI is unaffected (already routes per-cwd).
- Plugins that script against the MCP server programmatically will need to update their call sites.

There is no deprecation phase. Q3 was a deliberate choice for fail-fast over silent fallback.

---

## Out of scope

- **Automated re-homing of historical mis-routed decisions.** Q4 said manual via CLI verb only.
- **Fixing dangling cross-decision references after rehome.** The CLI warns; fixing is left to the user.
- **A "set active project" session-state tool.** Q2 rejected this in favor of explicit `repo_path`.
- **Renaming `project` to `repo_path` on existing tools that already accept `project` (a name).** Those tools — `query_graph`, `delete_project` — will keep their existing param shape unless implementation discovers a conflict. The new `repo_path` is additive.
- **The tier model spec (`personal` → `team`).** Tracked separately in `HANDOFF_DECISIONS.md` Gap 1.

---

## Open investigations

The implementation plan will need to settle these before the relevant phase lands; the design proceeds knowing they exist:

1. **Master project registry location.** The Field Report shows the indexer knows about 10 projects globally; `list_projects` returns 1. Where does the indexer's authoritative list live, and what's the read interface for the cross-repo tools in Phase 4? This determines the contract for `RepoContextResolver.listKnownRepos()` and the `available_projects` payload.

2. **`GraphStore` repo-scoping.** The current `createServer` signature takes a `store` parameter. The proposed signature drops it. Need to confirm during Phase 1 that `GraphStore` can be constructed per-context cheaply (it likely opens the graph.db, which is already in `RepoContext`), and that no shared store-level state needs preserving across repos.

3. **Schema migration on lazy first-touch.** `migrateDecisionsFromGraphDb` is idempotent and gated by `schema_meta`. Confirm during Phase 1 that running it lazily on first context resolution (rather than at server boot) has no race or ordering issue against concurrent tool calls for the same repo. (If it does, a per-repo mutex in the pool resolves it.)

---

## References

- `docs/architecture/field reports/field-report-2026-05-26-mcp-multi-project-routing.md` — empirical graph-DB symptoms.
- `HANDOFF_DECISIONS.md` Gap 3 — decisions-DB analog.
- `src/mcp-server/server.ts` — current startup binding.
- `src/db/resolve-path.ts` — `resolveDecisionsDbPath(startDir)`, the per-cwd resolver the CLI uses (the model for the new per-call resolver).
- `docs/architecture/decisions-storage.md` — decisions DB schema + sidecar rationale.
