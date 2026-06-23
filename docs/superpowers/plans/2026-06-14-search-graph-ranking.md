# search_graph Ranking, Section Exclusion & Pagination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `search_graph` rank results by kind priority + name-match quality, exclude doc/plan `section` nodes by default (opt-in via `kinds`), and paginate with a `total_matches` header.

**Architecture:** A new pure ranker module (`node-ranker.ts`) scores and sorts rows; `searchGraph` gains a `kinds` filter and excludes sections by default; a pure render module (`search-format.ts`) does clamping + header + node-line formatting; the `search_graph` tool handler composes them. All ranking/format logic is pure and unit-tested, mirroring the existing `frame-ranker.ts` pattern.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (via `GraphStore.queryRaw`), MCP tool registration (zod shapes).

**Spec:** [docs/superpowers/specs/2026-06-14-search-graph-ranking-design.md](../specs/2026-06-14-search-graph-ranking-design.md)

---

## File Structure

- **Create** `src/graph/node-ranker.ts` — pure ranking: `KIND_WEIGHT`, `nameMatchQuality`, `scoreNode`, `rankNodes`.
- **Create** `src/mcp-server/tools/search-format.ts` — pure presentation: `clampLimit`, `clampOffset`, `renderNodeSearch`.
- **Modify** `src/graph/code-queries.ts` — `searchGraph` gains `kinds` + default section exclusion + 1000 ceiling; add `countSuppressedSections`.
- **Modify** `src/mcp-server/tools/code-tools.ts` — `searchGraphShape` gains `kinds`/`limit`/`offset`; handler composes the above; drop the now-unused `formatNodes`.
- **Create** `tests/graph/node-ranker.test.ts`, `tests/mcp-server/search-format.test.ts`.
- **Modify** `tests/graph/code-queries.test.ts` — section-exclusion / kinds / count tests.
- **Modify** `docs/mcp-tools.md` — document new params + behavior.

Reference types (already defined in `src/graph/code-queries.ts`):

```ts
export interface IndexerNode {
  id: string; project: string; kind: string; name: string;
  qualified_name: string; file_path: string;
  start_line: number; end_line: number; data: string;
}
```

---

## Task 1: Pure node-ranker module

**Files:**
- Create: `src/graph/node-ranker.ts`
- Test: `tests/graph/node-ranker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/graph/node-ranker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rankNodes, scoreNode, nameMatchQuality, KIND_WEIGHT } from "../../src/graph/node-ranker.js";
import type { IndexerNode } from "../../src/graph/code-queries.js";

function node(partial: Partial<IndexerNode>): IndexerNode {
  return {
    id: partial.qualified_name ?? partial.name ?? "id",
    project: "p",
    kind: partial.kind ?? "function",
    name: partial.name ?? "x",
    qualified_name: partial.qualified_name ?? `mod::${partial.name ?? "x"}`,
    file_path: partial.file_path ?? "src/mod.ts",
    start_line: 1, end_line: 2, data: "{}",
  };
}

describe("nameMatchQuality", () => {
  it("returns 1 when query is absent (qn-only search)", () => {
    expect(nameMatchQuality("anything", undefined)).toBe(1);
  });
  it("scores exact (case-insensitive) > prefix > substring", () => {
    expect(nameMatchQuality("Serve", "serve")).toBe(1.0);
    expect(nameMatchQuality("serveViewer", "serve")).toBe(0.7);
    expect(nameMatchQuality("httpServe", "serve")).toBe(0.4);
  });
});

describe("scoreNode", () => {
  it("weights kind: a substring function beats an exact section", () => {
    const fn = node({ kind: "function", name: "doServe" });   // 0.95 * 0.4 = 0.38
    const sec = node({ kind: "section", name: "serve" });       // 0.10 * 1.0 = 0.10
    expect(scoreNode(fn, "serve")).toBeGreaterThan(scoreNode(sec, "serve"));
  });
  it("falls back to a default weight for unknown kinds", () => {
    const unknown = node({ kind: "gizmo", name: "serve" });
    expect(scoreNode(unknown, "serve")).toBeCloseTo(0.5 * 1.0);
  });
});

describe("rankNodes", () => {
  it("orders by kind priority for equal name-match quality", () => {
    const nodes = [
      node({ kind: "variable", name: "serveX", qualified_name: "m::serveX" }),
      node({ kind: "route", name: "serveY", qualified_name: "m::serveY" }),
      node({ kind: "function", name: "serveZ", qualified_name: "m::serveZ" }),
    ];
    const ranked = rankNodes(nodes, "serve");
    expect(ranked.map((n) => n.kind)).toEqual(["route", "function", "variable"]);
  });
  it("breaks ties by shorter name, then qualified_name ascending", () => {
    const nodes = [
      node({ kind: "function", name: "serveLong", qualified_name: "m::b" }),
      node({ kind: "function", name: "serveLong", qualified_name: "m::a" }),
      node({ kind: "function", name: "serve", qualified_name: "m::c" }),
    ];
    const ranked = rankNodes(nodes, "serveX"); // all substring (0.4), equal score
    expect(ranked.map((n) => n.qualified_name)).toEqual(["m::c", "m::a", "m::b"]);
  });
  it("is deterministic across repeated calls (pagination stability)", () => {
    const nodes = [
      node({ kind: "function", name: "alpha", qualified_name: "m::alpha" }),
      node({ kind: "function", name: "beta", qualified_name: "m::beta" }),
      node({ kind: "method", name: "gamma", qualified_name: "m::gamma" }),
    ];
    const a = rankNodes(nodes, "a").map((n) => n.qualified_name);
    const b = rankNodes([...nodes].reverse(), "a").map((n) => n.qualified_name);
    expect(a).toEqual(b);
  });
  it("does not mutate the input array", () => {
    const nodes = [node({ name: "b" }), node({ name: "a" })];
    const before = nodes.map((n) => n.name);
    rankNodes(nodes, "a");
    expect(nodes.map((n) => n.name)).toEqual(before);
  });
  it("exposes a KIND_WEIGHT table with section lowest", () => {
    expect(KIND_WEIGHT.section).toBeLessThan(KIND_WEIGHT.variable);
    expect(KIND_WEIGHT.route).toBeGreaterThanOrEqual(KIND_WEIGHT.function);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/node-ranker.test.ts`
Expected: FAIL — `Cannot find module '../../src/graph/node-ranker.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/graph/node-ranker.ts`:

```ts
/**
 * Pure ranker for search_graph results. No I/O — mirrors frame-ranker.ts.
 *
 * score = KIND_WEIGHT[kind] × nameMatchQuality(name, query)
 *
 * Sort is total and deterministic (score desc → shorter name → qualified_name
 * asc), so paginated calls over the same match set return a stable ordering.
 *
 * Forward-compat: a `layerWeight` argument can be added later (P2.1, frame/
 * layer-aware ranking) without changing existing call sites.
 */
import type { IndexerNode } from "./code-queries.js";

export const KIND_WEIGHT: Record<string, number> = {
  route: 1.0, function: 0.95, class: 0.95, method: 0.9,
  interface: 0.75, type: 0.75,
  module: 0.55, file: 0.5, folder: 0.45, variable: 0.5,
  channel: 0.4, anchor: 0.35,
  section: 0.1,
};
const DEFAULT_KIND_WEIGHT = 0.5;

/** Match quality of a node name against the search query.
 *  Absent query (qn-only search) → neutral 1. */
export function nameMatchQuality(name: string, query?: string): number {
  if (!query) return 1;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1.0;
  if (n.startsWith(q)) return 0.7;
  return 0.4;
}

export function scoreNode(node: IndexerNode, query?: string): number {
  const w = KIND_WEIGHT[node.kind] ?? DEFAULT_KIND_WEIGHT;
  return w * nameMatchQuality(node.name, query);
}

/** Returns a new array sorted by relevance; never mutates the input. */
export function rankNodes(nodes: IndexerNode[], query?: string): IndexerNode[] {
  return [...nodes].sort((a, b) => {
    const sb = scoreNode(b, query) - scoreNode(a, query);
    if (sb !== 0) return sb;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : 0;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/node-ranker.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add src/graph/node-ranker.ts tests/graph/node-ranker.test.ts
git commit -m "feat(graph): pure node-ranker for search_graph relevance"
```

---

## Task 2: searchGraph kinds filter + section exclusion + suppressed count

**Files:**
- Modify: `src/graph/code-queries.ts:40-70`
- Test: `tests/graph/code-queries.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("code-queries against unified cortex.db", …)` block in `tests/graph/code-queries.test.ts` (the fixture `docs/guide.md` produces `section` nodes `Sample Project`, `Overview`, `Usage`):

```ts
  it("searchGraph excludes section nodes by default", () => {
    const results = searchGraph(store, project, {});
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((n) => n.kind === "section")).toBe(false);
  });

  it("searchGraph includes sections when kinds requests them", () => {
    const results = searchGraph(store, project, { kinds: ["section"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((n) => n.kind === "section")).toBe(true);
    expect(results.some((n) => n.name === "Usage")).toBe(true);
  });

  it("searchGraph narrows to the requested kinds", () => {
    const results = searchGraph(store, project, { kinds: ["function"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((n) => n.kind === "function")).toBe(true);
  });

  it("countSuppressedSections counts pattern-matching sections", () => {
    expect(countSuppressedSections(store, project, { name_pattern: "Usage" })).toBeGreaterThanOrEqual(1);
    expect(countSuppressedSections(store, project, { name_pattern: "zzz-no-match" })).toBe(0);
  });
```

Update the import on line 8 to add `countSuppressedSections`:

```ts
import { searchGraph, countSuppressedSections, tracePath, getGraphSchema, listProjects, listProjectsUnified, indexStatus } from "../../src/graph/code-queries.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/code-queries.test.ts`
Expected: FAIL — `countSuppressedSections` is not exported; the `kinds`/default-exclusion tests fail because `searchGraph` does not yet filter sections.

- [ ] **Step 3: Write the minimal implementation**

In `src/graph/code-queries.ts`, replace the `searchGraph` function (lines 42-70) and add `countSuppressedSections`. The current `CODE_KIND_FILTER` constant on line 40 stays:

```ts
const CODE_KIND_FILTER = "kind NOT IN ('decision', 'pr', 'todo')";
const MAX_SEARCH_ROWS = 1000;

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string; kinds?: string[] }
): IndexerNode[] {
  const conditions: string[] = ["project = ?"];
  const values: unknown[] = [project];

  // Effective kind filter: an explicit kinds list (incl. the legacy `label`
  // alias) replaces the default; otherwise default to code kinds with
  // sections excluded.
  const kinds = [...(params.kinds ?? []), ...(params.label ? [params.label] : [])]
    .map((k) => k.toLowerCase());
  if (kinds.length > 0) {
    conditions.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    values.push(...kinds);
  } else {
    conditions.push(CODE_KIND_FILTER);
    conditions.push("kind != 'section'");
  }

  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }

  return store.queryRaw<IndexerNode>(
    `SELECT * FROM nodes WHERE ${conditions.join(" AND ")} LIMIT ${MAX_SEARCH_ROWS}`,
    values
  );
}

/** Count section nodes matching the name/qn pattern — i.e. how many results
 *  the default (no-kinds) filter suppressed. Callers pass 0 to the renderer
 *  when sections were opted in. */
export function countSuppressedSections(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; qn_pattern?: string }
): number {
  const conditions: string[] = ["project = ?", "kind = 'section'"];
  const values: unknown[] = [project];
  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }
  const row = store.queryRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM nodes WHERE ${conditions.join(" AND ")}`,
    values
  )[0];
  return row?.n ?? 0;
}
```

Note: the legacy single-`label` behavior is preserved — `label: "function"` now flows through the `kinds` union as `["function"]`, producing the same `kind IN (...)` filter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/code-queries.test.ts`
Expected: PASS — including the existing `searchGraph returns matches by name pattern` test (handleRequest is a `function`, not a section, so default exclusion does not affect it).

- [ ] **Step 5: Commit**

```bash
git add src/graph/code-queries.ts tests/graph/code-queries.test.ts
git commit -m "feat(graph): searchGraph kinds filter + default section exclusion"
```

---

## Task 3: Pure search-format module (clamp + render)

**Files:**
- Create: `src/mcp-server/tools/search-format.ts`
- Test: `tests/mcp-server/search-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp-server/search-format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clampLimit, clampOffset, renderNodeSearch } from "../../src/mcp-server/tools/search-format.js";
import type { IndexerNode } from "../../src/graph/code-queries.js";

function node(name: string, kind = "function"): IndexerNode {
  return {
    id: name, project: "p", kind, name,
    qualified_name: `mod::${name}`, file_path: "src/mod.ts",
    start_line: 1, end_line: 2, data: "{}",
  };
}

describe("clampLimit", () => {
  it("defaults to 30 when undefined", () => expect(clampLimit(undefined)).toBe(30));
  it("clamps to [1, 100]", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(42)).toBe(42);
  });
});

describe("clampOffset", () => {
  it("defaults to 0 and floors negatives", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(12)).toBe(12);
  });
});

describe("renderNodeSearch", () => {
  const rows = [node("serveA"), node("serveB"), node("serveC")];

  it("renders a header with the showing-window and total", () => {
    const text = renderNodeSearch(rows, { query: "serve", limit: 2, offset: 0, suppressedSections: 0 });
    expect(text.split("\n")[0]).toBe("showing 1–2 of 3 · offset 0");
    expect(text).toContain("function mod::serveA (src/mod.ts:1-2)");
    expect(text).not.toContain("serveC"); // outside the window
  });

  it("appends a suppression note only when sections were suppressed", () => {
    const withNote = renderNodeSearch(rows, { query: "serve", limit: 30, offset: 0, suppressedSections: 41 });
    expect(withNote.split("\n")[0]).toContain("41 section nodes suppressed (pass kinds=[\"section\"])");
    const noNote = renderNodeSearch(rows, { query: "serve", limit: 30, offset: 0, suppressedSections: 0 });
    expect(noNote).not.toContain("suppressed");
  });

  it("emits a showing-0 header on offset overshoot", () => {
    const text = renderNodeSearch(rows, { query: "serve", limit: 10, offset: 200, suppressedSections: 0 });
    expect(text.split("\n")[0]).toBe("showing 0 of 3 · offset 200");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp-server/search-format.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp-server/tools/search-format.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/mcp-server/tools/search-format.ts`:

```ts
/**
 * Pure presentation helpers for the search_graph tool: input clamping and
 * result rendering (ranking is applied by the caller via node-ranker).
 * No I/O, fully unit-testable.
 */
import type { IndexerNode } from "../../graph/code-queries.js";
import { rankNodes } from "../../graph/node-ranker.js";
import { denormalize } from "../qualified-name.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function clampOffset(offset?: number): number {
  if (offset === undefined) return 0;
  return Math.max(0, Math.floor(offset));
}

function formatLine(n: IndexerNode): string {
  return `${n.kind} ${denormalize(n.qualified_name, n.file_path)} (${n.file_path}:${n.start_line}-${n.end_line})`;
}

/** Rank `rows`, slice the [offset, offset+limit) window, and render a
 *  header + node lines. `suppressedSections` > 0 appends an opt-in hint. */
export function renderNodeSearch(
  rows: IndexerNode[],
  opts: { query?: string; limit: number; offset: number; suppressedSections: number },
): string {
  const total = rows.length;
  const ranked = rankNodes(rows, opts.query);
  const window = ranked.slice(opts.offset, opts.offset + opts.limit);
  const first = window.length === 0 ? 0 : opts.offset + 1;
  const last = opts.offset + window.length;
  const range = window.length === 0 ? "0" : `${first}–${last}`;
  let header = `showing ${range} of ${total} · offset ${opts.offset}`;
  if (opts.suppressedSections > 0) {
    header += ` · ${opts.suppressedSections} section nodes suppressed (pass kinds=["section"])`;
  }
  const body = window.map(formatLine).join("\n");
  return body ? `${header}\n${body}` : header;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp-server/search-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/search-format.ts tests/mcp-server/search-format.test.ts
git commit -m "feat(mcp): pure search-format render + clamp helpers"
```

---

## Task 4: Wire the search_graph tool handler

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts:54-59` (shape), `:782-793` (handler), `:443-449` (remove unused `formatNodes`)

- [ ] **Step 1: Extend the input shape**

Replace `searchGraphShape` (lines 54-59) with:

```ts
const searchGraphShape = {
  repo_path: RepoPathField,
  name_pattern: z.string().optional(),
  label: z.string().optional(),
  qn_pattern: z.string().optional(),
  kinds: z.array(z.string()).optional()
    .describe("Restrict to these node kinds (e.g. [\"function\",\"route\"]). Pass [\"section\"] to include doc/plan headings, which are excluded by default."),
  limit: z.number().int().optional().describe("Page size (default 30, max 100)."),
  offset: z.number().int().optional().describe("Result offset for pagination (default 0)."),
} as const;
```

- [ ] **Step 2: Add imports**

At the top of `code-tools.ts`, add to the existing `code-queries.js` import the `countSuppressedSections` symbol, and add a new import line for the render helpers. The current import is:

```ts
import {
  searchGraph,
  ...
} from "../../graph/code-queries.js";
```

Add `countSuppressedSections` to that list, and add:

```ts
import { clampLimit, clampOffset, renderNodeSearch } from "./search-format.js";
```

- [ ] **Step 3: Rewrite the handler**

Replace the handler body (lines 782-793) with:

```ts
      async (ctx, args) => {
        const project = projectFromCtx(ctx);
        if (!project) {
          return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
        }
        const { repo_path: _repoPath, limit, offset, ...params } = args;
        const qn = params.qn_pattern ? normalize(params.qn_pattern, project) : undefined;
        const searchParams = { ...params, qn_pattern: qn };
        const rows = searchGraph(ctx.store, project, searchParams);
        const queryDesc = `search_graph(${JSON.stringify(params)})`;
        if (rows.length === 0) return empty(queryDesc);
        const optedInSections = [...(params.kinds ?? []), ...(params.label ? [params.label] : [])]
          .map((k) => k.toLowerCase())
          .includes("section");
        const suppressedSections = optedInSections
          ? 0
          : countSuppressedSections(ctx.store, project, { name_pattern: params.name_pattern, qn_pattern: qn });
        const text = renderNodeSearch(rows, {
          query: params.name_pattern ?? qn,
          limit: clampLimit(limit),
          offset: clampOffset(offset),
          suppressedSections,
        });
        return ok(text);
      },
```

- [ ] **Step 4: Remove the now-unused `formatNodes`**

`formatNodes` (lines 443-449) was only used by the old `search_graph` handler. Delete the function. (If a type-check reports another user, keep it — but per the call-site audit on 2026-06-14 the only caller was line 790.)

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no type errors (the `get_code_snippet` callers at the old lines 875/884 still call `searchGraph` and receive `IndexerNode[]`, unchanged); all existing tests green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat(mcp): rank + paginate search_graph, exclude sections by default"
```

---

## Task 5: Document the new behavior

**Files:**
- Modify: `docs/mcp-tools.md` (the `search_graph` entry)

- [ ] **Step 1: Update the search_graph reference**

Find the `search_graph` section in `docs/mcp-tools.md` and update it to document: the new `kinds`, `limit`, `offset` params; that `section` nodes are excluded by default and re-enabled via `kinds: ["section"]`; that results are ranked by kind priority + name-match quality; and the `showing A–B of N · offset M` header with the suppression note. Keep the existing `repo_path` contract text. (No code; documentation only — match the surrounding entry's format.)

- [ ] **Step 2: Commit**

```bash
git add docs/mcp-tools.md
git commit -m "docs(mcp-tools): document search_graph ranking, kinds, pagination"
```

---

## After all tasks

- Gate 0 (visual/live QA): not a viewer change, but verify the tool live — start `npm run dev`, call `search_graph(name_pattern="serve")` against this repo via the MCP server (or the dev HTTP harness), and confirm: sections excluded, header present with a suppressed count, `kinds:["section"]` brings them back, `limit`/`offset` page correctly. This is the honest end-to-end check the unit tests can't give.
- Gate 1: `/review` on the diff since branch point.
- Capture a decision (`create_decision`) for the ranking model + section-default, linked to the frame kind-weight decision `D-qn7z` lineage and citing field-report P2.
- Gate 2 + merge protocol: full suite, version bump (patch → 0.8.11) across `package.json` / `plugin.json` / `.claude-plugin/marketplace.json` + CHANGELOG entry.
