# Cortex — Session Handoff (2026-05-10)

## TL;DR

Cortex v0.3 is a **multi-track release**. Track 1 (CBM absorption) is the most active workstream and just shipped Phase 4 of 8. Several other tracks from the v0.3 design corpus are spec'd but unimplemented (frame extraction, TODO entity, reconciliation engine, multiplayer test mode). The PR-entity track shipped earlier and is merged. **The actual question for the next session is which track to advance** — not just "what's next in CBM absorption."

- **Branch:** `main`, synced with `origin/main` at `4219921`
- **Tags:** `phase-1-subtree-merged` → `phase-4-schema-fold` (5 phase tags pushed)
- **Tests:** 48 files / 360 passed / 1 skipped / 0 failed
- **Build:** `bin/cortex-indexer` clean
- **Schema:** single-file `<install>/.cortex/graph.db`; no ATTACH; no `cbm_*` tables

## What's been done — the actual picture

### Recently shipped (this session: Phase 4 of CBM absorption)

[CBM absorption spec §3 Step 4](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md) — schema fold. Code entities now live in Cortex's `nodes`/`edges` tables alongside decisions, distinguished by `kind`. Indexer's bulk-write fast path (`sqlite_writer.c`) rewritten to produce the unified schema directly via raw B-tree pages. Perf overhead **+3%** on a 45k LOC C corpus → extrapolates to ~160s for Linux 180k LOC, well under the 3-min budget. 12 commits, merged + pushed. Full detail in §"Phase 4 detail" below.

### Shipped pre-this-session (still v0.3)

| Track | Status | Where |
|---|---|---|
| **CBM absorption Phase 1** — vendor CBM into `internal/cbm/` via subtree | ✅ tagged `phase-1-subtree-merged` | merged 2026-05-04 |
| **CBM absorption Phase 2** — `npm install` builds indexer locally; remove GitHub release download path | ✅ tagged `phase-2-build-pipeline` | merged 2026-05-04 |
| **CBM absorption Phase 3a** — indexer honors `CORTEX_DB`; `cbm_*` table prefix | ✅ tagged `phase-3a-storage-retarget` | merged 2026-05-04 |
| **CBM absorption Phase 3b** — TS query layer drops ATTACH; queries `cbm_*` directly | ✅ tagged `phase-3b-ts-side` | merged 2026-05-04 |
| **CBM absorption Phase 4** — schema fold (this session) | ✅ tagged `phase-4-schema-fold` | merged 2026-05-10 |
| **PR entity + decision narrative extensions** ("Spec A") | ✅ merged in `3d72f93` | `src/prs/`, `src/mcp-server/tools/pr-tools.ts`, `propose_decision`, `supersede_decision`, narrative fields on `Decision` |
| **2D graph viewer** (Plan B, post-LOD redesign) | ✅ shipped | `src/viewer/graph-viewer-2d.js` + `src/viewer/shared/` modules; default at `/viewer`; legacy 3D at `/viewer/3d` |
| **WebSocket event pipeline + mutation derivation** | ✅ shipped | `src/events/`, `src/ws/server.ts`, derives mutations for `pr.*` / `decision.ratified` |
| **MCP tool contract repair** | ✅ merged 2026-04-20 | All tools return structured responses |
| **Decision tools, hooks, skills** | ✅ shipped | `create_decision`, `why_was_this_built`, `link_decision`, `promote_decision`, `search_decisions`, etc. |

### v0.3 tracks spec'd but **NOT yet implemented**

These all have authoritative design docs in `docs/specs/cortex-v0.3/`:

| Track | Spec | Status |
|---|---|---|
| **CBM absorption Phase 6** — strip CBM's MCP shell + bridge `query_graph` / `get_architecture` / `ingest_traces` | [`2026-05-03-native-indexer-cbm-absorption-design.md`](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md) §3 Step 6 | Not started |
| **CBM absorption Phase 7** — repo-root `cortex.db` + content-addressed cache at `~/.cache/cortex/<key>.db` | Same spec §3 Step 7 | Not started |
| **CBM absorption Phase 8** — final cleanup; rename `Cbm*` TS symbols → `Code*` / `IndexerNode` | Same spec §3 Step 8 | Not started |
| **Phase 1 corpus survey** — Node script that runs CBM index across N curated GitHub repos, computes `(entity_count, edge_density, directory_depth, language_mix)` per repo. **Calibration data for frame extraction.** | [`docs/specs/cortex-v0.3/README.md`](docs/specs/cortex-v0.3/README.md) §"First build target" | Not started; user agreed to take this on |
| **TODO entity** — new entity type (`kind='todo'`), state machine, MCP tools (`propose_todo`, etc.), drawer surface, optional external-system bridge (Linear/JIRA/etc.) | [`todo-entity.md`](docs/specs/cortex-v0.3/todo-entity.md) | Not started; ~289 lines of spec |
| **Frame extraction** — semantic-first clustering (Leiden vs TF-IDF+HDBSCAN vs pinned-embedding+HDBSCAN, three-pipeline empirical comparison); aggregate nodes for auxiliary content | [`frame-extraction.md`](docs/specs/cortex-v0.3/frame-extraction.md) — 569 lines | Not started; depends on Phase 1 corpus survey |
| **Frame ranking** — `FrameKind` taxonomy, gravity model, ambient information-density target | [`frame-ranking.md`](docs/specs/cortex-v0.3/frame-ranking.md) — 395 lines | Not started; depends on extraction |
| **Frame layout** — D3-force layout with mulberry32 PRNG, 300-iteration deterministic seeding | [`frame-layout.md`](docs/specs/cortex-v0.3/frame-layout.md) — 307 lines | Not started; depends on extraction + ranking |
| **Reconciliation engine v1** — input: decision text + governed-files content; output: `match` / `partial-match` / `drift`; crude string matching, feature-flagged | [`cortex-multiplayer-spec.md`](docs/specs/cortex-v0.3/cortex-multiplayer-spec.md) §10.3 | Not started |
| **Multiplayer test mode** — TS DSL scenario runner so design stays playable without real multiplayer infra | Same spec §9 | Not started |
| **Frame canvas in viewer** — port the prototype's frame visual language (frames as regions, decisions/PRs as 4px dots, hover pills, selection rings + leader lines, drawer surface, merge animation) into the live 2D viewer | Same spec §1, §5, §6 | Live viewer is graph-style, not frame-style; gap is large |
| **Feed surface** — chronological surface for past events (merges, decisions, PRs, agent arrivals) | Same spec §10.1 | Design only |
| **PR authoring interface** — writing side of PRs (vs. reading side already in drawer) | Same spec §10.2 | Design only |

### Tracks deferred / dropped

- **CBM absorption Phase 5** (v0.2 cross-file migration shim) — **dropped** under break-away policy. User is the only consumer; no migrate-from-legacy path needed.
- **Onboarding gap** — agents (including this session) shipping significant architectural work without `create_decision` calls. `SELECT COUNT(*) FROM nodes WHERE kind='decision'` returns 0 in the live DB. Decision capture conventions exist in CLAUDE.md and workflow.md but aren't producing decisions in practice. Open question: hook-based prompt? `/review-recent-commits` skill? Mid-session triggers? Not yet investigated.

## Phase 4 detail (this session)

**TS-side**
- `nodes` gains nullable `start_line`, `end_line`, `project`; `edges` gains `project`. Three new compound indexes (`idx_nodes_kind_project`, `idx_nodes_kind_file`, `idx_edges_project_relation`).
- `CBM_LABEL_MAP` deleted — kinds are granular (`function`, `class`, `method`, `interface`, `enum`, `module`, `route`, ...) instead of the previous collapse to `function`/`component`/`path`.
- `getAllNodesUnified` / `getAllEdgesUnified` simplify to single SELECT with optional `project: string | string[]` filter.
- `code-queries.ts` queries `nodes WHERE project = ? AND kind NOT IN ('decision','pr','todo')`.

**C-side**
- `internal/cbm/internal/cbm/sqlite_writer.c` (the hot bulk-write path) rewritten to produce the new schema via raw B-tree pages. Record builders, comparators (sort by formatted text id to match SQLite BINARY collation), index B-trees, and `sqlite_autoindex_*_1` autoindexes for TEXT PRIMARY KEY all updated.
- `cbm_store_t.upsert_node` / `insert_edge` SQL-API path also writes the new schema. In-process `next_node_id` / `next_edge_id` counters seeded on store-open from `MAX(SUBSTR(id, 5))`.
- Bookkeeping tables renamed `cbm_*` → `ctx_*` (`ctx_projects`, `ctx_file_hashes`, `ctx_project_summaries`, `ctx_nodes_fts`, `ctx_node_vectors`, `ctx_token_vectors`).
- `init_schema` no longer creates `nodes`/`edges` (Cortex owns them).

**Break-away cleanup**
- `migrateSchemaFold()`, `cbm-discovery.ts`, `schema-fold-migration.test.ts`, `fts-migration.test.ts` deleted. No legacy-DB migration path ships.

**Verification**
| Stage | Result |
|---|---|
| Build | clean |
| `PRAGMA integrity_check` on smoke DB | `ok` |
| Full test suite | 48 files / 360 passed / 1 skipped / 0 failed |
| Perf on 45k LOC C corpus | 39.88s vs 38.68s pre-Phase-4 = **+3%** |

## What to pick up next — decision space

There's no single "right next thing." Five reasonable options, each with a different shape:

### Option A — Continue Track 1 (CBM absorption)

**Phase 6 (strip CBM's MCP shell + bridge missing tools).** Smallest scope of the remaining absorption phases. Files to delete: `internal/cbm/src/mcp/`, MCP entry in `internal/cbm/src/main.c`, `internal/cbm/graph-ui/`, `internal/cbm/vendored/mongoose`. New CLI subcommands (`query_graph`, `get_architecture`, `ingest_traces`) lifted from `mcp.c` to `cli/`, then bridged via Cortex's `code-tools.ts`. `manage_adr` deliberately not bridged.

**When to pick this:** if completing the absorption story matters more than other tracks. Phase 6 is mostly mechanical deletion + handler-lifting.

### Option B — Phase 1 corpus survey (the v0.3 README's explicit recommendation)

A standalone Node script that clones ~25 active GitHub repos (target archetypes: Nuxt, React, Vue, CommonJS, Go, Swift, Python), runs `bin/cortex-indexer cli index_repository` against each, and computes `(entity_count, edge_density, directory_depth, language_mix)`. Output is a CSV/JSON calibration dataset.

**Why this matters:** frame extraction (Track 3) needs this calibration to validate cluster-quality across diverse codebases. Without it, we'd be tuning extraction parameters against synthetic / single-repo data.

**When to pick this:** if you want to unblock the frame-extraction work that comes after. Self-contained, ~1-2 sessions of scripting + analysis.

### Option C — TODO entity

Smallest functional addition. Spec is concrete ([`todo-entity.md`](docs/specs/cortex-v0.3/todo-entity.md)): schema, state machine (open → in_progress → blocked → done / cancelled), MCP tools (`propose_todo`, `update_todo`, `start_todo`, `block_todo`, `complete_todo`, `cancel_todo`, `link_todo`), `kind='todo'` rows on the existing `nodes` table.

**When to pick this:** if you want a useful user-facing feature delivered quickly. Spec is well-scoped; mostly TS work; mirrors the Decision/PR pattern that already exists.

### Option D — Reconciliation engine v1

Crude string-matching version: input is a decision's narrative text + the current source of governed files; output is `match` / `partial-match` / `drift` plus optional list of nonconformant nodes. Lazy invocation (decisions reconcile on demand, not continuously). Feature-flagged. Behind the flag, the UI doesn't read from it yet — it's plumbing for the spec §3 ratification story.

**When to pick this:** if you want to make decision state real without UI dependencies. Smaller than frame extraction, larger than TODO.

### Option E — Frame extraction / ranking / layout

The biggest piece. The three docs (`frame-extraction.md`, `frame-ranking.md`, `frame-layout.md`) define a full algorithm: three competing pipelines, framework-aware tokenization, co-change matrix, dominator analysis, mulberry32 deterministic D3-force layout, FrameKind taxonomy. Multi-week effort. Strict dependency on Option B (corpus survey) for calibration.

**When to pick this:** when you're ready to commit a multi-session effort *and* the corpus data is ready.

### My recommendation (with the caveat that I have no priority context)

If you want to ship something user-facing quickly: **C (TODO entity)** — clean spec, mirrors existing patterns.

If you want to set up the next major piece: **B (corpus survey)** — unblocks E.

If you want to finish the absorption story: **A.6 (strip MCP shell)** — keeps that track moving and reduces dead code in `internal/cbm/`.

## Project conventions (recap)

From [`.claude/rules/workflow.md`](.claude/rules/workflow.md):
- **Branch first.** Never commit to `main`. Naming: `feature/<scope>/<desc>` where scope ∈ `{component, page, api, store, config, layout, css, db}`.
- **Atomic commits.** Format: `<type>(<scope>): <description>`.
- **Merge protocol.** `git merge --no-ff <branch>` then `git branch -d <branch>`. Push only when explicitly asked.
- **Gates.** Visual QA (Gate 0) for UI; `/review` (Gate 1) before marking tasks complete; `qa` agent (Gate 2) before merge. Backend-only / docs work may skip Gate 0.

From [`CLAUDE.md`](CLAUDE.md):
- Prefer `search_code` over Grep for code search.
- Before modifying code, check `why_was_this_built({ qualified_name })`.

From the brainstorm/spec/plan/execute pattern (used for Phase 4):
- For non-trivial work: `superpowers:brainstorming` → spec doc → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (for parallel-isolated tasks) or `superpowers:executing-plans` (for in-session sequential).

From recent observation (this session):
- **Subagent timeouts on large/complex C-side work.** Two implementer subagents timed out (~9 and ~93 min) when given the entire `sqlite_writer.c` rewrite. The second one made substantial progress before timeout but didn't commit. Lesson: split big C-side rewrites into smaller chunks, or use shorter scoped prompts. The B-tree page writer in particular is intricate enough that a fresh subagent can't ingest it cleanly in one pass.

## Tech debt

### Phase 4 follow-ups
- **Viewer regression for granular kinds.** 2D viewer's color/shape map was tuned for the old `function`/`component`/`path` collapse. Post-Phase-4 kinds (`class`, `method`, `interface`, `enum`, etc.) render with default styling. Pick up in a small viewer-styling pass.
- **CBM C tests broken.** `internal/cbm/tests/` (~2700 tests) still references `cbm_*` tables / old column names. `npm test` doesn't run them so it's not a CI issue, but if you ever want to run CBM's own test suite they need updating.
- **`Cbm*` TS interface names.** `CbmNode`, `CbmEdge`, `CbmProject` kept for diff continuity. Phase 8 renames.
- **Lean grammar parser ~100MB.** `internal/cbm/internal/cbm/vendored/grammars/lean/parser.c` flagged on push. Future Git LFS consideration.
- **`tests/mcp-contract/decision-tools.test.ts` 1 skipped test.** Pre-existing; investigate someday.

### From earlier sessions
- **`anim.nodes` grows unbounded** — `setHover` adds, `remove_node` doesn't evict.
- **`syncSimulation()` reheats on attribute-only `update_node`** — visible twitch.
- **`seen` Set in `websocket.js` unbounded** — ~26MB at 1M events.
- **WS reconnect drift** — mutations during outage aren't replayed.
- **`src/ws/server.ts:~52`** — 5ms `setTimeout` workaround for same-process WS frame ordering.
- **`tsconfig.json`** doesn't copy `.mjs` to `dist/` (matters for `npm run build` only).
- **`feat/phase1-implementation` local branch** — dead, far behind main, predates much of the work. Safe to delete.

### Process
- **Decision capture gap.** `SELECT COUNT(*) FROM nodes WHERE kind='decision'` = 0 in the live DB despite multiple sessions of architectural work. Decisions to-capture from this session alone:
  - "Break-away policy: no v0.2/v0.3 legacy DB migration shim ships" (Phase 4)
  - "Bulk-write fast path preserved via Option D rewrite" (Phase 4 — vs Option B SQL-flush which would have been ~33% slower)
  - "TEXT PK with rowid = integer counter; FTS rowid alignment via SUBSTR(id, 5)" (Phase 4)
  - "Indexer no longer creates `nodes`/`edges` — Cortex owns those tables" (Phase 4 ownership division)

## Quick start

```bash
cd ~/Development/cortex
git pull                              # should be clean
npm install                           # postinstall builds bin/cortex-indexer
npm test                              # expect 48 files / 360 passed / 1 skipped
bash scripts/build-indexer.sh         # rebuild indexer if you've touched C
npm run dev                           # MCP + 2D viewer + WS on :3334
```

Pick a track from §"What to pick up next" above. Then:

```
# For Option A.6 (strip CBM MCP shell):
/brainstorm Phase 6 of CBM absorption: strip CBM's MCP shell + bridge query_graph / get_architecture / ingest_traces. Spec is at docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md §3 Step 6.

# For Option B (corpus survey):
/brainstorm Phase 1 corpus survey for frame extraction calibration. Spec is at docs/specs/cortex-v0.3/README.md §"First build target". Output: a Node script that clones ~25 GitHub repos and produces a CSV of (entity_count, edge_density, directory_depth, language_mix) per repo.

# For Option C (TODO entity):
/brainstorm TODO entity implementation. Spec is at docs/specs/cortex-v0.3/todo-entity.md.

# For Option D (reconciliation engine v1):
/brainstorm decision reconciliation engine v1. Spec is at docs/specs/cortex-v0.3/cortex-multiplayer-spec.md §10.3.

# For Option E (frame extraction):
/brainstorm frame extraction algorithm. Spec is at docs/specs/cortex-v0.3/frame-extraction.md (and ranking + layout companions). Note: this depends on Option B corpus data for calibration.
```

## Key artifacts

### v0.3 design corpus
| File | What it is |
|---|---|
| [`docs/specs/cortex-v0.3/README.md`](docs/specs/cortex-v0.3/README.md) | v0.3 entry point — file index, reading order, status snapshot, promotion plan |
| [`cortex-multiplayer-spec.md`](docs/specs/cortex-v0.3/cortex-multiplayer-spec.md) | Original spec (~919 lines). Sections 1-7 + 9-11 still authoritative. §8 superseded by frame-* notes. |
| [`frame-extraction.md`](docs/specs/cortex-v0.3/frame-extraction.md) | Authoritative frame extraction algorithm |
| [`frame-ranking.md`](docs/specs/cortex-v0.3/frame-ranking.md) | Ranking + FrameKind taxonomy |
| [`frame-layout.md`](docs/specs/cortex-v0.3/frame-layout.md) | D3-force layout, mulberry32, deterministic seeding |
| [`todo-entity.md`](docs/specs/cortex-v0.3/todo-entity.md) | TODO entity spec |
| [`cortex-frames-prototype-v5.html`](docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html) | Canonical 2D prototype (open in browser) |
| [`cortex-backlog.md`](docs/specs/cortex-v0.3/cortex-backlog.md) | Historical design backlog |

### CBM absorption (Track 1)
| File | What it is |
|---|---|
| [`docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md`](docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md) | Parent spec — 8-step implementation order |
| [`docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md`](docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md) | Phase 4 spec |
| [`docs/superpowers/plans/2026-05-05-native-indexer-schema-fold.md`](docs/superpowers/plans/2026-05-05-native-indexer-schema-fold.md) | Phase 4 implementation plan |
| [`docs/superpowers/plans/2026-05-04-native-indexer-bootstrap.md`](docs/superpowers/plans/2026-05-04-native-indexer-bootstrap.md) | Phase 1+2 plan (subtree + build pipeline) |
| [`docs/superpowers/plans/2026-05-04-native-indexer-storage-retarget-c-side.md`](docs/superpowers/plans/2026-05-04-native-indexer-storage-retarget-c-side.md) | Phase 3a plan |
| [`docs/superpowers/plans/2026-05-04-native-indexer-storage-retarget-ts-side.md`](docs/superpowers/plans/2026-05-04-native-indexer-storage-retarget-ts-side.md) | Phase 3b plan |

### Project rules
| File | What it is |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Cortex project instructions for agents |
| [`.claude/rules/workflow.md`](.claude/rules/workflow.md) | Branching, commit, review, merge protocol |
| [`README.md`](README.md) | User-facing docs (now reflects post-Phase-4 architecture) |

## Key files (modified this session)

| File | Change |
|---|---|
| [`src/graph/schema.ts`](src/graph/schema.ts) | New columns + 3 compound indexes |
| [`src/graph/store.ts`](src/graph/store.ts) | `CBM_LABEL_MAP` deleted; `getAll*Unified` simplified |
| [`src/graph/code-queries.ts`](src/graph/code-queries.ts) | All SQL targets unified `nodes`/`edges` |
| [`src/index.ts`](src/index.ts) | `cbm_projects` → `ctx_projects` |
| [`src/mcp-server/tools/code-tools.ts`](src/mcp-server/tools/code-tools.ts) | Inline SQL + formatters use `kind` |
| [`internal/cbm/src/store/store.c`](internal/cbm/src/store/store.c) | New schema in `init_schema`, INSERTs, SELECTs |
| [`internal/cbm/internal/cbm/sqlite_writer.c`](internal/cbm/internal/cbm/sqlite_writer.c) | Bulk-write path full rewrite |
| [`internal/cbm/src/pipeline/pipeline.c`](internal/cbm/src/pipeline/pipeline.c) | FTS backfill uses `nodes.rowid` |
| [`tests/mcp-contract/globalSetup.ts`](tests/mcp-contract/globalSetup.ts) | Queries new schema |
| [`tests/graph/code-queries.test.ts`](tests/graph/code-queries.test.ts) | `ctx-` prefix; `ctx_projects` |
| [`tests/mcp-contract/code-tools.test.ts`](tests/mcp-contract/code-tools.test.ts) | Lowercase kind regex |
| [`tests/mcp-contract/smoke.test.ts`](tests/mcp-contract/smoke.test.ts) | Lowercase kind regex |
| [`README.md`](README.md) | Architecture, native-indexer, env vars all reflect single-file Phase-4 layout |
| [`HANDOFF.md`](HANDOFF.md) | This file — comprehensive v0.3 track overview |
| (deleted) `src/graph/cbm-discovery.ts` | Phase 5 migration shim — no longer needed |
| (deleted) `tests/graph/schema-fold-migration.test.ts` | Tested deleted migration |
| (deleted) `tests/graph/fts-migration.test.ts` | Tested pre-Phase-4 legacy upgrade |
