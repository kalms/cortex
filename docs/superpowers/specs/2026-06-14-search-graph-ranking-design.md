# search_graph Ranking, Section Exclusion & Pagination — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorming)
**Origin:** P2 in [field-report-2026-06-12-mesh-m1-platform-consumer.md](../../field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md)

## Problem

`search_graph` returns flat, unranked rows capped at `LIMIT 100` with no
`ORDER BY`. The `section` kind (1771 nodes in this repo vs. 528 `function`,
24 `route`) dominates name-pattern results: a query like
`name_pattern="serve"` drags in doc/plan/markdown headings that bury the
handful of real code hits. The field report measured this as the worst
single token-waster — 70+ results scanned by eye to find one.

The mitigation (report P2) has three parts:
1. Rank by kind priority with name-match boosts.
2. Default-demote `section` nodes unless explicitly requested.
3. Return a top-N window with a `total_matches` count instead of the full dump.

## Scope

`search_graph` **only**. `search_code` (already structurally annotated and
praised in the report) and `get_code_snippet` / `trace_path` are untouched.

**Explicitly deferred to a follow-on (P2.1):** frame/layer-aware ranking and
`layer`/`frame_id` filters. Frame coverage is still patchy (the `SRC·863`
mega-frame is a known open item), so layer is not yet a trustworthy ranking
signal. The ranker is designed to accept an optional layer-weight map later
**without API churn**, and P2.1 is sequenced *after* the frame-coverage fix.

## API

Additions to `searchGraphShape` (all optional, all backward-compatible):

| Param | Type | Default | Meaning |
|---|---|---|---|
| `name_pattern` | string | — | existing — substring match on `name` |
| `qn_pattern` | string | — | existing — substring match on `qualified_name` |
| `label` | string | — | existing — **back-compat alias**, folded into `kinds` |
| `kinds` | string[] | — | **NEW** — restrict to these kinds; also the section opt-in |
| `limit` | number | 30 | **NEW** — page size, clamped to 1–100 |
| `offset` | number | 0 | **NEW** — page start (≥ 0) |

Semantics:
- **No `kinds` given:** code kinds only — sections excluded (default
  `CODE_KIND_FILTER` *plus* `kind != 'section'`).
- **`kinds` given:** replaces the default filter entirely — results restricted
  to exactly those kinds. `kinds: ["section"]` brings sections back;
  `kinds: ["route","function"]` narrows to those.
- **`label` + `kinds` both given:** union (`label` is just a single-element
  contributor). `label` alone ≡ `kinds: [label]`.

## Components

### 1. `searchGraph` (src/graph/code-queries.ts) — modified

- Accept `kinds?: string[]` in params.
- When `kinds` absent: apply `CODE_KIND_FILTER AND kind != 'section'`.
- When `kinds` present: apply `kind IN (?, ?, …)` (lowercased), which
  *replaces* the default kind filter entirely. Because it is a positive
  allow-list, decision/pr/todo are excluded unless explicitly named; naming
  them is unsupported (decisions have their own tools) and out of scope —
  no special-case rejection, the result is simply whatever matches.
- **Remove the `LIMIT 100`** — return the full matching row set. The
  LIKE-filtered, kind-filtered set is small relative to total nodes; ranking
  and windowing happen above. (Safety cap: hard ceiling of 1000 rows fetched
  to bound pathological queries; if hit, the suppressed/total counts still
  reflect the true `COUNT(*)`.)
- Return both the rows and a `suppressed_sections` count: a scalar
  `COUNT(*)` of section rows that matched the name/qn pattern but were
  excluded by the default filter. Computed **only** when sections are
  excluded (no `kinds`), else 0.

Return shape: `{ rows: IndexerNode[]; total: number; suppressedSections: number }`
where `total` is the count of matching rows under the effective kind filter
(pre-window), and `rows` is capped at the 1000 safety ceiling.

### 2. `rankNodes` (src/graph/node-ranker.ts) — NEW pure module

Mirrors the [frame-ranker.ts](../../../src/frame-extraction/frame-ranker.ts)
idiom: pure, deterministic, no I/O.

```ts
export const KIND_WEIGHT: Record<string, number> = {
  route: 1.0, function: 0.95, class: 0.95, method: 0.9,
  interface: 0.75, type: 0.75,
  module: 0.55, file: 0.5, folder: 0.45, variable: 0.5,
  channel: 0.4, anchor: 0.35,
  section: 0.1,
};
const DEFAULT_KIND_WEIGHT = 0.5; // unknown kinds

// query is the matched pattern (name_pattern, else qn_pattern); absent → 1
export function nameMatchQuality(name: string, query?: string): number {
  if (!query) return 1;
  const n = name.toLowerCase(), q = query.toLowerCase();
  if (n === q) return 1.0;        // exact (case-insensitive)
  if (n.startsWith(q)) return 0.7; // prefix
  return 0.4;                      // substring (LIKE already guaranteed a hit)
}

export function scoreNode(node: IndexerNode, query?: string): number {
  return (KIND_WEIGHT[node.kind] ?? DEFAULT_KIND_WEIGHT)
       * nameMatchQuality(node.name, query);
}

// stable, deterministic sort: score desc, then shorter name, then qn asc
export function rankNodes(nodes: IndexerNode[], query?: string): IndexerNode[];
```

Tie-break order (guarantees identical ordering across paginated calls):
1. score descending
2. shorter `name` length first
3. `qualified_name` ascending (canonical, total order)

`section`'s low weight (0.1) means an opted-in section sorts after any code
kind unless the code hit is a much weaker name match — and even an exact
section match (0.1) loses to a substring `function` match (0.95 × 0.4 = 0.38).
This realizes the approved "sections always after code" choice via weight, not
a special case.

Forward-compat: signature can grow an optional `layerWeight?: Record<string,
number>` argument in P2.1 without changing existing call sites.

### 3. Tool handler (src/mcp-server/tools/code-tools.ts) — modified

```
searchGraph(...) → { rows, total, suppressedSections }
ranked = rankNodes(rows, name_pattern ?? qn_pattern)
window = ranked.slice(offset, offset + limit)
text   = header + formatNodes(window)
```

`limit` clamped to [1, 100]; `offset` floored at 0.

## Output format

Header line, then the existing `formatNodes` body:

```
search_graph(name_pattern="serve")
showing 1–6 of 6 · offset 0 · 41 section nodes suppressed (pass kinds=["section"])
function serveViewer (src/server/serve.ts:12-40)
route   /api/serve   (src/server/routes.ts:88-95)
...
```

- `showing A–B of TOTAL · offset N` where `A = offset+1` (or `0` when the
  window is empty), `B = offset + window.length`, `TOTAL = total`.
- Suppression note appended **only** when `suppressedSections > 0`.
- Empty result set (no matches at all): existing `empty(queryDesc)` path,
  unchanged.

## Error / edge handling

- **`offset >= total` (overshoot):** empty window, but still emit the header —
  `showing 0 of 142 · offset 200` — so the agent sees it overshot rather than
  a bare "no results."
- **`limit` out of range:** clamp silently (1–100); never error.
- **`offset` negative:** floor to 0.
- **No project / unindexed:** unchanged existing `project_not_found` path.
- **Safety ceiling hit (>1000 matches):** window still served from the first
  1000 ranked rows; `total` reflects the true count so the agent knows more
  exist. (Realistically unreachable for a name search; documented for safety.)

## Testing (TDD)

**node-ranker unit tests** (`tests/graph/node-ranker.test.ts`):
- kind-priority ordering (route > function > module > variable > section)
- name-match: exact > prefix > substring
- shorter-name tie-break at equal score
- `qualified_name` canonical tie-break (total order, no ambiguity)
- determinism: same input → identical order across two calls (pagination
  stability)
- unknown kind → `DEFAULT_KIND_WEIGHT`
- absent query → `nameMatchQuality` returns 1 (qn_pattern-only searches)

**searchGraph query tests** (`tests/graph/code-queries.test.ts` or existing):
- sections excluded by default
- `kinds: ["section"]` includes sections
- `kinds: ["route","function"]` narrows to those only
- `suppressedSections` count accurate when sections excluded; 0 when opted in
- `total` reflects post-filter pre-window count

**tool integration tests** (`tests/mcp-server/*search*`):
- header format (`showing A–B of TOTAL · offset N`)
- `total_matches` correctness
- offset/limit windowing returns the right slice
- offset-overshoot emits header with `showing 0`
- `label` alias maps into `kinds`
- suppression note present iff sections suppressed

## Files

- **Create:** `src/graph/node-ranker.ts`, `tests/graph/node-ranker.test.ts`
- **Modify:** `src/graph/code-queries.ts` (searchGraph signature + filters +
  counts), `src/mcp-server/tools/code-tools.ts` (shape + handler), relevant
  query/tool test files.
- **Docs:** update `docs/mcp-tools.md` search_graph entry (new params, ranking,
  pagination, section default).
