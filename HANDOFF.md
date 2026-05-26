# Cortex — Session Handoff (2026-05-26)

## TL;DR

Two waves this session. **Wave 1**: HTTP_CALLS / HANDLES queue from yesterday — shipped Bug 1 (Nuxt fetch detection: anthill-cloud 0→23 HTTP_CALLS), Bug 2 (URL-arg discriminator: cortex 76→25), refined Bug 3 diagnosis and deferred. **Wave 2**: a new field report from the agent in anthill-cloud landed mid-session ([docs/architecture/field reports/field-report-2026-05-26-cli-and-graph-coverage-followup.md](docs/architecture/field%20reports/field-report-2026-05-26-cli-and-graph-coverage-followup.md)). Triaged it and shipped the three small items immediately: lockfile-route noise (anthill-cloud 183→13 routes), `cortex index changes` bug fix, and `file:symbol` editor-jump form in resolveInput.

- **Branch:** `main`, ~8 commits ahead of `origin/main` (Wave 1 + Wave 2 + their merge commits — not pushed)
- **C tests:** new `service_patterns` suite passes 24/24. Pre-existing store/cypher/pipeline test failures are sanitizer-build issues unrelated to this work.
- **TS tests:** `resolve-input.test.ts` 8/8 pass (5 existing + 3 new for file:symbol form)
- **Build:** `bin/cortex-indexer` clean, `npx tsc` clean (full dist/ rebuilt)
- **`cortex` CLI:** installed at `~/.local/bin/cortex` (unchanged)

## What shipped this session (2026-05-26)

### Bug 1 — Nuxt fetch family HTTP_CALLS detection (merged: 5700759)

Adds `ctx_service_pattern_is_global_http()` allowlist covering `$fetch`, `useFetch`, `useLazyFetch`, and platform `fetch`. Wires a fallback in the unresolved-call branch of both `pass_calls.c` AND `pass_parallel.c` (the latter is the production path for repos >100 files — yesterday's plan only mentioned pass_calls.c). For unresolved calls whose bare callee matches the allowlist AND whose first string arg is URL-shaped, emits an HTTP_CALLS edge pointing to a Route node.

- **Why the original plan ("just add them to http_libraries[]") didn't work:** that table is a SUBSTRING match on the resolved QN. Nuxt's `$fetch` etc. are auto-imports — they never appear in an IMPORTS edge, so call resolution returns nothing and the call gets dropped before classification can run. The substring-match path is unreachable for them.
- **Impact:** anthill-cloud 0 → 23 HTTP_CALLS (all `via: global_http`, all real Nuxt fetches). cortex +1 legit fetch. No regressions elsewhere.
- **Known gap:** 47 of anthill-cloud's 57 `$fetch` calls use template-literal URLs (`` $fetch(`/api/${id}`) ``). `extract_positional_url` only accepts `string`/`string_literal`/`interpreted_string_literal` tree-sitter node kinds — `template_string` isn't in `is_string_like()` in [internal/indexer/extract/extract_calls.c:40-44](internal/indexer/extract/extract_calls.c#L40-L44). Adding it would recover ~80% more anthill HTTP_CALLS. Small follow-up.

### Bug 2 — URL-arg discriminator (merged: fe92f5c)

Adds `ctx_service_pattern_looks_like_http_url()` that rejects paths starting with filesystem prefixes (`/tmp/`, `/Users/`, `/usr/`, `/var/`, `/etc/`, `/opt/`, `/home/`, `/bin/`, `/sbin/`, `/private/`, `/dev/`, `/mnt/`, `/Volumes/`, `/Library/`, `/Applications/`, `/root/`, `/proc/`, `/sys/`, `/media/`, `/srv/`, `/run/`, `/boot/`, `/cygdrive/`) and paths ending with source-file/asset extensions (44 in the list: `.ts .go .py .c .rs .vue .json .yaml .md .png .woff2 …`).

Wired into `normalize_url_arg` (pass_parallel's detect_url_in_args), `try_emit_global_http_call`, and `try_emit_global_http_call_parallel`.

- **Impact:** cortex 76 → 25 HTTP_CALLS (51 FPs gone). The 25 remaining: 19 are legitimate `/api/...` paths from `src/mcp-server/api.ts` (Hono routes) + test fixtures, 6 are `/foo/bar/`, `/a/b/c/d/e` — generic-looking test data that the discriminator can't safely reject. No regressions in other indexes.

### Field-report follow-ups (Wave 2, all merged)

Triaged the 2026-05-26 field report and shipped the three small actionable items same session:

- **Lockfile route noise** (merged: `fcde0e1` — `d85a746`): `is_infra_file` in [pipeline.c:435](internal/indexer/src/pipeline/pipeline.c#L435) accepted any `.yaml`/`.yml`/`.tf`/`.hcl`/`.toml` path, so pnpm-lock.yaml's thousands of tarball URLs were upserted as `__route__infra__` nodes. **anthill-cloud 183 → 13 Route nodes**, cortex 60 → 20, no other corpus affected. Filter is a small basename allowlist (pnpm-lock.yaml, Cargo.lock, Pipfile.lock, poetry.lock, uv.lock, Gemfile.lock, mix.lock, composer.lock).

- **`cortex index changes` bug fix** (merged: `2a82a76` — `bd467cc`): one-line typo in [src/cli/commands/index.ts:32](src/cli/commands/index.ts#L32). The CLI passed `{ repo_path: ctx.cwd }` to `detect_changes` but the handler reads `{ project: ... }`. Now matches how `index status` is wired. SessionStart hook copy specifically points agents at this command — was a real usability hit.

- **`file:symbol` editor-jump form in resolveInput** (merged: `5f29a16` — `4f89e77`): adds a pre-check for `path/to/file.ext:identifier` inputs (the natural form for jump-to-definition). Bare file paths and bare names still work as before. 3 new tests cover the editor-jump form, tail-match (`Card.tsx:render` works as well as the full path), and the negative case (unknown symbol throws DomainError instead of silently falling through to file lookup).

**Field-report diagnoses that turned out to be wrong** (worth noting for the agent for next time):
- Report said `.vue` files don't appear as `file` nodes. **Actually 99 are present.** The agent queried `WHERE f.qualified_name CONTAINS ".vue"` but file QNs strip the extension (`...pages.onboarding.__file__`). The data is there; the query was wrong. Worth a docs note or schema change to preserve the extension.
- Report said Pinia stores aren't a node class because `useFoundationStore` returns zero. **Actually 16 other `use*Store` variables ARE indexed correctly** (useSlideLayoutsStore, useVariablesStore, …). The specific example uses a factory wrapper (`createFoundationStore()`) that hides the `defineStore` call, which IS a real gap — but the general pattern works.

### Bug 3 — HANDLES = 0 universally (diagnosed, deferred)

**Refined diagnosis** after reading [pass_route_nodes.c](internal/indexer/src/pipeline/pass_route_nodes.c) carefully: the emission logic is correct. `ensure_decorator_routes` scans Function/Method nodes for a `route_path` property and emits Route + HANDLES; `connect_prefix_to_decorators` and `match_infra_routes` are also working. Confirmed by counting: ZERO functions in ANY of the 9 indexed projects have a `"route_path":"..."` property in their JSON. The bug is upstream in extraction.

`extract_route_from_decorators` at [extract_defs.c:780-810](internal/indexer/extract/extract_defs.c#L780-L810) only matches Python/Java-style decorator syntax (`@app.get("/path")` over a function definition). The indexed corpora don't use that pattern:

| Project | Routing pattern | Why decorator extractor misses |
|---|---|---|
| anthill-cloud (Nuxt 3) | File-based: `server/api/orgs/index.get.ts` | No decorator. Route derives from filename + path |
| cortex (Hono) | Call-arg: `app.get('/api/x', handler)` | URL is in a CALL arg, not a decorator |
| trpc | `t.procedure.query(...)` | Procedure-based, no path string anywhere |
| pallets/click | CLI library | No routes |
| nuxt/ui, vueuse, TanStack/table | UI/utility libs | No routes |

To get HANDLES > 0, this needs a NEW route extractor per pattern. Highest-leverage target: **Nuxt file-based routing**, which would recover ~170 routes for anthill-cloud alone. Sketch of work:

1. In extract_defs.c (or a new extract_nuxt_routes.c): detect file paths matching `server/api/**/*.{get,post,put,delete,patch}.ts` and `server/api/**/index.{get,…}.ts`.
2. Derive the URL pattern from the path (translate `[id]` → `:id`, drop the `.get.ts` suffix, etc.).
3. Find the default-exported handler. In Nuxt these are `export default defineEventHandler(async (event) => { … })`. The arrow function inside isn't currently captured as a Function node — would need to either capture it OR attach `route_path`/`route_method` to the module/file node and adjust `ensure_decorator_routes` to scan those too.

**Scope estimate:** medium for Nuxt alone (1 day). Hono and tRPC patterns would be follow-ups. Deferred from this session to give it the focused C-side fixture trace work it deserves.

## What shipped 2026-05-25

### 1. User-friendly `cortex` CLI (16 commits)

Merge: `d3159c4` + QA fix merges `d61d596`, `e4c4010`.

A polished command-line front door wrapping the existing TS MCP helpers and the native indexer behind a namespaced verb-object surface. Five namespaces — `code`, `decision`, `graph`, `index`, `eval` — plus meta (`tour`, `install`, `help`).

- `bin/cortex` launcher that resolves symlinks (so the install symlink works from any cwd), exports `CORTEX_REPO_ROOT`, prefers `dist/cli/main.js`, falls back to `npx tsx`.
- `src/cli/` package: `main.ts`, `router.ts`, `context.ts`, `resolve-input.ts`, `paths.ts`, `format.ts`, `help.ts`, `tour.ts`, `install.ts`, `errors.ts`, `indexer-output.ts` plus a `commands/` directory.
- Smart input resolution at [src/shared/resolve-input.ts](src/shared/resolve-input.ts) (extracted in the resolver workstream below): file paths, canonical qns, dotted suffixes, bare names.
- 48 unit + 5 integration tests under [tests/cli/](tests/cli/), all green.
- Smoke-verified from `/Users/rka/Development/cortex` and `/Users/rka/Development/anthill-cloud` and `/tmp`.

Two QA passes happened post-merge. The second one (driven by an independent Opus review) fixed:
- `install.ts` + `eval.ts` were still resolving via `process.cwd()` — `cortex eval` broke from any non-cortex dir. Now use `repoRoot()`.
- `install.ts` uninstall over-matched on bare `alias cortex=` substring (clobbered user aliases); install didn't handle existing non-symlink at target.
- `context.ts dbHasProjectData` opened write-mode `GraphStore` (`CREATE TABLE IF NOT EXISTS` side-effect, didn't close, race with concurrent indexer). Now opens better-sqlite3 read-only with `fileMustExist`, closes in `finally`.
- `decision` commands created `.cortex/` under random dirs. Now requires git context (`state !== "no-project"`).
- `decision why` exited 0 on no-match; now throws `DomainError` → exit 3 (consistent with `cmdShow`).

Plan + spec: [docs/superpowers/plans/2026-05-24-user-friendly-cli.md](docs/superpowers/plans/2026-05-24-user-friendly-cli.md), [docs/superpowers/specs/2026-05-24-user-friendly-cli-design.md](docs/superpowers/specs/2026-05-24-user-friendly-cli-design.md).

### 2. MCP tool robustness (9 commits)

Merge: `4519415`. Plan: [docs/superpowers/plans/2026-05-21-mcp-tool-robustness.md](docs/superpowers/plans/2026-05-21-mcp-tool-robustness.md).

Three fixes from the 2026-05-21 field report. 6 TDD tasks, 25 new tests:

- **`search_code` argv hardening** — extracted rg/grep argv into `buildRgArgs`/`buildGrepFallbackArgs` helpers; added `--max-count 200` and `--exclude-dir=node_modules,.git,dist,build,.cache,vendored` so common patterns no longer time out on monorepos.
- **Decision input validator** — new `src/mcp-server/tools/decision-input-validation.ts` rejects writes whose `title`/`description`/`rationale`/`problem`/`resolution` fields contain XML marshalling leakage markers (`</invoke>`, `</rationale>`, etc.). Wired into all four write tools.
- **`governs` on `update_decision`** — `DecisionService.update` now accepts `governs` and `references` arrays with full-set-replacement semantics. Closes the recovery gap when governance was set wrong at create time (no more delete+recreate).

### 3. MCP tool input resolver (5 commits)

Merge: `e13982d`. Plan: [docs/superpowers/plans/2026-05-25-mcp-tool-input-resolver.md](docs/superpowers/plans/2026-05-25-mcp-tool-input-resolver.md).

Lifted the CLI's `resolveInput` heuristic into a new `src/shared/resolve-input.ts` returning a tagged result (`single | multi | none`). Wired into three MCP tools:
- `get_code_snippet` — accepts raw file paths and bare names
- `trace_path` — accepts file paths and bare names for `function_name`
- `why_was_this_built` — accepts bare names (file paths and qns already worked via `findGoverning`'s own walk)

Multi-match returns `ambiguous_input` with a numbered candidate list (new ErrorReason). 9 new tests. Closes the agentic-MCP-side of the field-report friction.

## What's next — actual current queue

### Item 1 — HTTP_CALLS / HANDLES extraction (Bug 1+2 done; Bug 3 + template-literal follow-up remain)

Post-session diagnostic counts (`~/.cache/cortex-indexer/*.db`):

| Project | HTTP_CALLS | HANDLES | route nodes | Notes |
|---|---:|---:|---:|---|
| cortex | 25 | 0 | 20 | was 76 HTTP_CALLS / 60 routes — Bug 2 + lockfile fix |
| anthill-cloud | **23** | 0 | **13** | was 0 HTTP_CALLS / 183 routes — Bug 1 + lockfile fix |
| trpc | 5 | 0 | 35 | unchanged |
| nuxt/ui | 2 | 0 | 130 | unchanged |
| vueuse | 2 | 0 | 14 | unchanged |
| pallets/click | 5 | 0 | 16 | unchanged |

**Remaining work:**

3. **HANDLES = 0 universally** — see "Bug 3" section above for the refined diagnosis. Next session should pick a single routing pattern (recommended: Nuxt file-based) and implement a new route extractor end-to-end with a real fixture trace. Estimated effort: medium for Nuxt alone (1 day).

4. **Template-literal URL arg extraction** (new follow-up to Bug 1). `extract_positional_url` in [extract_calls.c:531-545](internal/indexer/extract/extract_calls.c#L531-L545) only accepts simple string node kinds. Adding `template_string` (TS) and `formatted_string` (Python) would recover ~47 more anthill-cloud `$fetch` calls plus similar in other Nuxt/Python projects. Need to handle interpolations carefully — convert `` `/api/${id}` `` to `/api/:id` (the normalize_url_arg already has logic for this in pass_parallel.c). Estimated effort: small.

### Item 2 — Decision-capture process gap

`SELECT COUNT(*) FROM .cortex/decisions.db decisions` = 3, but architectural decisions made in recent sessions weren't captured. Decisions worth capturing retroactively (from this session alone):

- "Extract CLI `resolveInput` into `src/shared/` rather than letting MCP reach into `src/cli/`" — captured in the input-resolver plan but not as a decision row.
- "Probe local `.cortex/graph.db` for project data before using it; fall back to indexer cache" — captured in the QA-followups commit but not as a decision row.
- "Indexer-output unwrapper lives in `src/cli/`, not in the indexer or as a shared module — only the CLI is a human consumer of the raw output" — implicit in the QA pass.
- "`cortex` CLI launcher exports `CORTEX_REPO_ROOT`; modules resolve paths from that, not from `process.cwd()`" — surfaced by the Opus review.

This same gap was noted in the older root HANDOFF.md too and hasn't been addressed. Open question: hook-based prompt at commit time? `/review-recent-commits` skill? Manual capture pass? Not investigated yet.

### Item 3 — Polish items from the recent QA pass + 2026-05-26 field report

Tracked but deliberately deferred:
- **`get_code_snippet` source extraction has no unit-test coverage** ([src/cli/commands/code.ts:99-123](src/cli/commands/code.ts#L99-L123)) — the `.source` field extraction silently falls back to dumping JSON if the indexer's payload shape ever changes. Add a unit test that mocks `runIndexer` and asserts only the source is written.
- **`router.ts` `--flag value` form eats positionals.** `cortex install --uninstall foo` parses `uninstall` as `"foo"` (truthy string), then the boolean check fails. Either special-case known-boolean flags or document `--uninstall` as bare-only.
- **`decision promote` is unwired** — throws `UsageError` pointing at a bare `cortex-indexer cli` invocation. Either wire it or remove from the help table.
- **`graph sql '<sql>'` is a footgun** — no read-only enforcement. Document or prepend `--readonly` to sqlite3 args.
- **`tests/cli/context.test.ts:32`** — writes an empty file that the new read-only `dbHasProjectData` probe will happily open. Test passes by accident; should write valid sqlite header or skip the probe path explicitly.
- **`pass_route_nodes.c`** comment claims governance edges aren't transactional; technically true for single-statement writes (atomic at SQLite level) but misleading for multi-statement bulk operations. Wrap in `db.transaction()` if you ever do bulk link writes.

From the 2026-05-26 field report (after the three small items already shipped above):
- **Preserve file extension in `file` node qualified-names** — file QNs end in `__file__` with no extension, so `WHERE qualified_name CONTAINS ".vue"` returns 0 even when 99 Vue file nodes exist. Either preserve the extension (small schema change, careful with downstream consumers) or document this convention prominently in `cortex help qualified-names`. Either way kills a whole class of agent false negatives.
- **Recognize `defineStore` factory patterns** (Pinia) — direct `defineStore` calls already produce `use*Store` variable nodes. The factory pattern `createXxxStore(config)` that internally returns `defineStore(...)` produces only the factory function as a node, not the derived stores. Medium effort — needs to track call-site → defineStore returns through factory wrappers.
- **Verify `governs` linking and `FILE_CHANGES_WITH` actually work against `.vue` file paths** — the field report claimed these were broken on the basis of the (wrong) "no .vue file nodes" diagnosis. Should be a verify-only task; if it works, just document.
- **Investigate `<template>` references between components in `.vue` files** — `<ACardFooter />` template usage doesn't appear to create CALLS or USES edges. Unverified by the report; would close the last Vue-coverage gap.

### Item 4 — Open items from the older Phase 4 handoff that are still real

These survived multiple sessions; not deliberately ignored, just unprioritized:
- **2D viewer color/shape regression for granular kinds** post-Phase 4 (`class`, `method`, `interface`, `enum` render with default styling).
- **`anim.nodes` grows unbounded** in the viewer; `setHover` adds but `remove_node` doesn't evict.
- **`seen` Set in `src/viewer/websocket.js` unbounded** — ~26MB at 1M events.
- **WS reconnect drift** — mutations during outage aren't replayed.
- **Lean grammar parser ~100MB** at `internal/indexer/internal/cbm/vendored/grammars/lean/parser.c` flagged on push.

## What's in main right now

Top commits (8 ahead of `origin/main` at handoff-update time, not yet pushed):

```
61f1861 Merge branch 'fix/shared/resolve-input-file-symbol'   (Wave 2: editor-jump form)
4f89e77 fix(shared/resolve-input): accept file:symbol editor-jump form
2a82a76 Merge branch 'fix/cli/index-changes-resolution'       (Wave 2: index changes bug)
bd467cc fix(cli): index changes uses 'project' arg, not 'repo_path'
fcde0e1 Merge branch 'fix/indexer/lockfile-route-noise'       (Wave 2: lockfile routes)
d85a746 fix(indexer): skip lockfile basenames in infra route extraction
44263da docs(handoff): record Bug 1+2 shipped, refine Bug 3 diagnosis
fe92f5c Merge branch 'fix/indexer/url-arg-discriminator'      (Bug 2: cortex 76→25 HTTP_CALLS)
1949eab fix(indexer): reject filesystem-path strings in URL-arg HTTP_CALLS detection
5700759 Merge branch 'fix/indexer/nuxt-fetch-registry'        (Bug 1: anthill 0→23 HTTP_CALLS)
945056f fix(indexer): emit HTTP_CALLS for unresolved global HTTP callees
ed90450 docs(handoff): refresh for 2026-05-25 — CLI, MCP robustness, input resolver shipped
```

Eval baselines: 3 reports under [evals/reports/](evals/reports/), latest `2026-05-24_20-54`.

## How to start the next session

```bash
cd ~/Development/cortex
git pull --ff-only origin main          # should already be in sync
npm install                              # postinstall builds bin/cortex-indexer + installs cortex CLI

# Sanity smoke
cortex tour                              # confirm CLI works from cortex repo
npm test                                 # expect 487 passed / 1 skipped / 1 documented flake
```

### If picking up the template-literal follow-up (smallest remaining piece):

Goal: add `template_string` (TS) to `is_string_like()` in [extract_calls.c:40-44](internal/indexer/extract/extract_calls.c#L40-L44) so calls like `` $fetch(`/api/${id}`) `` get their URL captured. The URL normalizer in pass_parallel.c already handles `${...}` → `:varname` (see `normalize_url_arg`), so the rest of the pipeline is ready.

```bash
# Reindex anthill-cloud first to baseline:
cortex index delete Users-rka-Development-anthill-cloud
cd ~/Development/anthill-cloud && /Users/rka/Development/cortex/bin/cortex-indexer cli index_repository '{"repo_path":"/Users/rka/Development/anthill-cloud"}'
sqlite3 ~/.cache/cortex-indexer/Users-rka-Development-anthill-cloud.db \
  "SELECT COUNT(*) FROM edges WHERE relation='HTTP_CALLS'"   # expect 23 baseline
# After fix, expect ~70 (the ~47 template-literal $fetch + the 23 plain-string ones)
```

After is_string_like is widened, also ensure the strip_and_validate_string_arg path handles backtick stripping correctly — it currently checks `text[0] == '"' || text[0] == '\''` only.

### If picking up Bug 3 (HANDLES, Nuxt file-based routing):

This needs its own focused session. Read order: [pass_route_nodes.c](internal/indexer/src/pipeline/pass_route_nodes.c) (the emission logic — already correct), then [extract_defs.c:780-810](internal/indexer/extract/extract_defs.c#L780-L810) (where decorator routes get extracted), then look at how Nuxt routes are structured:

```bash
# Trace a real Nuxt route file
ls ~/Development/anthill-cloud/apps/activator/server/api/orgs/
# index.get.ts, index.post.ts, [id].get.ts, [id].patch.ts, …

# The file's default export is the handler — find it in the index:
sqlite3 ~/.cache/cortex-indexer/Users-rka-Development-anthill-cloud.db \
  "SELECT id, kind, name, qualified_name FROM nodes WHERE file_path = 'apps/activator/server/api/orgs/index.get.ts'"
# Currently: only file + module nodes. The handler arrow function inside defineEventHandler isn't captured as a Function.
```

Suggested approach: add a new pass (or extend pass_definitions) that:
1. Walks `result->defs` and for each module-level `export default defineEventHandler(...)`, captures the inner arrow function as a Function node.
2. Computes `route_path` from the file path (translate `[id]` → `:id`, strip `.get.ts` etc.).
3. Sets `route_method` from the filename suffix (`.get.ts` → GET).

Existing pass_route_nodes.c will then pick those functions up via `ensure_decorator_routes` and emit HANDLES.

### If picking up Item 2 (decision capture):

This is a meta-improvement, not feature work. Probably needs a brainstorm before any code lands. Open with:

```
/brainstorm decision-capture process gap. SELECT COUNT(*) FROM decisions = 3 after many architectural sessions. The CLAUDE.md guidance to "capture a decision proactively" isn't actually producing decisions. Investigate hook-based prompts, mid-session triggers, or a /review-recent-commits skill.
```

### If picking up an Item 3 polish item:

Most are small enough to do without ceremony. Use the file:line refs in this doc.

## Quick reference — current modules added this session

| File | What it does |
|---|---|
| [bin/cortex](bin/cortex) | Launcher; resolves symlinks; exports `CORTEX_REPO_ROOT`; prefers `dist/cli/main.js` |
| [src/cli/main.ts](src/cli/main.ts) | argv dispatch + meta (`--help`, `--version`, `tour`, `install`) |
| [src/cli/router.ts](src/cli/router.ts) | parseArgv + Levenshtein "did you mean" |
| [src/cli/context.ts](src/cli/context.ts) | Detects indexed/unindexed-repo/no-project; resolves graphDbPath with read-only probe |
| [src/cli/paths.ts](src/cli/paths.ts) | `repoRoot()` from `CORTEX_REPO_ROOT` env or import.meta.url fallback |
| [src/cli/format.ts](src/cli/format.ts) | `formatRows` + `writeRows(rows, fmt, emptyMessage)` |
| [src/cli/indexer-output.ts](src/cli/indexer-output.ts) | `unwrapIndexerResult` + `renderIndexerResult` (strips MCP envelope + log lines, surfaces isError) |
| [src/cli/install.ts](src/cli/install.ts) | symlink → ~/.local/bin/cortex, fall back to shell alias |
| [src/cli/tour.ts](src/cli/tour.ts) | Context-aware tour; pickSampleFunction filters by current project |
| [src/cli/commands/code.ts](src/cli/commands/code.ts) | find / search / show / where / calls / arch / schema |
| [src/cli/commands/decision.ts](src/cli/commands/decision.ts) | list / show / why / create / update / delete / link / propose / supersede |
| [src/cli/commands/graph.ts](src/cli/commands/graph.ts) | query (Cypher) / sql (raw SQLite) |
| [src/cli/commands/index.ts](src/cli/commands/index.ts) | run / status / changes / list / delete |
| [src/cli/commands/eval.ts](src/cli/commands/eval.ts) | Delegates to `evals/src/cli.ts` |
| [src/shared/resolve-input.ts](src/shared/resolve-input.ts) | `resolveInput(input, project, dbPath): ResolveResult` — tagged single/multi/none |
| [src/mcp-server/tools/decision-input-validation.ts](src/mcp-server/tools/decision-input-validation.ts) | `validateDecisionFields` — rejects XML marshalling leakage |

## Project conventions (recap, unchanged)

- **Branch first.** Never commit to `main`. Naming: `feature/<scope>/<desc>` or `fix/<scope>/<desc>`. Scope ∈ `{component, page, api, store, config, layout, css, db, cli, mcp, decisions, ...}`.
- **Atomic commits.** Format: `<type>(<scope>): <description>`.
- **Merge protocol.** `git merge --no-ff <branch>` then `git branch -d <branch>`. Push only when explicitly asked.
- **Gates.** Visual QA (Gate 0) for UI; `/review` (Gate 1) before marking tasks complete; `qa` agent (Gate 2) before merge.
- **Decision tools.** Prefer `search_decisions` → `create_decision` / `propose_decision` for any non-trivial choice. (See Item 2 — practice is lagging this rule.)

## Historical handoffs (for cross-reference)

- [docs/HANDOFF-2026-05-24.md](docs/HANDOFF-2026-05-24.md) — 2026-05-24 (one session before this one). Covered the eval harness work and the field-assessment investigation.
- The earlier 2026-05-10 root HANDOFF.md (now replaced by this file) covered the CBM absorption Phase 1-4 work. Phases 6-9 also shipped (see tags `phase-6-mcp-strip` through `phase-9-c-rename`) — CBM absorption is complete.
