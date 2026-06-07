# Graph Freshness Signal + Out-of-Band Auto-Refresh — Design

**Date:** 2026-06-07
**Status:** Approved (brainstorm) → ready for implementation plan
**Decision context:** Tier-1 of the "trust the graph over grep" goal.

## Problem

Agents reach for `grep`/`Read` instead of the Cortex graph tools when they
cannot trust the graph reflects what is on disk. This session proved it
concretely: `.cortex/db` had drifted to **0 bytes** and the read path silently
fell back to a 2-day-old `graph.db` (no frames, no contract edges,
`project=""`). Nothing surfaced this, so the only way to know was to inspect the
DB by hand — i.e. exactly the kind of out-of-band verification that makes an
agent stop trusting the tool and grep instead.

Two failure modes, both silent today:
1. **Staleness** — the working tree (commits and/or uncommitted edits) has moved
   past what was indexed; reads return plausible-but-outdated structure.
2. **Degraded read** — the canonical `.cortex/db` is empty/0-byte and reads fall
   back to a stale legacy `graph.db`, with no signal.

A read result an agent cannot date is a read result an agent will double-check
with grep.

## Goals

- Every graph **read** carries a freshness signal the agent sees at the moment
  it decides whether to trust the result.
- The **degraded/fallback** case is loud, not silent.
- The graph is kept fresh automatically where it is **safe** to do so, since
  reindex is cheap on most codebases (full reindex of cortex ≈ 6s; incremental
  ≈ sub-second).
- No false "fresh" when unindexed changes exist; no constant-red during normal
  heavy-dev editing (avoid alarm fatigue).

## Non-Goals

- Reindexing **inside** a per-call read tool (blocking, racy — see Safety
  Invariants).
- A general background file-watcher / editor-save debounce daemon (the
  post-commit boundary covers the high-value case; a watcher can come later).
- Changing the DB fallback-resolution logic itself (we *flag* the fallback; we
  do not rewrite how it is chosen).

## Approach (chosen: all-TS, resolver chokepoint)

Baseline written at index time (TS post-step, reusing git calls the index paths
already make); per-call check is a memoized TS helper invoked at the
`registerTool` chokepoint so every read tool is covered uniformly; banner via a
`cortex freshness` CLI command; auto-refresh driven out-of-band by the same
signal. No C changes, no binary rebuild.

Rejected: C-side baseline (needs a C change + rebuild for a value TS already
computes for the cache key); stat/mtime-only heuristic (crude, weak on the
commit case).

## Data Model

### Baseline — `cortex_index_meta` (key/value table in the graph DB)

Written **idempotently** as a post-index step by both index paths
(`index_repository` in `src/mcp-server/tools/code-tools.ts`, and
`runIndexCommand` in `src/cli/commands/index.ts`):

| key                  | value                                                          |
|----------------------|----------------------------------------------------------------|
| `indexed_commit`     | `git rev-parse HEAD` at index time (empty if non-git)          |
| `indexed_dirty_sig`  | `sha1(git status --porcelain --untracked-files=normal)`        |
| `indexed_at`         | ISO-8601 timestamp                                             |

`indexed_dirty_sig` captures the **exact working-tree state that was indexed**.
This is the key subtlety: indexing a dirty tree records that dirty state, so the
tree reads `fresh` immediately after — only *further* edits flip it to stale.
That avoids both false-fresh (unindexed changes present) and constant-red
(everything always "dirty" during heavy dev).

### Freshness result

```ts
type FreshnessState =
  | "fresh"          // disk state == indexed state
  | "stale:commits"  // HEAD moved since index
  | "stale:dirty"    // working tree differs from indexed dirty state
  | "stale:both"
  | "empty"          // degraded: 0-byte / legacy fallback / 0 nodes
  | "unknown";       // no baseline (pre-feature index) or non-git dir

interface Freshness {
  state: FreshnessState;
  commits_behind?: number;  // when computable; omitted after a rebase
  dirty?: boolean;
  indexed_at?: string;
  note?: string;            // human-facing, e.g. "3 files changed since index; reindex to refresh"
}
```

## Algorithm — `src/mcp-server/freshness.ts`

`computeFreshness({ repoPath, dbPath, store, canonical }): Freshness`, memoized
2 s per `repoPath` (module-level `Map<string,{value,expiresAt}>`):

1. **Degraded first.** If `canonical === false` (resolver opened a non-`.cortex/db`
   fallback), or `.cortex/db` is 0 bytes, or node-count is 0 → `state: "empty"`,
   note "reindex needed".
2. **No baseline / non-git.** `cortex_index_meta` absent → `state: "unknown"`,
   note "indexed before freshness tracking; reindex to enable" (or "not a git
   repository" when git is unavailable).
3. **Compare.** `curHead = git rev-parse HEAD`; `curDirtySig = sha1(git status --porcelain)`:
   - `curHead === indexed_commit && curDirtySig === indexed_dirty_sig` → `fresh`
   - HEAD differs → `stale:commits` (+ `commits_behind` via
     `git rev-list --count indexed_commit..HEAD`; omit on failure, e.g. rebase)
   - dirty sig differs → `stale:dirty`
   - both → `stale:both`

`invalidateFreshness(repoPath)` clears the memo; called at the end of
`index_repository` and `detect_changes`.

Cost: ≤ 2 git calls (`rev-parse`, `status --porcelain`) per cold check,
absorbed by the 2 s memo across bursts of reads.

## Integration

### a) Per-call attach (chokepoint)

In `registerTool` (`src/mcp-server/repo-context.ts`), the indexed path resolves
`ctx` then calls the handler. After the handler returns, `attachFreshness(result, ctx)`:
- computes the memoized freshness for `ctx.repoPath`;
- if `state !== "fresh"`, attaches a compact `freshness` object to the result
  **and** appends a one-line note to the MCP text content (e.g.
  `⚠ cortex freshness: stale:dirty — 3 files changed since index; results may be stale, reindex to refresh`)
  so the agent sees it whether or not it parses structured fields.

Opt-in via a `freshnessAware?: boolean` flag on `registerTool` options, set on
the **read** tools: `search_graph`, `get_code_snippet`, `trace_path`,
`query_graph`, `search_code`, `get_architecture`, `why_was_this_built`. Skipped
for write/index/crossRepo tools (`index_repository`, `detect_changes`,
`list_projects`, decision writes).

### b) Resolver exposes canonicity

`RepoContextResolver.resolve` already selects the DB path; surface
`canonical: boolean` (and the resolved path) on `RepoContext` so the degraded
check distinguishes a `.cortex/db` hit from a legacy `graph.db` fallback. This
is the piece that makes the silent fallback loud.

### c) Banner + CLI

- New `cortex freshness` CLI command — prints the `Freshness` for the cwd repo.
- Rewrite `hooks/check-index.sh` "indexed" detection: a **0-byte `.cortex/db`
  must not read as indexed**; call `cortex freshness` and print state into the
  SessionStart banner
  (`Index state: indexed (stale:dirty — 3 changed)` / `(degraded — reindex)`).

### d) Memo invalidation

`invalidateFreshness(repoPath)` at the end of `index_repository` and
`detect_changes`, so a reindex reads `fresh` immediately rather than after the
2 s TTL.

## Auto-Refresh (out-of-band)

Driven by the freshness signal at **safe boundaries only**, always **incremental**
(scoped to `detect_changes`-affected files, in-place — never the destructive
full delete+recreate during an active session):

- **SessionStart hook** (`check-index.sh`), after computing freshness:
  - `empty`/`unknown` → run a **full** index *synchronously* with a "building
    index…" message. Safe: this runs before the agent issues any reads, so there
    is no concurrent-read race against the destructive rebuild.
  - `stale:*` → run an **incremental** reindex (sub-second).
  - `fresh` → nothing.
- **Post-commit boundary** → incremental reindex. A commit is the clean,
  non-racy moment (HEAD moved, edit-storm paused). Wired via a Claude Code
  `PostToolUse` hook matching `git commit` (plugin-managed; exact matcher is an
  implementation detail of the plan).

### Safety Invariants (normative)

1. A per-call read tool **never** triggers a reindex and **never** blocks on one.
2. A **destructive** full reindex (delete+recreate `.cortex/db`) is run
   automatically **only** at SessionStart before any reads, or on explicit
   user/agent action — never from an in-session background trigger.
3. In-session auto-refresh is **incremental and in-place** only.
4. Escape hatches: `CORTEX_FRESHNESS=0` disables the whole feature;
   `CORTEX_AUTO_REFRESH=0` keeps the signal but disables auto-refresh.

> **Plan prerequisite:** confirm the incremental pipeline
> (`pipeline_incremental.c`) updates the store **in place** (does not
> delete+recreate `.cortex/db`). If it is not safe for concurrent reads, gate
> in-session incremental refresh behind that guarantee.

## Edge Cases

- **Non-git directory** → `unknown`; feature no-ops, reads unaffected.
- **Detached HEAD / shallow / rebased-away `indexed_commit`** → `stale:commits`
  without `commits_behind`, graceful.
- **Indexed on a dirty tree** → `fresh` until further edits (the `dirty_sig`
  invariant).
- **Large repo** → `git status` cost absorbed by the 2 s memo.
- **Concurrent reindex** → incremental in-place is safe; full reindex confined
  to safe windows (invariant 2).

## Testing

- **Unit (deterministic; temp git repo + fabricated `cortex_index_meta`):**
  every `computeFreshness` state; the `dirty_sig` invariant (index dirty →
  `fresh`; edit → `stale:dirty`; commit → `stale:commits`); degraded detection
  (0-byte db, legacy fallback, 0 nodes); `attachFreshness` (attaches + appends
  note when stale, skips when fresh); memo TTL + `invalidateFreshness`.
- **Integration:** index → `fresh`; touch a file → `stale:dirty`; commit →
  `stale:commits`; reindex → `fresh`. Assert incremental refresh is
  non-destructive (`.cortex/db` not zeroed/recreated mid-op).
- **CLI:** `cortex freshness` output shape.

## Rollout / Sequencing (for the plan)

1. Baseline write (`cortex_index_meta`) + `computeFreshness` + unit tests.
2. Resolver `canonical` flag + degraded detection.
3. `registerTool` `freshnessAware` attach + read-tool opt-in.
4. `cortex freshness` CLI + `check-index.sh` banner rewrite.
5. SessionStart auto-refresh (incremental for `stale:*`, full for
   `empty`/`unknown`) behind the in-place-incremental guarantee.
6. Post-commit `PostToolUse` incremental trigger.

Steps 1–4 deliver the trust signal; 5–6 deliver auto-refresh. Each step is
independently shippable.
