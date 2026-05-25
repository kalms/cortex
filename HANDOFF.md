# Cortex — Session Handoff (2026-05-25)

## TL;DR

Three back-to-back workstreams shipped to `main` this session: the user-friendly `cortex` CLI, an MCP tool robustness pass, and an MCP-side input resolver that lets agentic callers use the same file-path/bare-name shapes the CLI does. A second independent review by Opus surfaced five real issues that the in-flight reviews missed; all fixed and merged.

Next-up is **HTTP_CALLS / HANDLES extraction**, which on investigation turned out to be three separate indexer-C bugs rather than the "biggest single feature on the table" the older handoffs framed it as. Direction note: that work needs its own focused C-indexer session.

- **Branch:** `main`, pushed to `origin/main` at `e13982d`
- **Tests:** 79 files / 487 passed / 1 skipped / 1 failed
  - The 1 failure is the long-documented Python-venv timing flake in `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts:62` — unrelated to recent work
- **Build:** `bin/cortex-indexer` clean, `npx tsc --noEmit` clean
- **`cortex` CLI:** installed at `~/.local/bin/cortex` (symlinked to `bin/cortex` in this repo)

## What shipped this session

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

### Item 1 — HTTP_CALLS / HANDLES extraction gaps

The earlier handoff framed this as "biggest single feature, no spec, indexer C work, ~4-8 weeks." Investigation at the end of this session changed that framing — it's **three separate bugs in already-implemented infrastructure**, each independently fixable.

Diagnostic counts taken this session (`~/.cache/cortex-indexer/*.db`):

| Project | HTTP_CALLS | HANDLES | route nodes |
|---|---:|---:|---:|
| cortex | 76 (mostly false-positive — see below) | 0 | 41 |
| anthill-cloud | **0** | 0 | 170 |
| trpc | 5 | 0 | 35 |
| nuxt/ui | 2 | 0 | 130 |
| vueuse | 2 | 0 | 14 |
| pallets/click | 5 | 0 | 16 |

The three bugs:

1. **anthill-cloud has zero HTTP_CALLS despite 50+ real `$fetch("/api/...")` calls.** Nuxt's `$fetch`, `useFetch`, `useLazyFetch`, and native browser `fetch` aren't in the http_libraries registry at [internal/indexer/extract/service_patterns.c](internal/indexer/extract/service_patterns.c). Smallest fix: add them. Estimated effort: small — one C-file edit, rebuild via `scripts/build-indexer.sh`, reindex.

2. **cortex has 76 false-positive HTTP_CALLS.** Sample edge: `url_path: "/src/main.go", via: "arg_url"`. The URL detection logic in [internal/indexer/src/pipeline/pass_calls.c](internal/indexer/src/pipeline/pass_calls.c) treats any first-string-arg starting with `/` as a URL. Needs a discriminator (e.g., reject if extension suggests source file: `.go`, `.ts`, `.c`, `.py`, …). Estimated effort: small.

3. **HANDLES = 0 universally** across every project — even cortex's 41 route nodes have zero HANDLES. The pipeline pass exists at [internal/indexer/src/pipeline/pass_route_nodes.c](internal/indexer/src/pipeline/pass_route_nodes.c) ("ensure_decorator_routes" + "match_infra_routes") but emits nothing in any indexed project. Either route-decorator extraction isn't populating the `route_path` property on function nodes, or `match_one_infra_route` is silently failing. Estimated effort: medium — requires reading the pass thoroughly and tracing why no edges are produced.

**Why this stalled out at the end of this session:** these are C-indexer changes with a separate build cycle (`scripts/build-indexer.sh` → `make -f Makefile.indexer`), separate test framework ([internal/indexer/tests/](internal/indexer/tests/), 42 C test files), and each fix needs reindexing real corpora to verify. None of the TS/Node tooling used for this session's other workstreams applies.

**Suggested handling next session:**
- Start with bug #1 (Nuxt fetch registry expansion) — cheapest, validates the C-side dev loop is working before attempting the harder ones.
- Then bug #2 (false-positive discriminator) — also small.
- Bug #3 (HANDLES universal zero) — own session; read `pass_route_nodes.c` carefully first, possibly trace with a real fixture before writing changes.

### Item 2 — Decision-capture process gap

`SELECT COUNT(*) FROM .cortex/decisions.db decisions` = 3, but architectural decisions made in recent sessions weren't captured. Decisions worth capturing retroactively (from this session alone):

- "Extract CLI `resolveInput` into `src/shared/` rather than letting MCP reach into `src/cli/`" — captured in the input-resolver plan but not as a decision row.
- "Probe local `.cortex/graph.db` for project data before using it; fall back to indexer cache" — captured in the QA-followups commit but not as a decision row.
- "Indexer-output unwrapper lives in `src/cli/`, not in the indexer or as a shared module — only the CLI is a human consumer of the raw output" — implicit in the QA pass.
- "`cortex` CLI launcher exports `CORTEX_REPO_ROOT`; modules resolve paths from that, not from `process.cwd()`" — surfaced by the Opus review.

This same gap was noted in the older root HANDOFF.md too and hasn't been addressed. Open question: hook-based prompt at commit time? `/review-recent-commits` skill? Manual capture pass? Not investigated yet.

### Item 3 — Polish items from the recent QA pass

Tracked but deliberately deferred:
- **`get_code_snippet` source extraction has no unit-test coverage** ([src/cli/commands/code.ts:99-123](src/cli/commands/code.ts#L99-L123)) — the `.source` field extraction silently falls back to dumping JSON if the indexer's payload shape ever changes. Add a unit test that mocks `runIndexer` and asserts only the source is written.
- **`router.ts` `--flag value` form eats positionals.** `cortex install --uninstall foo` parses `uninstall` as `"foo"` (truthy string), then the boolean check fails. Either special-case known-boolean flags or document `--uninstall` as bare-only.
- **`decision promote` is unwired** — throws `UsageError` pointing at a bare `cortex-indexer cli` invocation. Either wire it or remove from the help table.
- **`graph sql '<sql>'` is a footgun** — no read-only enforcement. Document or prepend `--readonly` to sqlite3 args.
- **`tests/cli/context.test.ts:32`** — writes an empty file that the new read-only `dbHasProjectData` probe will happily open. Test passes by accident; should write valid sqlite header or skip the probe path explicitly.
- **`pass_route_nodes.c`** comment claims governance edges aren't transactional; technically true for single-statement writes (atomic at SQLite level) but misleading for multi-statement bulk operations. Wrap in `db.transaction()` if you ever do bulk link writes.

### Item 4 — Open items from the older Phase 4 handoff that are still real

These survived multiple sessions; not deliberately ignored, just unprioritized:
- **2D viewer color/shape regression for granular kinds** post-Phase 4 (`class`, `method`, `interface`, `enum` render with default styling).
- **`anim.nodes` grows unbounded** in the viewer; `setHover` adds but `remove_node` doesn't evict.
- **`seen` Set in `src/viewer/websocket.js` unbounded** — ~26MB at 1M events.
- **WS reconnect drift** — mutations during outage aren't replayed.
- **Lean grammar parser ~100MB** at `internal/indexer/internal/cbm/vendored/grammars/lean/parser.c` flagged on push.

## What's in main right now

Top 10 commits:

```
e13982d Merge branch 'feature/mcp/input-resolver'      (queue item complete: MCP input resolver)
1b9f31c feat(mcp): why_was_this_built accepts bare symbol names
c29172a feat(mcp): trace_path accepts file paths and bare names
62b524f feat(mcp): get_code_snippet accepts raw file paths and bare names
e6efacc refactor(resolve-input): extract heuristic into src/shared
e4c4010 Merge branch 'fix/cli/qa-followups-2'          (queue item complete: second QA pass)
606fc93 fix(cli): second QA pass — repo-root resolution, install hardening, db probe safety
4519415 Merge branch 'feature/mcp/tool-robustness'     (queue item complete: MCP robustness)
271ef01 feat(mcp): governs on update_decision
…
d3159c4 Merge branch 'feature/cli/user-friendly'       (queue item complete: user-friendly CLI)
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

### If picking up HTTP_CALLS / HANDLES (Item 1):

Don't dive into the C indexer cold. Start with diagnostics to confirm the bug list is still current, then pick the smallest:

```bash
# Re-confirm the bug list before touching code
for db in ~/.cache/cortex-indexer/*.db; do
  name=$(basename "$db" .db)
  http=$(sqlite3 "$db" "SELECT COUNT(*) FROM edges WHERE relation = 'HTTP_CALLS'" 2>/dev/null)
  handles=$(sqlite3 "$db" "SELECT COUNT(*) FROM edges WHERE relation = 'HANDLES'" 2>/dev/null)
  echo "http=$http handles=$handles  $name"
done | sort -k1,1 -k2,2 -r | head -10

# For Bug 1 (Nuxt fetch registry expansion):
$EDITOR internal/indexer/extract/service_patterns.c     # add $fetch / useFetch / useLazyFetch to http_libraries[]
bash scripts/build-indexer.sh                            # rebuild bin/cortex-indexer
cortex index .                                           # reindex cortex
cd ~/Development/anthill-cloud && cortex index .         # reindex anthill-cloud
sqlite3 ~/.cache/cortex-indexer/Users-rka-Development-anthill-cloud.db \
  "SELECT COUNT(*) FROM edges WHERE relation = 'HTTP_CALLS'"  # expect > 0
```

For Bug 2 / Bug 3, read the spec section in this doc and the listed C files before writing changes. Both are smaller than they look but deserve a fresh session that's set up for C-side debugging (gdb/lldb, the existing C test framework).

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
