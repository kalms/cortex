# Doc sweep follow-up — dead UUID references after the short-id cutover

**Status:** deferred to post-merge (cannot be completed in-branch — see why below)
**Relates to:** [2026-06-08-short-primitive-ids.md](2026-06-08-short-primitive-ids.md) Task 8

## Why this can't be done in the feature branch

The hard-cutover migration (`migrateDecisionIdsToShortForm`) rewrites every
UUID-keyed decision in the **live** `.cortex/decisions.db` to a short `D-<token>`
id and assigns a per-repo `seq`. That old→new id map only materialises when the
migration actually runs against the real decisions DB — which happens at server
startup *after this branch merges*. In the feature branch there is no migrated
live DB, so any `04c848f0 → D-N` rewrite here would be a guess. We do not write
guessed ids.

## Procedure (run once, after merge + first server start)

1. Let the server start so `migrateDecisionIdsToShortForm` runs against the real
   `.cortex/decisions.db` (or run an index/CLI command that opens it).
2. For each reference below, resolve the decision by title/content via
   `search_decisions` (or read the migrated row) to get its new `D-<seq>` id.
3. Replace the dead reference with the new `D-<seq>` id. Leave genuinely
   archival references (old field reports) as-is unless they aid navigation.
4. Commit as `docs: update decision references to D-<seq> short ids`.

## References to update

| File | Line | Current reference | Disposition |
|---|---|---|---|
| `CLAUDE.md` | ~57 | `decision \`04c848f0\`` (in-place incremental indexing) | **Rewrite** — live, load-bearing prose; replace with the migrated `D-<seq>`. |
| `docs/specs/cortex-v0.3/frame-extraction.md` | ~634 | `fa6aedaf-479b-4a40-96b7-1500a1973428` (already noted superseded) | Optional — archival; rewrite only if the decision survives and the link helps. |
| `docs/field reports/field-report-2026-05-21-vue-graph-and-decision-input.md` | ~171 | `cb1f6090-d9a7-4170-bf11-09a5bfd60c28` | Leave as-is — historical field report; archival. |

## Explicitly NOT references (do not touch)

- `docs/superpowers/plans/2026-06-08-short-primitive-ids.md` lines ~593–594 use
  `04c848f0-0000-…` as **test fixture** UUIDs in the migration test code. They
  are intentional and must stay.
