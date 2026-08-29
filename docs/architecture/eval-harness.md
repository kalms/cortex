# Eval Harness Architecture

> Audience: anyone touching `evals/` or the killer-query list. The
> [field assessment](../field-reports/field-assessment-nuxt-monorepo.md) is the
> driving motivation.

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

Default targets are Nuxt UI, NuxtHub starter, `elk`, and the
`anthill-cloud` monorepo from the field assessment. A further seventeen
multi-language repositories form the **corpus suite**, which is opt-in — see
[Assertion packs and suites](#assertion-packs-and-suites) below. The killer
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

The end-to-end flow (clone → index → score → assert → baseline diff) is
informed by the [field assessment](../field-reports/field-assessment-nuxt-monorepo.md).

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

## Assertion packs and suites

The harness scores two different kinds of thing, and they must not be confused:

| kind | `scope` | verdict comes from | applies to |
|---|---|---|---|
| ecosystem-specific | `nuxt` | a fixed `predicate` | Nuxt targets only |
| language-agnostic | `universal` | a **ratchet** against that repo's own baseline | any repository |

A `nuxt` assertion can be judged absolutely: `nitro_handlers` should be greater
than zero, full stop. A universal metric cannot. 40% call attribution may be
terrible for one language and entirely expected for another, so "is this number
good?" has no answer — only "did it move the wrong way against this repo's own
baseline?" does.

**That is why universal metrics carry no `predicate` at all.** Do not add one to
satisfy a type: an assertion that always passes reads as a check and is not one.
`AssertionResult.passed` is `boolean | null`, where `null` means *not judged* —
either the metric has no baseline yet, or it had nothing to measure.

Each target declares `packs` (which assertion scopes run against it) and
`suites` (which named runs it belongs to). Both have defaults, and the defaults
matter: `packs` defaults to `["universal"]`, so a new target gets the portable
checks and none of the ecosystem-specific ones; `suites` defaults to `["nuxt"]`.
Selection lives in `selectAssertions` (registry) and `selectTargets` (cli).

    npm run eval                     # default: the Nuxt suite, unchanged
    npm run eval -- --suite=corpus   # the 17-repo multi-language corpus
    npm run eval -- --suite=all

## The universal metrics

Six, in `evals/src/assertions/universal.ts`:

| metric | direction | what a bad number means |
|---|---|---|
| `file_sourced_calls` | lower | calls the indexer could not attribute to their enclosing callable, so they hang off the file node |
| `call_attribution_rate` | higher | the same defect as a proportion |
| `qn_collisions` | lower | two source files folding to one identity |
| `orphan_definition_rate` | lower | definitions extracted with no edges at all |
| `per_language_function_density` | higher | callables per file, **per language** — catches one language falling out of extraction while the repo-wide averages stay respectable |
| determinism (`--determinism`) | — | indexing the same tree twice yields a different graph |

### "Nothing to measure" is not zero

A rate over zero rows yields SQL `NULL`. The runner surfaces that as
`observed: null` and the ratchet as `not_measured`; it is never coerced to a
number. This is load-bearing rather than fussy: `orphan_definition_rate` is
lower-is-better, so a bogus low value reads as an *excellent* score. A total
extraction failure could then be scored an improvement and adopted into the
baseline as a deliberate gain.

## The ratchet

`ratchet()` (`assertions/ratchet.ts`) is pure: it compares an observed value to
a baseline given a direction and an epsilon. `applyRatchet` (`verdicts.ts`) is
the **single place** a universal metric's verdict is decided; the report and the
baseline merger both read the outcome it stores and never recompute it. Two
sites deciding independently whether a metric regressed is how a report and its
exit code come to disagree.

Epsilon is per-metric-kind:

- **percentage metrics** — 0.5 percentage points.
- **counts** — exact.
- **per-language density** — **proportional: 10% of that language's own
  baseline.** Density is callables-per-file, typically near 1, so a fixed 0.5
  would let a language lose most of its extraction — or vanish from the repo
  entirely — and still pass.

Map-valued metrics are judged per key; any regressed language fails the metric,
and a language present at baseline but absent now is treated as a collapse to
zero, not as a missing comparison.

> **Discriminate on the assertion, never on the value's shape.** Density map
> keys are file extensions harvested from arbitrary repositories, so a repo
> containing `x.status` or `x.text` can forge any shape test you write. All
> three modules key on `assertion.query.kind === "language_density"`. A shape
> sniff here once crashed the whole run's report rendering.

## Baselines

`evals/baselines/<target>.json` records each metric's value plus the
`source_sha` it was measured at. Targets track a moving branch, so without that
sha a baseline drifts against upstream silently.

**A normal run never rewrites a baseline.** An improvement beyond epsilon is
reported as `IMPROVED — baseline stale` and adopted only by an explicit
`npm run eval -- --accept-improvements`, which writes only the metrics the
ratchet confirmed as improved and never absorbs a regression. Adoption is
deliberate so that the resulting git diff is the review record — a metric can
rise for bad reasons, since counting garbage raises a count as surely as fixing
extraction does.

## Gotchas

- **`evals/cache/` holds whole third-party repositories.** They carry their own
  test suites; `vitest.config.ts` excludes the directory, or `npm test` picks up
  hundreds of foreign tests that fail for want of their own dependencies.
- **`evals/` is not typechecked by `npm test`.** The root `tsconfig.json`
  includes only `src`, and vitest transpiles without typechecking. The gate is
  `npx tsc --noEmit -p evals/tsconfig.json 2>&1 | grep -v '^src/viewer/'`, which
  must print nothing (the filtered errors are pre-existing vite-built viewer
  sources that the eval config drags in by overriding the root `exclude`).
- **A forced reindex must really be forced.** `maybeReindex` skips indexing when
  the cached graph is newer than the workdir's `.git/HEAD`. The determinism
  check deletes the graph DB precisely to defeat that; without it the second
  pass re-scores the first pass's graph and the check can never fail.
