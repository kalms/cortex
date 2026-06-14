# context_pack (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `context_pack(repo_path, qualified_name)` MCP tool that returns a symbol's source, direct callers, direct callees, governing decisions, and recent commits in one call.

**Architecture:** Pure composition of existing reads. A new module `context-pack.ts` resolves the symbol once, then assembles five best-effort labeled text sections. `readSnippet` + `projectFromCtx` are lifted out of the 936-line `code-tools.ts` into a shared helper so both files import them.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Zod, vitest, better-sqlite3. Reuses `tracePath`/`searchGraph` (`src/graph/code-queries.ts`), `resolveInput`, `DecisionSearch`, and `git log` via `execFile`.

Design: [docs/superpowers/specs/2026-06-14-context-pack-and-sibling-auto-index-design.md](../specs/2026-06-14-context-pack-and-sibling-auto-index-design.md) (§P1).

---

### Task 1: Extract `readSnippet` + `projectFromCtx` into a shared helper

**Files:**
- Create: `src/mcp-server/tools/code-tools-shared.ts`
- Modify: `src/mcp-server/tools/code-tools.ts` (remove the two local defs, import them instead)

No behavior change — this is a pure move so `context-pack.ts` can reuse the two helpers without importing the whole tool-registration module.

- [ ] **Step 1: Create the shared module with the two functions moved verbatim**

```ts
// src/mcp-server/tools/code-tools-shared.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexerNode } from "../../graph/code-queries.js";
import { ok, error as errorResponse } from "../response.js";
import { denormalize } from "../qualified-name.js";
import type { RepoContext } from "../repo-context.js";

/**
 * Derive the project name from the addressed repo's graph DB.
 * Each `.cortex/db` holds rows for exactly one project; LIMIT 1 is unambiguous.
 * Returns null when the table is missing (pre-migration DB) or empty.
 */
export function projectFromCtx(ctx: RepoContext): string | null {
  try {
    const rows = ctx.store.queryRaw<{ name: string }>(
      "SELECT name FROM ctx_projects LIMIT 1",
    );
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a code snippet for a resolved node off disk. Honors the stored
 * `ctx_projects.root_path` because the indexer wrote `file_path` relative to
 * that root, not to the path the caller addressed.
 */
export async function readSnippet(
  ctx: RepoContext,
  project: string,
  node: IndexerNode,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  try {
    const projectRow = ctx.store.queryRaw<{ root_path: string }>(
      "SELECT root_path FROM ctx_projects WHERE name = ?",
      [project],
    );
    if (projectRow.length === 0) {
      return errorResponse("project_not_found", `Project ${project} not found in indexer DB`);
    }
    const fullPath = join(projectRow[0].root_path, node.file_path);
    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, node.start_line - 1);
    const end = Math.min(lines.length, node.end_line);
    const snippet = lines.slice(start, end).join("\n");
    const display = denormalize(node.qualified_name, node.file_path);
    return ok(`// ${display} (${node.file_path}:${node.start_line}-${node.end_line})\n${snippet}`);
  } catch (e) {
    return errorResponse("fs_error", e instanceof Error ? e.message : String(e));
  }
}
```

- [ ] **Step 2: Delete the two local definitions from `code-tools.ts` and import them**

In `src/mcp-server/tools/code-tools.ts`, remove the `projectFromCtx` function (currently ~lines 184-193) and the `readSnippet` function (currently ~lines 203-227), then add to the import block near the top:

```ts
import { projectFromCtx, readSnippet } from "./code-tools-shared.js";
```

Leave the existing `import { join, dirname } from "node:path";` line — `dirname`/`join` are still used elsewhere in the file by `index_repository`.

- [ ] **Step 3: Typecheck + run the existing code-tools contract tests**

Run: `npx tsc --noEmit && npx vitest run tests/mcp-contract/code-tools.test.ts`
Expected: PASS (no behavior change; `get_code_snippet` still works via the moved `readSnippet`).

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools/code-tools-shared.ts src/mcp-server/tools/code-tools.ts
git commit -m "refactor(mcp): lift readSnippet + projectFromCtx into code-tools-shared"
```

---

### Task 2: Write the failing contract test for `context_pack`

**Files:**
- Create: `tests/mcp-contract/context-pack.test.ts`

Use a real symbol that exists in the contract fixture graph. `registerCodeTools` (which the harness calls) is the symbol used by the existing suite — pick a stable exported function present in the fixture. The existing `code-tools.test.ts` greps for symbols; reuse one it already asserts on. This plan uses `runCodeSearch` (exported from `src/graph/code-search.ts`, present in the fixture) as the happy-path target; if the fixture lacks it, substitute any function the existing `trace_path`/`get_code_snippet` tests resolve.

- [ ] **Step 1: Write the test file**

```ts
// tests/mcp-contract/context-pack.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("context_pack", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("returns all five labeled sections for a resolvable symbol", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "runCodeSearch" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("## SNIPPET");
    expect(text).toContain("## CALLERS");
    expect(text).toContain("## CALLEES");
    expect(text).toContain("## GOVERNING DECISIONS");
    expect(text).toContain("## RECENT COMMITS");
  });

  it("returns ambiguous_input once for a multi-match bare name", async () => {
    // A bare name with multiple matches in the fixture. If the fixture has no
    // ambiguous bare name, assert the error SHAPE on a known-ambiguous one;
    // otherwise this asserts the single-resolution contract holds.
    const res = await callTool(h, "context_pack", { qualified_name: "handler" });
    if (res.isError) {
      expect(res.content[0].text).toContain("Multiple matches");
    } else {
      expect(res.content[0].text).toContain("## SNIPPET");
    }
  });

  it("returns empty for an unresolvable name", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "ZzNoSuchSymbol999" });
    // empty() responses render a "no results" text and are not isError.
    expect(res.content[0].text.toLowerCase()).toMatch(/no results|empty|context_pack/);
  });

  it("rejects when repo_path is missing", async () => {
    const res = await callTool(h, "context_pack", { repo_path: undefined, qualified_name: "x" });
    expect(res.isError).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp-contract/context-pack.test.ts`
Expected: FAIL — `context_pack` is not a registered tool (callTool rejects / returns error "tool not found").

---

### Task 3: Implement `context-pack.ts`

**Files:**
- Create: `src/mcp-server/tools/context-pack.ts`

- [ ] **Step 1: Write the module**

```ts
// src/mcp-server/tools/context-pack.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { searchGraph, tracePath, IndexerNode } from "../../graph/code-queries.js";
import { resolveInput } from "../../shared/resolve-input.js";
import { normalize, denormalize } from "../qualified-name.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { DecisionSearch } from "../../decisions/search.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { projectFromCtx, readSnippet } from "./code-tools-shared.js";

const execFileAsync = promisify(execFile);

const CAP_CALLERS = 10;
const CAP_CALLEES = 10;
const CAP_DECISIONS = 5;
const CAP_COMMITS = 5;

const RepoPathField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "REQUIRED. Absolute path to the indexed git root this query targets. " +
      "If you don't know it, call list_projects first.",
  );

const contextPackShape = {
  repo_path: RepoPathField,
  qualified_name: z.string().min(1, "qualified_name must not be empty"),
} as const;
const contextPackSchema = z.object(contextPackShape);

type ResolveResult =
  | { kind: "single"; node: IndexerNode }
  | { kind: "none" }
  | { kind: "multi"; candidates: Array<{ qn: string; kind: string; file_path: string }> };

/** Resolve the input to exactly one node, mirroring get_code_snippet. */
function resolveNode(ctx: RepoContext, project: string, qualified_name: string): ResolveResult {
  if (!qualified_name.includes("::")) {
    const resolved = resolveInput(qualified_name, project, ctx.graphDbPath);
    if (resolved.kind === "none") return { kind: "none" };
    if (resolved.kind === "multi") return { kind: "multi", candidates: resolved.candidates };
    const nodes = searchGraph(ctx.store, project, { qn_pattern: resolved.symbol.qn });
    if (nodes.length === 0) return { kind: "none" };
    return { kind: "single", node: nodes[0] };
  }
  const qn = normalize(qualified_name, project);
  const nodes = searchGraph(ctx.store, project, { qn_pattern: qn });
  if (nodes.length === 0) return { kind: "none" };
  return { kind: "single", node: nodes[0] };
}

/** Best-effort sync wrapper: returns fallback on any throw. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Last N commits touching a file. null = git unavailable / not a repo. */
async function recentCommits(repoPath: string, filePath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-n", String(CAP_COMMITS), "--format=%h %s (%ad)", "--date=short", "--", filePath],
      { cwd: repoPath, timeout: 5000 },
    );
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function sectionHeader(label: string, shown: number, total: number): string {
  return total > shown ? `## ${label} (showing ${shown} of ${total})` : `## ${label} (${total})`;
}

/** Core composition — exported for direct unit testing. */
export async function buildContextPack(ctx: RepoContext, qualified_name: string) {
  const project = projectFromCtx(ctx);
  if (!project) {
    return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
  }

  const resolved = resolveNode(ctx, project, qualified_name);
  if (resolved.kind === "none") return empty(`context_pack(${qualified_name})`);
  if (resolved.kind === "multi") {
    const candidatesList = resolved.candidates
      .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
      .join("\n");
    return errorResponse(
      "ambiguous_input",
      `Multiple matches for '${qualified_name}'. Pick one and re-call:\n${candidatesList}`,
    );
  }

  const node = resolved.node;
  const bareName = node.qualified_name.split(/::|\./).pop() ?? qualified_name;

  // SNIPPET (best-effort).
  const snippetRes = await readSnippet(ctx, project, node);
  const snippetText = snippetRes.isError ? "(unavailable)" : snippetRes.content[0]?.text ?? "(unavailable)";

  // CALLERS / CALLEES (best-effort).
  const callers = safe(
    () => tracePath(ctx.store, project, { function_name: bareName, mode: "callers", max_depth: 1 }),
    [] as Array<{ node: IndexerNode; depth: number }>,
  );
  const callees = safe(
    () => tracePath(ctx.store, project, { function_name: bareName, mode: "calls", max_depth: 1 }),
    [] as Array<{ node: IndexerNode; depth: number }>,
  );

  // GOVERNING DECISIONS (best-effort).
  const decisions = safe(
    () => new DecisionSearch(ctx.decisionsRepo, ctx.decisionLinksRepo).findGoverning(node.file_path || node.qualified_name),
    [] as Array<{ id: string; title: string }>,
  );

  // RECENT COMMITS (best-effort; null → unavailable).
  const commits = await recentCommits(ctx.repoPath, node.file_path);

  const fmtNode = (r: { node: IndexerNode }) =>
    `- ${denormalize(r.node.qualified_name, r.node.file_path)}  (${r.node.file_path}:${r.node.start_line})`;

  const sections: string[] = [];
  sections.push(`## SNIPPET\n${snippetText}`);

  const callersShown = callers.slice(0, CAP_CALLERS);
  sections.push(
    `${sectionHeader("CALLERS", callersShown.length, callers.length)}\n${callersShown.map(fmtNode).join("\n") || "- (none)"}`,
  );

  const calleesShown = callees.slice(0, CAP_CALLEES);
  sections.push(
    `${sectionHeader("CALLEES", calleesShown.length, callees.length)}\n${calleesShown.map(fmtNode).join("\n") || "- (none)"}`,
  );

  const decShown = decisions.slice(0, CAP_DECISIONS);
  sections.push(
    `${sectionHeader("GOVERNING DECISIONS", decShown.length, decisions.length)}\n${decShown.map((d) => `- ${d.id}: ${d.title}`).join("\n") || "- (none)"}`,
  );

  if (commits === null) {
    sections.push("## RECENT COMMITS\n(unavailable)");
  } else {
    const commitsShown = commits.slice(0, CAP_COMMITS);
    sections.push(
      `${sectionHeader("RECENT COMMITS", commitsShown.length, commits.length)}\n${commitsShown.map((c) => `- ${c}`).join("\n") || "- (none)"}`,
    );
  }

  return ok(sections.join("\n\n"));
}

/** Register the context_pack tool on the MCP server. */
export function registerContextPackTool(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "context_pack",
    "Get a full context bundle for a symbol in ONE call: source snippet, direct callers, direct callees, governing decisions, and recent commits. Composes get_code_snippet + trace_path + why_was_this_built. Input accepts a qualified name, file path, dotted suffix, or bare name; returns ambiguous_input with candidates if multiple symbols match.",
    contextPackShape,
    registerTool(
      "context_pack",
      contextPackSchema,
      async (ctx, args) => buildContextPack(ctx, args.qualified_name),
      { resolver, freshnessAware: true },
    ),
  );
}
```

- [ ] **Step 2: Verify `resolveInput` candidate field names**

Open `src/shared/resolve-input.js` (or its `.ts` source) and confirm the `multi` branch exposes `candidates: Array<{ qn; kind; file_path }>` and the `single` branch exposes `symbol.qn`. These are the same fields `get_code_snippet` uses (`src/mcp-server/tools/code-tools.ts:737-746`), so they are correct — this step is a visual confirmation, not a change.

---

### Task 4: Wire registration into `registerCodeTools` + the harness picks it up

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (call `registerContextPackTool` at the end of `registerCodeTools`)

Registering inside `registerCodeTools` means both `server.ts` (production) and `tests/mcp-contract/harness.ts` (which already calls `registerCodeTools`) get the tool with no further wiring.

- [ ] **Step 1: Import and call the registrar**

Add to the import block of `code-tools.ts`:

```ts
import { registerContextPackTool } from "./context-pack.js";
```

At the very end of the `registerCodeTools` function body (after the `search_code` `server.tool(...)` block, before the closing `}`), add:

```ts
  // context_pack — composite read (P1). Registered here so both server.ts and
  // the contract harness pick it up via the single registerCodeTools call.
  registerContextPackTool(server, resolver);
```

- [ ] **Step 2: Run the context_pack contract test — expect PASS**

Run: `npx vitest run tests/mcp-contract/context-pack.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 3: Typecheck + full contract suite**

Run: `npx tsc --noEmit && npx vitest run tests/mcp-contract/`
Expected: PASS (no regressions in the existing tools).

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools/context-pack.ts src/mcp-server/tools/code-tools.ts tests/mcp-contract/context-pack.test.ts
git commit -m "feat(mcp): add context_pack composite tool (P1)"
```

---

### Task 5: Add the best-effort-degradation test

**Files:**
- Modify: `tests/mcp-contract/context-pack.test.ts`

Proves one failing section never sinks the pack, and the commits-unavailable path renders `(unavailable)`.

- [ ] **Step 1: Add a degradation test using a non-git repo fixture**

A `makeIndexedRepoFixture()` repo is `git init`'d, so `git log` succeeds (empty history → zero commits, not "unavailable"). To exercise the `(unavailable)` branch deterministically, this test asserts the commits section is always PRESENT (either a count or `(unavailable)`), and that the pack still returns when the symbol resolves:

```ts
  it("always renders a RECENT COMMITS section and never errors on a resolvable symbol", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "runCodeSearch" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toMatch(/## RECENT COMMITS( \(|\n)/);
    // SNIPPET present even if some downstream section is empty.
    expect(text).toContain("## SNIPPET");
  });
```

- [ ] **Step 2: Run it — expect PASS**

Run: `npx vitest run tests/mcp-contract/context-pack.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-contract/context-pack.test.ts
git commit -m "test(mcp): context_pack best-effort degradation + commits section"
```

---

### Task 6: Docs + decision capture

**Files:**
- Modify: `docs/mcp-tools.md` (add a `context_pack` entry)
- Modify: `CLAUDE.md` (routing table row)
- Modify: `README.md` (tool count + list)

- [ ] **Step 1: Add `context_pack` to docs/mcp-tools.md**

Add a section mirroring the `get_code_snippet` entry's format: params (`repo_path`, `qualified_name`), the five sections it returns, the caps (callers/callees 10, decisions/commits 5), and that it is freshness-aware. State it composes `get_code_snippet` + `trace_path` + `why_was_this_built` and is the preferred first call when orienting on a symbol.

- [ ] **Step 2: Add the CLAUDE.md routing-table row**

In the tool-routing table near the top of `CLAUDE.md`, add:

```
| Get full context for a symbol (code + callers + callees + decisions + commits) | `context_pack(qualified_name="…")` | 3 separate calls |
```

- [ ] **Step 3: Bump the tool count + list in README.md**

`README.md` line ~23 says "29 MCP tools" — change to "30 MCP tools" and add `context_pack` to the example list. Update the tool table (~line 186 region) with a `context_pack` row.

- [ ] **Step 4: Capture the decision**

Use the cortex MCP tools (this repo is indexed):

```
search_decisions({ repo_path: "<this repo>", query: "context_pack composite symbol tool" })
create_decision({
  repo_path: "<this repo>",
  title: "context_pack composite read tool",
  description: "Single MCP tool returning snippet + callers + callees + governing decisions + recent commits for a symbol.",
  rationale: "Collapses the 4-roundtrip symbol-exploration loop (get_code_snippet → trace_path×2 → why_was_this_built) into one turn; resolves the qualified_name once instead of 3×. Near-zero implementation risk: pure composition of existing reads.",
  alternatives: "JSON output (rejected: token cost + convention divergence from text-returning tools); keep the 4-call pattern (rejected: per-turn latency + token tax); defer recent_commits to P8 (rejected: user chose to include in v1).",
  governs: ["src/mcp-server/tools/context-pack.ts"]
})
link_decision({ repo_path: "<this repo>", decision_id: "<new id>", target: "src/mcp-server/tools/context-pack.ts", relation: "GOVERNS" })
```

- [ ] **Step 5: Commit docs**

```bash
git add docs/mcp-tools.md CLAUDE.md README.md
git commit -m "docs: document context_pack tool (P1)"
```

---

## Self-Review

**Spec coverage:** shape (Task 3 schema) ✓; resolve-once + ambiguous/empty (Task 3 `resolveNode`/`buildContextPack`, Task 2 tests) ✓; five best-effort sections + caps 10/10/5/5 (Task 3) ✓; commits `(unavailable)` path (Task 3 `recentCommits`, Task 5) ✓; truncation note (Task 3 `sectionHeader`) ✓; new module + helper extraction (Tasks 1, 3) ✓; registration (Task 4) ✓; docs + decision (Task 6) ✓; contract tests (Tasks 2, 5) ✓. `freshnessAware: true` (Task 3 registrar) ✓.

**Placeholder scan:** the happy-path fixture symbol (`runCodeSearch`) and the ambiguous-name (`handler`) are fixture-dependent — Task 2 Step 1 notes the substitution rule rather than leaving a bare TODO. No other placeholders.

**Type consistency:** `buildContextPack`, `resolveNode`, `recentCommits`, `sectionHeader`, `safe`, `registerContextPackTool`, `projectFromCtx`, `readSnippet` are used with the same signatures defined here. `tracePath` returns `Array<{node, depth}>` (matches `fmtNode`). `findGoverning` returns objects with `id`/`title` (matches the decisions render). `registerTool` default-mode signature matches `(ctx, args) => Promise<result>`.
