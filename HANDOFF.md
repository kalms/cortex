# Cortex — Session Handoff (2026-05-10)

## TL;DR

Phase 4 of the **CBM absorption** track is **done and merged to main**. Code entities now live in Cortex's `nodes`/`edges` tables alongside decisions, distinguished by `kind`. The indexer's bulk-write fast path (`sqlite_writer.c`) was rewritten to produce the unified schema directly via raw B-tree pages — perf overhead vs pre-Phase-4 is **+3%** on a 45k LOC C corpus.

- **Branch:** `main`, synced with `origin/main` (HEAD `68f33f4`)
- **Tags:** `phase-1-subtree-merged` → `phase-2-build-pipeline` → `phase-3a-storage-retarget` → `phase-3b-ts-side` → `phase-4-schema-fold` (all five pushed)
- **Tests:** 48 files / 360 passed / 1 skipped / 0 failed
- **Indexer:** `bin/cortex-indexer` builds clean (`bash scripts/build-indexer.sh`)
- **Schema:** single SQLite file at `<install>/.cortex/graph.db`; no ATTACH; no `cbm_*` tables anywhere

## What was done this session

### Phase 4 — Schema fold (12 commits, merged + pushed)

Spec: [docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md](docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md)
Plan: [docs/superpowers/plans/2026-05-05-native-indexer-schema-fold.md](docs/superpowers/plans/2026-05-05-native-indexer-schema-fold.md)

**TS-side**
- `nodes` gets nullable `start_line`, `end_line`, `project` columns; `edges` gets `project`. Three new compound indexes (`idx_nodes_kind_project`, `idx_nodes_kind_file`, `idx_edges_project_relation`).
- `CBM_LABEL_MAP` deleted — kinds are granular now (`function`, `class`, `method`, `interface`, `enum`, ...). The previous collapse to `function`/`component`/`path` is gone. **Viewer styling regression** — see Tech Debt below.
- `getAllNodesUnified` / `getAllEdgesUnified` simplify to a single `SELECT FROM nodes` / `edges` with optional project filter (`string | string[]`).
- `code-queries.ts` (renamed from `cbm-queries.ts` in Phase 3b) queries `nodes WHERE project = ? AND kind NOT IN ('decision','pr','todo')`.

**C-side**
- The bulk-write fast path (`internal/cbm/internal/cbm/sqlite_writer.c`) was rewritten to produce Cortex's `nodes`/`edges` schema via raw B-tree page writes. Record builders updated for the new column shape; comparators sort by formatted text id (so SQLite BINARY collation reads back in the same order); index B-trees rebuilt for the new index set; `sqlite_autoindex_nodes_1` / `sqlite_autoindex_edges_1` populated explicitly because TEXT PRIMARY KEY needs an explicit autoindex.
- The SQL-API path (`cbm_store_t.upsert_node` / `insert_edge`) also writes the new schema; in-process `next_node_id` / `next_edge_id` counters seed from `MAX(SUBSTR(id, 5))` on store-open.
- Bookkeeping tables renamed `cbm_*` → `ctx_*` (`ctx_projects`, `ctx_file_hashes`, `ctx_project_summaries`, `ctx_nodes_fts`, `ctx_node_vectors`, `ctx_token_vectors`).
- `init_schema` no longer creates `nodes`/`edges` (Cortex owns them).

**Break-away policy**
- The user is the only consumer; no migration shim ships. `migrateSchemaFold()`, `cbm-discovery.ts`, `schema-fold-migration.test.ts`, `fts-migration.test.ts` were deleted. Existing `cortex.db` files must be deleted manually (the user already did this).

### Verification

| Stage | Result |
|---|---|
| Build | clean |
| `PRAGMA integrity_check` on smoke DB | `ok` |
| Full test suite | 48 files / 360 passed / 1 skipped / 0 failed |
| Perf on 45k LOC C corpus | 39.88s vs 38.68s pre-Phase-4 = **+3%** |

Linear extrapolation: ~160s for Linux (180k LOC) — well under the 3-min budget.

## What's next

### Phase 6 — strip CBM's MCP shell + bridge missing tools

**This is the next logical step.** Spec sections [§2.6](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md) and [§3 Step 6](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md).

CBM is itself an MCP server today; its MCP shell is dead code from Cortex's POV (Cortex is the MCP server, CBM is just the indexer subprocess). What gets removed:
- `internal/cbm/src/mcp/mcp.c` and `mcp.h` (entire MCP server impl)
- The MCP-server entry in `internal/cbm/src/main.c` (the `cbm` binary's stdio MCP mode)
- `internal/cbm/graph-ui/` directory (CBM's own 3D viewer)
- `internal/cbm/vendored/mongoose` (CBM's HTTP server for that viewer)
- Related tests in `internal/cbm/tests/` for the MCP module

What gets added:
- New CLI subcommands inside `internal/cbm/src/cli/`: `query_graph` (Cypher), `get_architecture`, `ingest_traces`. Handlers exist today inside `mcp.c` — lift them to CLI before deleting `mcp.c`.
- New MCP tool registrations in `src/mcp-server/tools/code-tools.ts` for the three.
- Contract test coverage in `tests/mcp-contract/` for the three.

**`manage_adr` is intentionally NOT bridged** — Cortex's decision system supersedes it.

**Validation:** `tests/mcp-contract/` covers all 13 bridged code tools. `cbm --help` shows only CLI subcommands; no MCP-server mode remains.

**Risk:** removing `mcp/` will break compile if anything outside `mcp/` imports from there. Grep `internal/cbm/src/` for MCP-module references before deleting.

### Phase 7 — repo-root cortex.db + cache layer

[§3 Step 7](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md). Move the operational store from `<install>/.cortex/graph.db` to `<repo>/.cortex/db`. Add a content-addressed build-artifact cache at `~/.cache/cortex/<key>.db` (key = `sha256(remote_url + HEAD_sha + indexer_version + grammars_version)`). Auto-create `<repo>/.cortex/.gitignore` on first run.

The intent: anyone who clones the repo gets the same graph; cross-machine onboarding skips re-parsing.

### Phase 8 — final cleanup

[§3 Step 8](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md). Rename remaining `cbm*` symbols in TS (`cbmProject`, `CbmNode`, `CbmEdge`, `CbmProject`) → `code*` / `IndexerNode` / etc. Validate `grep -ri 'cbm\|CBM\|codebase-memory' src/ tests/` returns nothing outside `internal/cbm/`.

### Phase 5 was DROPPED

The original spec planned a v0.2-cache migration shim (read pre-Phase-4 `~/.cache/codebase-memory-mcp/<project>.db` and migrate). The user adopted a "break-away" policy (sole consumer, accept manual `rm cortex.db` on upgrade), so Phase 5 is no longer needed.

## Tech debt carried over (not blockers)

### Phase 4 follow-ups

- **Viewer regression — granular kinds.** The 2D viewer's color/shape map was tuned against the old collapsed `function`/`component`/`path` set. After Phase 4, kinds are granular (`class`, `method`, `interface`, `enum`, ...) and unmapped kinds render with default styling. Pick this up in a small viewer-styling pass before/after Phase 7.
- **CBM C tests broken.** `internal/cbm/tests/` (CBM's own ~2700-test suite) still references `cbm_*` table names + old column names. Out-of-scope for Phase 4. Two options: (a) update CBM tests to the new schema in a separate branch, (b) accept that we don't run them in Cortex CI (already the case — `npm test` runs only Cortex's TS suite). Document if (b) is the long-term call.
- **Lean grammar parser ~100MB.** `internal/cbm/internal/cbm/vendored/grammars/lean/parser.c`. GitHub flagged on push but accepted (under the 100MB hard limit). Future Git LFS consideration if repo grows.
- **`tests/mcp-contract/decision-tools.test.ts` has 1 skipped test.** Pre-existing, not touched by Phase 4. Worth investigating someday.
- **Indexer's `cbm_*` symbols (TS-side: `CbmNode`, `CbmEdge`, `CbmProject`).** Type interfaces still named `Cbm*` for diff continuity. Phase 8 renames.

### From earlier sessions (still open)

- **`anim.nodes` grows unbounded** in viewer; `setHover` adds, `remove_node` doesn't evict. Harmless but leaky.
- **`syncSimulation()` reheats on attribute-only `update_node`.** Visible twitch when a decision flips status.
- **`seen` Set in `websocket.js` unbounded.** ~26MB at 1M events.
- **WS reconnect drift:** mutations during outage aren't replayed; spec mentions a `>500 mutation → re-fetch /api/graph` recovery, not yet implemented.
- **`src/ws/server.ts:~52`** has a 5ms `setTimeout` workaround for same-process WS frame ordering (TODO comment in place).
- **`tsconfig.json`** doesn't copy `.mjs` to `dist/` (matters for `npm run build` only; dev unaffected).

## Project conventions (recap)

From [.claude/rules/workflow.md](.claude/rules/workflow.md):
- **Branch first.** Never commit to `main` directly. Naming: `feature/<scope>/<desc>` where scope ∈ `{component, page, api, store, config, layout, css, db}`.
- **Atomic commits.** One logical change per commit. Format: `<type>(<scope>): <description>`.
- **Merge protocol.** `git merge --no-ff <branch>` then `git branch -d <branch>`. Push only when explicitly asked.
- **Gates.** Visual QA (Gate 0) for UI changes; `/review` (Gate 1) before marking tasks complete; `qa` agent (Gate 2) before merge. Backend-only / docs work may skip Gate 0.
- **Decisions.** Capture architectural choices via `create_decision` after they land. The "onboarding gap" — agents shipping without capturing — is still an open item from earlier sessions.

From [CLAUDE.md](CLAUDE.md):
- Prefer `search_code` over Grep for code search (annotates matches with enclosing function/class).
- Before modifying code, check `why_was_this_built({ qualified_name })` for governing decisions.
- The 2D viewer is at `http://localhost:3334/viewer` in dev (`npm run dev`); MCP plugin instance uses :3333.

## Quick start for next session

```bash
cd ~/Development/cortex
git pull                              # sanity check; should be clean
npm install                           # postinstall builds bin/cortex-indexer
npm test                              # expect 48 files / 360 passed / 1 skipped / 0 failed
bash scripts/build-indexer.sh         # rebuild indexer if you've touched C
bin/cortex-indexer --help             # confirm binary works
npm run dev                           # MCP + viewer + WS on :3334
```

To kick off Phase 6:

```bash
# Survey what's there before deletion
ls internal/cbm/src/mcp/
ls internal/cbm/graph-ui/
grep -rn '"manage_adr"\|query_graph\|get_architecture\|ingest_traces' internal/cbm/src/
```

Then brainstorm → spec → plan → execute, same cadence as Phase 4.

```
# Recommended invocation for the next session
/brainstorm Phase 6 of the CBM absorption: strip CBM's MCP shell and bridge query_graph / get_architecture / ingest_traces. Spec is at docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md §3 Step 6.
```

## Key artifacts

| Artifact | Path |
|---|---|
| Parent spec — CBM absorption | [docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md) |
| Phase 4 spec | [docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md](docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md) |
| Phase 4 plan | [docs/superpowers/plans/2026-05-05-native-indexer-schema-fold.md](docs/superpowers/plans/2026-05-05-native-indexer-schema-fold.md) |
| Architecture doc — graph UI | [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) |
| Workflow rules | [.claude/rules/workflow.md](.claude/rules/workflow.md) |
| Project instructions | [CLAUDE.md](CLAUDE.md) |

## Key files (modified this session)

| File | Change |
|---|---|
| [src/graph/schema.ts](src/graph/schema.ts) | New columns on nodes/edges + 3 compound indexes |
| [src/graph/store.ts](src/graph/store.ts) | `CBM_LABEL_MAP` deleted; `getAll*Unified` simplified; `migrateSchemaFold` removed (break-away) |
| [src/graph/code-queries.ts](src/graph/code-queries.ts) | All SQL targets unified `nodes`/`edges` with `kind` filter |
| [src/index.ts](src/index.ts) | `cbm_projects` → `ctx_projects` |
| [src/mcp-server/tools/code-tools.ts](src/mcp-server/tools/code-tools.ts) | Inline SQL + output formatters use `kind` |
| [internal/cbm/src/store/store.c](internal/cbm/src/store/store.c) | `init_schema`, INSERT helpers, SELECT queries all use new schema |
| [internal/cbm/internal/cbm/sqlite_writer.c](internal/cbm/internal/cbm/sqlite_writer.c) | Bulk-write path rewritten — record builders, comparators, master catalog, autoindex population |
| [internal/cbm/src/pipeline/pipeline.c](internal/cbm/src/pipeline/pipeline.c) | FTS backfill uses `nodes.rowid` directly |
| [tests/mcp-contract/globalSetup.ts](tests/mcp-contract/globalSetup.ts) | `cbm_projects`/`cbm_nodes` → `ctx_projects`/`nodes` |
| [tests/graph/code-queries.test.ts](tests/graph/code-queries.test.ts) | `ctx-` prefix; `ctx_projects` reference |
| [tests/mcp-contract/code-tools.test.ts](tests/mcp-contract/code-tools.test.ts) | Lowercase kind regex |
| [tests/mcp-contract/smoke.test.ts](tests/mcp-contract/smoke.test.ts) | Lowercase kind regex |
| [README.md](README.md) | Architecture diagram, native-indexer section, env vars, project structure all reflect single-file post-Phase-4 layout |
| (deleted) `src/graph/cbm-discovery.ts` | Phase 5 migration shim — no longer needed |
| (deleted) `tests/graph/schema-fold-migration.test.ts` | Tested the migration we deleted |
| (deleted) `tests/graph/fts-migration.test.ts` | Tested pre-Phase-4 legacy FTS upgrade — break-away |
