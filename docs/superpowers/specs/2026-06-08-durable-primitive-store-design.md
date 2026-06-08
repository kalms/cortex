# Durable primitive store — relocation + store-agnostic interface

**Date:** 2026-06-08
**Status:** draft (brainstorm), pending user review → implementation plan
**Branch:** `feature/db/durable-primitive-store`
**Absorbs:** `2026-06-08-short-primitive-ids-design.md` (the ID scheme becomes a
component of this store; that spec's "DB-as-source-of-truth migration" is
reframed here).

## Problem

Durable, *authored* primitives — decisions today, TODOs next — live in
`<repo>/.cortex/decisions.db`. That location is wrong on two counts:

1. **It's a derived-cache directory.** `.cortex/` is gitignored and holds the
   regenerable graph DB (`db`, rebuilt on every index, replace-all dump). The
   durable, non-regenerable decisions DB was dropped into the same disposable
   bucket.
2. **It's per-worktree.** `resolveDecisionsDbPath` resolves to the *current*
   gitroot, and a git worktree's root is the worktree. So each branch/worktree
   gets its own isolated decisions DB. Observed: the `short-primitive-ids`
   worktree has **0** decisions; `main` has **29**. Authored knowledge created
   on one branch is stranded; it does not travel to other worktrees, to a fresh
   clone, or to a teammate.

This is the same class as the recurring "wrong DB" pollution (decision
`86c15efd`): durable and derived state conflated in one unstable location.

A separate in-flight design (`short-primitive-ids`) gives decisions/TODOs short
readable IDs (`D-9m2x` canonical + `D-12` display seq). Its random canonical PK
is exactly the collision-free key a multi-writer/sync world needs — but it was
scoped against the current (mislocated, per-worktree) store. The two efforts
reconcile here.

## Goals

- Relocate durable primitives to a **stable, out-of-repo, repo-keyed** store
  shared by all worktrees/branches of a repo on one machine.
- Introduce a **store-agnostic repository/mutation interface** so the backing
  engine is an implementation detail, swappable without touching call sites.
- Be **forward-compatible with team-realtime sync** (no schema/interface rewrite
  required to adopt it later).
- **Migrate** the existing decisions; preserve cross-repo isolation and
  `decision rehome` semantics.
- **Absorb** the `short-primitive-ids` ID scheme.

## Non-goals (explicitly deferred)

- **Standing up any sync substrate now.** Near-term is single-user, multiple
  worktrees; a shared local store suffices. No cloud Postgres, no replication
  service, no daemon.
- **Choosing the realtime transport.** Neon-Postgres-upstream + PowerSync/
  ElectricSQL, or libSQL embedded replicas, or cr-sqlite CRDT — all keep SQLite
  local and all accept the random canonical key. Recorded as a deferred,
  compatible upgrade; decided when team-realtime work begins.
- **Frame ranking.** Builds on this store; its own spec follows.
- Code nodes/edges and frames keep their current identity (qualified-name /
  name+path); unchanged here.

## Design

### 1. Storage location — out-of-repo, repo-keyed

Durable primitives move to an XDG data-home location, sibling to the existing
project registry (`~/.local/share/cortex-indexer/registry.db`), consistent with
the principle already stated in `graph-storage.md`: *durable metadata lives
under the XDG data home, not the regenerable cache.*

```
~/.local/share/cortex/<repo-key>/decisions.db      # (todos.db, etc. later)
```

- **`~/.local/share/cortex/`** (honoring `$XDG_DATA_HOME`). `~/.cortex/` is a
  friendlier, more-discoverable alternative — **decision for the user at review
  time**; both are out-of-repo and equivalent for the design.
- **`<repo-key>`** = canonical repo identity, *stable across worktrees*.
  Derived from the main working tree, resolved via
  `git rev-parse --git-common-dir` (→ its parent is the primary worktree),
  then keyed the same way the registry keys repos (`root_path` slug). Every
  worktree of a repo maps to **one** key → **one** store.
- The **graph DB stays** at `<repo>/.cortex/db` — it is derived and per-worktree
  is fine (each branch can index its own code).

### 2. Resolution change

`resolveDecisionsDbPath` (and a future `resolveTodoStorePath`) resolve to the
out-of-repo, repo-keyed home — not `<gitroot>/.cortex/decisions.db`. They become
worktree-aware via `git-common-dir`. The `$CORTEX_DECISIONS_DB` override is
retained (tests, isolation). This is the single chokepoint, mirroring how
`resolve-path.ts` already centralizes graph-DB resolution.

### 3. Store-agnostic interface (the load-bearing abstraction)

All durable-primitive access goes through a **repository/mutation contract**
that names *what* happens, not *where* it is stored:

```
DurablePrimitiveStore:
  create(entity) · update(id, patch) · get(ref) · search(query)
  link(from, to, relation) · supersede(id, by) · recordReconciliation(...)
```

- v1 implementation: better-sqlite3 against the relocated local DB (today's
  `DecisionsRepository` / `DecisionLinksRepository`, re-homed behind the
  interface).
- Mutations are modeled as **discrete, replayable operations** (create/update/
  link/supersede), not ad-hoc SQL at call sites — so they can later be emitted
  as events (the existing `events.db` pipeline) or fed to a CRDT/sync engine.
- The interface is the seam the substrate swaps beneath: local SQLite →
  Neon-upstream + local replica, or libSQL, or cr-sqlite. Call sites and schema
  are untouched by that swap.

### 4. ID scheme (absorbed from `short-primitive-ids`)

- **Canonical PK**: `<PREFIX>-<4-char lowercase Crockford base32>`, ≥1 letter
  (disjoint from the all-digit seq namespace), collision-checked at mint. The
  durable, rehome-stable, **merge/sync key**.
- **Display `seq`**: per-repo integer rendered `D-12`; assigned at creation,
  reassigned on rehome. Presentation only.
- `resolveRef`: all-digits → seq lookup; otherwise → canonical lookup. Links
  always store the canonical id.
- PRs: display sugar over the GitHub number; no canonical, no seq.
- Shared `src/ids/` chokepoint (`mintId`, `resolveRef`, `formatDisplay`), reused
  by decisions now and TODOs later.

### 5. Migration

One-shot, idempotent (server startup + defensively at the top of
`index_repository`), guarded by a `schema_meta` flag — the established pattern in
`src/decisions/migration.ts`. In one transaction:

1. **Relocate**: move/copy the repo's decisions from
   `<repo>/.cortex/decisions.db` to the repo-keyed XDG store. Consolidates any
   per-worktree DBs for the same repo-key into the single store (last-write or
   union by canonical id; union preferred — distinct decisions merge cleanly via
   distinct random canonicals).
2. **Re-key** UUID → `D-<random>`: PK, `superseded_by`, `decision_links.
   decision_id`, and `decision_links.target_ref` where `target_kind='decision'`;
   assign `seq` in `created_at` order. (FK-safe order or deferred FK enforcement,
   per the short-primitive-ids migration.)
3. Leave the now-empty `<repo>/.cortex/decisions.db` behind (or remove it);
   `.cortex/` stays gitignored.

Live-DB safety: checkpoint WAL before the move; the MCP server's open handle is
re-pointed at the new path on next open.

### 6. Team-realtime (deferred, documented seams)

When team-realtime work begins, the store-agnostic interface (3), discrete
mutations, and random canonical keys (4) are the seams that make it a
transport swap, not a rewrite:

- **Neon Postgres upstream + local SQLite replica** via PowerSync (offline
  read+write) or ElectricSQL (read-path; writes via API). Postgres gives the
  strongest schema governance; Neon branching can mirror git branches.
- **or** libSQL embedded replicas / cr-sqlite CRDT — pure-SQLite paths.

All keep SQLite local; none require changing the schema or the interface. (See
the substrate decision for the full rationale.)

## Verification

- **Migration**: seed a UUID-keyed decisions DB (+ links, supersession, PR
  links) at the old per-repo path; run migration; assert relocation to the
  repo-keyed store, all four remap sites consistent, `D-<n>` shapes, seq in
  `created_at` order, idempotent on re-run.
- **Cross-worktree** (the core fix): two worktrees of one repo resolve to the
  **same** store and observe the **same** decisions.
- **Repo-key stability**: same key from main worktree and from a linked
  worktree (`git-common-dir`); distinct repos get distinct keys.
- **Regression**: the existing `decisions-cross-repo-isolation` test must pass;
  add a `rehome` test (canonical preserved, seq reassigned from destination).
- **Interface**: call sites depend only on `DurablePrimitiveStore`; a fake
  in-memory implementation satisfies the contract (proves the abstraction).

## Risks / open questions

- **Repo-key edge cases**: bare/no-git dirs, submodules, a repo physically
  moved/renamed (key derived from path slug would change). Need fallback +
  possibly a stable repo identifier (e.g. first-commit hash or remote URL) —
  resolve in the plan.
- **Existing distributed decisions**: decisions presently live in *multiple*
  per-worktree DBs (main has 29; worktrees have their own). Migration must
  union them under the repo-key, not clobber. Random canonicals make the union
  safe; collisions are astronomically unlikely and checked.
- **`~/.local/share/cortex` vs `~/.cortex`**: user's call at review.
- **Coordination with `short-primitive-ids` branch**: that branch holds the ID
  spec + plan (no code yet). This spec supersedes its storage framing; the two
  plans should merge so the ID scheme and relocation land together (one
  migration, not two).
- **Decisions referencing branch-only code**: a shared store makes a decision
  visible on branches whose governed code doesn't exist yet. Acceptable —
  decisions are repo-level knowledge; governance resolves by qn/path and
  tolerates absent targets.

## Relationship to other specs

- **Supersedes/absorbs** `2026-06-08-short-primitive-ids-design.md`.
- **Unblocks** the frame-ranking spec (computed frame state gets a durable home
  that survives worktree churn).
- **Extends** the storage model in `docs/architecture/graph-storage.md` and
  `docs/architecture/decisions-storage.md` (durable vs derived split made
  explicit; durable moves out of `.cortex/`).
