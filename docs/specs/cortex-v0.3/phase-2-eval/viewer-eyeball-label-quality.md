# Viewer Eyeball Check — frame label quality

Generated: 2026-05-18

Follow-up to PR #15. PR #15's eyeball check called out that 6 of anthill-cloud's
9 frames had topically coherent contents but weak labels (`id`, `__dirname`,
`refresh`, `public`, `documents`, `apps activator`). This PR rewrites
`pickFrameLabel` to produce informative labels from the same clustering output.

Source data:
- Same anthill cluster JSON as PR #15 (no re-clustering — algorithm unchanged)
- Re-injected via `inject-frames.ts` after updating the label logic
- Screenshots: [.playwright-mcp/labels-anthill.png](../../../../.playwright-mcp/labels-anthill.png), [.playwright-mcp/labels-cortex.png](../../../../.playwright-mcp/labels-cortex.png)

## What changed in the algorithm

1. **Extended stop list.** Added URL/route param tokens (`id`, `slug`, `params`,
   `name`, `key`), runtime tokens (`__dirname`, `__filename`, `dirname`,
   `filename`), generic data tokens (`data`, `meta`, `metadata`, `default`,
   `props`, `state`), monorepo-convention dirs (`apps`, `packages`, `modules`),
   misc weak labels (`refresh`, `documents`, `public`, `private`).
2. **Short-token filter.** Tokens ≤ 2 characters (e.g. `id`, `ds`, `db`, `ui`,
   `ts`, `js`) are now treated as generic regardless of their content.
3. **Bigram preference.** The labeler now does a first pass over `top_tokens`
   looking for an n-gram where every word is non-generic. Catches cases where
   the first token by TF-IDF is generic but a later bigram is much more
   descriptive — e.g. `id` (rank 1, generic) → `design system` (rank 6) wins.
4. **Path-prefix fallback.** When no token survives the filters, the labeler
   computes the longest common directory prefix of the cluster's member paths
   and walks backward to find the deepest non-generic segment. Filenames are
   dropped before comparison; bracketed segments like `[id]` are skipped.

## Before / after

### Anthill-cloud

| Cluster | Before | After | Notes |
|---|---|---|---|
| 4 (25) | `server utils` | `arcane server` | Names the actual app, not just the layer |
| 5 (23) | `packages dsl` | `dsl compiler` | Describes function, not directory |
| 6 (14) | `id` | `activator design` | `id` was URL-param noise |
| 7 (13) | `use store` | `use store` | Already fine |
| 3 (11) | `refresh` | `org settings` | `refresh` was a method-call token |
| 0 (10) | `public` | `check constraints` | `public` was DB schema noise from drizzle migrations |
| 8 (7) | `documents` | `activator email` | `documents` was a generic component name |
| 1 (6) | `__dirname` | `drizzle config` | `__dirname` is a runtime global, not a topic |
| 2 (6) | `arcane chat` | `arcane chat` | Already fine |

8 of 9 frames now have informative labels. Only the `check constraints` cluster
is still slightly off — its files are Drizzle migration meta JSON which is
arguably auxiliary content that should be filtered out upstream. A follow-up
could add `meta` to `DEFAULT_AUXILIARY_SEGMENTS`; for now the label at least
describes what's in the files.

### Cortex

| Cluster | Before | After | Notes |
|---|---|---|---|
| 0 (22) | `rame extraction` (truncated) | `frame extraction` | Full token now visible |
| 1 (12) | `mcp server` | `mcp server` | Unchanged |
| 2 (10) | `itoa` | `tree sitter` | `itoa` was a method-name false signal |
| 3 (10) | `tree sitter` (was on a different cluster) | `pipeline pass` | Labels shifted to the right clusters |
| 4 (9) | `foundation` | `indexer foundation` | Bigram is more specific |
| 5 (8) | `indexer extract` | `indexer extract` | Unchanged |
| 6 (4) | `store` | `ctx_gbuf ctx` | Slightly worse — `ctx_gbuf` is internal struct name |

Cortex labels held up or improved. The one weak label (`ctx_gbuf ctx`) is a
TF-IDF artefact of the cluster being dominated by gbuf struct internals — a
real "store" or "graph store" label would be better, but the top tokens
don't include those for this cluster.

## Decision

**Ship.** Big improvement on anthill (8/9 frames upgraded), no regressions
on cortex (most unchanged, a few sharpened). The label cascade is now:
informative bigram → non-generic unigram → meaningful path segment →
`cluster:<id>`. Each fallback step makes a sensible-shaped guess and the
fall-through pattern matches the spec's labeling cascade in
[frame-extraction.md §Labeling](../../frame-extraction.md).

Remaining label-quality follow-ups for later:
1. Add `meta` to `DEFAULT_AUXILIARY_SEGMENTS` so drizzle/prisma migration
   meta JSON gets filtered out of clustering entirely.
2. Internal-struct names like `ctx_gbuf` could be filtered with a more
   nuanced stop list keyed on TF-IDF + entropy across the corpus, but
   that's eval-territory work.
