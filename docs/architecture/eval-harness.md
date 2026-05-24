# Eval Harness Architecture

> Audience: anyone touching `evals/` or the killer-query list. The
> [field assessment](field-assessment-nuxt-monorepo.md) is the
> driving motivation; the implementation plans live under
> [`docs/superpowers/`](../superpowers/).

## What this harness is for

There are **two** eval surfaces in this repo. Don't confuse them:

| Harness | Location | What it scores | npm script |
|---|---|---|---|
| **Tool-surface eval** (this doc) | `evals/` | Cortex's MCP tool answers against real-world target repos | `npm run eval` |
| **Frame-extraction eval** | `scripts/frame-extraction/eval*.ts` | Cluster quality of one clustering algorithm on one repo | `npm run eval:phase2` |

This document covers the **tool-surface** harness. Its purpose is to
catch regressions and progress on the kind of questions Cortex falls
short on for Vue/Nuxt monorepos (per the field assessment). The
frame-extraction eval scores cluster outputs and is documented
inline in [`frame-extraction.md`](frame-extraction.md).

## Inputs

```
evals/targets.json   — list of target repos (cloneable or local_path)
evals/src/queries.ts — fixed list of "killer queries" (Cypher illustrative + SQL concrete)
```

Current targets are Nuxt UI, NuxtHub starter, and the
`anthill-cloud` monorepo from the field assessment. The killer
queries cover:

- `functions_high_degree` — does the indexer extract enough function
  bodies that fan-in/-out queries return non-empty?
- `http_calls_with_api_path` — does the indexer extract
  `$fetch`/`useFetch` as `HTTP_CALLS` edges?
- `route_nodes_named` — are `route` nodes legitimate URLs (not
  pnpm-lock tarball strings)?
- `composables_called` — Vue convention: identifiers starting with
  `use`. Catches whether SFC + composable extraction lands.
- `vue_function_count` — function nodes in `.vue` files at all.
- `nitro_handlers` — function bodies inside `server/api/**/*.ts`.
- `decisions_present` — was anything promoted to `Decision` for this
  target?

Each query has a `baseline_expected: "pass" | "fail"` so the harness
can flag surprises in either direction (a query that was failing and
now passes is just as important as a regression).

## Outputs

The harness produces a `Scorecard` per target — see
`evals/src/assertions/types.ts`:

```ts
{
  target: "nuxt-ui",
  indexer_seconds: 12.4,            // null when reusing existing index
  nodes_by_label: { function: 1667, … },
  edges_by_type:  { CALLS: 3402, IMPORTS: 214, … },
  killer_queries: [{ name, cypher, row_count, sample_rows }, …]
}
```

`Baseline`s (committed under `evals/baselines/`) capture a previous
scorecard so the next run can diff against it. The harness reports
*surprises*: assertions whose baseline_expected disagrees with the
observed result.

## Assertion runner

`evals/src/assertions/runner.ts` runs a single `Assertion` against an
already-indexed DB. The supported query shapes are:

| Query kind | Backed by |
|---|---|
| `count_label` | `SELECT COUNT(*) FROM nodes WHERE kind = ?` |
| `count_edge` | `SELECT COUNT(*) FROM edges WHERE relation = ?` |
| `sql` | Raw SQL — returns count or stringified first column depending on predicate |
| `tool_call` | Reserved — routes through a separate tool-runner (not implemented yet) |

Predicates are `gt`/`gte`/`eq`/`matches`/`no_match`/`tool_text_nonempty`/`tool_text_contains`.

## Status

The harness is **scaffolded but not wired together**. The pieces:

- ✅ `evals/targets.json` — target list with both clone and local-path support
- ✅ `evals/src/queries.ts` — full killer-query list (Cypher comments cross-check against the spec)
- ✅ `evals/src/scorecard.ts` — bulk counts + killer query runner
- ✅ `evals/src/assertions/types.ts` + `runner.ts` — assertion model + SQL/count runner
- ✅ `tests/evals/scorecard.test.ts` + `assertion-runner.test.ts` — unit coverage
- ❌ `evals/src/cli.ts` — currently just `console.error("not implemented yet")`. Wiring up clone → index → score → assert → diff baseline is the next chunk.
- ❌ `evals/baselines/` — empty; populated on first end-to-end run.

The full plan (clone → index → score → assert → baseline diff) is in
[`docs/superpowers/2026-05-17-frame-extraction-eval-harness.md`](../superpowers/2026-05-17-frame-extraction-eval-harness.md)
and the spec it derives from is
[`docs/specs/cortex-v0.3/nuxt-impact-eval-harness.md`](../specs/cortex-v0.3/)
(if present) plus the [field assessment](field-assessment-nuxt-monorepo.md).

## Why the killer queries look the way they do

Each one mirrors a concrete failure observed during the field
assessment of a Nuxt monorepo (`anthill-cloud`, 5,010 nodes /
5,746 edges, 2026-05-20). Two examples:

- **`functions_high_degree` returns zero rows** on a 410-module Nuxt
  monorepo because the indexer doesn't extract functions from Vue
  SFC `<script setup>`, Nitro handler bodies, Pinia store setup
  blocks, or `app/composables/*.ts` arrow functions. That's ~90%
  of the meaningful symbols in the repo.
- **`route_nodes_named`** returns pnpm-lock tarball URLs (e.g.
  `tarball: https://…codeartifact…/@esbuild/win32-x64/…`)
  classified as routes. The indexer regex treats YAML `tarball:`
  fields as URL-like.

These are the questions a real user asks when they expect a code
graph to be useful. The harness exists so we know whether they're
answered well.
