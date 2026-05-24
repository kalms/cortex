# Nuxt-Impact Eval Harness — Design Spec

**Status:** Draft. Brainstormed with user 2026-05-21; design approved before
writing. Companion to
[docs/architecture/field-assessment-nuxt-monorepo.md](../../architecture/field-assessment-nuxt-monorepo.md).

## Goal

Stand up a measurement harness for Cortex that proves whether the priority
fixes from the Nuxt field assessment actually moved the needle, and catches
regressions on what already worked. The harness runs on a curated set of
pinned public Nuxt repos (reproducible) and can also point at a local
`anthill-cloud` checkout (real-world sanity check).

Output is a per-run scorecard plus a list of pass/fail assertions, each
tagged with the fix ID it tests. The "surprise" column — assertions whose
outcome differs from the recorded baseline — is what a human scans.

## Scope

In scope: graph-measurable assertions for the six fixes from the field
assessment's "Implementation Order I'd Actually Take":

- **Fix #2** — `$fetch` / `useFetch` produce `HTTP_CALLS` edges.
- **Fix #3** — Nuxt auto-import table feeds `IMPORTS` edges.
- **Fix #4** — Vue SFC functions surface as graph nodes with sensible
  qualified names and non-trivial degree.
- **Fix #5** — Nitro `defineEventHandler` bodies extract as function nodes
  with `HANDLES` edges to their `Route`.
- **Fix #6** — `Route` nodes are not polluted by tarball URLs from
  `pnpm-lock.yaml` or similar.
- **Fix #8** — Spec docs (`docs/superpowers/specs/*.md`) promoted into
  `Decision` nodes with `GOVERNS` edges.

Out of scope (handled by separate tests, not this harness):

- **Fix #1** — Startup hook index-state detection. This is a shell-script
  unit test against `hooks/check-index.sh`, not a graph query.
- **Fix #7** — Per-request project resolution in the MCP server. This is a
  behavioral MCP integration test, not a graph query.

Also out of scope: visual reporting beyond markdown, CI integration,
historical trend graphing across many runs. If the harness proves useful
those follow.

## Targets

Pinned public Nuxt repos for reproducibility, plus a local-path override
for anthill-cloud.

`evals/targets.json` lists entries of the shape:

```ts
type Target = {
  name: string;                  // "nuxt-ui"
  repo_url?: string;             // shallow-cloned when set
  sha?: string;                  // pinned commit
  default_branch?: string;       // diagnostic only
  local_path?: string;           // when set, skip clone and use this checkout
};
```

Initial roster:

- `nuxt-ui` — Nuxt UI itself, large surface, lots of composables.
- `nuxthub-starter` — NuxtHub starter, real Nitro handlers and `$fetch`.
- `nuxt-content-blog-starter` — content + pages, simpler shape.
- `anthill-cloud` — `local_path: "/Users/rka/Development/anthill-cloud"`,
  no SHA, run on demand.

Choice of public repos can change; the file is the source of truth.

## Non-goals

- Replacing existing indexer unit tests — the harness measures the
  *graph the indexer produces on a real Nuxt repo*, not internal C
  correctness.
- Generating performance benchmarks — `indexer_seconds` is recorded but
  not asserted on.
- Cross-target rollup metrics — each target is scored independently.

## Directory layout

```
evals/
  targets.json
  baselines/
    <target>.json                # committed; one per target
  src/
    cli.ts                       # entry — argv, target selection, dispatch
    target.ts                    # clone-or-reuse + index, returns path to graph.db
    scorecard.ts                 # bulk counts + killer queries
    assertions/
      types.ts                   # Assertion / AssertionResult shapes
      fix-2-http-calls.ts
      fix-3-auto-imports.ts
      fix-4-sfc-functions.ts
      fix-5-nitro-handlers.ts
      fix-6-route-poison.ts
      fix-8-decision-promotion.ts
      registry.ts                # exports all assertions, tagged by fix_id
    report.ts                    # render summary.md + per-target md/json
  reports/                       # gitignored — generated per run
  cache/                         # gitignored — cloned target repos
```

Key boundary: `target.ts` knows how to produce a `.cortex/graph.db`.
Everything downstream (`scorecard.ts`, all `assertions/*`) only reads from
the resulting DB via Cortex's own `GraphStore`. That separation means the
harness can also be pointed at an already-indexed repo without changing
assertion code.

## Data shapes

```ts
type Scorecard = {
  target: string;
  indexer_seconds: number;
  nodes_by_label: Record<string, number>;
  edges_by_type: Record<string, number>;
  killer_queries: {
    name: string;
    cypher: string;
    row_count: number;
    sample_rows: unknown[];      // first 5 rows for context, never asserted
  }[];
};

type Assertion = {
  fix_id: 2 | 3 | 4 | 5 | 6 | 8;
  name: string;
  description: string;
  query:
    | { kind: "cypher"; cypher: string }
    | { kind: "count_label"; label: string }
    | { kind: "count_edge"; type: string };
  predicate:
    | { op: "gt"; value: number }
    | { op: "gte"; value: number }
    | { op: "eq"; value: number }
    | { op: "matches"; regex: string }      // every row of result matches
    | { op: "no_match"; regex: string };    // no row matches (regression guard)
  baseline_expected: "pass" | "fail";
};

type AssertionResult = {
  assertion: Assertion;
  observed: number | string[];
  passed: boolean;
  surprised: boolean;             // outcome ≠ baseline_expected
};
```

## Scorecard — what gets collected per target

**Bulk counts** (trivially cheap, run unconditionally):

- `nodes_by_label` — `SELECT label, COUNT(*) FROM nodes GROUP BY label`
- `edges_by_type` — `SELECT type, COUNT(*) FROM edges GROUP BY type`

**Killer queries** (fixed list, run on every target):

| Name | Cypher | Why it matters |
|---|---|---|
| `functions_high_degree` | `MATCH (f:function) WHERE f.degree > 5 RETURN f.name, f.degree LIMIT 20` | Flagship "is anything connected" check — zero rows was the original anthill-cloud finding. |
| `http_calls_with_api_path` | `MATCH ()-[r:HTTP_CALLS]->(rt:Route) WHERE rt.name STARTS WITH '/api' RETURN rt.name, count(r) LIMIT 20` | Did `$fetch`/`useFetch` extraction work. |
| `route_nodes_named` | `MATCH (r:Route) RETURN r.name LIMIT 40` | Tarball-poison check + general route sanity. |
| `composables_called` | `MATCH (f:function)-[c:CALLS]->(g:function) WHERE g.name STARTS WITH 'use' RETURN g.name, count(c) ORDER BY count(c) DESC LIMIT 20` | Did auto-import-table work — composables should appear with non-zero in-degree. |
| `vue_function_count` | `MATCH (f:function) WHERE f.file_path ENDS WITH '.vue' RETURN count(f)` | Did SFC integration surface functions. |
| `nitro_handlers` | `MATCH (f:function) WHERE f.file_path =~ '.*server/api/.*\\.ts' RETURN f.qualified_name LIMIT 20` | Did Nitro extraction find handlers. |
| `decisions_present` | `MATCH (d:Decision) RETURN count(d)` | Did spec promotion populate decisions. |

Killer queries record `row_count` and the first 5 `sample_rows`. Samples
are reference material for the human reviewing the report — they never
feed assertions.

## Assertion catalog

All assertions have `baseline_expected: "fail"` unless marked **(baseline:
pass)** — those are regression guards. 20 assertions across 6 fixes, of
which 4 (in Fix #4) and 1 (in Fix #8) are tool-behavior assertions that
exercise the MCP tool layer rather than reading the graph directly.

### Fix #2 — `$fetch` / `useFetch` → `HTTP_CALLS`

- `http_calls_edge_count_nonzero` — `count(HTTP_CALLS edges) > 0`
- `http_calls_to_api_route` — count of `HTTP_CALLS` edges whose target
  `Route.name STARTS WITH '/api'` > 5
- `route_node_named_api_path` — `count(Route nodes where name STARTS WITH '/api')` > 3

### Fix #3 — Nuxt auto-import table → `IMPORTS`

- `imports_edge_count_grew` — `count(IMPORTS edges)` > `baseline.IMPORTS_count * 1.5`
- `composable_has_callers` — at least one function whose name `STARTS WITH 'use'`
  has `CALLS` in-degree > 0
- `pinia_store_node_exists` — `MATCH (f:function) WHERE f.name = 'defineStore'`
  has at least one CALLS edge to it

### Fix #4 — Vue SFC functions surface

Graph-content assertions (read from `graph.db` directly):

- `vue_function_node_count_nonzero` — `count(function nodes with file_path ENDS WITH '.vue')` > 10
- `vue_function_has_high_degree` — at least one such function with `degree > 5`
- `sfc_qn_well_formed` — sample 5 Vue functions; none have
  `qualified_name` containing literal `<script setup>` or null/empty

Tool-behavior assertions (exercise the MCP tool layer — see
[Tool-behavior assertion category](#tool-behavior-assertion-category)):

- `vue_file_is_module_node` — `MATCH (m:module) WHERE m.file_path ENDS WITH '.vue' RETURN count(m)` > 0.
  Encodes the "weaker MVP" from the
  [2026-05-21 follow-up field report](../../architecture/field-report-2026-05-21-vue-graph-and-decision-input.md):
  even without parsing, a `.vue` file should at minimum be a module node
  so `governs` linking and `get_code_snippet` can target it.
- `get_code_snippet_returns_vue_content` — calling
  `get_code_snippet(qualified_name=<path to .vue file>)` returns
  non-empty content. The path is picked from a target-specific fixture
  listing one known `.vue` path per target.
- `governs_link_to_vue_path_persists` — create a temporary decision via
  `create_decision(governs=[<.vue path>])`, immediately read it back via
  `get_decision`, assert `governs` array is non-empty. Decision is
  deleted after the assertion regardless of outcome.
- `search_graph_finds_vue_component` — `search_graph(name_pattern=<vue component basename without extension>)`
  returns at least one result.

These four catch the failure mode the follow-up field report
documented: graph-content fixes that don't propagate to tool-layer
behavior. Without them, a fix that registers Vue function nodes but
leaves `get_code_snippet` unable to resolve `.vue` paths would look like
a green Fix #4 in our harness while still being unusable in practice.

### Fix #5 — Nitro handlers extracted

- `nitro_handler_function_exists` — `count(function nodes in server/api/**/*.ts)` > 5
- `nitro_route_handles_edge` — `count((:function)-[:HANDLES]->(:Route))` > 0

### Fix #6 — Tarball URLs don't pollute Route nodes

- `no_tarball_routes` **(baseline: pass)** —
  `count(Route where name CONTAINS 'tarball' OR name MATCHES '.*\\.tgz')` == 0
- `no_codeartifact_routes` **(baseline: pass)** —
  `count(Route where name CONTAINS 'codeartifact')` == 0

These are the only assertions where baseline is "pass" — they encode
"this never should have happened." If they regress, the harness flags
them loudly in the surprises block.

### Fix #8 — Spec docs promoted to decisions

- `decision_node_count_nonzero` — `count(Decision)` > 0
- `decision_governs_edges_exist` — `count(:Decision-[:GOVERNS]->(*))` > 0
- `decision_rationale_no_xml_leakage` **(baseline: pass)** —
  `MATCH (d:Decision) WHERE d.rationale CONTAINS '</rationale>' OR d.rationale CONTAINS '<problem>' OR d.rationale CONTAINS '</invoke>' RETURN count(d)` == 0.
  Regression guard for the silent-bad-write failure mode described in
  Issue 2 of the
  [2026-05-21 follow-up field report](../../architecture/field-report-2026-05-21-vue-graph-and-decision-input.md):
  XML-namespace marshalling errors on the caller side previously
  concatenated structured fields into `rationale` and persisted with no
  warning. The robustness fix to `create_decision` (see
  [companion spec](2026-05-21-mcp-tool-robustness-design.md)) lands
  alongside this guard.

## Tool-behavior assertion category

Most assertions are pure graph reads — they open `graph.db` via
`GraphStore` and run a query. Five assertions (`vue_file_is_module_node`,
`get_code_snippet_returns_vue_content`,
`governs_link_to_vue_path_persists`, `search_graph_finds_vue_component`,
plus the existing fixture probe) require calling MCP tool functions
end-to-end: they exist because the
[2026-05-21 follow-up field report](../../architecture/field-report-2026-05-21-vue-graph-and-decision-input.md)
demonstrated that a graph-content fix can leave the tool layer broken.

The `Assertion` query shape gains a fourth kind:

```ts
| { kind: "tool_call"; tool: string; args: Record<string, unknown>; expect: ToolResultPredicate }
```

`tool_call` assertions invoke the actual MCP tool handler in-process
(not over JSON-RPC — same module the server registers). The handler
runs against the same target's `graph.db`. `ToolResultPredicate` shapes
mirror the existing predicate ops but operate on the tool's response
content rather than a count.

Target-specific fixtures live alongside `evals/baselines/<target>.json`
in `evals/fixtures/<target>.json`. Each fixture provides the inputs the
tool-behavior assertions need (one known `.vue` path, one known
component basename). These are checked in and reviewed when targets
change.

The decision to call tools in-process rather than spawn a server: keeps
the harness single-process, avoids transport flakiness, but loses
coverage of the JSON-RPC layer itself. The
[companion robustness spec](2026-05-21-mcp-tool-robustness-design.md)
addresses transport-layer concerns separately.

## Baselines

Baselines live in `evals/baselines/<target>.json`, committed to git.
Captured deliberately via:

```bash
npm run eval -- --capture-baseline=<target>
```

The baseline JSON stores:

- `nodes_by_label`, `edges_by_type` snapshots (used by the
  `imports_edge_count_grew` style assertions for "+50%" comparisons)
- Per-assertion `baseline_observed` value (what the assertion saw at
  capture time)

Baselines are re-captured **after** a fix lands, and the recapture commit
becomes the receipts trail for what that fix did. They are never
auto-updated by a normal run.

## Report shape

Each run writes three artifact types under
`evals/reports/<YYYY-MM-DD-HHmm>/`:

- `summary.md` — top-level report, one section per target. Opens with a
  "Surprises" block listing only assertions whose outcome differs from
  baseline, followed by a scorecard delta.
- `<target>.json` — full scorecard + assertion results, machine-readable.
- `<target>.md` — per-target full assertion table for humans.

Example `summary.md` section:

```
## nuxt-ui

  Surprises (3):
    ✓ http_calls_edge_count_nonzero — was 0, now 47 (fix #2)
    ✓ composable_has_callers — was 0 in-edges, now 23 (fix #3)
    ✗ no_tarball_routes — was 0 polluted routes, now 4 (REGRESSION)

  Scorecard delta:
    nodes.function:    412 → 1,103 (+168%)
    edges.HTTP_CALLS:    0 →    47
    edges.IMPORTS:     214 →   538 (+151%)
```

The "Surprises" block is the only thing a human has to read. Everything
else is reference material for follow-up.

## Invocation surface

```bash
npm run eval                                       # all targets, default report dir
npm run eval -- --target=nuxt-ui                   # one target
npm run eval -- --target=anthill-cloud \
                  --path=/Users/rka/Development/anthill-cloud   # local, no clone
npm run eval -- --capture-baseline=nuxt-ui         # update committed baseline
```

`--path` overrides `local_path` from `targets.json` for one-off runs
against a working tree.

## Module responsibilities

- **`cli.ts`** — parses argv, dispatches to either `runOneTarget`,
  `runAllTargets`, or `captureBaseline`. No domain logic.
- **`target.ts`** — given a `Target`, either shallow-clones (using
  `repo_url` + `sha`) into `evals/cache/<target>/` or reuses
  `local_path`. Runs `bin/cortex-indexer` against it. Returns absolute
  path to the resulting `graph.db`. Idempotent — if cache already has the
  right SHA, skip clone; if `graph.db` is newer than source, skip index.
- **`scorecard.ts`** — given a graph DB path + project name, runs bulk
  counts and killer queries, returns a `Scorecard`. Pure read.
- **`assertions/registry.ts`** — concatenates all per-fix assertion
  arrays into one list, preserving `fix_id` order.
- **`assertions/<fix-N>-*.ts`** — each file exports
  `assertions: Assertion[]`. Pure data, no execution logic.
- **`report.ts`** — given baseline + scorecard + assertion results,
  emits `summary.md`, `<target>.json`, `<target>.md`. Pure write.

Each module's public interface is one function. Internals are private to
the file. This is enforced by review, not by tooling.

## Sibling work — not in this harness

The
[2026-05-21 follow-up field report](../../architecture/field-report-2026-05-21-vue-graph-and-decision-input.md)
identified two MCP tool robustness issues this harness does not cover.
Both are deemed critical ("without it, Cortex is borderline useless"):

1. **`create_decision` silently persists malformed rationale.**
   Caller-side XML marshalling errors concatenate structured fields
   into `rationale`. No input validation, no warning. Recovery requires
   delete + recreate because `governs` is not settable on update.
2. **`search_code` errors on common patterns in large monorepos.** The
   tool prefers `rg` but falls back to bare `grep -rn` with no path
   exclusions, which times out or overflows buffer on common short
   patterns in any monorepo with `node_modules`.

Both are covered by the
[MCP Tool Robustness companion spec](2026-05-21-mcp-tool-robustness-design.md).
The harness encodes one regression guard related to Issue 1
(`decision_rationale_no_xml_leakage`), but the actual fixes — input
validation, `governs` on update, ripgrep-with-excludes — live in that
sibling spec, not here. The two specs land as parallel work streams.

## Open questions

- Does Cortex's `GraphStore` already accept an arbitrary `graph.db` path
  not tied to its own config resolution? If not, that's a small refactor
  before the harness can read multi-target results. Worth a 30-minute
  check during the writing-plans phase.
- For `imports_edge_count_grew`, "+50%" is a guess at a meaningful
  threshold. May need tuning after the first real run on each target.
- `anthill-cloud` baseline includes a working-copy state that drifts. We
  may want to record `git rev-parse HEAD` of the target at baseline
  capture time so we can tell if the comparison is stale.

These are deferred to the implementation plan.
