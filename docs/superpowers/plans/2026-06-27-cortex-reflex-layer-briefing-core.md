# Cortex Reflex Layer — Plan 1: Briefing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the study-time pre-edit briefing — a shared `composeBriefing` function surfaced via a new `cortex brief` CLI command and, primarily, as an automatic enrichment on `get_code_snippet` / `trace_path` MCP results, so the agent is briefed on a gated symbol *while forming its plan*.

**Architecture:** One keystone TS function `composeBriefing(deps, target)` reads the governing decision + reconciliation verdict (decisions sidecar DB) and the blast-radius caller count (graph DB), and formats a bounded ≤5-line headline plus a gate/escalate signal. Two thin callers: a `cortex brief <target>` CLI command, and an `attachBriefing` MCP enricher wired into the existing `registerTool` wrapper via a new `briefAware` flag — mirroring how `attachFreshness` already works.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, vitest, the existing `GraphStore` / `DecisionSearch` / `DecisionsRepository` stack.

## Global Constraints

- ESM only — every relative import ends in `.js` (e.g. `import { x } from "./compose.js"`).
- Decisions store opened via `openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root))`; graph read DB via `resolveGraphDbForRead(root)`; always `db.close()` in a `finally`.
- The MCP tool result shape is `{ content: Array<{ type: "text"; text: string }>; isError?: true; [k: string]: unknown }` (see `src/mcp-server/response.ts`).
- Reconciliation verdict lives on the **raw** `DecisionRecord.reconciliation_verdict` (`"match" | "partial" | "drift" | null`); `DecisionSearch.findGoverning` returns the lighter `Decision[]` which **strips** it, so the verdict must be re-read via `DecisionsRepository.get(id)`.
- Display string is derived by `displayState(status, verdict)` in `src/decisions/reconciliation.ts`.
- New behavior is gated by env `CORTEX_BRIEF` (default on; `=0` disables) and `CORTEX_BRIEF_FANOUT` (blast-radius threshold N, default 12).
- Headline is at most 5 lines. Silence (empty headline, `gated:false`) is the default when nothing trips the gate.
- This plan is part of the design at `docs/superpowers/specs/2026-06-27-cortex-reflex-layer-design.md`. It implements §4.1 (study-time enrichment) and the §5 `composeBriefing` + `cortex brief` units only. The edit-time backstop (§4.2–4.4) and onboarding headline (§6) are Plans 2 and 3.

---

## File Structure

- `src/briefing/types.ts` (create) — the `Briefing` result type + `BriefingDeps` interface.
- `src/briefing/format.ts` (create) — `formatHeadline(facts)`, pure string builder (≤5 lines).
- `src/briefing/blast-radius.ts` (create) — `blastRadius(store, project, target)`, the caller-count graph query.
- `src/briefing/compose.ts` (create) — `composeBriefing(deps, target, opts)`, the keystone.
- `src/cli/commands/brief.ts` (create) — `runBriefCommand(ctx, target)`.
- `src/cli/main.ts` (modify) — register the `brief` meta-command.
- `src/mcp-server/briefing-attach.ts` (create) — `attachBriefing(result, ctx, target)`, mirrors `attachFreshness`.
- `src/mcp-server/repo-context.ts` (modify) — honor a new `briefAware` registration flag in the wrapper.
- `src/mcp-server/tools/code-tools.ts` (modify) — set `briefAware: true` on `get_code_snippet` + `trace_path`.
- Tests under `tests/briefing/` and `tests/mcp-server/`.

---

### Task 1: Briefing types + headline formatter

**Files:**
- Create: `src/briefing/types.ts`
- Create: `src/briefing/format.ts`
- Test: `tests/briefing/format.test.ts`

**Interfaces:**
- Produces: `type Verdict = "match" | "partial" | "drift" | "unreconciled";`
- Produces: `interface BriefingFacts { target: string; decision?: { id: string; title: string; displayState: string; verdict: Verdict }; callerCount: number; fanoutThreshold: number; pr?: number; }`
- Produces: `interface Briefing { gated: boolean; escalate: boolean; headline: string; }`
- Produces: `function formatHeadline(facts: BriefingFacts): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/briefing/format.test.ts
import { describe, it, expect } from "vitest";
import { formatHeadline } from "../../src/briefing/format.js";

describe("formatHeadline", () => {
  it("renders a governed + drifting headline with the decision and verdict", () => {
    const out = formatHeadline({
      target: "src/foo.ts::bar",
      decision: { id: "D-xyz", title: "Do it this way", displayState: "active · drifting", verdict: "partial" },
      callerCount: 4,
      fanoutThreshold: 12,
      pr: 39,
    });
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(out).toContain("D-xyz");
    expect(out).toContain("Do it this way");
    expect(out).toContain("active · drifting");
    expect(out).toContain("4 callers");
    expect(out).toContain("PR #39");
    expect(out).toContain("context_pack");
  });

  it("renders a blast-radius-only headline (no decision, no PR)", () => {
    const out = formatHeadline({
      target: "src/util.ts::helper",
      callerCount: 30,
      fanoutThreshold: 12,
    });
    expect(out).toContain("30 callers");
    expect(out).not.toContain("PR #");
    expect(out).not.toMatch(/D-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/briefing/format.test.ts`
Expected: FAIL — `Cannot find module '../../src/briefing/format.js'`.

- [ ] **Step 3: Write the types**

```ts
// src/briefing/types.ts
import type { DecisionSearch } from "../decisions/search.js";
import type { DecisionsRepository } from "../decisions/repository.js";
import type { GraphStore } from "../graph/store.js";

export type Verdict = "match" | "partial" | "drift" | "unreconciled";

export interface BriefingFacts {
  target: string;
  decision?: { id: string; title: string; displayState: string; verdict: Verdict };
  callerCount: number;
  fanoutThreshold: number;
  pr?: number;
}

export interface Briefing {
  gated: boolean;
  escalate: boolean;
  headline: string;
}

/** Everything composeBriefing needs, satisfied by both the CLI and the MCP RepoContext. */
export interface BriefingDeps {
  search: DecisionSearch;
  decisions: DecisionsRepository;
  store: GraphStore;
  project: string;
}
```

- [ ] **Step 4: Write the formatter**

```ts
// src/briefing/format.ts
import type { BriefingFacts } from "./types.js";

/** Build the bounded (≤5-line) briefing headline. Pure. */
export function formatHeadline(f: BriefingFacts): string {
  const lines: string[] = [];
  if (f.decision) {
    const tag = f.decision.verdict === "match" ? "governs" : "⚠ governs";
    lines.push(`${tag} ${f.decision.id} "${f.decision.title}" (${f.decision.displayState})`);
  }
  if (f.callerCount >= f.fanoutThreshold) {
    lines.push(`blast radius: ${f.callerCount} callers — trace_path(mode="callers") to see them`);
  } else if (f.decision) {
    lines.push(`${f.callerCount} callers`);
  }
  if (f.pr) lines.push(`linked PR #${f.pr}`);
  lines.push(`full context: context_pack("${f.target}")`);
  return lines.join("\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/briefing/format.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/briefing/types.ts src/briefing/format.ts tests/briefing/format.test.ts
git commit -m "feat(briefing): Briefing types + bounded headline formatter"
```

---

### Task 2: Blast-radius caller count

**Files:**
- Create: `src/briefing/blast-radius.ts`
- Test: `tests/briefing/blast-radius.test.ts`

**Interfaces:**
- Consumes: `GraphStore.queryRaw<T>(sql, params): T[]` (from `src/graph/store.ts`).
- Produces: `function blastRadius(store: GraphStore, project: string, target: string): number` — distinct external inbound `CALLS`/`IMPORTS` edge sources for the target (a `file::member` qn or a bare file path).

- [ ] **Step 1: Write the failing test**

```ts
// tests/briefing/blast-radius.test.ts
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { blastRadius } from "../../src/briefing/blast-radius.js";

function makeStore(): { store: GraphStore; path: string } {
  const path = `/tmp/cortex-brief-${process.pid}-${Math.floor(performance.now())}.db`;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT, project TEXT, name TEXT, qualified_name TEXT, file_path TEXT, kind TEXT);
    CREATE TABLE edges (project TEXT, source_id TEXT, target_id TEXT, relation TEXT);
    INSERT INTO nodes VALUES ('t','p','bar','src/foo.ts::bar','src/foo.ts','function');
    INSERT INTO nodes VALUES ('self','p','helper','src/foo.ts::helper','src/foo.ts','function');
    INSERT INTO nodes VALUES ('c1','p','a','src/a.ts::a','src/a.ts','function');
    INSERT INTO nodes VALUES ('c2','p','b','src/b.ts::b','src/b.ts','function');
    INSERT INTO edges VALUES ('p','c1','t','CALLS');
    INSERT INTO edges VALUES ('p','c2','t','IMPORTS');
    INSERT INTO edges VALUES ('p','self','t','CALLS');   -- internal, excluded for file target
  `);
  db.close();
  return { store: new GraphStore(path, { readonly: true }), path };
}

let made: { store: GraphStore; path: string } | null = null;
afterEach(() => { made?.store.close?.(); made = null; });

describe("blastRadius", () => {
  it("counts distinct external callers of a qn", () => {
    made = makeStore();
    expect(blastRadius(made.store, "p", "src/foo.ts::bar")).toBe(3);
  });
  it("excludes same-file callers for a file-path target", () => {
    made = makeStore();
    // file target counts callers into any node of src/foo.ts, minus internal (self)
    expect(blastRadius(made.store, "p", "src/foo.ts")).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/briefing/blast-radius.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/briefing/blast-radius.ts
import type { GraphStore } from "../graph/store.js";

const CALL_RELS = "('CALLS','IMPORTS')";

/**
 * Direct inbound fan-in for `target`, deduped by source node.
 * - `file::member` qn → callers of that one node (excluding itself).
 * - bare file path     → callers into any node of the file, excluding same-file sources.
 */
export function blastRadius(store: GraphStore, project: string, target: string): number {
  if (target.includes("::")) {
    const rows = store.queryRaw<{ n: number }>(
      `SELECT COUNT(DISTINCT e.source_id) AS n
         FROM edges e
         JOIN nodes tn ON tn.id = e.target_id AND tn.project = e.project
        WHERE e.project = ? AND tn.qualified_name = ?
          AND e.relation IN ${CALL_RELS} AND e.source_id != e.target_id`,
      [project, target],
    );
    return rows[0]?.n ?? 0;
  }
  const rows = store.queryRaw<{ n: number }>(
    `WITH file_nodes AS (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
     SELECT COUNT(DISTINCT e.source_id) AS n
       FROM edges e
      WHERE e.project = ?
        AND e.target_id IN (SELECT id FROM file_nodes)
        AND e.source_id NOT IN (SELECT id FROM file_nodes)
        AND e.relation IN ${CALL_RELS}`,
    [project, target, project],
  );
  return rows[0]?.n ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/briefing/blast-radius.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/briefing/blast-radius.ts tests/briefing/blast-radius.test.ts
git commit -m "feat(briefing): blast-radius caller count over the graph"
```

---

### Task 3: composeBriefing (keystone)

**Files:**
- Create: `src/briefing/compose.ts`
- Test: `tests/briefing/compose.test.ts`

**Interfaces:**
- Consumes: `BriefingDeps`, `formatHeadline`, `blastRadius`, `DecisionSearch.findGoverning(target): Decision[]`, `DecisionsRepository.get(id): DecisionRecord | null`, `displayState(status, verdict)` from `src/decisions/reconciliation.ts`.
- Produces: `function composeBriefing(deps: BriefingDeps, target: string, opts?: { fanoutThreshold?: number }): Briefing`
- Gate: `gated = (decision present) || (callerCount >= threshold)`. `escalate = decision.verdict ∈ {partial, drift, unreconciled}`. Ungated → `{ gated:false, escalate:false, headline:"" }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/briefing/compose.test.ts
import { describe, it, expect } from "vitest";
import { composeBriefing } from "../../src/briefing/compose.js";
import type { BriefingDeps } from "../../src/briefing/types.js";

function deps(over: Partial<{ governing: any[]; record: any; callers: number }>): BriefingDeps {
  const governing = over.governing ?? [];
  return {
    search: { findGoverning: () => governing } as any,
    decisions: { get: () => over.record ?? null } as any,
    store: {} as any, // blastRadius is monkeypatched below via project trick; see note
    project: "p",
  };
}

describe("composeBriefing", () => {
  it("returns ungated/silent when nothing trips the gate", () => {
    const b = composeBriefing(deps({ callers: 0 }), "src/x.ts::y", { fanoutThreshold: 12, _callerCount: 0 } as any);
    expect(b.gated).toBe(false);
    expect(b.headline).toBe("");
  });

  it("gates + escalates on a partial-verdict governing decision", () => {
    const b = composeBriefing(
      deps({
        governing: [{ id: "D-xyz", title: "Do it this way", status: "active" }],
        record: { reconciliation_verdict: "partial" },
      }),
      "src/foo.ts::bar",
      { fanoutThreshold: 12, _callerCount: 3 } as any,
    );
    expect(b.gated).toBe(true);
    expect(b.escalate).toBe(true);
    expect(b.headline).toContain("D-xyz");
    expect(b.headline).toContain("drifting");
  });

  it("gates without escalating on high blast radius alone", () => {
    const b = composeBriefing(deps({ callers: 30 }), "src/util.ts::helper", { fanoutThreshold: 12, _callerCount: 30 } as any);
    expect(b.gated).toBe(true);
    expect(b.escalate).toBe(false);
    expect(b.headline).toContain("30 callers");
  });
});
```

> Note: `composeBriefing` accepts an optional injected `_callerCount` (test seam) so the keystone's decision/gate logic is unit-tested without a graph fixture; when absent it calls `blastRadius`. Task 2 already covers the SQL.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/briefing/compose.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/briefing/compose.ts
import type { Briefing, BriefingDeps, Verdict } from "./types.js";
import { formatHeadline } from "./format.js";
import { blastRadius } from "./blast-radius.js";
import { displayState } from "../decisions/reconciliation.js";

const DEFAULT_FANOUT = 12;

function normalizeVerdict(v: string | null | undefined): Verdict {
  return v === "match" || v === "partial" || v === "drift" ? v : "unreconciled";
}

export function composeBriefing(
  deps: BriefingDeps,
  target: string,
  opts?: { fanoutThreshold?: number; _callerCount?: number },
): Briefing {
  const threshold = opts?.fanoutThreshold ?? DEFAULT_FANOUT;

  const governing = deps.search.findGoverning(target);
  const top = governing[0];
  let decision: { id: string; title: string; displayState: string; verdict: Verdict } | undefined;
  if (top) {
    const rec = deps.decisions.get(top.id);
    const verdict = normalizeVerdict(rec?.reconciliation_verdict);
    decision = {
      id: top.id,
      title: top.title,
      verdict,
      displayState: displayState(top.status, rec?.reconciliation_verdict ?? null),
    };
  }

  const callerCount = opts?._callerCount ?? blastRadius(deps.store, deps.project, target);
  const gated = Boolean(decision) || callerCount >= threshold;
  if (!gated) return { gated: false, escalate: false, headline: "" };

  const escalate = Boolean(decision) && decision!.verdict !== "match";
  const headline = formatHeadline({ target, decision, callerCount, fanoutThreshold: threshold });
  return { gated, escalate, headline };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/briefing/compose.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/briefing/compose.ts tests/briefing/compose.test.ts
git commit -m "feat(briefing): composeBriefing keystone (gate + verdict + headline)"
```

---

### Task 4: `cortex brief` CLI command

**Files:**
- Create: `src/cli/commands/brief.ts`
- Modify: `src/cli/main.ts:22-23` (registries), `:19` area (import), `:63-67` area (dispatch)
- Test: `tests/cli/brief.test.ts`

**Interfaces:**
- Consumes: `composeBriefing`, `ProjectContext` (`src/cli/context.ts`), `openDecisionsDb` / `resolveDecisionsDbPath` / `legacyDecisionsDbPath` (`src/db/resolve-path.js`, `src/decisions/db.js`), `resolveGraphDbForRead`, `GraphStore`, `DecisionsRepository`, `DecisionLinksRepository`, `DecisionSearch`.
- Produces: `function runBriefCommand(ctx: ProjectContext, target: string | null): void` — prints the headline to stdout (empty output when ungated), exit code `2` when `escalate`, else `0`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/brief.test.ts
import { describe, it, expect } from "vitest";
import { briefForTarget } from "../../src/cli/commands/brief.js";

describe("briefForTarget (pure core of runBriefCommand)", () => {
  it("returns empty headline + exit 0 when ungated", () => {
    const r = briefForTarget(
      { search: { findGoverning: () => [] }, decisions: { get: () => null }, store: {}, project: "p" } as any,
      "src/x.ts::y",
      { fanoutThreshold: 12, _callerCount: 0 } as any,
    );
    expect(r.headline).toBe("");
    expect(r.exitCode).toBe(0);
  });
  it("returns exit 2 when escalated", () => {
    const r = briefForTarget(
      {
        search: { findGoverning: () => [{ id: "D-x", title: "t", status: "active" }] },
        decisions: { get: () => ({ reconciliation_verdict: "drift" }) },
        store: {}, project: "p",
      } as any,
      "src/foo.ts::bar",
      { fanoutThreshold: 12, _callerCount: 1 } as any,
    );
    expect(r.exitCode).toBe(2);
    expect(r.headline).toContain("D-x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/brief.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the command (pure core + IO wrapper)**

```ts
// src/cli/commands/brief.ts
import type { ProjectContext } from "../context.js";
import type { BriefingDeps } from "../../briefing/types.js";
import { composeBriefing } from "../../briefing/compose.js";
import { resolveGraphDbForRead, resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { DecisionSearch } from "../../decisions/search.js";
import { GraphStore } from "../../graph/store.js";

/** Pure-ish core: compose + map to {headline, exitCode}. Unit-tested. */
export function briefForTarget(
  deps: BriefingDeps,
  target: string,
  opts?: { fanoutThreshold?: number; _callerCount?: number },
): { headline: string; exitCode: number } {
  const b = composeBriefing(deps, target, opts);
  return { headline: b.headline, exitCode: b.escalate ? 2 : 0 };
}

export function runBriefCommand(ctx: ProjectContext, target: string | null): void {
  if (process.env.CORTEX_BRIEF === "0" || !target) return;
  const root = ctx.gitRoot ?? ctx.cwd;
  const graphPath = ctx.graphDbPath ?? resolveGraphDbForRead(root);
  if (!graphPath || !ctx.projectName) return; // unindexed → silent
  const ddb = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  try {
    const decisions = new DecisionsRepository(ddb);
    const links = new DecisionLinksRepository(ddb);
    const search = new DecisionSearch(decisions, links);
    const store = new GraphStore(graphPath, { readonly: true });
    try {
      const threshold = Number(process.env.CORTEX_BRIEF_FANOUT ?? 12) || 12;
      const { headline, exitCode } = briefForTarget(
        { search, decisions, store, project: ctx.projectName },
        target,
        { fanoutThreshold: threshold },
      );
      if (headline) process.stdout.write(headline + "\n");
      process.exitCode = exitCode;
    } finally {
      store.close?.();
    }
  } finally {
    ddb.close();
  }
}
```

- [ ] **Step 4: Wire it into the dispatcher**

In `src/cli/main.ts`, add the import next to line 19:

```ts
import { runBriefCommand } from "./commands/brief.js";
```

Add `"brief"` to `META_COMMANDS` (line 23):

```ts
const META_COMMANDS = ["tour", "help", "install", "setup", "freshness", "reconcile", "brief"];
```

Add the dispatch block next to the `freshness` block (lines 63-67):

```ts
  if (argv.namespace === "brief") {
    const ctx = loadContext(process.cwd());
    runBriefCommand(ctx, argv.command ?? argv.positionals[0] ?? null);
    return;
  }
```

(`cortex brief src/foo.ts::bar` parses to `namespace="brief"`, `command="src/foo.ts::bar"`.)

- [ ] **Step 5: Run test + a manual smoke**

Run: `npx vitest run tests/cli/brief.test.ts`
Expected: PASS.
Run: `npm run build && ./bin/cortex brief src/cli/main.ts ; echo "exit=$?"`
Expected: either empty output `exit=0` (ungated) or a headline; never an error/stack trace.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/brief.ts src/cli/main.ts tests/cli/brief.test.ts
git commit -m "feat(cli): cortex brief <target> command"
```

---

### Task 5: `attachBriefing` MCP enricher

**Files:**
- Create: `src/mcp-server/briefing-attach.ts`
- Test: `tests/mcp-server/attach-briefing.test.ts`

**Interfaces:**
- Consumes: `composeBriefing`, a `RepoContext` exposing `{ repoPath, projectName/project, store, decisionsRepo, decisionLinksRepo }` (see `governedRefs` usage in `src/mcp-server/reconciliation-attach.ts:7-11` for the ctx field names), and the `TextResult` shape.
- Produces: `function attachBriefing<T extends { content: Array<{ type: string; text: string }>; [k: string]: unknown }>(result: T, ctx: RepoContext, target: string | undefined): T` — appends the headline to the first text block when gated; returns the result unchanged when ungated, when `CORTEX_BRIEF=0`, or when `target` is undefined. Never throws.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/attach-briefing.test.ts
import { describe, it, expect } from "vitest";
import { attachBriefing } from "../../src/mcp-server/briefing-attach.js";

function fakeCtx(governing: any[], record: any) {
  return {
    repoPath: "/repo",
    project: "p",
    store: {} as any,
    decisionsRepo: { get: () => record },
    decisionLinksRepo: {} as any,
    // search is built inside attachBriefing from decisionsRepo + decisionLinksRepo;
    // for the test we stub via the module seam (see impl: _composeOverride).
    _composeOverride: () => ({ gated: governing.length > 0, escalate: false, headline: governing.length ? "BRIEF" : "" }),
  } as any;
}

describe("attachBriefing", () => {
  it("appends the headline to the first text block when gated", () => {
    const r = { content: [{ type: "text", text: "snippet" }] };
    const out = attachBriefing(r, fakeCtx([{ id: "D" }], {}), "src/foo.ts::bar");
    expect(out.content[0].text).toContain("snippet");
    expect(out.content[0].text).toContain("BRIEF");
  });
  it("returns unchanged when ungated", () => {
    const r = { content: [{ type: "text", text: "snippet" }] };
    const out = attachBriefing(r, fakeCtx([], null), "src/foo.ts::bar");
    expect(out.content[0].text).toBe("snippet");
  });
  it("returns unchanged when CORTEX_BRIEF=0", () => {
    const prev = process.env.CORTEX_BRIEF;
    process.env.CORTEX_BRIEF = "0";
    const r = { content: [{ type: "text", text: "snippet" }] };
    const out = attachBriefing(r, fakeCtx([{ id: "D" }], {}), "src/foo.ts::bar");
    expect(out.content[0].text).toBe("snippet");
    process.env.CORTEX_BRIEF = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/attach-briefing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the enricher**

```ts
// src/mcp-server/briefing-attach.ts
import type { RepoContext } from "./repo-context.js";
import { composeBriefing } from "../briefing/compose.js";
import { DecisionSearch } from "../decisions/search.js";

type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

/** Study-time briefing enrichment. Mirrors attachFreshness: append a note to the
 *  first text block when the target is gated; otherwise return unchanged. Never throws. */
export function attachBriefing<T extends TextResult>(result: T, ctx: RepoContext, target: string | undefined): T {
  if (process.env.CORTEX_BRIEF === "0" || !target) return result;
  try {
    const compose = (ctx as { _composeOverride?: (t: string) => { gated: boolean; escalate: boolean; headline: string } })._composeOverride;
    const b = compose
      ? compose(target)
      : composeBriefing(
          {
            search: new DecisionSearch(ctx.decisionsRepo, ctx.decisionLinksRepo),
            decisions: ctx.decisionsRepo,
            store: ctx.store,
            project: ctx.project,
          },
          target,
          { fanoutThreshold: Number(process.env.CORTEX_BRIEF_FANOUT ?? 12) || 12 },
        );
    if (!b.gated || !b.headline) return result;
    const first = result.content?.find((c) => c.type === "text");
    if (first) first.text += `\n\n${b.headline}`;
    (result as TextResult).briefing = { gated: b.gated, escalate: b.escalate };
    return result;
  } catch {
    return result; // degrade-safe — never break a tool response
  }
}
```

> Implementation note for the engineer: confirm the exact `RepoContext` field names for the graph store and project (`ctx.store` / `ctx.project`) against `src/mcp-server/repo-context.ts` and `reconciliation-attach.ts` (which reads `ctx.decisionLinksRepo`). If the project field is `ctx.projectName`, use that. Adjust the four `ctx.*` references to match; the `_composeOverride` seam keeps the unit test independent of those names.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/attach-briefing.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/briefing-attach.ts tests/mcp-server/attach-briefing.test.ts
git commit -m "feat(mcp): attachBriefing study-time enricher (degrade-safe)"
```

---

### Task 6: Wire `briefAware` into the registerTool wrapper + opt in code tools

**Files:**
- Modify: `src/mcp-server/repo-context.ts:411,429` (options type) and `:453-459` (wrapper block)
- Modify: `src/mcp-server/tools/code-tools.ts:705` (`get_code_snippet` opts) and `:656` (`trace_path` opts)
- Test: `tests/mcp-server/brief-aware-wiring.test.ts`

**Interfaces:**
- Consumes: `attachBriefing`, the existing `registerTool` options object `{ resolver, freshnessAware?, briefAware? }`.
- The wrapper extracts the briefing target from `args`: `args.qualified_name` (get_code_snippet) ?? `args.function_name` (trace_path).

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/brief-aware-wiring.test.ts
import { describe, it, expect } from "vitest";
import { briefTargetFromArgs } from "../../src/mcp-server/repo-context.js";

describe("briefTargetFromArgs", () => {
  it("prefers qualified_name, falls back to function_name", () => {
    expect(briefTargetFromArgs({ qualified_name: "src/a.ts::b" })).toBe("src/a.ts::b");
    expect(briefTargetFromArgs({ function_name: "doThing" })).toBe("doThing");
    expect(briefTargetFromArgs({})).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/brief-aware-wiring.test.ts`
Expected: FAIL — `briefTargetFromArgs` is not exported.

- [ ] **Step 3: Add the target extractor + wrapper handling**

In `src/mcp-server/repo-context.ts`, export a small helper (top-level):

```ts
export function briefTargetFromArgs(args: Record<string, unknown>): string | undefined {
  const qn = args["qualified_name"];
  if (typeof qn === "string" && qn.length > 0) return qn;
  const fn = args["function_name"];
  if (typeof fn === "string" && fn.length > 0) return fn;
  return undefined;
}
```

Add `briefAware?: boolean` to the `registerTool` options type at the two option-type sites (lines 411 and 429), alongside `freshnessAware?: boolean`.

Add the import near line 15:

```ts
import { attachBriefing } from "./briefing-attach.js";
```

Extend the wrapper block (lines 453-459) so briefing attaches after freshness, in the same default per-repo branch:

```ts
    const ctx = options.resolver.resolve(args.repo_path!);
    let result = await handler(ctx, args);
    if (options.freshnessAware && result && typeof result === "object" && "content" in (result as object)) {
      const f = freshnessForContext({ repoPath: ctx.repoPath, graphDb: ctx.graphDb, canonical: ctx.canonical });
      result = attachFreshness(result as any, f) as R;
    }
    if (options.briefAware && result && typeof result === "object" && "content" in (result as object)) {
      result = attachBriefing(result as any, ctx, briefTargetFromArgs(args as Record<string, unknown>)) as R;
    }
    return result;
```

- [ ] **Step 4: Opt the two tools in**

In `src/mcp-server/tools/code-tools.ts`, change the `get_code_snippet` registration options (line 705) from `{ resolver, freshnessAware: true }` to:

```ts
      { resolver, freshnessAware: true, briefAware: true },
```

And the `trace_path` registration options (line 656) likewise:

```ts
      { resolver, freshnessAware: true, briefAware: true },
```

- [ ] **Step 5: Run the unit test + full suite + typecheck**

Run: `npx vitest run tests/mcp-server/brief-aware-wiring.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: tsc exits 0 (the `briefAware` flag and `ctx.*` field names typecheck).
Run: `npx vitest run tests/briefing tests/mcp-server/attach-briefing.test.ts tests/cli/brief.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/repo-context.ts src/mcp-server/tools/code-tools.ts tests/mcp-server/brief-aware-wiring.test.ts
git commit -m "feat(mcp): briefAware wrapper flag; opt in get_code_snippet + trace_path"
```

---

### Task 7: Docs + env-gate documentation

**Files:**
- Modify: `CLAUDE.md` (the freshness-signal section — add a short "briefing signal" note) and `docs/mcp-tools.md` (note that `get_code_snippet`/`trace_path` may carry a briefing headline).

**Interfaces:** none (documentation).

- [ ] **Step 1: Add a CLAUDE.md note**

Under the freshness-signal section, add a paragraph:

```markdown
### Briefing signal — study-time pre-edit context

`get_code_snippet` and `trace_path` now also carry a **briefing headline** when
the fetched symbol is *gated*: governed by a decision, or with a blast radius
above `CORTEX_BRIEF_FANOUT` (default 12). The headline names the governing
decision + its reconciliation verdict and the caller count, and points to
`context_pack` for the full body. A `partial`/`drift`/`unreconciled` verdict marks
the area as drifting — treat it as a cue to read the decision before editing.
Gate off with `CORTEX_BRIEF=0`. The same headline is available on demand via
`cortex brief <path-or-qn>`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/mcp-tools.md
git commit -m "docs: document the study-time briefing signal + CORTEX_BRIEF gates"
```

---

## Self-Review

**Spec coverage (against the design doc):**
- §4.1 study-time enrichment → Tasks 5–6 (attachBriefing + briefAware wiring). ✓
- §5 `composeBriefing` keystone → Task 3; `cortex brief` CLI → Task 4; gate (governed OR fanout) + escalate (drift) → Task 3. ✓
- §2 principle (silence default, bounded ≤5-line headline, intervention scales) → headline length asserted in Task 1; ungated returns empty in Task 3; escalate flag in Task 3 (consumed by Plan 2's block-once). ✓
- §7 config (`CORTEX_BRIEF`, `CORTEX_BRIEF_FANOUT`) → Tasks 4–6. ✓
- §8 degrade-safety (enricher never throws/breaks response) → Task 5 try/catch + test. ✓
- **Deviation (noted):** §5 "last-touching PR" is not cheaply available server-side; the headline carries a governing decision's linked PR only (a later enhancement can add the reverse PR→file index). The `pr` field is plumbed through `BriefingFacts` but populated as a follow-up — `formatHeadline` already handles its presence/absence (Task 1 tests both).
- **Out of scope (Plans 2–3):** edit-time backstop hook, gate-cache, briefed ledger (§4.2–4.4); onboarding headline (§6). ✓

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step shows full code. The one explicit follow-up (PR field population) is called out as a deviation, not hidden. ✓

**Type consistency:** `Briefing { gated, escalate, headline }`, `BriefingFacts`, `BriefingDeps { search, decisions, store, project }`, `composeBriefing(deps, target, opts)`, `briefForTarget(...) → { headline, exitCode }`, `attachBriefing(result, ctx, target)`, `briefTargetFromArgs(args)` — names are consistent across Tasks 1–6. The `_callerCount` / `_composeOverride` test seams are documented where introduced. The one risk flagged for the engineer: the exact `RepoContext` field names (`ctx.store` / `ctx.project` vs `ctx.projectName`) — Task 5's note instructs verifying against `repo-context.ts` before relying on them; the test seam isolates the unit tests from that.
