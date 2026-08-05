# Changelog

All notable changes to Cortex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and Cortex aims for
[Semantic Versioning](https://semver.org/).

> **Note — 2026-06-23: repository cleanup & version renumber.** The project
> history was cleaned up and the release line renumbered to a tidy, monotonic
> range that better fits the release cadence going forward — the former `0.3.x`
> series is now `0.8.x` and `0.4.0` is now `0.9.0` (the release current at the
> time of the renumber; the top entry below is always the current release).
> CHANGELOG, version metadata, tags/releases, and commit history were all
> brought onto the new scheme.
>
> **`cortex-indexer` is a separate project with its own versioning and is
> deliberately untouched by this.** Its pinned `CORTEX_INDEXER_VERSION`
> (`v0.3.0`) refers to the standalone
> [`ruevu/cortex-indexer`](https://github.com/ruevu/cortex-indexer) release and
> stays as-is — it is not part of this repository's version line.

## [1.9.0] — 2026-08-05

Transport release: the sidecar now serves its MCP tool surface over HTTP, and
the sidecar tarball carries the plugin assets Mesh injects into its spawned
agents (mesh spec `2026-08-04-agent-cortex-injection-design.md`).

### Added

- **Streamable-HTTP `/mcp` endpoint on the viewer server.** The full MCP tool
  surface is now reachable over HTTP: stateless (a fresh server + transport
  per POST — tools are `repo_path`-parameterized per call), POST-only, and
  auth-gated exactly like `/api/*` when `CORTEX_API_TOKEN` is set. The stdio
  transport is unchanged; the sidecar entry serves both.
- **Sidecar tarball ships the plugin assets.** `skills/`, `hooks/`, and a
  staged `plugin.json` named `mesh-cortex` that declares skills + hooks only —
  MCP transport is injected by the host over HTTP, so the variant deliberately
  carries no `mcpServers`. The tarball smoke test now proves `/mcp` answers
  `initialize` from the staged tree and asserts the plugin assets' shape.
- **Guard test for the presence-hook matchers**: `mcp__.*cortex.*__…` must keep
  matching `mcp__mesh-cortex__*` tool names — Mesh's injected server name makes
  that matcher load-bearing.

### Fixed

- **`RepoContextResolver` disposal.** `createServer()` now wires the MCP
  server's `onclose` to `resolver.shutdown()`, so per-request servers (the
  `/mcp` stateless path) release their pooled `better-sqlite3` handles instead
  of leaking one per `repo_path` tool call. Process-lifetime stdio behavior is
  unchanged.
- **`/mcp` handler rejection guard.** `server.connect` / `handleRequest`
  failures answer a JSON-RPC 500 instead of becoming an unhandled rejection
  that would take down the sidecar.

## [1.8.2] — 2026-08-03

Packaging release: makes Cortex embeddable as the Mesh app's sidecar. No
tool or API behavior changes.

### Added

- **`sidecar-tarball` release workflow.** On every release publish (or manual
  dispatch for an existing tag), CI builds and uploads
  `cortex-sidecar-<version>-darwin-arm64.tar.gz` (+ `.sha256`) — a
  self-contained sidecar tree (`dist/`, viewer assets, production
  `node_modules`, and the prebuilt `cortex-indexer` at `bin/`) that downstream
  apps (Mesh) pin by version + checksum and embed. The tarball is smoke-tested
  (extract → serve → healthy) before upload; the tar step ships an explicit
  five-entry allowlist so runtime state can never leak into the artifact.

### Fixed

- **`d3-force` was a devDependency but is imported at runtime** (viewer API →
  frame layout) — a production-only install could never serve. Moved to
  `dependencies`; caught by the sidecar smoke test.
- **`better-sqlite3` bumped 11 → 12.** 11.x cannot compile against Electron
  43's V8, which blocked Mesh's Electron-ABI rebuild of the embedded sidecar;
  12.11.1 is drop-in (full suite green) and matches what Mesh itself ships.

## [1.8.1] — 2026-07-29

The last items from the 2026-06-12 agentic-experience field report, each
re-verified against the current codebase before implementation.

### Added

- **`changes_since` MCP tool (field-report P8, lean v1).** The temporal
  layer: `since` accepts a git ref, an ISO date, or a **decision id**
  (`D-xxxx` opens the window at that decision's capture time — "what moved
  since D-x was decided, and does it still hold?"). Returns a bounded commit
  window (`scope` path-prefix filter, `max_commits` cap + `truncated` flag),
  the changed files, the graph nodes they define, and the decision layer in
  the window: decisions created, reconciled, and governing the changed code
  (with reconciliation display state). Computed TS-side like the hotspots
  aspect — no indexer round-trip. An unresolvable `since` is
  `malformed_input`, never a silent unbounded window.
- **Cross-repo decision search (field-report P5).**
  `decision({action:"search", cross_repo:true})` fans out over every repo
  the server knows (pool + master registry) and returns hits grouped per
  repo — addressed repo first — plus a `skipped` list for registry rows that
  no longer resolve. Results deliberately stay grouped (FTS5 rank values are
  not comparable across databases); `scope` cannot combine with
  `cross_repo`. CLI parity: `cortex decision list --cross-repo [--query=…]`
  prints flat rows with a `repo` column (addressed repo first, unreachable
  registry rows noted on stderr) — deliberately lighter than the MCP path:
  it opens only each repo's decisions sidecar, no graph DB or indexed-repo
  requirement.
- **Branch-scoped decision candidates (field-report P4).**
  `decision({action:"candidates", base})` / `cortex decision candidates
  --base=<ref>` scope the manifest to `base..HEAD` commit clusters and
  markdown touched in `base...HEAD` — turning the cold-start seed machinery
  into the warm-path drafting input. Invalid refs error
  (`malformed_input` / `UsageError`) instead of silently returning the
  whole-history manifest.

### Changed

- **suggest-capture hook is now a drafting trigger on merges.** A local
  merge commit (HEAD^2 present, e.g. after `git merge`) turns the
  post-commit nudge into an active warm-path instruction: run branch-scoped
  candidates (`base:"HEAD^1"`), propose `author:"cortex:draft"` drafts
  (proposed-only per `D-vz80`), and present them for one-tap ratification
  via `decision({action:"promote"})`. A `gh pr merge` (remote merge — local
  HEAD unmoved, squash/rebase merges never create a HEAD^2) gets its own
  sync-then-draft instruction anchored to the pre-merge `origin/<default>`
  sha. Ordinary commits keep the original reminder.

### Closed without code (field-report P7 b/c)

- **Tool-description tightening (P7b)** — measured as already done by the
  1.0.0 consolidation (every tool description is a one-liner deferring to
  `docs/mcp-tools.md`). **Lazy-loading the schema long tail (P7c)** —
  obsoleted upstream: Claude Code now defers MCP tool schemas host-side
  (ToolSearch), and no MCP server-side mechanism exists to influence it.
  Todo `T-v9w3` cancelled with rationale.

## [1.8.0] — 2026-07-25

### Added

- **`show` MCP tool — durable stories (show-your-work slice 2b).** New verbs
  `story | advance | get | list | close | delete` beside 2a's `focus`. A
  story is an agent-curated walkthrough — ordered steps of caption + refs —
  minted atomically as an `S-xxxx` entity in the decisions.db sidecar
  (durable across reindex, shared by worktrees/clones), returned with a
  `viewer_url` deep link. `advance` pages every live viewer tab via the 2a
  delivery path (`POST /api/show-advance` → `show.advance` event, live-only,
  reaped with the `show.%` sweep). Steps are 1-based everywhere.
- **Viewer story mode.** Entry via `?story=S-xxxx` deep link, the ⌘K
  palette's new stories group, or a live advance — the viewer never
  auto-opens a story on load. Each step drives the held spotlight (lit refs,
  dimmed rest), animates a camera fit to the step's frames, and pulses
  `emphasis_edges` between frames. Bottom-center story card with title,
  relative age, caption, `‹ n/m ›` paging (arrow keys work), and Esc chain
  placement palette → drawer → story → spotlight → frame focus. **User-wins
  pacing:** a live advance moves the view only while you're following; if
  you paged away, an "agent is on step N →" chip appears and one click
  re-syncs. Decision `D-wn74`.
- **Clickable ref chips on caption cards (`T-bty4`).** Both the focus
  spotlight card and the story card now render their resolved refs as chips —
  frame chips move the camera, decision/todo chips open the drawer — without
  clearing the held spotlight.
- **HTTP contract:** `GET /api/stories`, `GET /api/stories/:id`,
  `POST /api/show-advance` (Zod schemas + generated docs).
- **Skills:** `show-your-work` gains story-authoring guidance;
  `explain-architecture` now always emits its explanation as an
  already-closed story and hands back the `viewer_url`.

### Fixed

- **`T-a1kg`:** the boot-time indexed-project lookup now canonicalizes the
  launch directory, so a server started from a linked worktree resolves its
  project instead of showing "(no projects)".
- **`T-7e5b`:** `show` dispatcher hardening — per-element ref bounds matching
  the endpoint schema, and a default arm for unknown actions.

## [1.7.0] — 2026-07-24

### Added

- **`show` MCP tool — held focus spotlight (show-your-work slice 2a).** A
  `focus` verb holds a spotlight on refs (paths, qualified names, `D-`/`T-`
  ids) in the live viewer: the targeted frames/decisions/todos stay lit while
  everything else dims, with a caption card describing the held state.
  Clears on `Esc`, on a replacing `focus` call, or on `refs: []`. Delivery is
  live-only (no persistence) and gated to the canonical repo, so a stray
  worktree/clone can't paint someone else's viewer. Decision `D-aqt6`
  (spotlight is held presentation state delivered via the existing presence
  transport — explanations can't ride decaying telemetry).
- **Skills:** new `show-your-work` skill (drives the `show` tool while
  narrating a change); `explain-architecture` gains a "spotlight while you
  explain" step so architecture walkthroughs highlight the relevant frames
  live instead of describing them blind.

## [1.6.0] — 2026-07-23

### Added

- **Live presence in the viewer** (show-your-work slice 1): a `PostToolUse`
  hook streams agent activity (files studied/edited, symbols traced,
  decisions consulted) to `POST /api/presence`; sessions render as colored
  avatars traversing the frame map with session-colored heat. Multi-session
  aware (worktrees canonicalize to one project); layers-menu toggle; 30-min
  backfill for late-joining tabs; `presence.activity` events reaped after
  24 h. Epoch-guard hardening on the viewer's frame/backfill/live loaders
  closes a boot-vs-backfill race so late-arriving frames can't stomp a
  since-superseded load. Opt out: `CORTEX_PRESENCE=0`. Decision: `D-zwrt`.
- **Presence visual fidelity — ported 1:1 from the refined v5 prototype.**
  - _Avatar strip + presence-tip._ The toolbar roster is now the prototype
    `.presence` strip: 28px overlapping session-colored avatar rings with the
    claude provider glyph, hover-lift, and a `presence-tip` showing `@handle`
    (workspace) + provider line. Idle sessions dim to neutral grey.
  - _Edge-riding synapses._ A traversal pulse now rides the **actual drawn
    inter-frame edge**'s geometry when one exists between the segment's frame
    pair (prototype `drawSynapses`), falling back to center-to-center only
    when no edge is drawn.
  - _Dot-level cursor approach._ When a session's ref resolves to a file whose
    dot is currently drawn (LOD budget + culling), the cursor targets that
    **dot**, not the frame center; it falls back to frame center when dots are
    shed at low zoom. The cursor itself is the prototype's breathing dot with
    a post-arrival `colorAmount` fade (~3.5 s) from hue to neutral ink.
  - _Two-tier heat (fixes the wide-border storm)._ Presence heat splits into a
    prominent **FLASH** tier applied on arrival (wide session-colored border,
    6 s decay — only the frame a session is on / just reached) and a faint
    **TRAIL** tier applied at event time (thin outline, 90 s decay — the
    reload-backfill trail). Backfill / reduced-motion applies TRAIL only, so a
    reload never lights every touched frame's wide border at once.
## [1.5.1] — 2026-07-12

### Added

- **Viewer camera — pan & zoom.** The graph canvas gains a camera composed as
  a pure post-transform on the fit-to-content view (identity renders exactly
  the previous scene): cursor-anchored wheel zoom (up to 4×), drag-to-pan with
  a 4px threshold that keeps click/dblclick/hover semantics intact, dblclick
  on empty canvas to animate back to fit, and an elastic below-fit overscroll
  that springs home. New engine API: `getCamera()` / `setCamera()` /
  `callbacks.onCameraChange`.
- **Screen-area LOD.** Per-frame dot budgets driven by on-screen frame area
  (`canvas/lod.js`, ~the old 22-dot look at fit on normal frames, fewer on
  squeezed ones — the dense-project fit view finally breathes; all members
  reveal as you zoom), with a deterministic scattered reveal order, per-file
  labels past 64px dot spacing, inter-frame edges receding at high zoom, and
  sub-frame detail shedding during overscroll.
- **Viewport culling + per-tick geometry cache** — large graphs (activator)
  hold ~120fps at fit and deep zoom.
- **Embeddable engine unit.** `adaptProjectData` moved into `canvas/adapt.js`
  (re-exported from `app/data.ts`), and `createEngine` accepts optional
  `isLight` and `storagePrefix` — the `canvas/` modules +
  `app/{entity-store,ws-client}.js` now form a dependency-free unit an
  embedder (Mesh) can vendor. Documented in
  `docs/architecture/viewer-sync-engine.md`.

### Changed

- Frame-member adaptation no longer pre-slices to 22 nodes (`MAX_FRAME_NODES`
  removed); the LOD budget decides draw-time counts.

## [1.5.0] — 2026-07-10

### Added

- **Self-maintaining storage garbage collection.** Three complementary,
  `CORTEX_GC`-gated passes (default on) reap what's provably regenerable and
  archive — never delete — what might be irreplaceable user data:
  - **Reap-after-publish** — a successful `cortex index` / `index_repository`
    now deletes its just-consumed `~/.cache/cortex-indexer/<slug>.db` slug
    cache, guarded by `isReapableSlugCache` (only when the repo's canonical
    `.cortex/db` provably has ≥1 node, or the repo path is gone).
  - **SessionStart current-repo sweep** — the SessionStart hook now runs
    `cortex index sweep`, clearing this repo's slug cache plus stale
    `db.stage-*`/`tmp-ctx_incr_*` staging leftovers (24h age guard).
  - **`cortex doctor` all-stores audit** — `--fix` now reaps regenerable
    copies (slug caches, stale staging, empty `~/.cortex/<repoId>` decision
    dirs) across the whole machine and **archives** (moves, never deletes)
    content-bearing orphan decision dirs to `~/.cortex/_archive/<repoId>/`.
  - New `src/db/store-paths.ts` (centralized cache/store path derivation) and
    `src/db/store-gc.ts` / `src/db/store-gc-audit.ts` (classification
    predicates + reap/archive/sweep + the all-stores audit) back all three.

### Changed

- **`cortex index list`/`delete` now read the TS `Registry`**, not the
  indexer's cache-dir scan — the same authoritative source `cortex doctor`
  and the MCP `list_projects` tool already use, so the CLI no longer surfaces
  phantom `.tmp` corpus entries or diverges from what's actually registered.

### Fixed

- **Eval/corpus indexing leaked slug caches and empty `~/.cortex/<repoId>`
  decision dirs** into the real `~/.cache/cortex-indexer` and `~/.cortex` on
  every ephemeral-clone run. Eval/corpus indexing now runs under a scratch
  `CTX_CACHE_DIR`/`CORTEX_HOME` (`evalIndexerEnv`), stopping the leak at the
  source; the `cortex doctor` audit is the backstop for anything that still
  slips through.

## [1.4.8] — 2026-07-08

### Fixed

- **Plugin MCP server never launched for plugin-install users (T-mskp).** The
  bundled `.mcp.json` wired the server with `${CLAUDE_PLUGIN_ROOT:-$PWD}`, but
  Claude Code neither exports `CLAUDE_PLUGIN_ROOT` into the MCP child's
  environment nor substitutes the defaulted form — it only string-substitutes
  the **exact bare `${CLAUDE_PLUGIN_ROOT}` token**. The expression collapsed to
  `$PWD`, so in any repo other than the cortex checkout the server exec'd a
  nonexistent `<cwd>/bin/cortex-mcp.sh` and died with `MCP error -32000:
  Connection closed`. `.mcp.json` now uses the bare token with a bash `$PWD`
  fallback for the repo's own project-scoped load, and `bin/cortex-mcp.sh`
  self-locates the repo root from `BASH_SOURCE` rather than trusting an env
  var. Decision `D-b2wf`.
- **`better-sqlite3` native binding missing in the plugin cache crashed boot.**
  Some plugin install/update paths copy `node_modules` without rebuilding the
  compiled binding for the platform, so `GraphStore`'s `new Database()` threw
  "Could not locate the bindings file" on startup. `bin/cortex-mcp.sh` now runs
  a stderr-only, non-fatal self-heal that probes the binding and rebuilds it
  once if missing.

## [1.4.7] — 2026-07-08

### Added

- **`cortex doctor` CLI command** — audits the project registry and flags
  (dry-run) or removes (`--fix`) orphan entries (subdirs/worktrees that
  collapse elsewhere) and dead entries (paths that no longer exist).
- Genuinely non-git directories are now readable end-to-end — `resolve()`
  serves a registered non-git project's store instead of throwing.

### Fixed

- **Canonical repo rooting (T-119)** — `index_repository` (MCP handler and
  the `cortex index` CLI) and the read resolver `resolve()` now canonicalize
  any path to its worktree-aware git root before deriving name/db/registry.
  A subdirectory or linked worktree passed to indexing no longer creates an
  orphan sub-project rooted at that path — it collapses to the canonical
  repo root. Built on a new `canonicalRepoPath` helper and unifying
  `resolve-path.ts` on `mainWorktreeRoot`.

### Changed

- `resolve()` no longer throws `NotAGitRepoError` for a subdir/worktree (they
  canonicalize to the repo root); a genuinely non-git, unindexed path now
  yields `RepoNotIndexedError` instead of `NotAGitRepoError`.

## [1.4.6] — 2026-07-08

### Fixed

- **`cortex tour` (and CLI index-state detection) misreported canonically-indexed
  repos as unindexed** — `src/cli/context.ts` carried its own graph-DB resolver
  that only probed the two *legacy* locations (`<repo>/.cortex/graph.db` and the
  `~/.cache/cortex-indexer/<slug>.db` cache). Since the canonical store became
  `<repo>/.cortex/db` (D-2ke5), a repo indexed solely there — the norm — resolved
  to no DB, so `loadContext` returned `unindexed-repo` and `cortex tour` told the
  user to index an already-indexed repo (seen in `../cortex-indexer`). The CLI now
  delegates to `resolveGraphDbForRead`, the single graph-path chokepoint the
  MCP/viewer/code-query paths already share (prefers `.cortex/db`, keeps the legacy
  paths as fallback), removing the divergent second resolver.

## [1.4.5] — 2026-07-07

### Fixed

- **Human-readable record timestamps in the viewer** — decision/todo
  `proposedAt` values rendered as raw ISO strings in the records list, the
  decision drawer, and the todo drawer. A shared `formatRelativeDate` helper
  now shows relative time for recent records (`1 min ago`, `2 days ago`) and
  falls back to an absolute clock (`January 21, 2026 2:34pm`) once the gap
  reaches 3 days. The list still sorts on the raw ISO, so newest-first order is
  unchanged; the drawer provenance drops its awkward `on ` prefix
  (`proposed by @agent · 2 days ago`).

## [1.4.4] — 2026-07-04

### Fixed

- **Light-mode contrast for tinted frames** — the 1.4.2 light-mode contrast
  pass only reached the untinted (neutral) draw path; the layer-lens tint
  branches divided the same light-mode boosts back out of their alpha math, so
  with the layer tint on the layer hues washed out to near-invisible on the
  light page. Light mode now keeps the true layer hue and raises the rest-state
  tint alpha to roughly the old hover level (so the resting frame reads the way
  hovering used to). The untinted (neutral) light-mode frame contrast was eased
  down a notch to match — pure-black borders/ink read heavier per unit alpha
  than the lighter coloured hues, so tint-on and tint-off now sit at the same
  perceived weight. Dark-mode tint is unchanged.
- **Uniform toolbar button height** — the viewer's toolbar controls (project
  switcher, search, records, layers, theme toggle) are now a fixed 28px with
  flex-centered content, so the `◐` theme toggle's taller glyph line box no
  longer left it ~2.5px taller than the text buttons.

## [1.4.3] — 2026-07-04

### Fixed

- **Stale graph reads in `query_graph`/`search_graph`/`get_graph_schema`** —
  the pinned indexer is bumped to
  [cortex-indexer v0.3.1](https://github.com/ruevu/cortex-indexer/releases/tag/v0.3.1),
  whose query routing now honors the `CORTEX_DB` env var Cortex sets per call.
  Previously the C binary always read the shared cache copy
  (`~/.cache/cortex-indexer/<project>.db`), which could be arbitrarily stale
  relative to the repo's canonical `.cortex/db` — queries missed anything
  indexed since the cache was last written. Routing falls back to the cache
  when the env-named DB doesn't contain the requested project, so
  cross-project queries keep working.
- **`n.kind` in Cypher queries** — the indexer's Cypher engine now resolves
  `kind` (the documented NodeSchema property and SQL column name) as an alias
  of the internal `label` field, in both `WHERE` and `RETURN`; it previously
  returned an empty string.
- **Double-wrapped bridged-tool responses** — successful `query_graph`/
  `get_architecture`/`ingest_traces`/`detect_changes` calls returned the
  indexer CLI's MCP envelope re-wrapped inside `content[0].text`;
  `invokeIndexer` now unwraps the envelope so clients get the payload
  directly. This was masked because the success path never executed against
  fixture repos before the routing fix; it also silently broke the
  hotspots-aspect merge and the `index_status` cache fallback.

## [1.4.2] — 2026-07-04

### Added

- **Marginalia "View all" overflow** — a focused frame's decision/todo pill
  columns stop at the frame's bottom edge; overflow folds into a `View all (N)`
  pill that opens the records drawer scoped to that frame (new `onViewAll`
  engine callback, `frameId` on the drawer's list view). The scoped list
  header names the frame and offers a `×` to widen back to all records.

### Changed

- **Edges render as the lowest canvas layer** — frames, nodes, and marginalia
  now draw on top of the connectivity web (marginalia could previously be
  painted over by edges). Light-mode edges use a mid gray at reduced alpha
  instead of near-black, so dense hubs no longer dominate the scene.
- **Light-mode frame contrast raised** — frames get a visible soft-gray fill
  (the old white-on-white fill was invisible on the light page), a stronger
  border floor, and brighter labels/counts.
- **UI buttons speak Geist Sans** — toolbar buttons, drawer nav (back/close),
  and records-list tabs switch from Geist Mono to Sans; Mono stays for
  data/ids.
- **Marginalia pills are width-locked** — long summaries truncate at the end
  (the leading `D-…`/`T-…` id stays visible) so pills never run past the
  viewport.
- **Todo marginalia moved to the frame's left edge** — decisions keep the
  right column, todos get their own left column with the same width, overflow,
  and View-all rules.

### Fixed

- **File-governed decisions now surface at load** — decision file-kind
  `governs` refs fold into the frame-governance rollup at data-adapt time
  (mirroring todos), so their marginalia pills, anchors, and promoted frames
  appear on load instead of only after the first live update; the
  frame-scoped records list resolves open AND closed records through one
  shared membership predicate.

## [1.4.1] — 2026-07-04

### Fixed

- **Command palette accessibility** — the palette panel now carries
  `role="dialog"`/`aria-modal` with a labelled input, traps Tab (modified
  combos like Ctrl/Cmd+Tab stay with the browser), keeps focus pinned to the
  search input so arrow/Enter navigation survives clicks in the results area,
  and restores focus to the opener element on close.
- **Project switcher keyboard support** — the previously mouse-only dropdown
  is now a proper select-only combobox (`role="combobox"` +
  `aria-activedescendant`): ArrowUp/Down open and move the highlight,
  Home/End jump, Enter/Space select, Escape closes without disturbing the
  drawer or canvas focus, and clicks on menu chrome no longer strand the
  menu in a keyboard-dead state.

## [1.4.0] — 2026-07-04

### Added

- **⌘K command palette** — a fuzzy-searched jump-to for frames, files,
  symbols, decisions, and todos, plus quick actions (browse records, switch
  project, toggle layers/theme).
- **File knowledge card in the drawer** — opening a file shows its layer,
  owning frame, fan-in/out, co-change neighbors, symbols, and the
  decisions/todos that govern it.
- **Records list** — a `records` drawer view with all/decisions/todos tabs;
  closed todos are muted to the bottom instead of being hidden.
- **Project switcher** showing the project's real display name and root
  path, not just its slug.
- **Drawer navigation stack with back** — in-drawer links (co-change files,
  connections, decision/todo references) push a new view instead of
  replacing the current one, with a back button to retrace.

### Changed

- **Viewer chrome rebuilt as a Vite + React 18 + TypeScript app** (toolbar,
  drawer, palette, project switcher) around the preserved imperative canvas
  rendering engine, wrapped behind a `createEngine(...)` boundary — the
  canvas draw loop is unchanged.
- **Viewer is served from a committed build** (`src/viewer/dist`); CI gates
  bundle freshness (a rebuild must match the committed output) and
  typechecks the viewer app independently of the server build.

## [1.3.2] — 2026-07-03

### Changed

- **Verbosity/layering cleanup from the 2026-07-03 field report** (net −145 LOC,
  behavior-preserving):
  - **MCP tool layer**: single shared `RepoPathField` + `AlternativeSchema`/
    `ProvenanceSchema` (`src/mcp-server/tools/shared-fields.ts`, was copy-pasted
    across 9 modules) and a shared `execAction()` catch/normalize wrapper
    applied to 12 verbatim handlers (handlers with materially different catch
    logic keep their own).
  - **Layering**: the pure viewer-layout math moved out of `src/mcp-server/`
    into `src/frame-extraction/positioning/` (`floating-placement`,
    `frame-layout`, `frame-map`, `frame-pair-rollup`, `frame-flow-rollup`,
    `aggregate-ties`, `aggregate-positioning`) — consumed only by the HTTP
    viewer routes and depending entirely on frame-extraction internals.
  - **Entity stores**: one canonical `toDecision` mapper (`src/decisions/map.ts`,
    was three byte-identical copies); `classifyTarget()` passthrough inlined.

### Removed

- Dead code: `src/connectors/types.ts` (Phase-2 stub, zero importers), the
  viewer's no-op `findRecentToucher()` stub, and the inert `.card-scrim`
  CSS/HTML/JS remnants.

## [1.3.1] — 2026-07-03

### Fixed

- **Decision/todo `update` is now atomic** (field report 2026-07-03 §3). Link
  replacement in `DecisionService`/`TodoService` deleted old GOVERNS/REFERENCES
  links and inserted replacements as separate statements — a crash mid-update
  could leave an entity with a half-replaced governance set (the contract
  briefing, reconciliation, and `why` all key off). The record patch and both
  link-replacement passes now land in one `db.transaction()` (nested passes are
  savepoints), with fault-injection tests covering rollback of removals,
  partial inserts, and the record patch.
- **CI can no longer silently skip the binary-backed MCP-contract suites.**
  `tests/mcp-contract/globalSetup.ts` now throws under CI (`CI` set and not
  `"false"`) when `bin/cortex-indexer` is missing, instead of setting the
  skip flag — a missing binary previously skipped 3 suites while the run
  reported green (the fetch step gates the common path; this closes the rest).

## [1.3.0] — 2026-07-03

### Added

- **Architecture hotspots — a `computeHotspots` primitive ranking source
  modules by a composite `score` (0–100)** blending three max-normalized,
  weighted-summed signals: external inbound fan-in (`in_edges` — distinct
  CALLS/IMPORTS callers from outside the module, dependency risk),
  `governing_decisions` (distinct active decisions governing refs in the module),
  and `open_todos` (distinct non-terminal todos governing refs in the module).
  Weights default to equal and are caller-tunable. `nodes` is a display
  annotation only, not scored. Deterministic, computed TS-side against the graph
  store — no indexer round-trip. Surfaces both *dependency* hotspots (much
  depends on it) and *attention* hotspots (much governance / open work lives
  there), bridging the global `get_architecture` histogram and per-symbol
  `blastRadius`.
- **`get_architecture(aspects=["hotspots"])`** — new aspect returning
  `{ project, hotspots: HotspotArea[] }`. When combined with other aspects
  (e.g. `["all", "hotspots"]`), the indexer-routed payload for the other
  aspects is merged with `hotspots` rather than dropped; `hotspots`-only
  calls skip the indexer round-trip entirely.
- **`cortex code arch --hotspots`** — prints the ranked hotspot table.
  **`cortex code arch --headline`** — prints the bounded (≤8-line) onboarding
  headline (scale + top hotspots + entrypoints), or nothing on an empty
  graph.
- **Sentinel-gated SessionStart onboarding headline.** `hooks/check-index.sh`
  emits the headline once per session — gated by a session-id sentinel
  (`<repo>/.cortex/.oriented`) so it fires on a genuinely new session but not
  on resume/compact — inside the existing `CORTEX_BRIEF` block. Set
  `CORTEX_ONBOARD=0` to disable it.

## [1.2.6] — 2026-07-02

### Changed

- **Design deliberation moved out of the public tree into private `.superpowers/`.**
  The `docs/superpowers/` plans + specs (raw brainstorming/deliberation) are no
  longer tracked. The one in-flight topic (reflex layer) was consolidated into a
  single private `.superpowers/reflex-layer.md`; all shipped topics were dropped
  (their record lives in this CHANGELOG, the architecture docs, and decisions).

### Added

- **Architecture-doc coverage for shipped subsystems that only lived in deleted
  specs.** `docs/architecture/frame-extraction.md` gains a consolidated
  "Frame ranking, layout & layers" section (ranker formula/budget, deterministic
  d3-force layout, HDBSCAN `min_samples` tuning, label-quality F1, the six-layer
  agreement-based taxonomy + kind-weight table, earnable-domain, diversity
  selection, and the "import graph is the wrong signal" negative result).
  `docs/architecture/graph-storage.md` gains a "Per-call repo routing
  (RepoContext)" subsection and a "why not `backup()`/`VACUUM INTO`" page-size
  note. `docs/architecture/decisions-storage.md` gains ID-scheme, Reconciliation,
  TODO-entity, and Schema-migrations subsections (and the stale `-- UUID` schema
  comment is corrected).

### Fixed

- **Repointed tracked references off the removed specs onto active docs** — five
  source-comment citations (`src/db/resolve-path.ts`, `src/events/types.ts`,
  `src/frame-extraction/frame-kind.ts`, `src/mcp-server/frame-flow-rollup.ts`,
  `src/mcp-server/repo-context.ts`), `CLAUDE.md`, `HANDOFF.md` (also de-staled:
  reflex Plan 2 shipped in 1.2.3), several architecture docs, and six CHANGELOG
  links now point at architecture docs. Seven stale decision governs/reference
  links to the removed spec paths were dropped from the durable decisions store.

## [1.2.5] — 2026-07-02

### Added

- **Reactive read-path sync engine — the viewer adapts live, no reload.**
  Decision and TODO changes now stream to the frames viewer as **projection
  deltas** over `/ws` and the canvas updates in place:
  - **`todo.*` events**: `TodoService` write paths (propose / update /
    transition / link) now emit events, closing the last silent write path.
  - **Projection channel**: a server-side deriver maps each event to the
    entity's full adapted shape (the same `buildAdaptedDecision` /
    `buildAdaptedTodo` that serve `/api/decisions` and `/api/todos` — one
    adapter, two transports), keyed by the source event's ULID (the sync
    cursor). New `projection` / `catchup` / `catchup_result` WS messages;
    `hello` now carries `head_ulid`.
  - **Catch-up protocol**: reconnecting clients replay deltas past their
    cursor (window: 500) or fall back to a snapshot; deltas are derived at
    read time, so replay is state-converging and overlap is harmless.
  - **Client reactive store** (`src/viewer/store.js`): id-keyed entity maps
    with identity-stable objects, coalesced rAF flush (a burst of deltas is
    one repaint), and silent catch-up (no stale animations after a wake).
  - **Live change treatments** (`src/viewer/live-effects.js`): the v5
    prototype's live-activity grammar, pulse-free — outline→fill births,
    synapse leader fires + draining halos on update, drain-to-outline
    removals, frame-border heat residue, and presence pills (agent `✳` on
    `#60a5fa`, user base-white) with attribution always on — one pill per
    actor, riding the latest change, so bursts don't stack pills.
  - **Sync indicator**: quiet toolbar `live / syncing / offline` state,
    shown for the server-bound project.
- **Architecture page**: [`docs/architecture/viewer-sync-engine.md`](docs/architecture/viewer-sync-engine.md),
  cross-linked from `graph-ui.md`.

## [1.2.4] — 2026-07-01

### Fixed

- **Viewer: ghost marginalia made decision nodes light up on hover far from the
  cursor.** After focusing a frame and unfocusing it, `computeFocusProgress`
  never dropped the from-state, so the defocused frame's marginalia pills kept
  rendering at alpha 0 on every frame — invisible, but still registering hover
  and click hit rects. Hovering that empty strip expanded the decision's
  floating dot pill and leader lines anywhere on the canvas, and clicking empty
  space opened its drawer. The from-state is now cleared the moment the focus
  transition completes, and `drawMarginaliaForFrame` skips fully-faded pills so
  invisible marginalia can never register hit rects.

## [1.2.3] — 2026-07-01

### Added

- **Edit-time block-once backstop (reflex layer, Plan 2).** A `PreToolUse`
  hook (`hooks/brief-edit.sh`, on `Edit`/`Write`/`MultiEdit`) now catches the
  case where you edit a *gated* file (governed by an active decision, or with a
  blast radius above `CORTEX_BRIEF_FANOUT`) **without having studied it first**.
  On the first such edit it denies once with the same briefing headline
  `cortex brief` produces — naming the governing decision, its verdict, and the
  caller count — then records the file so a re-issue proceeds. Studying the file
  in the same session (`get_code_snippet`/`trace_path`) disarms the backstop:
  study-time enrichment records both the studied qualified-name **and its file
  path** in a session **briefed-ledger** (`.cortex/.briefed`), which the hook
  keys on. A `cortex brief --build-gate-cache` step (run at SessionStart)
  precomputes the gated-path set (`.cortex/.brief-gate-cache`) so the hook
  answers most edits with no CLI spawn. Gated-path selection is **active-only**
  (superseded decisions never gate).

### Notes

- Additive and degrade-safe: the hook exits **allow** on any failure (missing
  `jq`, unresolvable CLI, empty payload, non-edit tool) and is gated off with
  `CORTEX_BRIEF=0` (whole reflex layer) or `CORTEX_BRIEF_BLOCK=0` (backstop
  only). It intervenes at most once per file per session — silence by default.
  The SessionStart onboarding headline remains deferred to reflex-layer Plan 3.

## [1.2.2] — 2026-06-27

### Added

- **Study-time pre-edit briefing (reflex layer, Plan 1).** `get_code_snippet`
  and `trace_path` now carry a **briefing headline** when the fetched symbol is
  *gated* — governed by an active decision, or with a blast radius above
  `CORTEX_BRIEF_FANOUT` (default 12). The headline names the governing decision
  and its reconciliation verdict, the caller count, and points to `context_pack`
  for the full body; a `partial`/`drift`/`unreconciled` verdict flags the area as
  drifting before you edit. The same briefing is available on demand via the new
  `cortex brief <path-or-qn>` CLI command. Built as a shared `composeBriefing`
  keystone surfaced through an `attachBriefing` enricher wired into the central
  `registerTool` wrapper (mirroring the freshness signal via a `briefAware`
  flag) plus the CLI. Gate off with `CORTEX_BRIEF=0`. Briefs only on
  **active** decisions and surfaces the **worst** reconciliation verdict among
  those governing a target (`drift` > `partial` > `unreconciled` > `match`), so a
  superseded decision never drives a briefing and a drifting one is never masked
  by a clean one.

### Notes

- Additive and degrade-safe: the enricher never alters a tool's structured
  payload and never throws (any failure returns the result unchanged). The
  edit-time block-once backstop and the SessionStart onboarding headline are
  deferred to reflex-layer Plans 2 and 3.

## [1.2.1] — 2026-06-27

### Added

- **Durable-store migration runner.** The primitives DB
  (`~/.cortex/<repoId>/decisions.db`) now converges through a single,
  name-tracked migration runner (`src/db/migrate.ts`) instead of flag-gated
  self-heal scattered across store-openers. Applied migrations are recorded by
  **name** in a `_cortex_migrations` ledger (the simonw/sqlite-migrate pattern,
  not `PRAGMA user_version`), so the scheme is safe across parallel branches and
  append-only. A store carrying a migration name this binary doesn't recognize
  (written by a newer Cortex) is **hard-refused** — `MigrationError` →
  CLI exit 4 — rather than silently misread. `openDecisionsDb` is the single
  chokepoint: ensure schema → relocate legacy → snapshot-if-pending-and-non-empty
  → run migrations → restore-on-failure. The one existing data migration
  (legacy UUID → `D-` short ids) becomes the first ledger entry; its scattered
  call sites are removed. (Decision `D-b0kp`, TODO `T-21`.)
- **Pre-migration snapshots.** Before applying a pending migration to a
  non-empty store, the runner takes a consistent `VACUUM INTO` snapshot under
  `<storeDir>/backups/` (retaining the last 3) and restores from it if the
  migration throws — so a failed upgrade never leaves a half-migrated store.

### Fixed

- **Graph-import decision ids stay canonical.** With the id migration moved into
  the open-time runner, the legacy graph→sidecar import path
  (`migrateDecisionsFromGraphDb`, which inserts UUID-keyed rows *after* the
  runner has already recorded the id migration) would have left those imported
  decisions un-converted. The import path now force-re-runs the id converter
  when it actually imports rows, keeping all decision ids in `D-` short form.
- **`MigrationError` CLI hint is now kind-specific.** `store-too-new` advises
  upgrading the plugin; `migration-failed` (where the store was already restored
  from its snapshot) advises re-running and reporting, instead of the misleading
  "upgrade the plugin".

## [1.2.0] — 2026-06-27

### Added

- **`cortex todo` CLI namespace.** The TODO primitive (storage + MCP `todo`
  tool + `/api/todos`, shipped in 1.0.0/1.1.1) is now driveable from the
  terminal at full parity with the MCP tool: `list`, `show`, `search`,
  `propose`, `update`, `transition`, `link`. The prose-heavy `propose` and
  `update` open `$EDITOR` (git-commit style) when run without inline flags —
  the buffer's first non-comment line is the summary, the rest the
  description; an empty summary aborts; a non-interactive context (no TTY)
  requires the summary inline instead. Link fields (`--governs`,
  `--spawns-from`, `--blocked-by`) stay flags. `todo link` validates
  `--relation` against the five relation types. New `src/cli/editor.ts`
  (`openEditor`) is a small reusable editor helper (aborts on a signal-killed
  editor). Wired into `cortex --help` / `cortex todo --help`.

### Fixed

- **`cortex decision` now reads the live durable decisions store.** The
  `decision` CLI's `openService` opened the stale legacy in-repo
  `.cortex/decisions.db`, while the MCP server (and the new `todo` CLI) use
  the durable `~/.cortex/<repoId>/decisions.db` via `resolveDecisionsDbPath`.
  The CLI is repointed to the live store, so `cortex decision list`/`show`/etc.
  see the same decisions the MCP tools write. (`rehome` was already correct and
  is unchanged.)

## [1.1.3] — 2026-06-27

### Changed

- **Aggregate dots are calmer and reveal detail on hover.** Dots are a uniform
  size (no longer scaled by `member_count`); the title + file count are hidden by
  default and shown only on hover, using the **same hover pill** as the file /
  decision / todo node dots (the pill chrome is now a shared `renderInfoPill`).
- **Decision / TODO node labels show only the sequenced id** (`D-<seq>` /
  `T-<seq>`) — the title was redundant with the focused-frame marginalia. The
  **canonical id** (e.g. `D-p8bg`) is now surfaced in the record card's metadata
  line.
- **Hovering a decision/TODO highlights its connection edges** — the leader lines
  from the floating dot AND from its marginalia pill to the nodes it governs
  brighten together (plus decision→child-TODO leaders). The highlight **persists
  while that record's drawer is open**, so the connection stays visible without
  holding the hover.

### Fixed

- **Frames viewer is now visually centered (fit-to-content), and auxiliary items
  ring the cloud instead of sitting inside it.** The viewer used to map the fixed
  1000×800 virtual stage edge-to-edge onto the canvas, so any layout imbalance —
  the residual left/right lean, bottom-heaviness — showed directly, and the prior
  server-side recenter (`D-vmhy`) only balanced the *ambient* cloud, never the
  satellites/aggregates that actually skewed the picture. Two changes:
  - **Viewer fit-to-content centering** (`src/viewer/viewer.js`): a new
    `computeViewTransform` centers the frames' **area-weighted center of mass**
    in the canvas (both axes) and scales to fit the frame extent (capped at 1 so
    sparse graphs aren't magnified, floored so a tiny canvas can't invert the
    scene), with extra top headroom for frame labels. It centers the *mass*, not
    the bounding-box center, so a few sparse outliers can't skew the framing; the
    small auxiliary aggregate dots annotate the cloud and don't drive the fit
    (they're clamped on-canvas so they stay visible). Baked into the shared
    px-mapping (`framePxBase`, `drawAggregates`) so hit-testing, tooltips, and
    focus mode stay consistent. The frame mass now sits at the canvas center
    (measured within ~12px on the cortex project) regardless of layout lean, and
    re-centers on resize.
  - **Cloud keep-out** (`src/mcp-server/floating-placement.ts`): `ambientCloud` +
    `pushOutsideCloud` push any non-ambient frame or aggregate whose gravity
    centroid landed inside the ambient cloud out to the cloud's outskirts before
    separation, so auxiliaries never sit in the cloud's visual middle. The
    keep-out is an **axis-aware box** (per-axis half-extents), not a single
    radius: a uniform radius is sized by the furthest frame in any direction, so
    an item pushed along the cloud's short axis (e.g. straight up when the spread
    is sideways) got flung far past the cloud into empty space; bounding the push
    per-axis keeps each auxiliary hugging the cloud in its own direction. Pure
    and deterministic (no trig). Decision `D-p8bg`.

## [1.1.2] — 2026-06-26

### Fixed

- **Frames viewer no longer leans left/right (deterministic horizontal recenter).**
  The default layer-adjacency (stratify) layout replaces d3 `forceCenter` with a
  weak `forceX` so the vertical sink force owns the y-axis — but `forceX` never
  recenters the cloud's mean, so the equilibrium could settle off-center and read
  as a left/right "lean" that varied per layout seed. After the simulation, the
  ambient frame cloud is now translated on x so its bounding box is centered on
  the stage. Applied **only** in the stratify path, so the `CORTEX_LAYER_LAYOUT=0`
  path stays byte-identical to pre-slice output. Decision `D-vmhy`. (Separate,
  not addressed here: any change to a frame's id/label/member-count reseeds the
  layout and reshuffles it — force-directed layout is chaotic w.r.t. input
  changes; deferred.)

## [1.1.1] — 2026-06-26

### Added

- **TODO viewer slice — TODO entities now render on the frames canvas.** The
  TODO entity foundation shipped in 1.0.0 (storage + tools + `/api/todos`
  contract) but TODOs were invisible on the canvas; this renders them, mirroring
  the decision pipeline:
  - Ambient yellow TODO dots (open = solid yellow, blocked = yellow + amber
    ring, in-progress = yellow base; done/cancelled excluded from the canvas),
    with hover pills (`T-NN · summary`).
  - TODO marginalia pills stacked beside decision pills on the focused frame,
    with leader lines to anchor dots.
  - Decision → TODO leader lines for `spawnsFrom` children when a decision is
    selected.
  - A TODO record drawer (reusing the decision-card chrome) with in-place
    decision ↔ TODO ref-pill pivoting, and a new **Tasks** section on the
    decision drawer listing its `spawnsFrom` children.
- **Unified layers menu.** The viewer's `layers` menu is now one flat list of
  toggleable layers — **frames / decisions / todos / layer tint** (with the
  six-tier architectural legend nested under the tint toggle) — each persisted to
  `localStorage`. Hiding `frames` suppresses only the box chrome; file dots,
  edges, and layout are untouched, so decisions and TODOs stay anchorable.

### Fixed

- **GOVERNS qualified-name classification (decisions + todos).** A real
  qualified name (`dir/file.ts::sym`, which always contains `/`) was
  misclassified as a `path` and silently dropped by `resolveGovernsRef`. Both
  the decisions and todos services now share a `classifyGovernsTarget` helper
  (`src/shared/classify-ref.ts`) that checks the `::` marker before `/`.

## [1.1.0] — 2026-06-25

### Added

- **Visual polish for the `cortex` CLI.** A new zero-dependency styling layer
  (`src/cli/style.ts`) brings color and glyphs to interactive output:
  - **Tables/lists** (`code find`/`search`/`where`/`calls`, `index list`,
    `schema`): bold-cyan headers with a dim rule, dimmed secondary columns
    (`file_path`/`kind`/`depth`/`line`), and cell truncation sized to the
    terminal.
  - **Errors**: a red `✗` label and a dim `→` hint line.
  - **Help** (`--help`, per-namespace, per-command): bold headings, cyan
    command names, green example commands.
  - **Progress spinner** for `cortex index` — an animated braille spinner on
    stderr while the indexer runs (the indexer call moved from sync to async
    `execFile` so the spinner can animate), resolving to `✓ indexed <project>`.
- **`--color=always` / `--color=never` / `--no-color` flags**, plus the
  `NO_COLOR`, `CORTEX_NO_COLOR`, `CORTEX_COLOR`, and `CORTEX_ASCII` environment
  gates. Color auto-detects an interactive TTY otherwise.

### Notes

- **Non-interactive output is unchanged.** When the target stream isn't a TTY
  (pipes, redirection, `--format json`/`plain`, `NO_COLOR`), output contains
  zero ANSI bytes and is byte-for-byte identical to before — machine consumers
  and scripts are unaffected. A non-UTF-8 locale falls back to ASCII glyphs.

## [1.0.3] — 2026-06-25

### Fixed

- **CLI no longer runs stale compiled code after a pull.** `bin/cortex` prefers a
  compiled `dist/` over `src/` when present, but `dist/` is a gitignored local
  artifact that `git pull` never rebuilt — so `cortex index` silently ran
  out-of-date code (e.g. the 1.0.2 `cluster:N` label recovery didn't reach the
  CLI until a manual `npm run build`). Added committed git hooks
  (`.githooks/post-merge`, `post-checkout`) that rebuild `dist/` after a ref move
  **only when** `dist/` already exists and compiled inputs (`src/`, `tsconfig*`,
  `package.json`) actually changed; wired via `core.hooksPath` from `postinstall`
  (`scripts/install-git-hooks.mjs`, guarded to git work trees, best-effort). When
  `dist/` is absent the CLI already falls back to `tsx src/` (always current), so
  the hook is a no-op there.

## [1.0.2] — 2026-06-25

### Changed

- **`cluster:N` label recovery** — the frame labeler no longer drops straight to
  the opaque `cluster:N` after its strict passes. Three deterministic recovery
  steps run first: (1) a directory-aware short-token rule (a 2-char token that
  names a real subsystem directory like `ws`/`io`/`db` is eligible; 1-char and
  filename-stem tokens stay rejected); (2) a last-resort relaxed pass that
  accepts the best TF-IDF top-token at a 0.3 salience floor, allowing soft
  generics (`index`/`meta`/`ids`) but never route-params, dynamic segments,
  repo-ubiquitous terms, or org-root/layout conventions; (3) an honest directory
  descriptor (dominant informative dir(s) shared by 2+ members, e.g.
  `decisions/todos` — no file count) before the `cluster:N` floor. On cortex this
  takes opaque `cluster:N` labels from 5 to 0 (real labels: `ws`, `allocator`,
  `todos`, `graph/capture`, …); measured ≤2 on the OO corpus repos with no
  garbage labels across TS/Python/Go.

## [1.0.1] — 2026-06-24

### Added

- **Class-hierarchy affinity clustering signal** — files whose classes share an
  in-repo (domain) base class are pulled together during frame clustering
  (deterministic, gated by `CORTEX_FRAME_HIERARCHY`, γ=0.3; a modest OO-only
  frame-quality lift; inert on functional repos).

### Removed

- Embedding-signal spike code removed (negative result evaluated and discarded).
  Code embeddings collapsed files into unnameable mega-blobs (96% of pairs within
  0.05 cosine distance); no dense AND topical graph signal was found. See
  `docs/research/2026-06-24-embedding-cluster-signal.md` for the full write-up.

## [1.0.0] — 2026-06-24

> **Breaking release.** The MCP primitive tool surface is consolidated from 17
> separately-named tools into 3 action-dispatched tools (`decision` / `pr` /
> `todo`). Old tool names are removed (clean break). External MCP consumers
> (e.g. mesh) must migrate per the table below. The HTTP API contract is
> unaffected (still `version: 1`; `/api/todos` is purely additive).

### Added

- **TODO entity** — storage layer, `todo` MCP tool (action-dispatched: `propose` /
  `get` / `list` / `search` / `update` / `link` / `transition`), `/api/todos`
  HTTP endpoint, and `AdaptedTodo` contract. TODOs live in the durable decisions
  sidecar alongside decisions, linked to code and decisions via the same
  qualified-name / file-path edges.

### Changed

- **Consolidated 17 decision / PR tools into 3 action-dispatched tools.**
  `decision`, `pr`, and `todo` replace the 17 separately-named tools. Every
  caller passes `action` to select the operation; all other parameters are
  unchanged. See the Migration table below.

### Removed

- Individual tool names `create_decision`, `update_decision`, `delete_decision`,
  `get_decision`, `search_decisions`, `why_was_this_built`, `decision_candidates`,
  `link_decision`, `promote_decision`, `propose_decision`, `supersede_decision`,
  `record_reconciliation`, `pending_reconciliations`, `open_pr`, `add_pr_touch`,
  `merge_pr`, `get_pr` — all removed from the MCP surface; replaced by the
  `decision` / `pr` / `todo` dispatchers below.

### Migration

| Old tool name | New call form |
|---|---|
| `create_decision(…)` | `decision({action:"create", …})` |
| `update_decision({id, …})` | `decision({action:"update", id, …})` |
| `delete_decision({id})` | `decision({action:"delete", id})` |
| `get_decision({id})` | `decision({action:"get", id})` |
| `search_decisions({query, …})` | `decision({action:"search", query, …})` |
| `why_was_this_built({qualified_name})` | `decision({action:"why", qualified_name})` ⚠️ external consumers (e.g. mesh) must update |
| `decision_candidates({…})` | `decision({action:"candidates", …})` |
| `link_decision({decision_id, target, …})` | `decision({action:"link", decision_id, target, …})` |
| `promote_decision({id, tier})` | `decision({action:"promote", id, tier})` |
| `propose_decision(…)` | `decision({action:"propose", …})` |
| `supersede_decision({old_decision_id, …})` | `decision({action:"supersede", old_decision_id, …})` |
| `record_reconciliation({decision_id, verdict, …})` | `decision({action:"reconcile", decision_id, verdict, …})` |
| `pending_reconciliations({…})` | `decision({action:"pending", …})` |
| `open_pr({title, author, …})` | `pr({action:"open", title, author, …})` |
| `add_pr_touch({pr_number, …, action:"added"\|"modified"})` | `pr({action:"touch", pr_number, …, change:"added"\|"modified"})` — inner field renamed `action`→`change` |
| `merge_pr({pr_number})` | `pr({action:"merge", pr_number})` |
| `get_pr({pr_number})` | `pr({action:"get", pr_number})` |

## [0.9.0] — 2026-06-16

### Added

- **Versioned, Zod-enforced HTTP contract for the viewer endpoints (P6).** The
  seven viewer endpoints plus new `GET /api/health` and `GET /api/freshness` are
  now a versioned contract (contract `version: 1`, decoupled from the package
  semver). One Zod schema per response in
  [`src/mcp-server/api-schemas.ts`](src/mcp-server/api-schemas.ts) is the single
  source of truth: it validates at runtime, derives the TS type via `z.infer`, and
  generates the committed JSON Schema docs under [`docs/api/`](docs/api/) (via
  [`scripts/gen-api-schemas.ts`](scripts/gen-api-schemas.ts), `npm run gen:api-schemas`),
  guarded by a byte-identity drift test. A `respond()` chokepoint
  ([`src/mcp-server/api-respond.ts`](src/mcp-server/api-respond.ts)) validates every
  payload (throw in test/CI or under `CORTEX_API_STRICT=1`, else log-and-send) and
  stamps the version/freshness/ETag headers. Decision `D-tszm`;
  [design](docs/architecture/http-api-contract.md).
- **Freshness over HTTP** — a two-signal model: an `ETag` derived from the index
  baseline drives `If-None-Match` → `304` conditional revalidation on the data
  endpoints, while an `X-Cortex-Freshness` header + a lightweight `GET /api/freshness`
  carry the live staleness verdict (reusing `freshnessForContext`). Lets a consumer
  (Mesh) replace its blind TTL cache with verdict-keyed revalidation.
- **HTTP hardening, env-gated and inert by default** — loopback-default bind
  (`CORTEX_BIND_HOST`), GET/HEAD method gate, CORS origin allowlist
  (`CORTEX_CORS_ORIGINS`), opt-in constant-time bearer auth (`CORTEX_API_TOKEN`,
  `/api/health` exempt), traversal-safe static serving, security headers
  (CSP / `X-Frame-Options` / `nosniff` / `Referrer-Policy`), oversized-request-target
  → `414`, and request/headers timeouts. The CSP permits the viewer's Geist web
  fonts while keeping `script-src 'self'`.

### Changed

- All viewer endpoint responses now carry a top-level `version` field (additive —
  Mesh M1's existing reads are unaffected); `GET /api/decisions/:id` is wrapped as
  `{ version, decision }`. The viewer HTTP server now binds `127.0.0.1` by default
  (was all interfaces).
- The hand-written `AdaptedDecision` / `GovernsRef` / `FileEdge` TypeScript
  interfaces are now derived from the Zod schemas via `z.infer` (single source of
  truth). New env vars: `CORTEX_BIND_HOST`, `CORTEX_API_TOKEN`, `CORTEX_CORS_ORIGINS`,
  `CORTEX_API_STRICT`.

## [0.8.24] — 2026-06-16

### Fixed

- **Floating frames/aggregates no longer overlap each other or ambient frames.**
  0.8.23 positioned each satellite independently (`repelFromBoxes` against ambient
  boxes only), so co-anchored satellites resolved to the same centroid and
  **stacked** — and pushing one off an ambient frame could drop it onto another.
  Placement now runs through `separateMovables` in
  [`src/mcp-server/floating-placement.ts`](src/mcp-server/floating-placement.ts):
  a deterministic **greedy free-slot** placer that keeps a satellite's seed if
  free, else takes the nearest unoccupied spot found by scanning outward in
  expanding integer grid rings (no trig → cross-platform deterministic), treating
  ambient frames **and already-placed satellites** as occupied. The "frames never
  sit on top of each other" invariant now holds by construction whenever the
  stage has room (a force-relaxation approach was tried first and rejected — it
  deadlocked in dense ambient clusters). New tests assert zero satellite/ambient
  and satellite/satellite overlap, plus determinism and the saturated-stage
  fallback. (Known follow-up: aggregate dots and non-ambient frames are placed in
  separate endpoints, so a dot can still land on a satellite frame — a dot can
  overlap a box across the two passes; not addressed here.)

## [0.8.23] — 2026-06-16

### Added

- **Floating-entity placement (taxonomy layout slice, part 2)** — non-ambient
  frames and auxiliary aggregates are now positioned by a deterministic
  server-side **gravity centroid** near the ambient frames they relate to,
  replacing the viewer's two fixed strips. A new pure module
  [`src/mcp-server/floating-placement.ts`](src/mcp-server/floating-placement.ts)
  runs *after* the (unchanged, byte-identical) ambient force-sim: each
  non-ambient frame settles at the pair-weighted centroid of the ambient frames
  it connects to (`rollupFramePairs`), and each aggregate via an
  **edge → path → margin** tie cascade ([`src/mcp-server/aggregate-ties.ts`](src/mcp-server/aggregate-ties.ts):
  CALLS/USAGE/IMPORTS edges to frames, else shared directory ancestry, else a
  de-emphasized margin slot), with one-directional frame-repulsion so a satellite
  never lands inside an unrelated frame. The placement pass depends only on the
  final ambient positions + ties — never on *how* those positions were produced —
  so a future network/layered layout mode composes on top unchanged. Positions
  are emitted in `/api/frames` (non-ambient frames) and `/api/aggregates`
  (positioned aggregates); the viewer renders satellites at those positions,
  visually de-emphasized.
  [Design](docs/architecture/graph-ui.md).

### Changed

- **The viewer's two fixed strips are gone** — the auxiliary-aggregate bottom
  strip and the decision-governed-frame top strip are replaced by the
  gravity-centroid placement above. Governance *selection* stays client-side
  (the viewer still chooses which non-ambient frames to render from
  `FRAME_GOVERNANCE`), but their *position* now comes from the server. This
  **supersedes the `D-xwxj` governed-frame promotion stopgap**.

## [0.8.22] — 2026-06-16

### Changed

- **Layer-adjacency layout force is now ON by default** (taxonomy layout slice,
  the default-on flip). `CORTEX_LAYER_LAYOUT` is now an **opt-out**: set it to
  `"0"` to restore the pre-slice `forceCenter` layout (positions byte-identical
  to the unstratified base). Backs the positive corpus observe verdict (decision
  `D-marq`): across the eval-layers corpus, every successful repo stratifies
  positively on Spearman(y, sink) — mean ≈ 0.77, median ≈ 0.74, range 0.51–0.95
  (vueuse 0.95, TanStack/table 0.95, trpc 0.83, rubygems 0.78, cortex 0.74,
  saleor 0.72, peft 0.71, click 0.70, anthill 0.58, nuxt/ui 0.51), with no
  negative or near-zero result on any archetype (vue/react/ts-monorepo/nuxt/
  go/python/django/rails). The metric under-states the real effect (it uses
  `0.5` for flowless frames where the layout uses per-layer `NOMINAL_SINK`). The
  layout force and its mechanism shipped in 0.8.21; this release only flips the
  default. Gate 0 confirmed a clean default-on render on cortex (vertical spread
  y 118→593 over an 800-tall stage, ceremony at the substrate, zero console
  errors).

## [0.8.21] — 2026-06-16

### Added

- **Layer-adjacency layout force (taxonomy layout slice, part 1)** — a vertical
  stratification force in [`src/mcp-server/frame-layout.ts`](src/mcp-server/frame-layout.ts):
  ambient frames settle into a surface→substrate slice (sources high, sinks low)
  via a new `forceY(yTarget(sink))` on the existing d3-force base (pair-link
  clustering, charge, collide/AABB tail unchanged). The position is **measured**,
  not categorical — each frame's target `y` comes from its sink ratio
  `fanIn/(fanIn+fanOut)` (the same flow signal the classifier uses), with a
  per-layer `NOMINAL_SINK` fallback only for flowless frames. The layout module
  stays layer-agnostic (it receives a plain `sink` number); `frame-map.ts`
  computes the effective sink and reads the flag. Gated behind
  `CORTEX_LAYER_LAYOUT`, **default off** (inert — positions byte-identical when
  off, golden-tested; `forceCenter` is swapped for a horizontal-only `forceX`
  only when stratifying). `eval-layers` gained a Spearman(y, sink) stratification
  metric for the observe pass. Decision `D-marq`; relates to `D-wvsz` / `D-g4qb`.
  [Design](docs/architecture/graph-ui.md).
  Floating-entity placement (replacing the fixed bottom strip; subsuming the
  `D-xwxj` governed-frame promotion) is a separate follow-on slice.

## [0.8.20] — 2026-06-15

### Changed

- **Layer-diversity ambient selection is now ON by default** (taxonomy slice 3b,
  the default-on flip). `CORTEX_LAYER_DIVERSITY` is now an **opt-out**: set it to
  `"0"` to restore the kind-weighted-only ambient set (the ranker's top-budget).
  Backs the positive corpus observe verdict (decision `D-wvsz`): across the
  eval-layers corpus, diversity collapses redundant interface frames and surfaces
  domain/data on interface-heavy repos (vueuse interface 7→4 / data 1→3, nuxt/ui
  2 layers → 5, saleor interface 7→3 +data, rubygems re-surfaces a domain frame),
  with the ceremony cap holding everywhere (≤1), no junk promoted on coverage
  alone (the `0.5×` floor), and no churn on already-diverse/tiny repos. The
  diversity selector and its mechanism shipped in 0.8.19; this release only flips
  the default. Gate 0 confirmed a clean default-on render on cortex.

## [0.8.19] — 2026-06-15

### Added

- **Layer-diversity ambient selection (taxonomy step 3b)** — the `× diversity`
  term of the frame-ranking formula. A new pure module
  [`src/frame-extraction/frame-diversity.ts`](src/frame-extraction/frame-diversity.ts)
  (`selectAmbientByDiversity`) makes the viewer's ambient frame-set selection
  layer-aware via a deterministic two-phase greedy: Phase 1 fills the budget by
  effective score `score × DECAY^k` (geometric repeat-decay, `DECAY=0.6`) with a
  ceremony cap (≤1, relaxed only to avoid an empty canvas); Phase 2 does
  **bounded coverage repair** — guarantees ≥1 of domain/interface/data when the
  repo has them by promoting the missing layer's best frame over the weakest
  safely-displaceable one, but only if it clears `0.5 × displaced score` (refuses
  weak promotions — the D-qn7z junk-leapfrogging guard). Wired into
  [`src/mcp-server/frame-map.ts`](src/mcp-server/frame-map.ts) behind
  `CORTEX_LAYER_DIVERSITY`, **default off** (inert — ambient set byte-identical
  to pre-slice when off). `eval-layers` gained a diversity off-vs-on ambient
  delta for the observe pass. Decision `D-wvsz`; relates to `D-g4qb` (kind-weight)
  and `D-qn7z`.
  [Design](docs/architecture/frame-extraction.md#diversity--ambient-selection).
  Measured on cortex (flag on): ceremony correctly capped 2→1, over-represented
  domain yields a slot, interface gains a second frame, ambient held at budget.

## [0.8.18] — 2026-06-15

### Fixed

- **CI: sibling auto-index denylist was too broad** — the `prefer-cortex` hook's
  auto-index denylist matched a bare `tmp` path segment, so on Linux (where
  `os.tmpdir()` is `/tmp`) it silently excluded **every** temp-dir git repo —
  including the test fixtures, which failed only on the Linux CI runner (macOS
  temp is `/var/folders/…`, so it passed locally and hid the gap). Dropped bare
  `tmp` from the denylist; `.tmp` (cortex's eval-clone convention) and
  `node_modules`/`vendor`/`dist`/`build`/`.cache` remain. A git repo a user
  actively greps under `/tmp` is now a legitimate auto-index target. Added a
  regression test that exercises a sibling under system `/tmp`. Decision `D-mmtb`
  updated.

## [0.8.17] — 2026-06-15

Agentic-experience field report §5 items **P1** and **P3**, shipped together.

### Added

- **`context_pack` MCP tool (P1)** — one call returns a symbol's full context
  bundle as five labeled text sections: `## SNIPPET`, `## CALLERS` (direct,
  cap 10), `## CALLEES` (direct, cap 10), `## GOVERNING DECISIONS` (cap 5), and
  `## RECENT COMMITS` (last 5 touching the file). Capped lists show
  `(showing N of M)` when truncated. It resolves the `qualified_name` **once**
  and composes existing reads (`get_code_snippet` + `trace_path` ×2 +
  `why_was_this_built` + `git log`); each section is best-effort, so one failing
  source degrades to `- (none)` / `(unavailable)` rather than sinking the pack.
  Collapses the 4-roundtrip symbol-exploration loop into one turn. Freshness-aware.
  New [`src/mcp-server/tools/context-pack.ts`](src/mcp-server/tools/context-pack.ts);
  `readSnippet`/`projectFromCtx` lifted into
  [`code-tools-shared.ts`](src/mcp-server/tools/code-tools-shared.ts). Decision `D-bptf`.

### Changed

- **`prefer-cortex` hook is target-aware (P3)** — the index gate now keys on the
  **search target** repo (resolved from the `Grep`/`Glob` `path` arg or the
  first path-like token of a `Bash` command; cwd for bare patterns), not the cwd
  repo. A code grep against an **unindexed sibling** is no longer wrongly denied
  because the cwd repo happened to be indexed; a grep against a *second indexed*
  repo still redirects. Decision `D-mmtb`.
- **Sibling auto-index (P3)** — when a code search targets an unindexed
  high-certainty git repo (real root, not under `.tmp`/`tmp`/`node_modules`/
  `vendor`/`dist`/`build`/`.cache`), the hook fires a **detached background
  `cortex index . <path>`** for it and allows the grep immediately. Deduped by a
  60-min sentinel (`<root>/.cortex/.auto-index-attempted`, fails toward retry),
  logged to `<root>/.cortex/auto-index.log`, CLI resolved via `CORTEX_BIN` →
  `command -v cortex` (no-op if unresolvable). Opt out with `CORTEX_AUTO_INDEX=0`.
  Degrade-safe: any failure still allows the grep.

### Fixed

- **Stale "index a repo" CLI hint** — corrected the non-existent
  `cortex index repository --path=<path>` form (which the CLI rejects as an
  unknown subcommand) to the supported `cortex index . <path>` in the
  `RepoNotIndexedError` hint ([`repo-context.ts`](src/mcp-server/repo-context.ts)),
  the `decision rehome` not-indexed errors
  ([`decision-rehome.ts`](src/cli/commands/decision-rehome.ts)), and the
  CLAUDE.md MCP-routing docs. These had been misdirecting agents/users to a
  command that errors out.

## [0.8.16] — 2026-06-14

### Changed

- **Docs** — rewrote [`HANDOFF.md`](HANDOFF.md) NEXT-STEP point 7 (the
  field-report P1–P8 agentic-experience plan) as a status table: P2 shipped;
  P3/P1/P6/P4/P5/P7/P8 outlined with what-it-is + effort, in suggested sequence,
  plus the reaffirmed ⏩ operational items. No code change.

## [0.8.15] — 2026-06-14

### Changed

- **Docs sync** — refreshed [`HANDOFF.md`](HANDOFF.md) and
  [`docs/specs/progress.md`](docs/specs/progress.md) to record the 0.8.11–0.8.14
  search-noise line (field-report P2 + follow-ons), and corrected the stale
  "search ranking (P2) — future" references now that P2 has shipped. No code
  change.

## [0.8.14] — 2026-06-14

### Fixed

- **`prefer-cortex` hook no longer denies commands that merely mention a search
  word in a quoted argument** ([hooks/prefer-cortex.sh](hooks/prefer-cortex.sh)).
  A `git commit -m "…grep…"` (or `echo "rg …"`) was misread as a code search and
  blocked. The Bash branch now strips quoted string literals before probing for a
  command-position search tool; a real code search keeps its tool word unquoted
  so it still redirects, and scope detection still runs against the original
  command (quoted non-code globs like `--glob '*.md'` are preserved). +4 tests.

## [0.8.13] — 2026-06-14

### Fixed

- **`cortex code search` now finds code, not just docs** (decision `D-qfz9`).
  The CLI's full-text search was routed through the indexer binary's
  `search_code`, which caps at ~10 results and orders doc-first — a common term
  like `extract` (91 code files) returned only `.md` files. It now runs the same
  ripgrep engine as the MCP `search_code` tool and ranks **code-first**, so code
  hits lead.

### Added

- **Shared `src/graph/code-search.ts` engine** — `runCodeSearch` (ripgrep →
  grep fallback → parse → enclosing-symbol annotation) and `rankSearchHits`
  (orders by `KIND_WEIGHT[enclosing.kind]`; Markdown/doc hits enclose to a
  `module` node or nothing and sink below real code). The rg helpers moved here
  from `code-tools.ts` (re-exported there for compatibility). The MCP
  `search_code` tool is now a thin wrapper over it — **output byte-identical**.
- **`cortex code search` structured output + flags** — results render as ranked
  rows (`file`, `line`, `symbol`, `text`) via `writeRows` (respects
  `--format json|plain|table`), with `--limit`/`--offset` pagination and a
  `# showing A–B of N` stderr status line. A misused `--kind` on `search` now
  prints a redirect to `cortex code find` instead of being silently ignored;
  the `search` help entry is corrected.

## [0.8.12] — 2026-06-14

### Added

- **`cortex code find` reaches parity with the `search_graph` tool**
  ([`src/cli/commands/code.ts`](src/cli/commands/code.ts)). Results are now
  ranked (`rankNodes`), doc/plan `section` nodes are excluded by default with a
  stderr note reporting how many were hidden and how to opt in, and the command
  gains `--kind`/`--kinds` (comma-separated), `--limit`, and `--offset` flags.
  This also honors the `--kind` flag that the help text already advertised but
  the command ignored. Structured output (`--format json|plain|table`) is
  preserved; the status line goes to stderr so stdout stays pipe-clean.
- **`clampLimit`/`clampOffset` relocated to**
  [`src/graph/search-params.ts`](src/graph/search-params.ts) so both the CLI and
  the MCP tool share them without the CLI depending on the mcp-server layer.

### Fixed

- **`search_graph` suppression note no longer fires under an explicit filter**
  ([`src/mcp-server/tools/code-tools.ts`](src/mcp-server/tools/code-tools.ts)).
  The `K section nodes suppressed` hint now appears **only when the default
  filter is in effect** (no `kinds`/`label`). Previously a scoped query like
  `kinds: ["route"]` still reported suppressed sections — misleading, since the
  caller chose the scope rather than accepting a section-hiding default.

### Changed

- **Documented `search_graph` search syntax**
  ([`docs/mcp-tools.md`](docs/mcp-tools.md)): `name_pattern` is a
  case-insensitive substring (`LIKE '%…%'`, `%`/`_` wildcards); `qn_pattern` is
  a non-auto-wrapped `LIKE` against the normalized qualified name (add `%`
  yourself); `kinds`/`label` are exact kind matches; params are AND-ed.

## [0.8.11] — 2026-06-14

### Added

- **`search_graph` result ranking, section exclusion & pagination** — field
  report P2 (decision `D-fq9g`). Results are now ranked by a pure scorer
  ([`src/graph/node-ranker.ts`](src/graph/node-ranker.ts)) — `KIND_WEIGHT[kind] ×
  nameMatchQuality` (exact > prefix > substring), with a deterministic tie-break
  (score → shorter name → qualified-name) so pagination is stable. Doc/plan
  `section` nodes (the largest, noisiest kind — 1771 vs 528 functions in this
  repo) are **excluded from name/qn results by default**; the response header
  reports `K section nodes suppressed (pass kinds=["section"])`. New `kinds`
  (string[]), `limit` (default 30, max 100) and `offset` params; the legacy
  `label` param is folded into the `kinds` union. A query matching only sections
  returns the header-only opt-in hint instead of a bare "no results".
- **Pure render/clamp helpers**
  ([`src/mcp-server/tools/search-format.ts`](src/mcp-server/tools/search-format.ts))
  and `countSuppressedSections`
  ([`src/graph/code-queries.ts`](src/graph/code-queries.ts)).

### Changed

- `search_graph` output now leads with a `showing A–B of N · offset M` header.
  `searchGraph` keeps its `IndexerNode[]` return shape, so `get_code_snippet`
  and other callers are unaffected. Frame/layer-aware ranking is deferred to a
  follow-on (P2.1), gated on frame-coverage quality.

## [0.8.10] — 2026-06-13

### Changed

- **Kind-weight frame ranking is now ON by default**
  ([`src/mcp-server/frame-map.ts`](src/mcp-server/frame-map.ts)). The taxonomy
  enable slice's kind-weighted ambient set (decision `D-g4qb`) is the default
  user-visible ranking after a positive corpus observe verdict. `CORTEX_KIND_WEIGHT`
  flips from an opt-in to an **opt-out** — set it to `"0"` to restore the
  pre-slice `nameability × structural_weight` ranking. The pure ranker is
  unchanged; `opts.applyKindWeight` still overrides for tests. Gate 0 visual
  confirmed a clean render with the new default.

## [0.8.9] — 2026-06-13

### Added

- **Kind-weight frame ranking** — taxonomy enable slice 3a
  ([`src/frame-extraction/frame-ranker.ts`](src/frame-extraction/frame-ranker.ts),
  [`frame-kind.ts`](src/frame-extraction/frame-kind.ts),
  [`frame-map.ts`](src/mcp-server/frame-map.ts); decision `D-g4qb`). Frame
  ranking score gains a per-layer `kind_weight` multiplier (earned domain 1.00,
  interface 0.90, orchestration 0.85, data 0.75, infrastructure 0.55,
  fallback-domain 0.50, ceremony 0.20) so the ambient set tilts toward narrative
  layers and away from substrate/ceremony. Gated behind `CORTEX_KIND_WEIGHT`,
  **default off** — with the flag off, ranking is byte-identical to before (an
  enforced test guarantee). The ranker stays pure: `kind_weight` is threaded as a
  plain number on `FrameRecord` (omitted ≡ 1); the weights table + env flag live
  at the call site (`frame-map` classifies before ranking and reads the
  `fallback` flag only to pick the weight — never serialized).
- **Corpus ambient-diff in the layer eval**
  ([`scripts/frame-extraction/eval-layers.ts`](scripts/frame-extraction/eval-layers.ts)):
  reports the ambient set flag-off vs flag-on per repo. Observe over 11 repos
  confirmed kind-weight evicts ceremony/config noise (eslint-config,
  playwright-config, tsconfig, training/scripts, test cassettes, json-schemas),
  tilts toward interface/domain/data, and demotes fallback-domain to interface —
  with no junk leapfrogging into the ambient set.

## [0.8.8] — 2026-06-13

### Added

- **Earnable `domain` layer** — frame-layer taxonomy step 2
  ([`src/frame-extraction/frame-kind.ts`](src/frame-extraction/frame-kind.ts),
  decision `D-8vbv`). Runtime code in the classifier's previously-silent middle
  sink band now *earns* `domain` instead of only ever falling into it. The
  residual (`W_DOMAIN_RUNTIME = 0.5 × runtimeFrac`, ~80% runtime bar) is an
  **earned fallback** — held aside and applied only when no layer-specific
  source cleared `MIN_SIGNAL`, so any real path/label/content signal still wins.
  Earned vs fallback domain are distinguished by the internal `fallback` flag
  (production `/api/frames` still serializes only `{ frame_id, layer }`).
- **Corpus-wide layer eval** ([`scripts/frame-extraction/eval-layers.ts`](scripts/frame-extraction/eval-layers.ts)):
  clone→index→cluster→classify across `corpus.json`, reporting per-repo + corpus
  layer distributions and the mid-band `runtimeFrac` distribution. Validated the
  signal across 11 repos (TS/Vue/React/Nuxt/Python/Django): earns domain on 8/11,
  with the 0.8 runtime bar sitting in a natural distributional gap (fallback
  frames cluster at 0.5–0.7 runtime, earned at 0.9–1.0).

### Changed

- **Enable-slice weights settled** for the future kind-weight ranking
  (`HANDOFF.md`): earned domain `1.00`, fallback domain `0.50`. The domain
  question that gated the enable slice is resolved; step 3 is unblocked.

## [0.8.7] — 2026-06-13

### Added

- **Handler-suffix orchestration signal** in the frame-layer classifier
  ([`src/frame-extraction/frame-kind.ts`](src/frame-extraction/frame-kind.ts)):
  Nitro/h3 method-suffixed route files (`*.{get,post,put,patch,delete,head,options}.{ts,js,…}`,
  case-insensitive) whose path contains an `api`/`routes` segment now contribute
  to **orchestration**. Observe-phase measurement on anthill-cloud found these
  handler frames are pure sources (sink 0.0), so the surface pair tied and the
  canonical tie-break starved orchestration to zero frames. Weight is aliased to
  `W_PATH` (not a restated literal) so the documented "same weight as a path
  token" intent survives tuning. Route-dir scoping prevents the typed-accessor
  idiom (`cache.get.ts`) outside route dirs from flipping substrate frames.
  Decision `D-gbqj`.

### Changed

- **Ceremony layer tint → warm taupe** `rgb(125, 110, 93)`
  ([`src/viewer/viewer.js`](src/viewer/viewer.js)): the former cool gray
  `rgb(99, 105, 121)` was indistinguishable from infrastructure's slate at lens
  alphas (a correct `infrastructure` frame read as `ceremony` to the eye).
  Warm-vs-cool hue separates where lightness alone washed out.
- **Legend swatches single-sourced from `LAYER_RGB`**: the six per-layer
  swatch colors are now injected from the viewer's palette constant at init
  rather than hand-synced in CSS — collapsing three copies of the palette to
  one runtime source.
- **`FrameKindInternal` distinguishes fallback from tie**: the internal eval
  shape gained a `fallback` flag so the agreement report separates a pure
  `MIN_SIGNAL` fallback from a within-pair tie (both previously printed
  `conf=0.00`). Production `/api/frames` still serializes only `{ frame_id,
  layer }` (negative test extended to the new field).
- **Observe-phase findings + verdict recorded** ([`HANDOFF.md`](HANDOFF.md),
  [frame-layers design](docs/architecture/frame-extraction.md#layer-taxonomy)):
  cross-repo measurement shows `domain` is only ever reached by fallback (never
  earned), orchestration starved on framework idioms, and frame quality is the
  ceiling. Verdict: **do not enable kind-weight** until the domain question is
  resolved. The stale "restart the MCP server" handoff step was removed (the
  server already serves the `layer` field).

### Fixed

- **Frame-layer regression net blind spot**: the layer fixture was regenerated
  against the current 17-frame graph (was 15) with hand labels for the new
  frames, and the test now **fails if a named fixture frame lacks an `EXPECTED`
  entry** (`Object.hasOwn`, not `in`) — previously, new frames passed silently
  by being skipped. Unnamed `cluster:*` blobs remain exempt by prefix.

## [0.8.6] — 2026-06-13

### Changed

- **Progress assessment + session handoff refreshed**
  ([`docs/specs/progress.md`](docs/specs/progress.md), [`HANDOFF.md`](HANDOFF.md)):
  frame-layers milestone 1 and deterministic rendering recorded as shipped; the
  taxonomy follow-up re-staged as classify → observe → enable with **observe as
  the current phase**; the former "0.8.5" feature line (TODO entity,
  floating-entity placement, record drawer for TODOs) renumbered **0.8.6+**;
  long-resolved known issues (stale `graph.db` shadowing, contracts
  `database disk image is malformed`) marked resolved per decision `D-47xb`.

## [0.8.5] — 2026-06-12

### Fixed

- **Viewer dots could render as one dot, faking duplicate edges**: file-dot
  placement inside frames was `Math.random()` per load, so dense frames
  reliably produced dot pairs within ~5px that read as a single dot — making
  a hub file's distinct edges look like multiple edges to the same target.
  Dots now sit on a jitter-bounded grid (cell from member index, jitter
  seeded from the file path via fnv1a + mulberry32 — the frame layout's
  seeding approach), so neighbors can never coincide and the same graph
  renders identical dot positions on every load. Decision anchor dots take
  the same seeded treatment, removing the last `Math.random()` from the
  render data path. Verified by byte-identical screenshots across reloads.

## [0.8.4] — 2026-06-12

### Added

- **Frame layer lens (taxonomy milestone 1: classify + observe)** — every frame
  now carries a deterministic architectural `layer`
  (`interface | orchestration | domain | data | infrastructure | ceremony`),
  classified at read time behind `/api/frames` by
  [`frame-kind.ts`](src/frame-extraction/frame-kind.ts): an agreement-based
  combination of directed graph position (new
  [`frame-flow-rollup.ts`](src/mcp-server/frame-flow-rollup.ts) fan-in/fan-out),
  curated path patterns, and content signals. The viewer gains a `layers`
  toolbar menu (show-layers switch + the only legend); on = quiet per-layer
  tint of frame fill/border/label, off (default) = pixel-identical to the
  lens-less viewer. Classifier internals (confidence, contributions) are never
  serialized or rendered — enforced by a negative serialization test. Ranking
  and layout are deliberately untouched (classify → observe → enable; the
  kind-weight, layer-adjacency layout, and floating-entity slices come later).
  Regression net: frozen cortex fixture + hand-labeled `anyOf` expectations
  ([`expected-layers.test.ts`](tests/frame-extraction/expected-layers.test.ts)),
  which already caught and fixed two classifier bugs pre-merge (ceremony
  leakage via test-path tokens; weak-plurality override at MIN_SIGNAL 0.25).
  Decisions `D-qn7z`, `D-24p0`, `D-b1gd`; design spec
  [frame-layers taxonomy](docs/architecture/frame-extraction.md#layer-taxonomy).

## [0.8.3] — 2026-06-12

### Added

- **Field report: Mesh M1 platform-consumer perspective**
  ([`docs/field-reports/field-report-2026-06-12-mesh-m1-platform-consumer.md`](docs/field-reports/field-report-2026-06-12-mesh-m1-platform-consumer.md)):
  the first report written from the seat of a product *built on* Cortex (Mesh
  consumes the HTTP API as a managed sidecar). Documents the decision layer as
  the behavioral moat, an honest token-economics ledger (roughly neutral for a
  build-elsewhere session; the fixed per-turn schema tax is the largest single
  item), search-noise and grep-hook cross-repo friction, and the undocumented
  HTTP surface — with a prioritized P1–P8 mitigation plan (`context_pack`
  composite tool, search ranking, target-repo-aware hook, warm-path decision
  drafting, cross-repo decision search, versioned HTTP contract + freshness
  over HTTP, token-tax reduction, temporal layer).

## [0.8.2] — 2026-06-11

### Fixed

- **Clean builds produced a `dist/` that crashed at startup**: `npm run build`
  (`tsc` alone) copied neither `src/events/worker/schema.sql` (read by
  `EventPersister` at boot) nor `src/events/worker-bootstrap.mjs` (spawned by
  the worker supervisor) into `dist/`. The build script now copies both.
  Surfaced by Mesh, which spawns `node dist/index.js` as its substrate
  sidecar; verified by a clean-build spawn + `/api/projects` health check +
  stdin-EOF shutdown.

## [0.8.1] — 2026-06-11

A reliability + enforcement patch: make `search_code` robust to bad patterns and
timed-out searches, and **enforce** the Cortex-over-grep routing at the harness
instead of merely documenting it — plus a complete MCP tool reference.

### Added

- **Cortex-over-grep enforcement hook** (`hooks/prefer-cortex.sh`): a `PreToolUse`
  hook on `Grep` / `Glob` / `Bash` that, on an indexed repo, **denies
  code-targeted searches** and redirects to `search_code` / `search_graph` (the
  redirect rides back as the denial reason). Policy: _block code, allow non-code_
  — non-code-scoped searches, pipe-filter greps (`ps aux | grep`), and unindexed
  repos pass; a `cortex:grep-ok` token escapes a deliberate code grep. Catches
  `git grep` / `xargs grep` / path-prefixed greps. Degrade-safe (any failure →
  allow). Replaces the prior no-op `echo` hint. (decision `D-sq61`)
- **MCP tools reference** ([`docs/mcp-tools.md`](docs/mcp-tools.md)): every tool's
  purpose, params, return shape, the `repo_path` routing contract, and error
  shapes; linked from `CLAUDE.md` and the architecture index. Synced the
  `CLAUDE.md` tool list (added the previously-omitted PR/contract tools:
  `open_pr`, `add_pr_touch`, `merge_pr`, `get_pr`, `ingest_traces`,
  `check_contracts`).

### Fixed

- **`search_code` returned opaque `internal_error`** mid-traversal on invalid
  regex patterns (rg exit 2) and timed-out searches (SIGTERM). A pure
  `classifySearchExec` now maps rg/grep failures to
  `output | empty | missing | invalid_pattern | error`, routed through by both
  binaries: bad patterns return an actionable `invalid_pattern`; timeouts and
  `maxBuffer` overflows degrade to partial-output-or-empty; only genuinely
  unexpected, output-less failures are errors. `REGEX_ERROR_RE` is anchored to
  phrases the engines actually emit (verified live against rg + GNU/BSD grep).
  (decision `D-2exa`)

### Changed

- **Workflow rule**: every merge to `main` now requires a semver bump (default
  **patch** unless stated minor/major) across `package.json`, `plugin.json`, and
  `.claude-plugin/marketplace.json`, **plus a `CHANGELOG.md` entry**.

## [0.8.0] — 2026-06-10

The v0.3 cycle: Cortex grows from a code-graph MCP server into a **decision-provenance
system** with a **2D frames viewer**, and the native indexer is **split into its own
repository** and consumed as a prebuilt binary. This is the structural / data /
provenance half of the v0.3 design; the "multiplayer canvas" half is descoped (see
_Removed_), and the remaining single-player items (TODO entity, floating-entity
placement, record drawer for TODOs) are deferred to 0.8.5.

### Added

**Decision provenance**
- Durable decision store (`.cortex/decisions.db`, relocated to the per-repo durable
  store under `~/.cortex/<repo-id>/`) that survives every reindex — decisions are
  never overwritten by the derived graph.
- Decision tools: `create_decision`, `update_decision`, `propose_decision`,
  `promote_decision`, `supersede_decision`, `link_decision`, `get_decision`,
  `search_decisions`, `why_was_this_built`, `decision_candidates`, `delete_decision`.
- Decision links key on **stable string qualified-names / file paths / PR numbers**,
  not graph node IDs, so they survive re-indexing.
- **Reconciliation engine** (flag-gated behind `CORTEX_RECONCILE`): hashes the
  working-tree source a decision governs, lets the agent judge match/partial/drift,
  and projects a derived `display_state` (`active` / `active · drifting` / `stale`).
  Tools `record_reconciliation`, `pending_reconciliations`; on-read drift block.
- **Cold-start seeding** (`seed-decisions` skill + `decision_candidates`): frames
  decision candidates from git history + docs for human ratification on a freshly
  indexed repo.

**Frames**
- Frame-extraction pipeline: tf-idf + HDBSCAN clustering, co-change signal,
  framework-aware tokenisation, auxiliary-content detection, two content streams,
  and graph integration.
- **Frame ranking — Path 1**: a deterministic, taxonomy-free budget-cut ranker
  (`score = nameability × structural_weight`) plus a seeded d3-force gravity layout
  behind `/api/frames`.
- **Frame coverage**: HDBSCAN `min_samples` retune + graph-reclamation of residual
  noise to its most-connected cluster — measured semantic-file coverage **29% → 88%**
  on the Cortex graph.

**2D frames viewer**
- Live viewer (`/viewer`) wired to `/api/graph`, `/api/projects`, `/api/decisions`,
  `/api/frames`, with a project switcher, force-directed frame layout, and
  decision **governance pills + record drawer** (decision card / marginalia) on the
  focused frame.

**Native indexer (now a separate project)**
- The indexer ships as a **prebuilt binary** fetched at `postinstall`
  (`scripts/fetch-indexer.mjs`) from a `cortex-indexer` GitHub release, pinned by
  `CORTEX_INDEXER_VERSION`, checksum-verified and cached, with a lazy runtime
  version guard (`ensureIndexer`). `CORTEX_INDEXER_PATH` overrides for local dev.
- Cross-repo binary contract (`--version` JSON, `cli <tool> <json>`, `CORTEX_DB`
  staging target, release asset naming) recorded as a decision in `cortex-indexer`.

**PR data model**
- PR schema + tools (`open_pr`, `add_pr_touch`, `merge_pr`, `get_pr`); data only,
  not yet rendered on canvas.

**Graph storage & multi-project**
- Per-repo canonical graph store `.cortex/db` + a machine-wide project **registry**
  under the XDG data home; durable metadata separated from regenerable cache.
- **MCP multi-project routing**: every tool takes an absolute `repo_path`; decisions
  and graph reads/writes route to the addressed repo instead of pooling into the
  server's home repo.

### Changed

- **Indexer distribution**: replaced the in-tree C build (`internal/indexer/` +
  `scripts/build-indexer.sh`, postinstall compile) with the prebuilt-binary fetch.
  Cortex is now pure TypeScript/MCP and needs no C toolchain to install.
- **Graph publish path**: reindex now builds into a private staging DB and publishes
  into `.cortex/db` via a single libsqlite3 WAL transaction (`publishStagedDb`),
  so the long-lived MCP handle never sees a corrupt/out-of-band rewrite
  (supersedes the former in-place truncate).
- cortex git history was rewritten to sever the `codebase-memory-mcp`/CBM fork
  lineage; that lineage is preserved in `cortex-indexer`.

### Fixed

- **Viewer decisions were not project-scoped**: `/api/decisions` (list + `:id`) read
  from the server's startup-bound home repo, so the viewer showed the home project's
  decisions for every project. Now resolves the requested project's own decisions
  store (`openProjectDecisions`).
- **Decision-governed frames could be invisible**: a decision governing a frame the
  ranker left non-ambient had no on-screen frame to attach to. Such frames are now
  promoted into the render set (`withGovernedFramesRendered`) so their decisions
  always surface. _(Stopgap ahead of the 0.8.5 floating-entity work.)_
- Removed the legacy `CBM_BINARY_PATH` alias and all `cbm` naming residue from the
  cortex tree.

### Removed

- **Multiplayer scenario DSL** (spec §9.3) and the **multiplayer canvas chrome**
  (merge animation, agent cursors) are not being pursued.
- `codebase-memory-mcp` MIT attribution moved out of cortex (into `cortex-indexer`,
  where the derived code now lives); cortex is wholly proprietary.

### Deferred to 0.8.5

- **TODO entity** (schema, state machine, tools, external bridge) — the headline
  0.8.5 feature.
- **Floating-entity placement** of post-reclamation residual nodes + aggregates.
- **Record drawer adoption for TODOs** (the drawer already ships for decisions).

[1.9.0]: https://github.com/ruevu/cortex/releases/tag/v1.9.0
[1.8.2]: https://github.com/ruevu/cortex/releases/tag/v1.8.2
[1.8.1]: https://github.com/ruevu/cortex/releases/tag/v1.8.1
[1.8.0]: https://github.com/ruevu/cortex/releases/tag/v1.8.0
[1.7.0]: https://github.com/ruevu/cortex/releases/tag/v1.7.0
[1.6.0]: https://github.com/ruevu/cortex/releases/tag/v1.6.0
[1.5.1]: https://github.com/ruevu/cortex/releases/tag/v1.5.1
[1.5.0]: https://github.com/ruevu/cortex/releases/tag/v1.5.0
[1.4.8]: https://github.com/ruevu/cortex/releases/tag/v1.4.8
[1.4.7]: https://github.com/ruevu/cortex/releases/tag/v1.4.7
[1.4.6]: https://github.com/ruevu/cortex/releases/tag/v1.4.6
[1.4.5]: https://github.com/ruevu/cortex/releases/tag/v1.4.5
[1.4.4]: https://github.com/ruevu/cortex/releases/tag/v1.4.4
[1.4.3]: https://github.com/ruevu/cortex/releases/tag/v1.4.3
[1.4.2]: https://github.com/ruevu/cortex/releases/tag/v1.4.2
[1.4.1]: https://github.com/ruevu/cortex/releases/tag/v1.4.1
[1.4.0]: https://github.com/ruevu/cortex/releases/tag/v1.4.0
[1.3.2]: https://github.com/ruevu/cortex/releases/tag/v1.3.2
[1.3.1]: https://github.com/ruevu/cortex/releases/tag/v1.3.1
[1.3.0]: https://github.com/ruevu/cortex/releases/tag/v1.3.0
[1.2.6]: https://github.com/ruevu/cortex/releases/tag/v1.2.6
[1.2.5]: https://github.com/ruevu/cortex/releases/tag/v1.2.5
[1.2.4]: https://github.com/ruevu/cortex/releases/tag/v1.2.4
[1.2.3]: https://github.com/ruevu/cortex/releases/tag/v1.2.3
[1.2.2]: https://github.com/ruevu/cortex/releases/tag/v1.2.2
[1.2.1]: https://github.com/ruevu/cortex/releases/tag/v1.2.1
[1.2.0]: https://github.com/ruevu/cortex/releases/tag/v1.2.0
[1.1.3]: https://github.com/ruevu/cortex/releases/tag/v1.1.3
[1.1.2]: https://github.com/ruevu/cortex/releases/tag/v1.1.2
[1.1.1]: https://github.com/ruevu/cortex/releases/tag/v1.1.1
[1.1.0]: https://github.com/ruevu/cortex/releases/tag/v1.1.0
[1.0.3]: https://github.com/ruevu/cortex/releases/tag/v1.0.3
[1.0.2]: https://github.com/ruevu/cortex/releases/tag/v1.0.2
[1.0.1]: https://github.com/ruevu/cortex/releases/tag/v1.0.1
[1.0.0]: https://github.com/ruevu/cortex/releases/tag/v1.0.0
[0.9.0]: https://github.com/ruevu/cortex/releases/tag/v0.9.0
[0.8.24]: https://github.com/ruevu/cortex/releases/tag/v0.8.24
[0.8.23]: https://github.com/ruevu/cortex/releases/tag/v0.8.23
[0.8.22]: https://github.com/ruevu/cortex/releases/tag/v0.8.22
[0.8.21]: https://github.com/ruevu/cortex/releases/tag/v0.8.21
[0.8.20]: https://github.com/ruevu/cortex/releases/tag/v0.8.20
[0.8.19]: https://github.com/ruevu/cortex/releases/tag/v0.8.19
[0.8.18]: https://github.com/ruevu/cortex/releases/tag/v0.8.18
[0.8.17]: https://github.com/ruevu/cortex/releases/tag/v0.8.17
[0.8.16]: https://github.com/ruevu/cortex/releases/tag/v0.8.16
[0.8.15]: https://github.com/ruevu/cortex/releases/tag/v0.8.15
[0.8.14]: https://github.com/ruevu/cortex/releases/tag/v0.8.14
[0.8.13]: https://github.com/ruevu/cortex/releases/tag/v0.8.13
[0.8.12]: https://github.com/ruevu/cortex/releases/tag/v0.8.12
[0.8.11]: https://github.com/ruevu/cortex/releases/tag/v0.8.11
[0.8.10]: https://github.com/ruevu/cortex/releases/tag/v0.8.10
[0.8.9]: https://github.com/ruevu/cortex/releases/tag/v0.8.9
[0.8.8]: https://github.com/ruevu/cortex/releases/tag/v0.8.8
[0.8.7]: https://github.com/ruevu/cortex/releases/tag/v0.8.7
[0.8.6]: https://github.com/ruevu/cortex/releases/tag/v0.8.6
[0.8.5]: https://github.com/ruevu/cortex/releases/tag/v0.8.5
[0.8.4]: https://github.com/ruevu/cortex/releases/tag/v0.8.4
[0.8.3]: https://github.com/ruevu/cortex/releases/tag/v0.8.3
[0.8.2]: https://github.com/ruevu/cortex/releases/tag/v0.8.2
[0.8.1]: https://github.com/ruevu/cortex/releases/tag/v0.8.1
[0.8.0]: https://github.com/ruevu/cortex/releases/tag/v0.8.0
[0.2.0]: https://github.com/ruevu/cortex/releases/tag/v0.2.0
