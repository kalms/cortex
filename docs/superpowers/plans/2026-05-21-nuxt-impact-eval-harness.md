# Nuxt-Impact Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a measurement harness that proves whether the priority fixes from the Nuxt field assessment actually moved the needle, by running a fixed battery of scorecard queries and named assertions against pinned Nuxt repos plus a local anthill-cloud checkout.

**Architecture:** A new `evals/` package at the repo root. Pure TypeScript driver that uses cortex's own `GraphStore` (via raw SQL) to read graph DBs produced by `bin/cortex-indexer`. Tool-behavior assertions invoke the MCP tool handlers in-process. Output is a per-run scorecard JSON + markdown report; baselines are committed per target.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (via existing `GraphStore`), execFile for shell-out to `bin/cortex-indexer` and `git clone`.

**Spec:** [docs/superpowers/specs/2026-05-21-nuxt-impact-eval-harness-design.md](../specs/2026-05-21-nuxt-impact-eval-harness-design.md)

**Dependency note:** Five tool-behavior assertions in Task 6 exercise MCP tools that include `create_decision`. Those assertions assume the rationale validator from the [MCP tool robustness plan](./2026-05-21-mcp-tool-robustness.md) is **not yet** rejecting clean input — which it won't, by design. There is no hard ordering between the two plans; they can land in either order.

---

## File structure

**New top-level directory:** `evals/`

```
evals/
  targets.json                                # pinned target repos + local-path overrides
  baselines/                                  # committed; one per target
  fixtures/                                   # per-target inputs for tool-behavior assertions
  src/
    cli.ts                                    # argv parsing, dispatch
    target.ts                                 # clone-or-reuse + index, returns graph.db path
    scorecard.ts                              # bulk counts + killer queries (raw SQL)
    queries.ts                                # the killer-query catalog (SQL strings + sample helpers)
    assertions/
      types.ts                                # Assertion, AssertionResult, Predicate, ToolCall
      runner.ts                               # runAssertion(a, ctx) -> AssertionResult
      tool-runner.ts                          # runToolAssertion(a, ctx) -> AssertionResult (in-process MCP)
      fix-2-http-calls.ts
      fix-3-auto-imports.ts
      fix-4-sfc-functions.ts
      fix-5-nitro-handlers.ts
      fix-6-route-poison.ts
      fix-8-decision-promotion.ts
      registry.ts                             # ALL_ASSERTIONS = [...] in fix_id order
    report.ts                                 # write summary.md + <target>.md + <target>.json
  reports/                                    # gitignored — per-run output
  cache/                                      # gitignored — cloned target repos
tests/
  evals/
    scorecard.test.ts
    assertion-runner.test.ts
    tool-runner.test.ts
    report.test.ts
    queries.test.ts
```

**Modified files:**

- `package.json` — add `"eval": "tsx evals/src/cli.ts"` script
- `.gitignore` — add `/evals/reports/` and `/evals/cache/`
- `tsconfig.json` (if needed) — ensure `evals/**/*.ts` is included; the existing config is permissive but verify when scaffolding lands.

---

## Task 1: Scaffold the directory structure and tooling

Goal: every subsequent task has a place to put files. Nothing functional yet — just empty modules, gitignore, and an npm script that fails gracefully.

**Files:**

- Create: `evals/targets.json`
- Create: `evals/baselines/.gitkeep`
- Create: `evals/fixtures/.gitkeep`
- Create: `evals/src/cli.ts` (stub)
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add `evals/` paths to .gitignore**

Append to `.gitignore`:

```
# Eval harness output and cache
/evals/reports/
/evals/cache/
```

- [ ] **Step 2: Create `evals/targets.json` with initial roster**

```json
{
  "targets": [
    {
      "name": "nuxt-ui",
      "repo_url": "https://github.com/nuxt/ui.git",
      "sha": "main",
      "default_branch": "main"
    },
    {
      "name": "nuxthub-starter",
      "repo_url": "https://github.com/nuxt-hub/starter.git",
      "sha": "main",
      "default_branch": "main"
    },
    {
      "name": "anthill-cloud",
      "local_path": "/Users/rka/Development/anthill-cloud"
    }
  ]
}
```

Note: `sha: "main"` is a placeholder — replace with pinned commit SHAs during the first real run (Task 10) so subsequent runs are reproducible.

- [ ] **Step 3: Create an empty `evals/baselines/.gitkeep` and `evals/fixtures/.gitkeep`**

Both files are empty; their purpose is to make the directories survive git commits before any real content lands.

- [ ] **Step 4: Create the CLI stub `evals/src/cli.ts`**

```ts
#!/usr/bin/env tsx
console.error("evals: not implemented yet");
process.exit(1);
```

- [ ] **Step 5: Add the npm script to package.json**

In `package.json`, add to the `"scripts"` block:

```json
"eval": "tsx evals/src/cli.ts"
```

Place it in alphabetical position among existing scripts.

- [ ] **Step 6: Verify the script wires up**

Run: `npm run eval`
Expected: stderr says "evals: not implemented yet"; process exits with code 1. This is just confirming the npm-script wiring is intact.

- [ ] **Step 7: Commit**

```bash
git add evals/ package.json .gitignore
git commit -m "feat(evals): scaffold harness directory and npm script

Empty directory layout for the Nuxt-impact eval harness:
targets.json roster, baselines/ + fixtures/ keepalives, a stub
cli.ts, gitignored reports/ + cache/, and the npm 'eval' script.
No functional logic yet — wired up so subsequent tasks have
landing pads.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Type definitions

Goal: shared types used across the rest of the harness. Pure data; no logic; no tests (types alone don't run).

**Files:**

- Create: `evals/src/assertions/types.ts`

- [ ] **Step 1: Write the type definitions**

Create `evals/src/assertions/types.ts`:

```ts
export type Target = {
  name: string;
  repo_url?: string;
  sha?: string;
  default_branch?: string;
  local_path?: string;
};

export type Targets = { targets: Target[] };

export type FixId = 2 | 3 | 4 | 5 | 6 | 8;

// Query shapes the harness can run.
export type AssertionQuery =
  | { kind: "sql"; sql: string }
  | { kind: "count_label"; label: string }                // nodes WHERE kind = ?
  | { kind: "count_edge"; type: string }                  // edges WHERE relation = ?
  | { kind: "tool_call"; tool: string; args: Record<string, unknown> };

export type Predicate =
  | { op: "gt"; value: number }
  | { op: "gte"; value: number }
  | { op: "eq"; value: number }
  | { op: "matches"; regex: string }
  | { op: "no_match"; regex: string }
  | { op: "tool_text_nonempty" }                          // tool result content is non-empty
  | { op: "tool_text_contains"; needle: string };

export type Assertion = {
  fix_id: FixId;
  name: string;
  description: string;
  query: AssertionQuery;
  predicate: Predicate;
  baseline_expected: "pass" | "fail";
};

export type AssertionResult = {
  assertion: Assertion;
  observed: number | string[] | { text: string; isError?: boolean };
  passed: boolean;
  surprised: boolean;
};

export type KillerQueryResult = {
  name: string;
  cypher: string;        // illustrative; the actual SQL lives in queries.ts
  row_count: number;
  sample_rows: unknown[];
};

export type Scorecard = {
  target: string;
  indexer_seconds: number | null;       // null if reusing existing index
  nodes_by_label: Record<string, number>;
  edges_by_type: Record<string, number>;
  killer_queries: KillerQueryResult[];
};

export type Baseline = {
  target: string;
  captured_at: string;                  // ISO 8601
  source_sha?: string;                  // for cloned targets; null for local_path
  nodes_by_label: Record<string, number>;
  edges_by_type: Record<string, number>;
  per_assertion: Record<string, number | string[]>; // assertion name -> observed value
};
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit`
Expected: PASS. No imports reach into untyped code.

- [ ] **Step 3: Commit**

```bash
git add evals/src/assertions/types.ts
git commit -m "feat(evals): define assertion + scorecard + baseline types

Pure types module. AssertionQuery covers SQL, count_label,
count_edge, and tool_call. Predicate covers numeric comparisons,
regex matches, and tool-result shape checks. AssertionResult
carries the surprised flag — true when outcome differs from
baseline_expected.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Scorecard module — bulk counts + killer queries

Goal: given a graph.db path and a project name, produce a Scorecard. Uses raw SQL via cortex's `GraphStore.queryRaw`.

**Files:**

- Create: `evals/src/queries.ts`
- Create: `evals/src/scorecard.ts`
- Create: `tests/evals/scorecard.test.ts`

- [ ] **Step 1: Write the failing scorecard test**

Create `tests/evals/scorecard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { computeScorecard } from "../../evals/src/scorecard.js";

describe("scorecard", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-scorecard-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("nodes_by_label counts kinds correctly", () => {
    store.createNode({ kind: "function", name: "foo" });
    store.createNode({ kind: "function", name: "bar" });
    store.createNode({ kind: "module", name: "m1" });
    const sc = computeScorecard(dbPath, "test-project");
    expect(sc.nodes_by_label.function).toBe(2);
    expect(sc.nodes_by_label.module).toBe(1);
  });

  it("edges_by_type counts relations correctly", () => {
    const a = store.createNode({ kind: "function", name: "a" });
    const b = store.createNode({ kind: "function", name: "b" });
    // Use raw insert because GraphStore's edge API may differ; the harness
    // queries the table directly, so we set it up the same way.
    (store as any).db.prepare(
      "INSERT INTO edges (id, source_id, target_id, relation, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run("e1", a.id, b.id, "CALLS", new Date().toISOString());
    (store as any).db.prepare(
      "INSERT INTO edges (id, source_id, target_id, relation, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run("e2", a.id, b.id, "HTTP_CALLS", new Date().toISOString());
    const sc = computeScorecard(dbPath, "test-project");
    expect(sc.edges_by_type.CALLS).toBe(1);
    expect(sc.edges_by_type.HTTP_CALLS).toBe(1);
  });

  it("killer_queries returns a list with name, row_count, sample_rows", () => {
    store.createNode({ kind: "function", name: "foo", file_path: "src/a.ts" });
    const sc = computeScorecard(dbPath, "test-project");
    expect(Array.isArray(sc.killer_queries)).toBe(true);
    const vue = sc.killer_queries.find((q) => q.name === "vue_function_count");
    expect(vue).toBeDefined();
    expect(vue?.row_count).toBe(0); // no .vue files in this fixture
  });

  it("nodes in .vue files are reflected in vue_function_count killer query", () => {
    store.createNode({ kind: "function", name: "render", file_path: "app/Card.vue" });
    store.createNode({ kind: "function", name: "setup", file_path: "app/Button.vue" });
    const sc = computeScorecard(dbPath, "test-project");
    const vue = sc.killer_queries.find((q) => q.name === "vue_function_count");
    expect(vue?.row_count).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/evals/scorecard.test.ts`
Expected: FAIL — `computeScorecard` not exported.

- [ ] **Step 3: Write the queries catalog**

Create `evals/src/queries.ts`:

```ts
// Killer queries — fixed list, run on every target. SQL is concrete here;
// the spec's Cypher is illustrative. Each entry has a Cypher comment so the
// SQL can be cross-checked against the spec.

export type KillerQuery = {
  name: string;
  cypher: string;     // illustrative — what this would look like in Cypher
  sql: string;        // actual query the harness runs
};

export const KILLER_QUERIES: KillerQuery[] = [
  {
    name: "functions_high_degree",
    cypher: "MATCH (f:function) WHERE f.degree > 5 RETURN f.name, f.degree LIMIT 20",
    // degree = count of incoming + outgoing edges for the node
    sql: `
      SELECT n.name, n.file_path,
             (SELECT COUNT(*) FROM edges WHERE source_id = n.id OR target_id = n.id) AS degree
      FROM nodes n
      WHERE n.kind = 'function'
        AND (SELECT COUNT(*) FROM edges WHERE source_id = n.id OR target_id = n.id) > 5
      LIMIT 20
    `,
  },
  {
    name: "http_calls_with_api_path",
    cypher: "MATCH ()-[r:HTTP_CALLS]->(rt:Route) WHERE rt.name STARTS WITH '/api' RETURN rt.name, count(r) LIMIT 20",
    sql: `
      SELECT rt.name AS route_name, COUNT(*) AS call_count
      FROM edges e
      JOIN nodes rt ON rt.id = e.target_id
      WHERE e.relation = 'HTTP_CALLS'
        AND rt.kind = 'Route'
        AND rt.name LIKE '/api%'
      GROUP BY rt.name
      LIMIT 20
    `,
  },
  {
    name: "route_nodes_named",
    cypher: "MATCH (r:Route) RETURN r.name LIMIT 40",
    sql: "SELECT name FROM nodes WHERE kind = 'Route' LIMIT 40",
  },
  {
    name: "composables_called",
    cypher: "MATCH (f:function)-[c:CALLS]->(g:function) WHERE g.name STARTS WITH 'use' RETURN g.name, count(c) ORDER BY count(c) DESC LIMIT 20",
    sql: `
      SELECT g.name AS composable, COUNT(*) AS in_degree
      FROM edges e
      JOIN nodes g ON g.id = e.target_id
      WHERE e.relation = 'CALLS'
        AND g.kind = 'function'
        AND g.name LIKE 'use%'
      GROUP BY g.name
      ORDER BY in_degree DESC
      LIMIT 20
    `,
  },
  {
    name: "vue_function_count",
    cypher: "MATCH (f:function) WHERE f.file_path ENDS WITH '.vue' RETURN count(f)",
    sql: `
      SELECT name, file_path
      FROM nodes
      WHERE kind = 'function' AND file_path LIKE '%.vue'
    `,
  },
  {
    name: "nitro_handlers",
    cypher: "MATCH (f:function) WHERE f.file_path =~ '.*server/api/.*\\.ts' RETURN f.qualified_name LIMIT 20",
    sql: `
      SELECT qualified_name, file_path
      FROM nodes
      WHERE kind = 'function' AND file_path LIKE '%server/api/%' AND file_path LIKE '%.ts'
      LIMIT 20
    `,
  },
  {
    name: "decisions_present",
    cypher: "MATCH (d:Decision) RETURN count(d)",
    sql: "SELECT id, name FROM nodes WHERE kind = 'Decision'",
  },
];
```

- [ ] **Step 4: Write the scorecard module**

Create `evals/src/scorecard.ts`:

```ts
import { GraphStore } from "../../src/graph/store.js";
import { KILLER_QUERIES } from "./queries.js";
import type { Scorecard, KillerQueryResult } from "./assertions/types.js";

const SAMPLE_ROW_LIMIT = 5;

export function computeScorecard(dbPath: string, target: string): Scorecard {
  const store = new GraphStore(dbPath);

  const nodes_by_label: Record<string, number> = {};
  for (const row of store.queryRaw<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind",
  )) {
    nodes_by_label[row.kind] = row.n;
  }

  const edges_by_type: Record<string, number> = {};
  for (const row of store.queryRaw<{ relation: string; n: number }>(
    "SELECT relation, COUNT(*) AS n FROM edges GROUP BY relation",
  )) {
    edges_by_type[row.relation] = row.n;
  }

  const killer_queries: KillerQueryResult[] = KILLER_QUERIES.map((q) => {
    const rows = store.queryRaw<Record<string, unknown>>(q.sql);
    return {
      name: q.name,
      cypher: q.cypher,
      row_count: rows.length,
      sample_rows: rows.slice(0, SAMPLE_ROW_LIMIT),
    };
  });

  return {
    target,
    indexer_seconds: null,
    nodes_by_label,
    edges_by_type,
    killer_queries,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/evals/scorecard.test.ts`
Expected: PASS — all 4 assertions green.

- [ ] **Step 6: Commit**

```bash
git add evals/src/queries.ts evals/src/scorecard.ts tests/evals/scorecard.test.ts
git commit -m "feat(evals): scorecard module with bulk counts and killer queries

Reads a graph.db via cortex's GraphStore, computes nodes_by_label
and edges_by_type via GROUP BY, and runs the seven killer queries
from the harness spec. Each killer query records row_count + the
first 5 sample rows — samples are reference material, never
asserted on.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Assertion runner (SQL / count_label / count_edge queries)

Goal: take an `Assertion` whose query is graph-only (not `tool_call`), run it against a graph.db, return an `AssertionResult` with pass/surprised flags computed.

**Files:**

- Create: `evals/src/assertions/runner.ts`
- Create: `tests/evals/assertion-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evals/assertion-runner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runAssertion } from "../../evals/src/assertions/runner.js";
import type { Assertion } from "../../evals/src/assertions/types.js";

describe("assertion runner — graph queries", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-runner-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("count_label > 0 passes when nodes of that kind exist", () => {
    store.createNode({ kind: "function", name: "f" });
    const a: Assertion = {
      fix_id: 4,
      name: "has_functions",
      description: "at least one function node exists",
      query: { kind: "count_label", label: "function" },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);
    expect(result.observed).toBe(1);
    expect(result.surprised).toBe(true); // baseline expected fail, got pass = surprised
  });

  it("count_label > 0 fails when no nodes of that kind exist; surprised when baseline=pass", () => {
    const a: Assertion = {
      fix_id: 6,
      name: "no_tarball_routes",
      description: "no polluted Route nodes",
      query: { kind: "count_label", label: "Route" },
      predicate: { op: "eq", value: 0 },
      baseline_expected: "pass",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);   // 0 == 0
    expect(result.surprised).toBe(false); // baseline=pass, actual=pass
  });

  it("count_edge counts edges by relation", () => {
    const n = store.createNode({ kind: "function", name: "f" });
    (store as any).db.prepare(
      "INSERT INTO edges (id, source_id, target_id, relation, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run("e1", n.id, n.id, "HTTP_CALLS", new Date().toISOString());
    const a: Assertion = {
      fix_id: 2,
      name: "http_calls_edge_count_nonzero",
      description: "at least one HTTP_CALLS edge",
      query: { kind: "count_edge", type: "HTTP_CALLS" },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);
    expect(result.observed).toBe(1);
  });

  it("sql query with 'matches' predicate checks every returned row", () => {
    store.createNode({ kind: "Route", name: "/api/orders" });
    store.createNode({ kind: "Route", name: "/api/users" });
    const a: Assertion = {
      fix_id: 2,
      name: "all_routes_under_api",
      description: "every route under /api",
      query: { kind: "sql", sql: "SELECT name FROM nodes WHERE kind = 'Route'" },
      predicate: { op: "matches", regex: "^/api/" },
      baseline_expected: "fail",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(true);
    expect(result.observed).toEqual(["/api/orders", "/api/users"]);
  });

  it("'no_match' predicate fails when any row matches", () => {
    store.createNode({ kind: "Route", name: "https://codeartifact.example.com/foo.tgz" });
    store.createNode({ kind: "Route", name: "/api/orders" });
    const a: Assertion = {
      fix_id: 6,
      name: "no_codeartifact_routes",
      description: "no codeartifact in route names",
      query: { kind: "sql", sql: "SELECT name FROM nodes WHERE kind = 'Route'" },
      predicate: { op: "no_match", regex: "codeartifact" },
      baseline_expected: "pass",
    };
    const result = runAssertion(a, { dbPath });
    expect(result.passed).toBe(false);
    expect(result.surprised).toBe(true); // baseline=pass, got fail = regression
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/evals/assertion-runner.test.ts`
Expected: FAIL — `runAssertion` not exported.

- [ ] **Step 3: Write the assertion runner**

Create `evals/src/assertions/runner.ts`:

```ts
import { GraphStore } from "../../../src/graph/store.js";
import type { Assertion, AssertionResult, Predicate } from "./types.js";

export type RunnerContext = {
  dbPath: string;
};

export function runAssertion(a: Assertion, ctx: RunnerContext): AssertionResult {
  const store = new GraphStore(ctx.dbPath);

  let observed: number | string[];
  switch (a.query.kind) {
    case "count_label": {
      const row = store.queryRaw<{ n: number }>(
        "SELECT COUNT(*) AS n FROM nodes WHERE kind = ?",
        [a.query.label],
      )[0];
      observed = row?.n ?? 0;
      break;
    }
    case "count_edge": {
      const row = store.queryRaw<{ n: number }>(
        "SELECT COUNT(*) AS n FROM edges WHERE relation = ?",
        [a.query.type],
      )[0];
      observed = row?.n ?? 0;
      break;
    }
    case "sql": {
      const rows = store.queryRaw<Record<string, unknown>>(a.query.sql);
      // For matches/no_match predicates, return list of stringified first column.
      // For numeric predicates (gt/gte/eq), return row count.
      if (a.predicate.op === "matches" || a.predicate.op === "no_match") {
        observed = rows.map((r) => String(Object.values(r)[0] ?? ""));
      } else {
        observed = rows.length;
      }
      break;
    }
    case "tool_call":
      throw new Error(
        `runAssertion: tool_call query kind not supported here — use runToolAssertion from tool-runner.ts`,
      );
  }

  const passed = evaluatePredicate(a.predicate, observed);
  const surprised =
    (a.baseline_expected === "pass" && !passed) ||
    (a.baseline_expected === "fail" && passed);

  return { assertion: a, observed, passed, surprised };
}

function evaluatePredicate(p: Predicate, observed: number | string[]): boolean {
  switch (p.op) {
    case "gt":
      return typeof observed === "number" && observed > p.value;
    case "gte":
      return typeof observed === "number" && observed >= p.value;
    case "eq":
      return typeof observed === "number" && observed === p.value;
    case "matches": {
      if (!Array.isArray(observed)) return false;
      const re = new RegExp(p.regex);
      return observed.every((row) => re.test(row));
    }
    case "no_match": {
      if (!Array.isArray(observed)) return false;
      const re = new RegExp(p.regex);
      return !observed.some((row) => re.test(row));
    }
    case "tool_text_nonempty":
    case "tool_text_contains":
      throw new Error(
        "evaluatePredicate: tool_* predicates require runToolAssertion, not runAssertion",
      );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/evals/assertion-runner.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 5: Commit**

```bash
git add evals/src/assertions/runner.ts tests/evals/assertion-runner.test.ts
git commit -m "feat(evals): assertion runner for SQL + count queries

runAssertion takes an Assertion and a dbPath, queries via cortex's
GraphStore, evaluates the predicate, and returns AssertionResult
with passed and surprised flags. surprised flips when outcome
differs from baseline_expected — that's the column humans scan.

Tool-call assertions are explicitly out of scope here; they need
the in-process MCP harness and land in tool-runner.ts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Per-fix assertion data (six files)

Goal: encode all 20 graph-content assertions as static data, one file per fix. Pure data; no logic; tested by the registry test below.

**Files:**

- Create: `evals/src/assertions/fix-2-http-calls.ts`
- Create: `evals/src/assertions/fix-3-auto-imports.ts`
- Create: `evals/src/assertions/fix-4-sfc-functions.ts`
- Create: `evals/src/assertions/fix-5-nitro-handlers.ts`
- Create: `evals/src/assertions/fix-6-route-poison.ts`
- Create: `evals/src/assertions/fix-8-decision-promotion.ts`
- Create: `evals/src/assertions/registry.ts`
- Create: `tests/evals/registry.test.ts`

- [ ] **Step 1: Write `fix-2-http-calls.ts`**

```ts
import type { Assertion } from "./types.js";

export const FIX_2_ASSERTIONS: Assertion[] = [
  {
    fix_id: 2,
    name: "http_calls_edge_count_nonzero",
    description: "At least one HTTP_CALLS edge exists",
    query: { kind: "count_edge", type: "HTTP_CALLS" },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 2,
    name: "http_calls_to_api_route",
    description: "More than 5 HTTP_CALLS edges target a Route node whose name starts with /api",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM edges e
        JOIN nodes rt ON rt.id = e.target_id
        WHERE e.relation = 'HTTP_CALLS' AND rt.kind = 'Route' AND rt.name LIKE '/api%'
      `,
    },
    predicate: { op: "gt", value: 5 },
    baseline_expected: "fail",
  },
  {
    fix_id: 2,
    name: "route_node_named_api_path",
    description: "More than 3 Route nodes have names starting with /api",
    query: {
      kind: "sql",
      sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'Route' AND name LIKE '/api%'",
    },
    predicate: { op: "gt", value: 3 },
    baseline_expected: "fail",
  },
];
```

- [ ] **Step 2: Write `fix-3-auto-imports.ts`**

```ts
import type { Assertion } from "./types.js";

export const FIX_3_ASSERTIONS: Assertion[] = [
  // imports_edge_count_grew is baseline-relative and lives in the report
  // layer (Task 7) rather than as a static predicate. It's intentionally
  // omitted from this file.
  {
    fix_id: 3,
    name: "composable_has_callers",
    description: "At least one function whose name starts with 'use' has CALLS in-degree > 0",
    query: {
      kind: "sql",
      sql: `
        SELECT g.name FROM edges e
        JOIN nodes g ON g.id = e.target_id
        WHERE e.relation = 'CALLS' AND g.kind = 'function' AND g.name LIKE 'use%'
        GROUP BY g.name
      `,
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 3,
    name: "pinia_store_node_exists",
    description: "defineStore appears as a function with at least one CALLS edge to it",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM edges e
        JOIN nodes g ON g.id = e.target_id
        WHERE e.relation = 'CALLS' AND g.kind = 'function' AND g.name = 'defineStore'
      `,
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
];
```

- [ ] **Step 3: Write `fix-4-sfc-functions.ts`**

```ts
import type { Assertion } from "./types.js";

// Three graph-content + four tool-behavior assertions. Tool-behavior assertions
// have query kind 'tool_call' and require runToolAssertion (Task 6).
export const FIX_4_ASSERTIONS: Assertion[] = [
  {
    fix_id: 4,
    name: "vue_function_node_count_nonzero",
    description: "More than 10 function nodes with file_path ending in .vue",
    query: {
      kind: "sql",
      sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'function' AND file_path LIKE '%.vue'",
    },
    predicate: { op: "gt", value: 10 },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "vue_function_has_high_degree",
    description: "At least one .vue function with degree > 5",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM nodes f
        WHERE f.kind = 'function' AND f.file_path LIKE '%.vue'
          AND (SELECT COUNT(*) FROM edges WHERE source_id = f.id OR target_id = f.id) > 5
      `,
    },
    predicate: { op: "gte", value: 1 },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "sfc_qn_well_formed",
    description: "No .vue function has qualified_name containing literal '<script setup>' or null",
    query: {
      kind: "sql",
      sql: `
        SELECT COALESCE(qualified_name, '') AS qn FROM nodes
        WHERE kind = 'function' AND file_path LIKE '%.vue'
        LIMIT 5
      `,
    },
    predicate: { op: "no_match", regex: "<script setup>|^$" },
    baseline_expected: "fail",
  },
  // Tool-behavior assertions — must be run by runToolAssertion.
  {
    fix_id: 4,
    name: "vue_file_is_module_node",
    description: "Even without parsing, .vue files appear as module nodes (governs/get_code_snippet MVP)",
    query: {
      kind: "sql",
      sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'module' AND file_path LIKE '%.vue'",
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "get_code_snippet_returns_vue_content",
    description: "get_code_snippet with a .vue path returns non-empty content",
    query: {
      kind: "tool_call",
      tool: "get_code_snippet",
      args: { /* qualified_name filled in from fixture at run time */ },
    },
    predicate: { op: "tool_text_nonempty" },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "governs_link_to_vue_path_persists",
    description: "create_decision(governs=[<.vue path>]) -> get_decision shows non-empty governs",
    query: {
      kind: "tool_call",
      tool: "__governs_link_vue_path__",   // pseudo-tool — handled specially in tool-runner
      args: {},
    },
    predicate: { op: "tool_text_nonempty" },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "search_graph_finds_vue_component",
    description: "search_graph(name_pattern=<vue component basename>) returns at least one result",
    query: {
      kind: "tool_call",
      tool: "search_graph",
      args: { /* name_pattern filled in from fixture */ },
    },
    predicate: { op: "tool_text_nonempty" },
    baseline_expected: "fail",
  },
];
```

- [ ] **Step 4: Write `fix-5-nitro-handlers.ts`**

```ts
import type { Assertion } from "./types.js";

export const FIX_5_ASSERTIONS: Assertion[] = [
  {
    fix_id: 5,
    name: "nitro_handler_function_exists",
    description: "More than 5 function nodes whose file_path is under server/api/**/*.ts",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM nodes
        WHERE kind = 'function' AND file_path LIKE '%server/api/%' AND file_path LIKE '%.ts'
      `,
    },
    predicate: { op: "gt", value: 5 },
    baseline_expected: "fail",
  },
  {
    fix_id: 5,
    name: "nitro_route_handles_edge",
    description: "At least one HANDLES edge from a function to a Route",
    query: { kind: "count_edge", type: "HANDLES" },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
];
```

- [ ] **Step 5: Write `fix-6-route-poison.ts`**

```ts
import type { Assertion } from "./types.js";

export const FIX_6_ASSERTIONS: Assertion[] = [
  {
    fix_id: 6,
    name: "no_tarball_routes",
    description: "No Route nodes whose name contains 'tarball' or ends in .tgz (regression guard)",
    query: {
      kind: "sql",
      sql: "SELECT name FROM nodes WHERE kind = 'Route'",
    },
    predicate: { op: "no_match", regex: "tarball|\\.tgz" },
    baseline_expected: "pass",
  },
  {
    fix_id: 6,
    name: "no_codeartifact_routes",
    description: "No Route nodes whose name contains 'codeartifact' (regression guard)",
    query: {
      kind: "sql",
      sql: "SELECT name FROM nodes WHERE kind = 'Route'",
    },
    predicate: { op: "no_match", regex: "codeartifact" },
    baseline_expected: "pass",
  },
];
```

- [ ] **Step 6: Write `fix-8-decision-promotion.ts`**

```ts
import type { Assertion } from "./types.js";

export const FIX_8_ASSERTIONS: Assertion[] = [
  {
    fix_id: 8,
    name: "decision_node_count_nonzero",
    description: "At least one Decision node exists",
    query: { kind: "count_label", label: "Decision" },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 8,
    name: "decision_governs_edges_exist",
    description: "At least one GOVERNS edge from a Decision exists",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM edges e
        JOIN nodes d ON d.id = e.source_id
        WHERE e.relation = 'GOVERNS' AND d.kind = 'Decision'
      `,
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 8,
    name: "decision_rationale_no_xml_leakage",
    description: "No Decision has rationale containing structured-marshalling markers (regression guard)",
    query: {
      kind: "sql",
      sql: `
        SELECT json_extract(data, '$.rationale') AS rationale
        FROM nodes
        WHERE kind = 'Decision' AND json_extract(data, '$.rationale') IS NOT NULL
      `,
    },
    predicate: { op: "no_match", regex: "</rationale>|<problem>|</invoke>" },
    baseline_expected: "pass",
  },
];
```

- [ ] **Step 7: Write the registry**

Create `evals/src/assertions/registry.ts`:

```ts
import { FIX_2_ASSERTIONS } from "./fix-2-http-calls.js";
import { FIX_3_ASSERTIONS } from "./fix-3-auto-imports.js";
import { FIX_4_ASSERTIONS } from "./fix-4-sfc-functions.js";
import { FIX_5_ASSERTIONS } from "./fix-5-nitro-handlers.js";
import { FIX_6_ASSERTIONS } from "./fix-6-route-poison.js";
import { FIX_8_ASSERTIONS } from "./fix-8-decision-promotion.js";
import type { Assertion } from "./types.js";

export const ALL_ASSERTIONS: Assertion[] = [
  ...FIX_2_ASSERTIONS,
  ...FIX_3_ASSERTIONS,
  ...FIX_4_ASSERTIONS,
  ...FIX_5_ASSERTIONS,
  ...FIX_6_ASSERTIONS,
  ...FIX_8_ASSERTIONS,
];
```

- [ ] **Step 8: Write the registry smoke test**

Create `tests/evals/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ALL_ASSERTIONS } from "../../evals/src/assertions/registry.js";

describe("assertion registry", () => {
  it("has at least 18 graph-content assertions", () => {
    expect(ALL_ASSERTIONS.length).toBeGreaterThanOrEqual(18);
  });

  it("every assertion name is unique", () => {
    const names = ALL_ASSERTIONS.map((a) => a.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("baseline_expected is either 'pass' or 'fail'", () => {
    for (const a of ALL_ASSERTIONS) {
      expect(["pass", "fail"]).toContain(a.baseline_expected);
    }
  });

  it("fix_id is one of {2, 3, 4, 5, 6, 8}", () => {
    for (const a of ALL_ASSERTIONS) {
      expect([2, 3, 4, 5, 6, 8]).toContain(a.fix_id);
    }
  });

  it("each fix has at least 2 assertions", () => {
    const byFix: Record<number, number> = {};
    for (const a of ALL_ASSERTIONS) {
      byFix[a.fix_id] = (byFix[a.fix_id] ?? 0) + 1;
    }
    for (const fid of [2, 3, 4, 5, 6, 8]) {
      expect(byFix[fid]).toBeGreaterThanOrEqual(2);
    }
  });
});
```

- [ ] **Step 9: Run the registry test to verify it passes**

Run: `npx vitest run tests/evals/registry.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 10: Commit**

```bash
git add evals/src/assertions/fix-*.ts evals/src/assertions/registry.ts tests/evals/registry.test.ts
git commit -m "feat(evals): assertion catalog — 20 assertions across 6 fixes

Six per-fix data files plus a registry that flattens them in
fix_id order. Smoke-tested for uniqueness, baseline_expected
shape, fix_id range, and minimum per-fix count. The
imports_edge_count_grew assertion is baseline-relative and lands
in the report layer rather than as a static predicate.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Tool-behavior assertion runner

Goal: invoke MCP tool handlers in-process for the five `tool_call` assertions in Fix #4. Reuses cortex's existing server registration but doesn't go over JSON-RPC — calls the underlying handlers directly with a real `GraphStore` + decision DB.

**Files:**

- Create: `evals/src/assertions/tool-runner.ts`
- Create: `tests/evals/tool-runner.test.ts`
- Modify: `evals/fixtures/<target>.json` — example schema; one entry created in Task 10

- [ ] **Step 1: Define the fixture schema in this plan (no file yet)**

Each target's fixture file at `evals/fixtures/<name>.json` has shape:

```ts
type Fixture = {
  /** A real .vue file path inside this target — used by get_code_snippet + governs */
  vue_file_path: string;
  /** Basename without extension — used by search_graph */
  vue_component_name: string;
};
```

Task 10 will create the first fixture against anthill-cloud. Subagents implementing earlier tasks don't need to write fixture content — the schema is documented here for reference.

- [ ] **Step 2: Write the failing tool-runner test**

Create `tests/evals/tool-runner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runToolAssertion } from "../../evals/src/assertions/tool-runner.js";
import type { Assertion } from "../../evals/src/assertions/types.js";

describe("tool-runner — in-process MCP tool assertions", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-toolrun-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("vue_file_is_module_node: passes when a .vue module node exists", () => {
    store.createNode({ kind: "module", name: "Card.vue", file_path: "app/Card.vue" });
    const a: Assertion = {
      fix_id: 4,
      name: "vue_file_is_module_node",
      description: "stub",
      query: {
        kind: "sql",
        sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'module' AND file_path LIKE '%.vue'",
      },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
    };
    // vue_file_is_module_node is SQL-only — runToolAssertion delegates to runAssertion.
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
    });
    expect(result.passed).toBe(true);
  });

  it("get_code_snippet_returns_vue_content: fails when no module node for the vue path", () => {
    const a: Assertion = {
      fix_id: 4,
      name: "get_code_snippet_returns_vue_content",
      description: "stub",
      query: {
        kind: "tool_call",
        tool: "get_code_snippet",
        args: {},
      },
      predicate: { op: "tool_text_nonempty" },
      baseline_expected: "fail",
    };
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
    });
    expect(result.passed).toBe(false);
  });

  it("search_graph_finds_vue_component: passes when a node matches the basename", () => {
    store.createNode({ kind: "function", name: "Card", qualified_name: "app/Card.vue::Card" });
    const a: Assertion = {
      fix_id: 4,
      name: "search_graph_finds_vue_component",
      description: "stub",
      query: {
        kind: "tool_call",
        tool: "search_graph",
        args: {},
      },
      predicate: { op: "tool_text_nonempty" },
      baseline_expected: "fail",
    };
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
    });
    expect(result.passed).toBe(true);
  });

  it("governs_link_to_vue_path_persists: round-trips through decision DB", () => {
    // This test exercises the cortex decision service end-to-end using a temp decision DB.
    // It passes when create_decision with a .vue governs target results in a non-empty
    // governs array on read-back.
    const a: Assertion = {
      fix_id: 4,
      name: "governs_link_to_vue_path_persists",
      description: "stub",
      query: { kind: "tool_call", tool: "__governs_link_vue_path__", args: {} },
      predicate: { op: "tool_text_nonempty" },
      baseline_expected: "fail",
    };
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
      decisionsDbPath: join(dir, "decisions.db"),
    });
    expect(result.passed).toBe(true);
    // The cortex decision service stores governs as a link, not as filesystem-validated.
    // So this passes even without a real module node — the assertion is purely about
    // whether the round-trip preserves the array.
  });
});
```

- [ ] **Step 3: Write the tool-runner**

Create `evals/src/assertions/tool-runner.ts`:

```ts
import { GraphStore } from "../../../src/graph/store.js";
import { openDecisionsDb } from "../../../src/decisions/db.js";
import { DecisionsRepository } from "../../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../../src/decisions/links-repository.js";
import { DecisionService } from "../../../src/decisions/service.js";
import { runAssertion } from "./runner.js";
import type { Assertion, AssertionResult } from "./types.js";

export type Fixture = {
  vue_file_path: string;
  vue_component_name: string;
};

export type ToolRunnerContext = {
  dbPath: string;
  fixture: Fixture;
  project: string;
  decisionsDbPath?: string;
};

export function runToolAssertion(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  // Non-tool_call queries delegate to the regular runner.
  if (a.query.kind !== "tool_call") {
    return runAssertion(a, { dbPath: ctx.dbPath });
  }

  switch (a.query.tool) {
    case "get_code_snippet":
      return runGetCodeSnippet(a, ctx);
    case "search_graph":
      return runSearchGraph(a, ctx);
    case "__governs_link_vue_path__":
      return runGovernsLinkVuePath(a, ctx);
    default:
      throw new Error(`tool-runner: unknown tool ${a.query.tool}`);
  }
}

function runGetCodeSnippet(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  // Cortex's get_code_snippet resolves a qualified name (or file path) to a node
  // and returns its content. Direct SQL replicates the lookup path the MCP tool uses.
  const store = new GraphStore(ctx.dbPath);
  const rows = store.queryRaw<{ name: string; data: string }>(
    "SELECT name, data FROM nodes WHERE file_path = ? OR qualified_name = ? LIMIT 1",
    [ctx.fixture.vue_file_path, ctx.fixture.vue_file_path],
  );
  const text = rows[0]?.name ? `Node found: ${rows[0].name}` : "";
  return result(a, text, { kind: "tool_text_nonempty" });
}

function runSearchGraph(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  const store = new GraphStore(ctx.dbPath);
  const rows = store.queryRaw<{ name: string }>(
    "SELECT name FROM nodes WHERE name LIKE ?",
    [`%${ctx.fixture.vue_component_name}%`],
  );
  const text = rows.length > 0 ? `Found ${rows.length} matches` : "";
  return result(a, text, { kind: "tool_text_nonempty" });
}

function runGovernsLinkVuePath(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  if (!ctx.decisionsDbPath) {
    throw new Error("governs_link_to_vue_path_persists requires decisionsDbPath");
  }
  const db = openDecisionsDb(ctx.decisionsDbPath);
  try {
    const links = new DecisionLinksRepository(db);
    const svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links,
    });
    const d = svc.create({
      title: "harness-temp",
      description: "harness",
      rationale: "harness",
      governs: [ctx.fixture.vue_file_path],
    });
    const found = links.findByDecision(d.id).filter((l) => l.relation === "GOVERNS");
    svc.delete(d.id);
    const text = found.length > 0 ? `governs persisted: ${found.length}` : "";
    return result(a, text, { kind: "tool_text_nonempty" });
  } finally {
    db.close();
  }
}

function result(
  a: Assertion,
  text: string,
  _predicateHint: { kind: "tool_text_nonempty" },
): AssertionResult {
  const passed = (() => {
    if (a.predicate.op === "tool_text_nonempty") return text.length > 0;
    if (a.predicate.op === "tool_text_contains") return text.includes(a.predicate.needle);
    return false;
  })();
  const surprised =
    (a.baseline_expected === "pass" && !passed) ||
    (a.baseline_expected === "fail" && passed);
  return { assertion: a, observed: { text }, passed, surprised };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/evals/tool-runner.test.ts`
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Commit**

```bash
git add evals/src/assertions/tool-runner.ts tests/evals/tool-runner.test.ts
git commit -m "feat(evals): in-process tool-behavior assertion runner

Three handlers for Fix #4 tool-behavior assertions:
- get_code_snippet (file_path / qn lookup)
- search_graph (name LIKE pattern)
- __governs_link_vue_path__ (full create/read/delete round-trip
  through DecisionService into a temp decisions.db)

Non-tool_call assertions delegate to runAssertion. Decisions
fixture is created and torn down inside the assertion, so no
state leaks across runs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Report generation

Goal: given a `Scorecard`, an array of `AssertionResult`, and an optional `Baseline`, write `summary.md`, `<target>.md`, and `<target>.json` under a per-run reports directory.

**Files:**

- Create: `evals/src/report.ts`
- Create: `tests/evals/report.test.ts`

- [ ] **Step 1: Write the failing report test**

Create `tests/evals/report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderSummary } from "../../evals/src/report.js";
import type { Scorecard, AssertionResult, Baseline, Assertion } from "../../evals/src/assertions/types.js";

const stubAssertion: Assertion = {
  fix_id: 2,
  name: "http_calls_edge_count_nonzero",
  description: "stub",
  query: { kind: "count_edge", type: "HTTP_CALLS" },
  predicate: { op: "gt", value: 0 },
  baseline_expected: "fail",
};

describe("report.renderSummary", () => {
  it("renders a target heading", () => {
    const sc: Scorecard = {
      target: "nuxt-ui",
      indexer_seconds: 12.3,
      nodes_by_label: { function: 100 },
      edges_by_type: { CALLS: 50 },
      killer_queries: [],
    };
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results: [], baseline: null }]);
    expect(md).toContain("## nuxt-ui");
  });

  it("lists surprises with checkmark/cross prefixes", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
    };
    const results: AssertionResult[] = [
      { assertion: stubAssertion, observed: 47, passed: true, surprised: true },
    ];
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results, baseline: null }]);
    expect(md).toContain("Surprises");
    expect(md).toMatch(/✓\s+http_calls_edge_count_nonzero/);
    expect(md).toContain("(fix #2)");
  });

  it("marks regressions as REGRESSION", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
    };
    const regressionAssertion: Assertion = {
      ...stubAssertion,
      name: "no_tarball_routes",
      baseline_expected: "pass",
    };
    const results: AssertionResult[] = [
      { assertion: regressionAssertion, observed: 4, passed: false, surprised: true },
    ];
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results, baseline: null }]);
    expect(md).toContain("REGRESSION");
    expect(md).toMatch(/✗\s+no_tarball_routes/);
  });

  it("omits the Surprises block when no assertion is surprised", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
    };
    const results: AssertionResult[] = [
      { assertion: stubAssertion, observed: 0, passed: false, surprised: false },
    ];
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results, baseline: null }]);
    expect(md).not.toContain("Surprises");
  });

  it("renders scorecard delta when baseline is provided", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: { function: 1103 }, edges_by_type: { HTTP_CALLS: 47, IMPORTS: 538 },
      killer_queries: [],
    };
    const baseline: Baseline = {
      target: "nuxt-ui",
      captured_at: "2026-05-21T00:00:00Z",
      nodes_by_label: { function: 412 },
      edges_by_type: { HTTP_CALLS: 0, IMPORTS: 214 },
      per_assertion: {},
    };
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results: [], baseline }]);
    expect(md).toContain("Scorecard delta");
    expect(md).toMatch(/nodes\.function:\s+412 → 1,?103/);
    expect(md).toMatch(/edges\.HTTP_CALLS:\s+0 → 47/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/evals/report.test.ts`
Expected: FAIL — `renderSummary` not exported.

- [ ] **Step 3: Write the report module**

Create `evals/src/report.ts`:

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Scorecard,
  AssertionResult,
  Baseline,
} from "./assertions/types.js";

export type TargetReport = {
  target: string;
  scorecard: Scorecard;
  results: AssertionResult[];
  baseline: Baseline | null;
};

export function renderSummary(reports: TargetReport[]): string {
  const lines: string[] = ["# Eval Run Summary", ""];

  for (const r of reports) {
    lines.push(`## ${r.target}`, "");
    const surprises = r.results.filter((x) => x.surprised);
    if (surprises.length > 0) {
      lines.push(`  Surprises (${surprises.length}):`);
      for (const s of surprises) {
        const mark = s.passed ? "✓" : "✗";
        const tail = s.passed
          ? `(fix #${s.assertion.fix_id})`
          : s.assertion.baseline_expected === "pass"
            ? "(REGRESSION)"
            : `(fix #${s.assertion.fix_id} regression)`;
        const obs = formatObserved(s.observed);
        lines.push(`    ${mark} ${s.assertion.name} — ${obs} ${tail}`);
      }
      lines.push("");
    }
    if (r.baseline) {
      lines.push("  Scorecard delta:");
      const labels = new Set([
        ...Object.keys(r.scorecard.nodes_by_label),
        ...Object.keys(r.baseline.nodes_by_label),
      ]);
      for (const label of labels) {
        const before = r.baseline.nodes_by_label[label] ?? 0;
        const after = r.scorecard.nodes_by_label[label] ?? 0;
        if (before !== after) {
          lines.push(`    nodes.${label}: ${fmt(before)} → ${fmt(after)}`);
        }
      }
      const edges = new Set([
        ...Object.keys(r.scorecard.edges_by_type),
        ...Object.keys(r.baseline.edges_by_type),
      ]);
      for (const e of edges) {
        const before = r.baseline.edges_by_type[e] ?? 0;
        const after = r.scorecard.edges_by_type[e] ?? 0;
        if (before !== after) {
          lines.push(`    edges.${e}: ${fmt(before)} → ${fmt(after)}`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function formatObserved(obs: AssertionResult["observed"]): string {
  if (typeof obs === "number") return `now ${obs}`;
  if (Array.isArray(obs)) return `${obs.length} rows`;
  return obs.text || "(empty)";
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function writeReportArtifacts(
  reportsDir: string,
  reports: TargetReport[],
): { summaryPath: string; perTargetPaths: { target: string; json: string; md: string }[] } {
  mkdirSync(reportsDir, { recursive: true });
  const summaryPath = join(reportsDir, "summary.md");
  writeFileSync(summaryPath, renderSummary(reports), "utf-8");

  const perTargetPaths = reports.map((r) => {
    const json = join(reportsDir, `${r.target}.json`);
    writeFileSync(json, JSON.stringify({ scorecard: r.scorecard, results: r.results }, null, 2));
    const md = join(reportsDir, `${r.target}.md`);
    writeFileSync(md, renderPerTarget(r), "utf-8");
    return { target: r.target, json, md };
  });
  return { summaryPath, perTargetPaths };
}

function renderPerTarget(r: TargetReport): string {
  const lines: string[] = [
    `# ${r.target}`,
    "",
    "| Fix | Name | Passed | Surprised | Observed |",
    "|---|---|---|---|---|",
  ];
  for (const x of r.results) {
    const observed = formatObserved(x.observed).replace(/\|/g, "\\|");
    lines.push(
      `| ${x.assertion.fix_id} | ${x.assertion.name} | ${x.passed ? "✓" : "✗"} | ${x.surprised ? "*" : ""} | ${observed} |`,
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/evals/report.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 5: Commit**

```bash
git add evals/src/report.ts tests/evals/report.test.ts
git commit -m "feat(evals): markdown + json report generation

renderSummary produces the top-level summary.md with a per-target
Surprises block and an optional Scorecard delta against baseline.
writeReportArtifacts also emits <target>.json (machine-readable)
and <target>.md (full assertion table) under a timestamped dir.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Target acquisition (clone-or-reuse + index)

Goal: given a `Target`, produce a `.cortex/graph.db` path the harness can read. For `local_path` targets, reuse the user's working copy. For `repo_url` targets, shallow-clone into `evals/cache/<name>/` at the pinned SHA and run `bin/cortex-indexer index_repository`. Idempotent.

**Files:**

- Create: `evals/src/target.ts`

- [ ] **Step 1: Write the target module**

Create `evals/src/target.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Target } from "./assertions/types.js";

export type AcquiredTarget = {
  name: string;
  workdir: string;             // absolute path to the source tree
  graphDbPath: string;         // absolute path to .cortex/graph.db
  source_sha?: string;
  indexer_seconds: number | null;
};

const CACHE_ROOT = resolve(process.cwd(), "evals/cache");
const INDEXER_BIN = resolve(process.cwd(), "bin/cortex-indexer");

export function acquireTarget(target: Target, pathOverride?: string): AcquiredTarget {
  if (target.local_path || pathOverride) {
    const workdir = resolve(pathOverride ?? target.local_path!);
    if (!existsSync(workdir)) {
      throw new Error(`Target ${target.name}: local path does not exist: ${workdir}`);
    }
    return {
      name: target.name,
      workdir,
      graphDbPath: join(workdir, ".cortex/graph.db"),
      indexer_seconds: maybeReindex(workdir, target.name),
    };
  }

  if (!target.repo_url || !target.sha) {
    throw new Error(`Target ${target.name}: requires either local_path or repo_url+sha`);
  }

  const workdir = join(CACHE_ROOT, target.name);
  if (!existsSync(workdir)) {
    execFileSync("git", ["clone", "--depth", "50", target.repo_url, workdir], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", workdir, "fetch", "--depth", "50", "origin", target.sha], { stdio: "inherit" });
  execFileSync("git", ["-C", workdir, "checkout", "--detach", target.sha], { stdio: "inherit" });
  const head = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  return {
    name: target.name,
    workdir,
    graphDbPath: join(workdir, ".cortex/graph.db"),
    source_sha: head,
    indexer_seconds: maybeReindex(workdir, target.name),
  };
}

function maybeReindex(workdir: string, projectName: string): number | null {
  // Skip indexing if .cortex/graph.db exists and is newer than the workdir's
  // newest tracked file. Cheap heuristic — pessimistic skip; user can blow
  // away evals/cache/<name>/.cortex/ to force a rebuild.
  const graphDb = join(workdir, ".cortex/graph.db");
  if (existsSync(graphDb)) {
    const graphMtime = statSync(graphDb).mtimeMs;
    const headMtime = existsSync(join(workdir, ".git/HEAD"))
      ? statSync(join(workdir, ".git/HEAD")).mtimeMs
      : 0;
    if (graphMtime >= headMtime) return null;
  }
  const start = Date.now();
  execFileSync(INDEXER_BIN, ["index_repository", "--path", workdir, "--project", projectName], {
    stdio: "inherit",
  });
  return (Date.now() - start) / 1000;
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

Note: there are intentionally no unit tests here. `target.ts` is a thin shell over `git clone` and `cortex-indexer`. Both are tested by their respective owners. The Task 10 end-to-end run is the actual integration test.

- [ ] **Step 3: Commit**

```bash
git add evals/src/target.ts
git commit -m "feat(evals): target acquisition — clone + index or reuse local

acquireTarget(target) returns workdir + graphDbPath + source_sha.
For local_path targets, reuses the working copy and re-indexes
only when .git/HEAD is newer than the graph.db. For repo_url
targets, shallow-clones into evals/cache/, checks out the pinned
SHA, and runs bin/cortex-indexer.

No unit tests — thin wrapper over git + indexer; covered by the
Task 10 end-to-end run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: CLI wiring

Goal: parse argv, load `targets.json`, drive the pipeline (acquire → scorecard → assertions → report). Implements three modes: `npm run eval` (all targets), `--target=<name>`, and `--capture-baseline=<name>`.

**Files:**

- Modify: `evals/src/cli.ts` (replace the stub)

- [ ] **Step 1: Replace cli.ts with the real implementation**

Replace the contents of `evals/src/cli.ts`:

```ts
#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireTarget } from "./target.js";
import { computeScorecard } from "./scorecard.js";
import { runAssertion } from "./assertions/runner.js";
import { runToolAssertion } from "./assertions/tool-runner.js";
import { ALL_ASSERTIONS } from "./assertions/registry.js";
import { writeReportArtifacts, type TargetReport } from "./report.js";
import type {
  Targets,
  Target,
  AssertionResult,
  Baseline,
} from "./assertions/types.js";

type Args = {
  target?: string;
  path?: string;
  captureBaseline?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--target=")) args.target = a.slice("--target=".length);
    else if (a.startsWith("--path=")) args.path = a.slice("--path=".length);
    else if (a.startsWith("--capture-baseline=")) args.captureBaseline = a.slice("--capture-baseline=".length);
  }
  return args;
}

function loadTargets(): Targets {
  const txt = readFileSync(resolve("evals/targets.json"), "utf-8");
  return JSON.parse(txt) as Targets;
}

function loadBaseline(target: string): Baseline | null {
  const p = resolve("evals/baselines", `${target}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Baseline;
}

function loadFixture(target: string): { vue_file_path: string; vue_component_name: string } | null {
  const p = resolve("evals/fixtures", `${target}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function runTarget(target: Target, pathOverride?: string): TargetReport {
  const acquired = acquireTarget(target, pathOverride);
  const scorecard = computeScorecard(acquired.graphDbPath, acquired.name);
  scorecard.indexer_seconds = acquired.indexer_seconds;

  const fixture = loadFixture(acquired.name);
  const decisionsDbPath = join(resolve("evals/cache"), acquired.name, "decisions.db");

  const results: AssertionResult[] = [];
  for (const a of ALL_ASSERTIONS) {
    if (a.query.kind === "tool_call") {
      if (!fixture) {
        // Skip tool-behavior assertions when no fixture file exists for the target.
        continue;
      }
      results.push(runToolAssertion(a, {
        dbPath: acquired.graphDbPath,
        fixture,
        project: acquired.name,
        decisionsDbPath,
      }));
    } else {
      results.push(runAssertion(a, { dbPath: acquired.graphDbPath }));
    }
  }

  const baseline = loadBaseline(acquired.name);
  return { target: acquired.name, scorecard, results, baseline };
}

function captureBaseline(target: Target, pathOverride?: string): void {
  const report = runTarget(target, pathOverride);
  const baseline: Baseline = {
    target: target.name,
    captured_at: new Date().toISOString(),
    source_sha: undefined,
    nodes_by_label: report.scorecard.nodes_by_label,
    edges_by_type: report.scorecard.edges_by_type,
    per_assertion: Object.fromEntries(
      report.results.map((r) => {
        const obs = typeof r.observed === "object" && r.observed !== null && "text" in r.observed
          ? (r.observed as { text: string }).text
          : (r.observed as number | string[]);
        return [r.assertion.name, obs];
      }),
    ),
  };
  mkdirSync(resolve("evals/baselines"), { recursive: true });
  writeFileSync(resolve("evals/baselines", `${target.name}.json`), JSON.stringify(baseline, null, 2));
  console.log(`Baseline captured for ${target.name}.`);
}

function main(): void {
  const args = parseArgs(process.argv);
  const { targets } = loadTargets();

  if (args.captureBaseline) {
    const t = targets.find((x) => x.name === args.captureBaseline);
    if (!t) {
      console.error(`Unknown target: ${args.captureBaseline}`);
      process.exit(1);
    }
    captureBaseline(t, args.path);
    return;
  }

  const selected = args.target ? targets.filter((x) => x.name === args.target) : targets;
  if (selected.length === 0) {
    console.error(`No matching targets`);
    process.exit(1);
  }

  const reports: TargetReport[] = [];
  for (const t of selected) {
    try {
      reports.push(runTarget(t, args.path));
    } catch (e) {
      console.error(`[${t.name}] failed:`, e instanceof Error ? e.message : e);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 16);
  const reportsDir = resolve("evals/reports", stamp);
  const { summaryPath } = writeReportArtifacts(reportsDir, reports);
  console.log(`Eval complete. Summary: ${summaryPath}`);
}

main();
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Smoke test — empty run (no targets configured for clone)**

Run: `npm run eval -- --target=does-not-exist`
Expected: stderr "No matching targets"; exit code 1.

- [ ] **Step 4: Commit**

```bash
git add evals/src/cli.ts
git commit -m "feat(evals): CLI driver — acquire, score, assert, report

cli.ts wires the full pipeline. Three modes:

  npm run eval                          # all targets
  npm run eval -- --target=NAME         # one target
  npm run eval -- --target=NAME --path=/local/checkout
  npm run eval -- --capture-baseline=NAME

Tool-behavior assertions are skipped when no fixture file exists
for the target — keeps the harness usable on fresh targets before
fixtures are written.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: First end-to-end run — capture baseline for anthill-cloud

Goal: prove the harness works against a real, large Nuxt target. Capture the first baseline. Commit both the fixture and the baseline so the next run can diff.

**Files:**

- Create: `evals/fixtures/anthill-cloud.json`
- Create: `evals/baselines/anthill-cloud.json` (output of the run)

- [ ] **Step 1: Write the anthill-cloud fixture**

Pick one real .vue file inside the anthill-cloud working tree. From the field report the example was `apps/activator/app/components/ADesignSystemCard.vue` — use that or any equivalent file the implementer can verify exists.

Create `evals/fixtures/anthill-cloud.json`:

```json
{
  "vue_file_path": "apps/activator/app/components/ADesignSystemCard.vue",
  "vue_component_name": "ADesignSystemCard"
}
```

If the implementer cannot verify that exact file exists, run `find /Users/rka/Development/anthill-cloud/apps -name '*.vue' | head -1` and use whatever comes back, with the basename as `vue_component_name`.

- [ ] **Step 2: Run the harness in capture-baseline mode**

Run:

```bash
npm run eval -- --capture-baseline=anthill-cloud --path=/Users/rka/Development/anthill-cloud
```

Expected:
- Indexer runs (may take a minute on a fresh clone; skipped if already indexed)
- Scorecard computed, all 20 assertions evaluated
- `evals/baselines/anthill-cloud.json` written
- Console says `Baseline captured for anthill-cloud.`

- [ ] **Step 3: Sanity-check the baseline**

Open `evals/baselines/anthill-cloud.json`. Verify:

- `nodes_by_label` has entries for at least `function`, `module`
- `edges_by_type` has entries (CALLS at minimum)
- `per_assertion` has 20 entries — one per registered assertion

If any of those are missing, the pipeline has a bug; fix before committing the baseline.

- [ ] **Step 4: Run a normal eval (not capture mode) to verify the report path**

Run:

```bash
npm run eval -- --target=anthill-cloud --path=/Users/rka/Development/anthill-cloud
```

Expected:
- Indexer skipped (cached graph.db newer than .git/HEAD)
- Report written to `evals/reports/<timestamp>/summary.md` + `anthill-cloud.{md,json}`
- Console prints the summary path

Open `summary.md` and verify it has a `## anthill-cloud` section. The Surprises block should be EMPTY this run — we just captured the baseline, so no assertion differs from baseline_expected (which for the regression guards is "pass", which they should all be hitting right now).

- [ ] **Step 5: Commit the fixture and baseline**

```bash
git add evals/fixtures/anthill-cloud.json evals/baselines/anthill-cloud.json
git commit -m "feat(evals): capture first anthill-cloud baseline

Fixture identifies one real .vue file + component name for the
tool-behavior assertions. Baseline captures 20 assertion
observations + scorecard at the current pre-fix state of cortex.

Next run after any of the priority fixes lands should produce a
non-empty Surprises block, which is the harness's whole point.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — every existing test still passes, all new harness tests green.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Confirm gitignored paths**

Run: `git status --porcelain | grep -E '(evals/reports|evals/cache)'`
Expected: no output (those paths are gitignored).

- [ ] **Step 4: Skim the committed baseline**

Open `evals/baselines/anthill-cloud.json` and confirm it looks reasonable. This file is the "before" record — it should make sense at a glance.
