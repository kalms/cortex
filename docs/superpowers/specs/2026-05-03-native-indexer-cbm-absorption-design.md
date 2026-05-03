# Cortex v0.3 — Native Indexer (CBM Absorption)

**Date:** 2026-05-03
**Status:** Design — pending implementation
**Branch:** `feature/api/native-indexer`
**Track:** v0.3 Track 1 (CBM-first slicing, see [docs/specs/cortex-v0.3/README.md](../../specs/cortex-v0.3/README.md))

---

## 0. Purpose

Replace the externally-distributed `codebase-memory-mcp` binary with an absorbed, in-tree native indexer owned by Cortex. Unify code-entity storage with decision/PR/TODO storage in `cortex.db`. Eliminate the GitHub-release download path and the SQLite ATTACH layer.

This unblocks v0.3 frame extraction (which reads code entities + decisions + PRs as one graph) and gives Cortex agents a fully-owned semantic indexing pipeline that we can extend without upstream-PR latency.

**Out of scope** for this spec:
- Frame extraction algorithm (Track 3 — separate plan, consumes the unified graph this spec produces)
- v0.3 visual canvas (Track 4)
- Switching to N-API / FFI bindings (Track 1.5 if profiling justifies; not now)
- Adding new tree-sitter grammars beyond CBM's existing 66

---

## 1. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | CBM source lives in Cortex's tree under `internal/cbm/` with full git history | `git log --oneline internal/cbm/` shows CBM commits |
| G2 | Code entities (functions, classes, methods, files, symbols) live in `cortex.db`'s `nodes`/`edges` tables alongside decisions / PRs / TODOs | `SELECT DISTINCT kind FROM nodes` returns code + decision + pr kinds from one db |
| G3 | The 9 existing CBM-backed MCP tools continue to work with identical contracts | `tests/mcp-contract/` passes unchanged |
| G4 | `bin/codebase-memory-mcp` (downloaded), `scripts/install-cbm.sh` (download script), `~/.cache/codebase-memory-mcp/` discovery — all gone | grep returns no references |
| G5 | A v0.2 deployment with an existing attached CBM database at `~/.cache/codebase-memory-mcp/<project>.db` migrates cleanly on first v0.3 startup | manual test on a v0.2 snapshot; entities accessible after upgrade |
| G6 | `npm install` builds the indexer locally — no GitHub release fetch, no auth required | fresh clone + `npm install` produces a working binary |

---

## 2. Architecture

### 2.1 Repository structure (post-merge)

```
cortex/
├── internal/
│   └── cbm/                      ← from `git subtree add` of DeusData/codebase-memory-mcp
│       ├── src/                  CBM C source: main.c, mcp/, pipeline/, semantic/,
│       │                         simhash/, store/, cypher/, discover/, watcher/, traces/
│       ├── vendored/             tree-sitter, sqlite3, yyjson, xxhash, mimalloc, nomic, mongoose, tre
│       ├── tools/                tree-sitter-form, tree-sitter-magma
│       ├── tests/                CBM's 2586-test suite
│       └── Makefile.cbm          CBM's existing build rules — invoked by Cortex's postinstall
├── bin/
│   └── cortex-indexer            ← built artifact, replaces the downloaded codebase-memory-mcp binary
├── scripts/
│   └── build-indexer.sh          ← postinstall hook: runs make -f internal/cbm/Makefile.cbm
├── src/
│   ├── graph/
│   │   ├── schema.ts             extended: start_line, end_line on nodes; new edge relations
│   │   ├── store.ts              attachCbm() removed; queries hit cortex.db directly
│   │   ├── code-queries.ts       ← renamed from cbm-queries.ts; SQL targets cortex.db
│   │   └── code-discovery.ts     ← renamed from cbm-discovery.ts; v0.2 migration only
│   └── mcp-server/tools/
│       └── code-tools.ts         spawns bin/cortex-indexer; passes cortex.db path
└── (deleted) bin/codebase-memory-mcp, scripts/install-cbm.sh
```

### 2.2 Data model — schema unification

Code entities fold into the existing `nodes`/`edges` tables. Schema additions (one migration step):

```sql
-- Add line-range columns to nodes (CBM has them, cortex.db doesn't)
ALTER TABLE nodes ADD COLUMN start_line INTEGER;
ALTER TABLE nodes ADD COLUMN end_line INTEGER;

-- Index for code-entity lookups
CREATE INDEX IF NOT EXISTS idx_nodes_kind_file ON nodes(kind, file_path);
```

**Node `kind` vocabulary** (additive — existing decision/pr/todo kinds preserved):

| kind | Source | Identity |
|---|---|---|
| `file` | filesystem entry indexed by CBM | qualified_name = repo-relative path |
| `function` | tree-sitter symbol | qualified_name = `<project>.<path>.<name>` |
| `class` | tree-sitter symbol | same shape |
| `method` | tree-sitter symbol on a class | same shape |
| `symbol` | top-level identifier (const, var, type) | same shape |
| `module` | logical compilation unit (CBM-derived) | same shape |
| `decision` / `pr` / `todo` | existing — unchanged | |

The `data` JSON column carries kind-specific extras (visibility, signature, hash, etc.) — keeps the schema additive instead of growing per-kind columns.

**Edge `relation` vocabulary** (matches CBM's existing edge types verbatim, since downstream code already speaks it):

`CALLS`, `IMPORTS`, `DEFINES`, `DEFINES_METHOD`, `HANDLES`, `IMPLEMENTS`, `OVERRIDE`, `USAGE`, `FILE_CHANGES_WITH`, `CONTAINS_FILE`, `CONTAINS_FOLDER`, `CONTAINS_PACKAGE`, plus existing decision-edge relations (`GOVERNS`, `SUPERSEDES`, `RELATED_TO`, `DEPENDS_ON`, `INTRODUCED_IN`, `IMPLEMENTED_BY`, ...).

`HTTP_CALLS` and `ASYNC_CALLS` are listed in CBM's docs but defer until Cortex actually uses them.

### 2.3 Process model

Cortex's TS continues to spawn the indexer binary via `execFile` — same pattern as today, just pointed at our own `bin/cortex-indexer`. CBM's existing CLI subcommand surface (`cli index_repository`, `cli detect_changes`, `cli delete_project`) stays. Read queries no longer ATTACH a separate database; they hit `cortex.db` directly.

```
┌────────── Cortex (TS) ──────────┐
│                                 │
│  MCP tool: index_repository     │
│        │                        │
│        ▼                        │
│   execFile(bin/cortex-indexer,  │
│     "cli", "index_repository",  │
│     { repo_path, db_path })     │
│        │                        │
│  ┌─────┴─────────────┐          │
│  │                   │          │
│  ▼                   ▼          │
│  bin/cortex-indexer (C)         │
│   ↓ writes nodes/edges          │
│  cortex.db ←──── reads ─────────┤
│                       │         │
│  search_graph / trace │         │
│  trace_path / etc.    │         │
└───────────────────────┴─────────┘
```

**CBM's storage model needs adjustment to make this work.** Today CBM writes one SQLite file per project (`<cache_dir>/<project>.db`); cache dir is set via `CBM_CACHE_DIR` env or defaults to `~/.cache/codebase-memory-mcp/`. The discriminator across projects is the *file*, not a column. Multi-project queries don't exist — each `cbm_store_t` opens exactly one project's DB.

For Cortex's unified model, CBM's storage layer needs:

1. A `--db-path <path>` CLI flag (and/or `CORTEX_DB` env var) that overrides the per-project file resolution and points at a single shared file
2. CBM's `project` column on `nodes`/`edges` becomes the per-project discriminator at the *row* level instead of the file level — this matches CBM's existing schema (the column already exists, just isn't the primary partition)
3. `resolve_store` in [internal/cbm/src/mcp/mcp.c](../../../internal/cbm/src/mcp/mcp.c) (CBM's per-project store cache) is bypassed in CLI mode — CLI mode opens the shared file once

This is real C-side work, but bounded. CBM's parsing, AST extraction, semantic, simhash, watcher, and pipeline modules don't need to change — only the storage entry point (`cbm_store_open` / `project_db_path` in [src/mcp/mcp.c](../../../internal/cbm/src/mcp/mcp.c#L681) and the foundation `cache_dir` resolver).

### 2.4 Migration from v0.2

A v0.2 deployment has:
- `cortex.db` with decisions/PRs (no code entities)
- An attached CBM database at `~/.cache/codebase-memory-mcp/<project>.db` with code entities

On first v0.3 startup, `src/graph/code-discovery.ts` performs a one-time migration if it detects a CBM cache file matching the current project:

1. Open the CBM cache read-only via ATTACH
2. Stream-copy `cbm.nodes` into `cortex.db`'s `nodes` table (mapping CBM's `label` → `kind`, preserving `qualified_name` / `file_path` / `start_line` / `end_line`)
3. Stream-copy `cbm.edges` into `cortex.db`'s `edges` table (mapping CBM's `type` → `relation`)
4. Write a marker row into a new `migrations` table indicating CBM-import done
5. Detach; CBM cache file remains on disk untouched (user can delete manually)

Subsequent startups skip the migration. The migration is idempotent (re-running is a no-op via marker check). If CBM cache is absent (fresh install), nothing happens — first `index_repository` call populates the unified graph natively.

### 2.5 What CBM's MCP shell becomes

CBM today is *also* an MCP server. We don't need that — Cortex is the MCP server. CBM's MCP module (`internal/cbm/src/mcp/`) becomes dead code from Cortex's perspective. Two options:

**A. Leave it.** Dead code doesn't hurt; reduces merge complexity.
**B. Strip it.** Removes ~one module; signals "this is now Cortex's indexer, not an MCP product."

**Decision: A for v0.3.** Keep CBM's source as-imported. Stripping is a future cleanup once we're confident we never need to re-sync from upstream. The CLI subcommands we *use* (`cli index_repository`, etc.) live in CBM's `cli/` module and are unaffected either way.

---

## 3. Implementation order

Each step is a meaningful merge boundary. Tests pass at the end of each.

### Step 1 — Subtree merge

```bash
git remote add cbm-source ../codebase-memory-mcp
git subtree add --prefix=internal/cbm cbm-source main
git remote remove cbm-source
```

CBM source lands under `internal/cbm/` with its 2586-test history preserved. `make -f internal/cbm/Makefile.cbm cbm` builds a working `cbm` binary as before. No Cortex code changes yet.

**Validation:** `make -f internal/cbm/Makefile.cbm test` passes; `make -f internal/cbm/Makefile.cbm cbm` produces a binary; the binary indexes a small test repo into a temp DB.

### Step 2 — Build pipeline integration

- `scripts/build-indexer.sh` — wraps `make -f internal/cbm/Makefile.cbm cbm` and copies the binary to `bin/cortex-indexer`
- `package.json` `postinstall` updated: replace `bash scripts/install-cbm.sh` with `bash scripts/build-indexer.sh`
- `scripts/install-cbm.sh` deleted
- `bin/codebase-memory-mcp` deleted from the repo (it was downloaded; not needed in source control)
- `bin/.gitignore` updated to ignore built `cortex-indexer`

**Validation:** Fresh clone + `npm install` on macOS arm64 produces a working `bin/cortex-indexer`. Linux + Windows builds verified in CI (separate ticket if not already in CBM's CI).

### Step 3 — Indexer storage retarget

Inside `internal/cbm/`, add an explicit single-file storage mode:

- `--db-path <path>` flag and `CORTEX_DB` env var on CLI entry points (`cli/cli.c`)
- New code path that bypasses `project_db_path()` and opens the supplied file directly
- The existing `project` column on `nodes`/`edges` becomes the row-level discriminator (already present in CBM's schema; `WHERE project = ?` filters already exist throughout)
- For initial integration, CBM's tables land in `cortex.db` under a `cbm_` prefix (`cbm_projects`, `cbm_nodes`, `cbm_edges`) — preserves CBM's schema verbatim and keeps the change in CBM minimal: it's still the same `CREATE TABLE` text, just with a prefixed name
- Cortex's TS read layer queries `cbm_nodes` / `cbm_edges` for now (a one-line change in `code-queries.ts`)

This step keeps CBM's internal write-path intact — same schema, same SQL, same semantics — while collapsing the *file boundary*. ATTACH is gone; both Cortex and the indexer write into one file.

**Validation:** `bin/cortex-indexer cli index_repository --db-path ./test.db '{"repo_path":"."}'` populates `cbm_projects` / `cbm_nodes` / `cbm_edges` in `test.db`. Cortex's TS query layer points at the same file and `tests/mcp-contract/` passes against it.

### Step 4 — Schema fold

Now that everything lives in one file, fold CBM's prefixed tables into Cortex's existing `nodes` / `edges` schema:

1. `ALTER TABLE nodes ADD COLUMN start_line INTEGER;`
2. `ALTER TABLE nodes ADD COLUMN end_line INTEGER;`
3. `ALTER TABLE nodes ADD COLUMN project TEXT;` (CBM's discriminator)
4. Migration: copy `cbm_nodes` → `nodes` (mapping `label` → `kind`, preserving qualified_name / file_path / start_line / end_line / project)
5. Migration: copy `cbm_edges` → `edges` (mapping `type` → `relation`)
6. Drop `cbm_nodes` / `cbm_edges` / `cbm_projects`
7. CBM's storage init updated to write directly into `nodes` / `edges` (no `cbm_` prefix). This is the second C-side change: the SQL strings in CBM's `store/` module switch table names. CBM's `project` column already exists and slots into the new schema.
8. Cortex's `getAllNodesUnified()` / `getAllEdgesUnified()` — already in `store.ts` — simplify to plain queries against `nodes` / `edges`. ATTACH-related code (`attachCbm`, the discovery logic that locates CBM cache files) deleted.
9. `src/graph/cbm-queries.ts` → `src/graph/code-queries.ts`; SQL fully unprefixed.

**Validation:** `tests/mcp-contract/` passes; new `tests/graph/code-queries.test.ts` exercises queries against unified storage. The old `tests/graph/cbm-attach.test.ts` is deleted.

### Step 5 — v0.2 migration shim

`src/graph/code-discovery.ts` (renamed from `cbm-discovery.ts`):
- On startup, check for an existing CBM cache at `~/.cache/codebase-memory-mcp/<project>.db`
- If found AND `migrations` table doesn't have the `cbm-import` marker: ATTACH read-only, copy entities, mark done, detach
- If marker exists: skip
- If cache absent: no-op

`src/index.ts`: replace `discoverCbmDb` + `attachCbm` calls with the migration runner. After migration completes, the rest of the runtime never touches the CBM cache file again.

**Validation:** Manual test — checkout a v0.2 commit, run a real index, switch to v0.3, verify entities accessible via `search_graph` and `trace_path` without re-indexing.

### Step 6 — Cleanup

- Rename remaining `cbm*` symbols in TS (`cbmProject`, `CbmNode`, etc.) → `code*` / `IndexerNode` / etc.
- Update `README.md` "CBM Integration" section → "Native Indexer"
- Update `CLAUDE.md` if it mentions CBM
- Delete `tests/graph/cbm-attach.test.ts` if not already replaced

**Validation:** `grep -ri "cbm\|CBM\|codebase-memory" src/ tests/` returns nothing (or only references inside `internal/cbm/`).

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| **Cross-platform build complexity.** CBM's Makefile assumes Unix tooling (clang/gcc, pkg-config, libgit2 optional). Windows users on a fresh `npm install` may hit build failures. | CBM already builds on Windows per its README. Document the toolchain expectation in Cortex's `README.md`. Consider a prebuild fallback for v0.4. |
| **Repo size growth.** CBM is 45k LOC of C plus vendored deps (`mimalloc`, `nomic`, etc.). The Cortex repo will roughly 5×. | Acceptable cost for ownership. Vendored deps are under `internal/cbm/vendored/` and don't affect TS dev workflow. |
| **CBM schema drift.** CBM's storage layer has its own migration system. When we point CBM at cortex.db, both migration systems converge on the same file. | Step 4 explicitly folds CBM tables into Cortex's schema; only Cortex's migration runner survives. |
| **CBM C-side modifications fight upstream.** Steps 3 + 4 require touching CBM's storage init and SQL strings. Future CBM bugfixes that we'd want to pull in could conflict. | Modifications are bounded (storage entry point + table names — not parsing/AST/semantic logic). Conflicts during cherry-picks are tractable. We accepted this trade-off explicitly when choosing absorption over external dependency. |
| **v0.2 user data loss.** Botched migration could leave a v0.2 user without their indexed graph. | Migration is read-only on the CBM cache; original file untouched. If migration fails, user can re-index from scratch — no worse than today's CBM re-index path. |
| **Subtree merge gotchas.** `git subtree add` rewrites commit dates; future bidirectional sync (if we ever need to pull CBM upstream changes) is fiddly. | We're cutting upstream sync explicitly — no need for `git subtree pull`. If a CBM bug fix lands upstream that we want, we cherry-pick it manually. |
| **Test suite duplication.** CBM's 2586 tests + Cortex's 179. Both run on `npm test`? Just one? | Default: `npm test` runs Cortex's TS tests only. Add `npm run test:indexer` for CBM's C tests, run in CI. |
| **Frame extraction (Track 3) reads from this graph.** If schema choices here are wrong, Track 3 has to rework them. | Schema mapping in §2.2 was checked against `frame-extraction.md`'s requirements — co-change matrix, file-co-change edges, function/class/method granularity all available. |

---

## 5. Open questions

1. **Test runner integration.** Does `npm test` in Cortex skip CBM's C tests entirely, or run them in CI only? Lean: skip in dev, run via dedicated CI step.
2. **CBM's MCP shell.** Leave as-is in `internal/cbm/src/mcp/` (current call), or strip in step 6 cleanup? Lean: leave for now.
3. **Indexer binary name.** `cortex-indexer` (matches Cortex naming) or `cbm` (matches CBM naming, less rename churn). Lean: `cortex-indexer` — signals the absorption.
4. **Embedded HTTP server (mongoose).** CBM ships a graph-UI HTTP server at port 9749. Cortex has its own viewer. The mongoose code is dead from Cortex's POV. Strip or leave? Lean: leave (zero-cost dead code) until we strip CBM's MCP shell in a future cleanup.
5. **CBM CLI invocation contract.** Today: `codebase-memory-mcp cli <tool> <json-args>`. Post-absorption: `cortex-indexer cli <tool> <json-args> --db-path ...`. Implementing the `--db-path` flag is part of step 3; the open question is whether we plumb it as a flag (visible in the contract) or as an env var (`CORTEX_DB`). Lean: env var only — keeps Cortex's TS code paths consistent and avoids changing CBM's argv parsing.
6. **Phase 1 corpus survey scope.** The user agreed to take this on. Scope: which repos, which metrics. This is feeding Track 3 (frame extraction) — a separate spec, but the survey can run in parallel with Track 1 implementation (CBM already produces the index stats; we just need to run it across N repos and compare).

---

## 6. Out-of-scope future work

- **N-API binding.** Replace subprocess invocation with in-process FFI. Wins ~50ms per indexer call, costs significant binding maintenance. Defer until profiling shows it matters.
- **Strip CBM's MCP shell.** Remove `internal/cbm/src/mcp/` once we're confident we never need upstream sync. Reduces dead code.
- **Strip CBM's graph-UI HTTP server.** Same reasoning.
- **Switch to FFI-loaded grammars.** Today CBM's grammars are statically compiled in. If we want runtime grammar loading (for plugin grammars), this is a real change.
- **WASM fallback.** If a platform exists where building C is impossible (some CI sandboxes), a `web-tree-sitter` fallback keeps Cortex usable. Not needed yet.

---

## Appendix A: Why this scope, and why now

The original v0.3 plan (in [docs/specs/cortex-v0.3/README.md](../../specs/cortex-v0.3/README.md)) listed CBM replacement as an unscoped concern. During design dialogue on 2026-05-03, two facts surfaced:

1. CBM is owned source (DeusData/codebase-memory-mcp), not third-party.
2. CBM's existing infrastructure (simhash, nomic embeddings, co-change pipeline, watcher) covers ~80% of what v0.3 frame extraction needs.

Together these make absorption strictly better than rewrite: we get unified schema, owned source, *and* the algorithm infrastructure for Track 3 — all without rewriting 45k lines of working C. The earlier "Native Indexing" memory ([memory/project_native_indexing.md](../../../../.claude/projects/-Users-rka-Development-cortex/memory/project_native_indexing.md)) parked a "tree-sitter WASM rewrite" — this spec replaces that direction with absorption.

## Appendix B: Decisions to capture once Track 1 lands

To be created via `create_decision` when implementation completes (IDs assigned at creation time):

- **Absorb CBM into Cortex.** Replaces "depend on external codebase-memory-mcp binary." Rationale: ownership of indexing pipeline, no upstream-PR latency, infrastructure reuse for v0.3 frame extraction. Alternatives considered: WASM rewrite (rejected — months of work to redo what CBM has), N-API binding (rejected — adds build surface for unmeasured perf gain), keep external (rejected — defeats v0.3 ambition).
- **Unify code entities into cortex.db nodes/edges.** Replaces SQLite ATTACH. Rationale: one query path for frame extraction; eliminates ATTACH operational complexity. Alternatives: separate code-entity namespace inside cortex.db (rejected — wants `getAllNodesUnified`); separate file ATTACHed (rejected — same as today, no win).
- **Subprocess invocation, not FFI.** Rationale: keep process boundary for debuggability; perf gain unmeasured. Defer FFI to v0.4 if profiling justifies.
- **Subtree merge for absorption (over vendor-copy).** Rationale: preserves CBM's git history for blame and archaeology; one-time operation; reverse-sync from upstream not a goal.
