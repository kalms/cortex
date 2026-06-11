# Changelog

All notable changes to Cortex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and Cortex aims for
[Semantic Versioning](https://semver.org/).

## [0.3.1] — 2026-06-11

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

## [0.3.0] — 2026-06-10

The v0.3 cycle: Cortex grows from a code-graph MCP server into a **decision-provenance
system** with a **2D frames viewer**, and the native indexer is **split into its own
repository** and consumed as a prebuilt binary. This is the structural / data /
provenance half of the v0.3 design; the "multiplayer canvas" half is descoped (see
_Removed_), and the remaining single-player items (TODO entity, floating-entity
placement, record drawer for TODOs) are deferred to 0.3.5.

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
  always surface. _(Stopgap ahead of the 0.3.5 floating-entity work.)_
- Removed the legacy `CBM_BINARY_PATH` alias and all `cbm` naming residue from the
  cortex tree.

### Removed

- **Multiplayer scenario DSL** (spec §9.3) and the **multiplayer canvas chrome**
  (merge animation, agent cursors) are not being pursued.
- `codebase-memory-mcp` MIT attribution moved out of cortex (into `cortex-indexer`,
  where the derived code now lives); cortex is wholly proprietary.

### Deferred to 0.3.5

- **TODO entity** (schema, state machine, tools, external bridge) — the headline
  0.3.5 feature.
- **Floating-entity placement** of post-reclamation residual nodes + aggregates.
- **Record drawer adoption for TODOs** (the drawer already ships for decisions).

[0.3.1]: https://github.com/ruevu/cortex/releases/tag/v0.3.1
[0.3.0]: https://github.com/ruevu/cortex/releases/tag/v0.3.0
[0.2.0]: https://github.com/ruevu/cortex/releases/tag/v0.2.0
