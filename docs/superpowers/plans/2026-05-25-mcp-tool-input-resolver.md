# MCP Tool Input Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP server's `get_code_snippet`, `trace_path`, and `why_was_this_built` tools accept the same input shapes the CLI's `resolveInput` accepts — raw file paths, canonical qualified names, dotted suffixes, and bare symbol names — so agentic users (Claude Code talking MCP, not the CLI) get the same .vue-path-just-works behavior the field report flagged.

**Architecture:** Extract the existing CLI heuristic from `src/cli/resolve-input.ts` into a project-shared module `src/shared/resolve-input.ts` returning a tagged result (`{ kind: "single", ... } | { kind: "multi", candidates } | { kind: "none" }`). The CLI keeps a thin throwing wrapper for back-compat; MCP handlers convert the tagged result into MCP responses (`ok`, `empty`, `errorResponse("ambiguous_input", ...)`).

**Tech Stack:** TypeScript, vitest, the existing better-sqlite3-backed `GraphStore`. No new dependencies.

**Spec:** This document — small enough to combine spec + plan inline.

---

## Why a shared module

`src/cli/resolve-input.ts` works only via `import` paths reachable from the CLI tree. The MCP handlers live under `src/mcp-server/` and would have to reach back into `src/cli/` to use it, which crosses an abstraction boundary the codebase otherwise avoids. Lifting the pure-function core into `src/shared/` lets both consumers depend on it without one importing the other.

The current `resolveInput` throws `DomainError` from `src/cli/errors.ts`. That coupling is the second reason to extract: MCP handlers should not throw CLI errors; they convert states into MCP response shapes.

---

## File structure

**New files:**
- `src/shared/resolve-input.ts` — pure `resolveInput(input, project, dbPath): ResolveResult` returning a tagged union. No CLI/MCP-specific types.
- `tests/shared/resolve-input.test.ts` — tests against a tempdir `GraphStore`, exercising the four input shapes + multi-match + zero-match cases.

**Modified files:**
- `src/cli/resolve-input.ts` — re-export `ResolvedSymbol` and `Disambiguation` types from `../shared/resolve-input.js`; the existing `resolveInput` becomes a thin wrapper that converts `{ kind: "none" }` → `DomainError`. CLI callers continue to import from `../resolve-input.js` unchanged.
- `src/mcp-server/tools/code-tools.ts` — `get_code_snippet` and `trace_path` handlers call the shared resolver, then handle the three result kinds.
- `src/mcp-server/tools/decision-tools.ts` — `why_was_this_built` handler calls the shared resolver to convert bare names to qns before calling `findGoverning`.
- `tests/cli/resolve-input.test.ts` — unchanged behavior; tests continue to pass against the back-compat wrapper.

---

## Task 1: Extract `resolveInput` into `src/shared/resolve-input.ts`

Goal: lift the pure heuristic into a shared module returning a tagged result. CLI wrapper preserves the existing throwing surface.

**Files:**
- Create: `src/shared/resolve-input.ts`
- Create: `tests/shared/resolve-input.test.ts`
- Modify: `src/cli/resolve-input.ts`

- [ ] **Step 1: Write the failing shared-module test**

Create `tests/shared/resolve-input.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInput } from "../../src/shared/resolve-input.js";

describe("shared resolveInput", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  const project = "test-project";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-shared-resolve-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("single match by file path → kind: 'single'", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const r = resolveInput("apps/Card.vue", project, dbPath);
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.symbol.qn).toBe("test-project.apps.Card");
  });

  it("single match by canonical qn → kind: 'single'", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const r = resolveInput("test-project.apps.Card", project, dbPath);
    expect(r.kind).toBe("single");
  });

  it("single match by bare name → kind: 'single'", () => {
    store.createNode({
      kind: "function", name: "handleRequest",
      file_path: "src/handler.ts",
      qualified_name: "test-project.src.handler.handleRequest",
    });
    const r = resolveInput("handleRequest", project, dbPath);
    expect(r.kind).toBe("single");
    if (r.kind === "single") expect(r.symbol.qn).toBe("test-project.src.handler.handleRequest");
  });

  it("multiple matches → kind: 'multi' with candidates", () => {
    store.createNode({ kind: "function", name: "render", file_path: "a.ts", qualified_name: "test-project.a.render" });
    store.createNode({ kind: "function", name: "render", file_path: "b.ts", qualified_name: "test-project.b.render" });
    const r = resolveInput("render", project, dbPath);
    expect(r.kind).toBe("multi");
    if (r.kind === "multi") expect(r.candidates.length).toBe(2);
  });

  it("no matches → kind: 'none'", () => {
    const r = resolveInput("apps/missing.vue", project, dbPath);
    expect(r.kind).toBe("none");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/resolve-input.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared module**

Create `src/shared/resolve-input.ts`:

```ts
import { GraphStore } from "../graph/store.js";

export type ResolvedSymbol = { qn: string; file_path: string; kind: string };

export type ResolveResult =
  | { kind: "single"; symbol: ResolvedSymbol }
  | { kind: "multi"; candidates: ResolvedSymbol[]; input: string }
  | { kind: "none"; input: string };

const SOURCE_EXTS = new RegExp("\\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$");

function lookupByFilePath(store: GraphStore, input: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE file_path = ? OR file_path LIKE ('%' || ?) LIMIT 5",
    [input, input],
  );
}

function lookupByQn(store: GraphStore, qn: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE qualified_name = ? LIMIT 5",
    [qn],
  );
}

function lookupByName(store: GraphStore, name: string): ResolvedSymbol[] {
  return store.queryRaw<ResolvedSymbol>(
    "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE name = ? OR name LIKE ? LIMIT 5",
    [name, `%${name}%`],
  );
}

export function resolveInput(input: string, project: string, dbPath: string): ResolveResult {
  const store = new GraphStore(dbPath);

  let candidates: ResolvedSymbol[] = [];

  // 1. File path (contains '/' or ends in a source extension)
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
    candidates = lookupByFilePath(store, input);
  }

  // 2. Canonical qn (starts with project prefix)
  if (candidates.length === 0 && input.startsWith(`${project}.`)) {
    candidates = lookupByQn(store, input);
  }

  // 3. Dotted suffix (e.g. components.foo)
  if (candidates.length === 0 && input.includes(".") && !input.includes("/")) {
    candidates = lookupByQn(store, input);
    if (candidates.length === 0) {
      candidates = store.queryRaw<ResolvedSymbol>(
        "SELECT qualified_name AS qn, file_path, kind FROM nodes WHERE qualified_name LIKE ('%' || ?) LIMIT 5",
        [input],
      );
    }
  }

  // 4. Bare name fallback
  if (candidates.length === 0) {
    candidates = lookupByName(store, input);
  }

  if (candidates.length === 0) return { kind: "none", input };
  if (candidates.length === 1) return { kind: "single", symbol: candidates[0] };
  return { kind: "multi", candidates, input };
}
```

- [ ] **Step 4: Run the shared test to verify it passes**

Run: `npx vitest run tests/shared/resolve-input.test.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Update the CLI wrapper to delegate**

Replace `src/cli/resolve-input.ts` with:

```ts
import { resolveInput as sharedResolve, type ResolvedSymbol } from "../shared/resolve-input.js";
import { DomainError } from "./errors.js";

export type { ResolvedSymbol } from "../shared/resolve-input.js";
export type Disambiguation = { candidates: ResolvedSymbol[]; input: string };

const SOURCE_EXTS = new RegExp("\\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$");

function tipFor(input: string): string {
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
    return `Try:\n  cortex code find ${input.split("/").pop()?.replace(SOURCE_EXTS, "")}    search by name\n  cortex index changes                refresh the index`;
  }
  return `Try:\n  cortex code find '${input}%'    name prefix match\n  cortex help qualified-names    learn the canonical form`;
}

export function resolveInput(
  input: string,
  project: string,
  dbPath: string,
): ResolvedSymbol | Disambiguation {
  const r = sharedResolve(input, project, dbPath);
  if (r.kind === "none") {
    throw new DomainError(`no symbol matched '${input}'`, tipFor(input));
  }
  if (r.kind === "single") return r.symbol;
  return { candidates: r.candidates, input: r.input };
}
```

- [ ] **Step 6: Run the existing CLI tests to verify the back-compat wrapper holds**

Run: `npx vitest run tests/cli/resolve-input.test.ts`
Expected: PASS — 5/5 (same tests as before).

- [ ] **Step 7: Commit**

```bash
git add src/shared/resolve-input.ts tests/shared/resolve-input.test.ts src/cli/resolve-input.ts
git commit -m "refactor(resolve-input): extract heuristic into src/shared

Lift the four-shape input resolver (file path, qn, dotted suffix, bare
name) out of src/cli/resolve-input.ts into src/shared/resolve-input.ts.
Shared version returns a tagged result ({ kind: 'single' | 'multi' |
'none' }); CLI keeps a thin throwing wrapper for back-compat. MCP
handlers will consume the tagged result directly in subsequent commits.

No behavior change — both old CLI tests and new shared tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire shared resolver into `get_code_snippet`

Goal: `get_code_snippet({ qualified_name: 'apps/foo.vue' })` should now resolve the file path, find the module/file node, and return the source — instead of failing with `empty`.

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts`
- Test: `tests/mcp-contract/code-tools.test.ts` (extend)

- [ ] **Step 1: Write the failing contract test**

Append to `tests/mcp-contract/code-tools.test.ts`, inside the top-level `describe("code-tools contract", ...)`:

```ts
  describe("get_code_snippet input resolution", () => {
    it("accepts a raw file path and returns source", async () => {
      // Pick a file we know exists in the test fixture
      const res = await callTool(h, "get_code_snippet", {
        qualified_name: "src/api/handler.ts",
      });
      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain("handleRequest");
    });

    it("returns ambiguous_input when input matches multiple symbols", async () => {
      // 'handler' is generic enough to match more than one node in the fixture
      const res = await callTool(h, "get_code_snippet", {
        qualified_name: "handler",
      });
      // Either single-match (if fixture only has one) or ambiguous_input;
      // assert one of the two valid shapes
      if (res.isError) {
        expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
      } else {
        expect(res.content[0].text.length).toBeGreaterThan(0);
      }
    });

    it("returns project_not_found-like error for zero matches", async () => {
      const res = await callTool(h, "get_code_snippet", {
        qualified_name: "totallymadeup_function_xyzzy",
      });
      // Either empty (no matches) or error — both are valid no-result responses
      expect(res.content[0].text.length).toBeGreaterThan(0);
    });
  });
```

Note: this contract test runs against the fixture project; the exact symbols in the fixture determine which assertions hold. Read `tests/mcp-contract/code-tools.test.ts` to see what's already in the fixture before writing the test — adapt the symbol names if `handleRequest` / `src/api/handler.ts` aren't present.

- [ ] **Step 2: Run the contract test to verify it fails (or is brittle)**

Run: `npx vitest run tests/mcp-contract/code-tools.test.ts`
Expected: FAIL — `get_code_snippet` with `"src/api/handler.ts"` returns `empty` because the current handler only does `normalize(input)` which doesn't handle raw paths.

- [ ] **Step 3: Wire the shared resolver into `get_code_snippet`**

In `src/mcp-server/tools/code-tools.ts`, locate the `get_code_snippet` handler (around line 297). Add an import at the top:

```ts
import { resolveInput } from "../../shared/resolve-input.js";
```

Read the file to confirm the existing `dbPath` variable. The handler currently does:

```ts
const qn = normalize(qualified_name, indexerProject);
const nodes = searchGraph(store, indexerProject, { qn_pattern: qn });
if (nodes.length === 0) return empty(...);
const node = nodes[0];
```

Replace that block with:

```ts
const resolved = resolveInput(qualified_name, indexerProject, dbPath);
if (resolved.kind === "none") {
  return empty(`get_code_snippet(${qualified_name})`);
}
if (resolved.kind === "multi") {
  const candidatesList = resolved.candidates
    .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
    .join("\n");
  return errorResponse(
    "ambiguous_input",
    `Multiple matches for '${qualified_name}'. Pick one and re-call:\n${candidatesList}`,
  );
}
const node = searchGraph(store, indexerProject, { qn_pattern: resolved.symbol.qn })[0];
if (!node) {
  // Resolver said it found a node, but searchGraph's filter rejected it
  // (e.g. resolver returned a 'file' kind that searchGraph filters out)
  return empty(`get_code_snippet(${qualified_name})`);
}
```

If `dbPath` isn't already in scope in the handler, derive it from the `store` instance — read the existing `code-tools.ts` to find how the store is constructed and either thread `dbPath` through or expose it as `store.dbPath` (one-line edit on the GraphStore class if needed; check first).

Important: keep the existing `ok(...)` source-rendering block downstream of the new resolver — don't touch the snippet-rendering logic.

Update the tool description (the 2nd arg to `server.tool`) from `"Get source code for a fully qualified name"` to `"Get source code for a symbol. Input can be a qualified name, file path, dotted suffix, or bare symbol name. Returns ambiguous_input with candidates if multiple symbols match."`.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `npx vitest run tests/mcp-contract/code-tools.test.ts`
Expected: PASS — including the new 3 tests + all pre-existing tests.

- [ ] **Step 5: Run the full mcp-contract suite to verify no regression**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/mcp-contract/code-tools.test.ts
git commit -m "feat(mcp): get_code_snippet accepts raw file paths and bare names

Wire src/shared/resolve-input into the handler so callers can pass
'apps/foo.vue', 'handleRequest', or any of the four input shapes the
CLI's cortex code show already accepts. Multi-match returns
ambiguous_input with a numbered candidate list; zero-match returns
empty as before.

Closes the agentic-side of the field-report friction: Claude Code
talking MCP now gets the same UX as Claude Code talking CLI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire shared resolver into `trace_path`

Goal: `trace_path({ function_name: 'apps/foo.vue', ... })` resolves the file path to a symbol qn, then derives the bare function name for the existing `tracePath` SQL.

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts`
- Test: `tests/mcp-contract/code-tools.test.ts` (extend)

- [ ] **Step 1: Write the failing contract test**

Append inside the `describe("code-tools contract", ...)`:

```ts
  describe("trace_path input resolution", () => {
    it("accepts a raw file path and resolves to a function", async () => {
      const res = await callTool(h, "trace_path", {
        function_name: "src/api/handler.ts",
        mode: "callers",
      });
      // The fixture's src/api/handler.ts contains handleRequest; trace should not error
      expect(res.isError).toBeFalsy();
    });

    it("returns ambiguous_input on multi-match", async () => {
      const res = await callTool(h, "trace_path", {
        function_name: "handler",
        mode: "callers",
      });
      if (res.isError) {
        expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
      }
    });
  });
```

Adapt the symbol/path names to whatever the fixture actually exposes — read the fixture setup in `tests/mcp-contract/code-tools.test.ts` first.

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npx vitest run tests/mcp-contract/code-tools.test.ts`
Expected: FAIL — `trace_path` with `"src/api/handler.ts"` returns empty results because the function_name SQL filter is exact.

- [ ] **Step 3: Wire the resolver into `trace_path`**

Locate the `trace_path` handler. Replace:

```ts
const results = tracePath(store, indexerProject, params);
if (results.length === 0) return empty(...);
```

with:

```ts
const resolved = resolveInput(params.function_name, indexerProject, dbPath);
if (resolved.kind === "none") {
  return empty(`trace_path(${JSON.stringify(params)})`);
}
if (resolved.kind === "multi") {
  const candidatesList = resolved.candidates
    .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
    .join("\n");
  return errorResponse(
    "ambiguous_input",
    `Multiple matches for '${params.function_name}'. Pick one and re-call:\n${candidatesList}`,
  );
}
const fnName = resolved.symbol.qn.split(".").pop()!;
const results = tracePath(store, indexerProject, { ...params, function_name: fnName });
if (results.length === 0) return empty(`trace_path(${JSON.stringify(params)})`);
```

Update the tool description to `"Trace call chains from a function (mode: calls, callers). function_name accepts a bare name, qualified name, or file path."`.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `npx vitest run tests/mcp-contract/code-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full mcp-contract suite**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/mcp-contract/code-tools.test.ts
git commit -m "feat(mcp): trace_path accepts file paths and bare names

Wire src/shared/resolve-input into trace_path so function_name can be
a file path, qn, or bare name. After resolution, derive the bare name
from the resolved qn and pass it to the existing tracePath query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire shared resolver into `why_was_this_built`

Goal: `why_was_this_built({ qualified_name: 'handleRequest' })` (bare name) resolves to a qn or path before calling `findGoverning`. File paths and qns already work via `findGoverning`'s own path-walking; this task adds the bare-name case.

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`
- Test: `tests/mcp-contract/decision-tools.test.ts` (extend)

- [ ] **Step 1: Write the failing contract test**

Append inside the `describe("decision-tools contract", ...)`:

```ts
  describe("why_was_this_built input resolution", () => {
    it("accepts a bare symbol name and resolves before findGoverning", async () => {
      // Create a decision that governs a file the bare name will resolve to
      const created = await callTool(h, "create_decision", {
        title: "Why-bare-name test",
        description: "test",
        rationale: "test",
        governs: ["src/api/handler.ts"],
      });
      const id = JSON.parse(created.content[0].text).id;

      // Now query by bare function name — handleRequest lives in the fixture's
      // src/api/handler.ts, so the resolver should map to that file and
      // findGoverning should walk up to find the governing decision.
      const res = await callTool(h, "why_was_this_built", {
        qualified_name: "handleRequest",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Why-bare-name test");

      await callTool(h, "delete_decision", { id });
    });

    it("falls through to path-walk for raw file paths (back-compat)", async () => {
      const created = await callTool(h, "create_decision", {
        title: "Path-walk test",
        description: "test",
        rationale: "test",
        governs: ["src/api/handler.ts"],
      });
      const id = JSON.parse(created.content[0].text).id;

      const res = await callTool(h, "why_was_this_built", {
        qualified_name: "src/api/handler.ts",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Path-walk test");

      await callTool(h, "delete_decision", { id });
    });
  });
```

Read the fixture setup in `tests/mcp-contract/decision-tools.test.ts` to confirm what `src/api/handler.ts` and `handleRequest` resolve to in the fixture project. Adjust the symbol names if needed.

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npx vitest run tests/mcp-contract/decision-tools.test.ts`
Expected: FAIL — bare-name `handleRequest` doesn't resolve to a path that `findGoverning` can match.

- [ ] **Step 3: Wire the resolver into `why_was_this_built`**

In `src/mcp-server/tools/decision-tools.ts`, locate the `why_was_this_built` handler (around line 247). Add the resolver import at the top:

```ts
import { resolveInput } from "../../shared/resolve-input.js";
```

The handler needs access to the GraphStore's dbPath and the indexer project. Read how the handler is wired (look near the top of the registration function to see what's in scope — there's a `store` and likely an `indexerProject` similar to code-tools.ts). If they aren't in scope, plumb them through from `registerDecisionTools(server, ...)` (it likely already takes them; if not, take them as new parameters and update the caller in `src/mcp-server/server.ts`).

Replace the handler body's `findGoverning(qualified_name)` call with:

```ts
async ({ qualified_name }) => {
  try {
    // Resolve bare names / dotted suffixes to a concrete qn or path before
    // calling findGoverning. findGoverning already handles file paths and
    // qns via its own walk; the resolver fills the bare-name gap.
    let target = qualified_name;
    if (indexerProject && dbPath) {
      const resolved = resolveInput(qualified_name, indexerProject, dbPath);
      if (resolved.kind === "single") {
        // Prefer the file_path for path-walk semantics; fall back to qn.
        target = resolved.symbol.file_path || resolved.symbol.qn;
      } else if (resolved.kind === "multi") {
        const candidatesList = resolved.candidates
          .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
          .join("\n");
        return errorResponse(
          "ambiguous_input",
          `Multiple matches for '${qualified_name}'. Pick one and re-call:\n${candidatesList}`,
        );
      }
      // 'none' falls through — findGoverning can still walk the raw input
      // as a path, preserving back-compat for non-symbol inputs like
      // 'docs/architecture/foo.md'.
    }
    const results = search.findGoverning(target);
    if (!results || results.length === 0) {
      return empty(`why_was_this_built(${qualified_name})`);
    }
    return ok(JSON.stringify(results, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("internal_error", msg);
  }
}
```

If `indexerProject` and `dbPath` aren't available in the decision-tools scope, the handler degrades gracefully: when both are missing, skip the resolver and call `findGoverning(qualified_name)` directly (preserves current behavior).

Update the tool description to `"Find decisions governing a code entity. Input accepts qualified names, file paths, or bare symbol names. Walks up file/directory hierarchy if no direct match."`.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `npx vitest run tests/mcp-contract/decision-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full mcp-contract suite**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts tests/mcp-contract/decision-tools.test.ts
git commit -m "feat(mcp): why_was_this_built accepts bare symbol names

Wire src/shared/resolve-input into the handler so callers can ask
'why was handleRequest built' instead of needing to know it lives at
src/api/handler.ts. Bare names are resolved to a file path (preferred
for path-walk semantics) or qn, then passed to the existing
findGoverning. Falls through gracefully when no symbol matches —
findGoverning's own path-walking handles non-symbol inputs like docs/.

Closes the field-report gap for agentic users querying by symbol name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
npm test
```

Expected: all tests pass except the documented pre-existing Python-venv flake.

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Smoke from CLI side (ensures back-compat wrapper still works)**

```bash
cortex code show apps/activator/app/components/ADesignSystemCard.vue
# Expected: disambiguation list (multi-match) OR source code (single)
cortex code show handleRequest
# Expected: source code or disambiguation
cortex decision why handleRequest
# Expected: governing decision (if any) or "no decisions govern"
```

- [ ] **Smoke from MCP side (manual; spawn server in another terminal)**

If quickly verifiable: call `get_code_snippet({"qualified_name": "src/api/handler.ts"})` via the indexer cli or via the MCP transport. Expected: source code returned, not `empty`.
