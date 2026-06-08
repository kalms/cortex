# Short, readable IDs for Cortex primitives — design

**Date:** 2026-06-08
**Status:** approved (brainstorm), pending implementation plan
**Branch:** `feature/db/short-primitive-ids`

## Problem

Decisions are stored with full `randomUUID()` primary keys (36 chars). The
canvas/viewer, marginalia pills, and prose references all have to truncate
them to 8-char prefixes (`04c848f0`) to be legible. Long opaque IDs:

- are hard to scan visually on the ambient canvas and in marginalia;
- crowd out room for the different list types / marginalia treatments the
  v0.3 spec calls for;
- don't match the spec, which already specifies `D-<number>` for decisions
  (`cortex-multiplayer-spec.md` §3.2) and `T-<number>` for TODOs
  (`todo-entity.md`).

The goal: short, readable, typed IDs for the user-facing primitives, while
keeping a storage key that is stable across re-index and **across the
`decision rehome` operation** (which physically moves a decision between
per-repo DBs).

This applies to all user-facing primitive types, not just decisions.

## Scope

In scope:

| Type | Prefix | Treatment |
|---|---|---|
| Decision | `D-` | Full: random canonical id + per-repo `seq`. **Live migration target.** |
| TODO | `T-` | Full: random canonical id + per-repo `seq`. *Entity not yet implemented — design defines the scheme for when it lands.* |
| Pull request | `PR-` | Display prefix only. Identity stays the real GitHub number. No random canonical, no Cortex `seq`. |

Out of scope (explicitly):

- **Frames** — identified by name/path today; not given short ids in this pass.
- **Code nodes & edges** — thousands of rows, already addressed by
  `qualified_name`; adding per-row counters is high-cost / low-value.

## ID model

Every in-scope *full-treatment* primitive (decisions, future TODOs) carries
two identifiers:

| Field | Example | Role | Stability |
|---|---|---|---|
| `id` (canonical PK) | `D-9m2x` | stored PK, link target, value agents pass to tools | permanent; never reassigned |
| `seq` (int) | `12` → shown `D-12` | friendly display number in viewer/marginalia | assigned once at creation; gaps on delete; **reassigned on rehome** |

### Canonical id

- Format: `<PREFIX>-<token>` where `token` is 4 characters of lowercase
  **Crockford base32** (alphabet `0123456789abcdefghjkmnpqrstvwxyz` —
  excludes `i l o u` to avoid visual ambiguity).
- ~1.05M (32⁴) values per type per repo — far beyond any realistic decision
  count; collisions are checked against the DB at mint time and regenerated.
- **Generation invariant:** a minted token always contains **at least one
  letter** (regenerate if all-digit). This keeps the canonical namespace
  disjoint from the all-digit `seq` namespace (see disambiguation below).

### Why a random canonical *and* a stable seq

A seq-based PK (`D-12`) would be the obvious "readable" key, but
`decision rehome <id> --to=<path>` moves a decision into another repo's
`.cortex/decisions.db`. If the PK were `D-12`, it would collide with the
destination repo's own `D-12`. The opaque random canonical `D-9m2x` survives
a rehome untouched; only its `seq` is reassigned from the destination repo's
counter. The random id is therefore the durable cross-repo handle; the seq is
a per-repo presentation nicety.

### Both forms are citeable

Tools (`get_decision`, `why_was_this_built`, `link_decision`, `governs`, …)
accept **either** form, disambiguated by a single rule with no extra sigil:

- token matches `^\d+$` (all digits) → **seq** lookup on `(type, seq)`
- otherwise → **canonical** lookup on `id`

Because minted canonical tokens always contain ≥1 letter, `D-1234` (a seq) and
any random token can never be confused. The seq form resolves to the canonical
row, so links are always *stored* against the canonical `id`.

### PRs are special

`PR-142` is display sugar over the real GitHub PR number `142`. PRs get **no**
random canonical and **no** Cortex seq. PR↔decision links continue to key on
the GitHub number (stable across re-index, as today).

## Storage & generation

- New table in `decisions.db`:

  ```sql
  CREATE TABLE IF NOT EXISTS id_sequences (
    entity_type TEXT PRIMARY KEY,   -- 'decision', 'todo'
    next_val    INTEGER NOT NULL    -- next seq to hand out
  );
  ```

- New `decisions` columns (additive): `seq INTEGER`. The canonical id stays in
  the existing `id` PK column (its *value* changes shape, the column does not).

- A shared `src/ids/` module — the single chokepoint, reused by decisions now
  and TODOs later:
  - `mintId(type): { id, seq }` — allocates `seq` (increment `id_sequences`)
    and a collision-free canonical token **in one transaction** with the row
    insert, so concurrent creates cannot collide on either field.
  - `resolveRef(type, token): canonicalId | null` — implements the
    digit-vs-letter disambiguation rule.
  - `formatDisplay(type, seq): string` — e.g. `D-12` (viewer/marginalia).

- FTS is unaffected: `decisions_fts` is keyed on `rowid`, not `id`.

## Migration — hard cutover

A one-shot, idempotent migration (same pattern as
`src/decisions/migration.ts`), guarded by a `schema_meta` flag, run at server
startup and defensively at the top of `index_repository`. UUIDs are **dropped**
— there is no `legacy_uuid` column.

In a single transaction it must remap **every** site where a decision id
appears:

1. `decisions.id` (PK) → new `D-<random>`; assign `seq` in `created_at` order
   so `D-1` is the oldest decision.
2. `decisions.superseded_by` (self-reference) → remapped to the new id.
3. `decision_links.decision_id` (FK) → remapped.
4. `decision_links.target_ref` where `target_kind = 'decision'` (supersession
   targets stored as links) → remapped.

Because `decision_links.decision_id` has `ON DELETE CASCADE` and `foreign_keys`
is ON, the remap builds the old→new map first, then updates in dependency-safe
order (or temporarily defers FK enforcement within the transaction).

### Consequence & mitigation

External prose references to old UUID prefixes (CLAUDE.md, `docs/`, old field
reports) go **dead** after cutover. Mitigation: a one-time sweep that rewrites
known `04c848f0`-style references to their new `D-N` ids where the old→new map
resolves them; unmappable historical prose is left as-is.

## Viewer / display

- Monospace, color-coded per the v0.3 spec: **green** `D-`, **yellow** `T-`,
  **indigo** `PR-`.
- Pills / marginalia render `D-12 · LOD band projection` using `seq`.
- Optional zero-padding (`D-012`) is a pure viewer formatting choice; `seq`
  stays an integer in storage.

## Testing

- `src/ids/` unit tests: mint uniqueness, all-digit-token rejection,
  `resolveRef` disambiguation (seq vs canonical), display formatting.
- Migration test: seed a DB with UUID-keyed decisions + links + supersession +
  PR links, run migration, assert all four remap sites are consistent, ids are
  `D-<n>` shaped, seq order matches `created_at`, idempotency on re-run.
- Regression: the existing cross-repo isolation test must still pass; add a
  rehome test asserting canonical id is preserved and seq is reassigned from
  the destination counter.
- Tool contract: `get_decision` / `link_decision` accept both seq and
  canonical forms and resolve to the same row.

## Open questions / future

- TODO entity is not yet implemented; this design only reserves `T-` and the
  shared minting path for it.
- Frames may warrant `F-` ids in a later pass if marginalia density demands it.
