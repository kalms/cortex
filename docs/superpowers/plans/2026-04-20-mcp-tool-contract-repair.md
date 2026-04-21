# MCP Tool Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every MCP tool a Zod response contract, a fixture-backed integration test, and a normalized qualified-name handling so the MCP surface can be verifiably correct instead of silently broken.

**Architecture:** Shared `response.ts` defines `SuccessResponse | NoResultsResponse | ErrorResponse` Zod schemas. Shared `qualified-name.ts` provides pure `normalize()` / `denormalize()` functions. A new `tests/mcp-contract/` suite indexes a committed fixture repo via the real `bin/codebase-memory-mcp` in vitest globalSetup, then invokes tools through an in-process MCP `Client`↔`Server` pair using `InMemoryTransport.createLinkedPair()`. Each tool refactors to use the response helpers; each tool gets ≥3 contract tests (happy/empty/error); qualified-name tools add a round-trip test.

**Tech Stack:** TypeScript, vitest, `@modelcontextprotocol/sdk@^1.12.0` (`InMemoryTransport`, `Client`, `McpServer`), Zod, better-sqlite3, `bin/codebase-memory-mcp` (upstream Go binary).

**Spec:** [docs/superpowers/specs/2026-04-20-mcp-tool-contract-repair-design.md](../specs/2026-04-20-mcp-tool-contract-repair-design.md)

---

## File Structure

**New files:**
- `src/mcp-server/response.ts` — Zod response schemas + `ok()` / `empty()` / `error()` constructors. One responsibility: the tool-response wire contract.
- `src/mcp-server/qualified-name.ts` — Pure `normalize()` / `denormalize()` functions. No state, no I/O.
- `tests/fixtures/sample-project/src/server.ts` — Fixture: two functions with a `CALLS` edge.
- `tests/fixtures/sample-project/src/router.ts` — Fixture: one class with a method, imports server.
- `tests/fixtures/sample-project/src/utils.js` — Fixture: one JS function (exercises JS parser path).
- `tests/fixtures/sample-project/docs/guide.md` — Fixture: `## Overview` heading (exercises `Section` label).
- `tests/mcp-contract/globalSetup.ts` — Vitest globalSetup: copy fixture, index it via binary, export paths.
- `tests/mcp-contract/harness.ts` — Instantiate `McpServer` + `Client` pair per test; factory for test suites.
- `tests/mcp-contract/qualified-name.test.ts` — Exhaustive table for normalizer.
- `tests/mcp-contract/response.test.ts` — Schema validation + helper round-trips.
- `tests/mcp-contract/code-tools.test.ts` — Contract tests for 10 code tools.
- `tests/mcp-contract/decision-tools.test.ts` — Contract tests for 7 decision tools.
- `tests/mcp-contract/promotion-tools.test.ts` — Contract tests for `promote_decision`.

**Modified files:**
- `src/mcp-server/tools/code-tools.ts` — Every handler switches to response helpers; `search_graph` / `get_code_snippet` normalize qualified names; `get_graph_schema` adds counts; `trace_path` adds `max_depth` + depth annotation; `search_code` distinguishes missing-tooling from empty.
- `src/mcp-server/tools/decision-tools.ts` — Every handler switches to response helpers; `why_was_this_built` normalizes qualified name input.
- `src/mcp-server/tools/promotion-tools.ts` — Handler switches to response helpers.
- `src/graph/cbm-queries.ts:82` — `tracePath` params accept optional `max_depth`, return tuples `{ node, depth }`.
- `vitest.config.ts` — Register `globalSetup` for the `mcp-contract` suite.

---

### Task 0: Branch & setup

Already on branch `refactor/api/mcp-tool-contract`. Spec committed. No action.

---

### Task 1: Fixture repo

**Files:**
- Create: `tests/fixtures/sample-project/src/server.ts`
- Create: `tests/fixtures/sample-project/src/router.ts`
- Create: `tests/fixtures/sample-project/src/utils.js`
- Create: `tests/fixtures/sample-project/docs/guide.md`

- [ ] **Step 1: Write `server.ts`**

Path: `tests/fixtures/sample-project/src/server.ts`

```ts
export function parseBody(raw: string): Record<string, unknown> {
  return JSON.parse(raw);
}

export function handleRequest(body: string): Record<string, unknown> {
  const parsed = parseBody(body);
  return { ok: true, data: parsed };
}
```

- [ ] **Step 2: Write `router.ts`**

Path: `tests/fixtures/sample-project/src/router.ts`

```ts
import { handleRequest } from "./server.js";

export class Router {
  route(path: string, body: string): Record<string, unknown> {
    if (path === "/ping") return { ok: true };
    return handleRequest(body);
  }
}
```

- [ ] **Step 3: Write `utils.js`**

Path: `tests/fixtures/sample-project/src/utils.js`

```js
export function formatLog(level, msg) {
  return `[${level}] ${msg}`;
}
```

- [ ] **Step 4: Write `guide.md`**

Path: `tests/fixtures/sample-project/docs/guide.md`

```markdown
# Sample Project

## Overview

This fixture repo exercises the CBM indexer with TS, JS, and Markdown.

## Usage

See `src/server.ts` for the handler.
```

- [ ] **Step 5: Verify binary indexes the fixture**

Run:
```bash
TMPDIR=$(mktemp -d)
cp -r tests/fixtures/sample-project "$TMPDIR/"
./bin/codebase-memory-mcp cli index_repository "{\"path\":\"$TMPDIR/sample-project\"}"
```

Expected: exit 0; stdout mentions nodes indexed. If the binary errors, stop and resolve before continuing.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/sample-project/
git commit -m "test(mcp-contract): committed fixture repo for contract suite"
```

---

### Task 2: Response contract module

**Files:**
- Create: `src/mcp-server/response.ts`
- Create: `tests/mcp-contract/response.test.ts`

- [ ] **Step 1: Write the failing tests**

Path: `tests/mcp-contract/response.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { ok, empty, error, SuccessResponse, NoResultsResponse, ErrorResponse, ResponseSchema } from "../../src/mcp-server/response.js";

describe("response helpers", () => {
  it("ok() produces a valid SuccessResponse", () => {
    const r = ok("hello");
    expect(SuccessResponse.safeParse(r).success).toBe(true);
    expect(r.content[0].text).toBe("hello");
    expect(r.isError).toBeUndefined();
  });

  it("empty() produces a valid NoResultsResponse with the stable prefix", () => {
    const r = empty("search_graph(name_pattern=foo)");
    expect(NoResultsResponse.safeParse(r).success).toBe(true);
    expect(r.content[0].text).toMatch(/^No results: /);
    expect(r.content[0].text).toContain("search_graph(name_pattern=foo)");
  });

  it("error() produces a valid ErrorResponse with reason slug", () => {
    const r = error("project_not_found", "no project registered at /tmp/x");
    expect(ErrorResponse.safeParse(r).success).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^ERROR reason=project_not_found: /);
  });

  it("ResponseSchema accepts all three shapes", () => {
    expect(ResponseSchema.safeParse(ok("x")).success).toBe(true);
    expect(ResponseSchema.safeParse(empty("q")).success).toBe(true);
    expect(ResponseSchema.safeParse(error("internal_error", "boom")).success).toBe(true);
  });

  it("ResponseSchema rejects malformed responses", () => {
    expect(ResponseSchema.safeParse({ content: "not-an-array" }).success).toBe(false);
    expect(ResponseSchema.safeParse({ content: [{ type: "image", text: "x" }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests (should fail: module not found)**

Run: `npm test -- response.test`
Expected: FAIL with "Cannot find module '../../src/mcp-server/response.js'".

- [ ] **Step 3: Write `response.ts`**

Path: `src/mcp-server/response.ts`

```ts
import { z } from "zod";

const TextContent = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const SuccessResponse = z.object({
  content: z.array(TextContent).min(1),
  isError: z.undefined().optional(),
});

export const NoResultsResponse = z.object({
  content: z.array(TextContent).length(1).refine(
    (arr) => arr[0].text.startsWith("No results: "),
    { message: "NoResultsResponse content must start with 'No results: '" }
  ),
  isError: z.undefined().optional(),
});

export const ErrorResponse = z.object({
  content: z.array(TextContent).length(1).refine(
    (arr) => /^ERROR reason=[a-z_]+: /.test(arr[0].text),
    { message: "ErrorResponse content must start with 'ERROR reason=<slug>: '" }
  ),
  isError: z.literal(true),
});

export const ResponseSchema = z.union([SuccessResponse, ErrorResponse, NoResultsResponse]);

export type ErrorReason =
  | "project_not_found"
  | "binary_failed"
  | "malformed_input"
  | "internal_error"
  | "fs_error";

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function empty(query: string) {
  return { content: [{ type: "text" as const, text: `No results: ${query}` }] };
}

export function error(reason: ErrorReason, detail: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `ERROR reason=${reason}: ${detail}` }],
  };
}
```

- [ ] **Step 4: Run the tests (should pass)**

Run: `npm test -- response.test`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/response.ts tests/mcp-contract/response.test.ts
git commit -m "feat(mcp): response contract module with Zod schemas + helpers"
```

---

### Task 3: Qualified-name normalizer

**Files:**
- Create: `src/mcp-server/qualified-name.ts`
- Create: `tests/mcp-contract/qualified-name.test.ts`

- [ ] **Step 1: Write the failing tests**

Path: `tests/mcp-contract/qualified-name.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalize, denormalize } from "../../src/mcp-server/qualified-name.js";

const P = "sample-project";

describe("normalize", () => {
  const cases: Array<[string, string, string]> = [
    // [description, input, expected output]
    ["colon form, simple", "src/server.ts::handleRequest", "sample-project.src.server.handleRequest"],
    ["colon form, member notation", "src/router.ts::Router.route", "sample-project.src.router.Router.route"],
    ["colon form, nested path", "src/a/b/c.ts::fn", "sample-project.src.a.b.c.fn"],
    ["colon form, .js extension", "src/utils.js::formatLog", "sample-project.src.utils.formatLog"],
    ["colon form, .tsx extension", "src/ui/App.tsx::App", "sample-project.src.ui.App.App"],
    ["dotted form, already normalized", "sample-project.src.server.handleRequest", "sample-project.src.server.handleRequest"],
    ["wildcard colon form", "src/server.ts::%", "sample-project.src.server.%"],
    ["wildcard dotted form", "sample-project.src.server.%", "sample-project.src.server.%"],
    ["bare wildcard", "%handleRequest%", "%handleRequest%"],
  ];

  it.each(cases)("%s: %s → %s", (_desc, input, expected) => {
    expect(normalize(input, P)).toBe(expected);
  });

  it("throws on empty input", () => {
    expect(() => normalize("", P)).toThrow(/empty/i);
  });

  it("throws on missing project for dotted form lookup", () => {
    expect(() => normalize("src/server.ts::fn", "")).toThrow(/project/i);
  });
});

describe("denormalize", () => {
  const cases: Array<[string, string, string, string]> = [
    ["simple function", "sample-project.src.server.handleRequest", "src/server.ts", "src/server.ts::handleRequest"],
    ["member notation", "sample-project.src.router.Router.route", "src/router.ts", "src/router.ts::Router.route"],
    ["nested path", "sample-project.src.a.b.c.fn", "src/a/b/c.ts", "src/a/b/c.ts::fn"],
    ["js file", "sample-project.src.utils.formatLog", "src/utils.js", "src/utils.js::formatLog"],
  ];

  it.each(cases)("%s: %s + %s → %s", (_desc, qn, fp, expected) => {
    expect(denormalize(qn, fp)).toBe(expected);
  });

  it("falls back to raw qn when file_path is empty", () => {
    expect(denormalize("sample-project.src.server.handleRequest", "")).toBe(
      "sample-project.src.server.handleRequest"
    );
  });
});
```

- [ ] **Step 2: Run the tests (should fail)**

Run: `npm test -- qualified-name.test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `qualified-name.ts`**

Path: `src/mcp-server/qualified-name.ts`

```ts
/**
 * Qualified-name normalization for MCP tool inputs/outputs.
 *
 * Two forms exist in the wild:
 * - Colon form (humans, docs, LSP convention): "src/file.ts::symbol"
 * - Dotted form (what the CBM binary stores):  "<project>.src.file.symbol"
 *
 * normalize()   accepts either and returns the dotted form for SQL LIKE.
 * denormalize() converts dotted form back to colon form using file_path.
 */

const KNOWN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function normalize(input: string, project: string): string {
  if (!input) throw new Error("normalize: input is empty");

  if (input.includes("::")) {
    if (!project) throw new Error("normalize: project is required for colon-form input");
    const [filePath, symbol] = input.split("::", 2);
    let fileNoExt = filePath;
    for (const ext of KNOWN_EXTENSIONS) {
      if (fileNoExt.endsWith(ext)) {
        fileNoExt = fileNoExt.slice(0, -ext.length);
        break;
      }
    }
    const fileDotted = fileNoExt.split("/").join(".");
    return `${project}.${fileDotted}.${symbol}`;
  }

  // Dotted form or raw wildcard — return as-is.
  return input;
}

export function denormalize(stored: string, filePath: string): string {
  if (!filePath) return stored;
  // Strip extension
  let fileNoExt = filePath;
  for (const ext of KNOWN_EXTENSIONS) {
    if (fileNoExt.endsWith(ext)) {
      fileNoExt = fileNoExt.slice(0, -ext.length);
      break;
    }
  }
  const fileDotted = fileNoExt.split("/").join(".");
  const idx = stored.indexOf(`.${fileDotted}.`);
  if (idx === -1) return stored;
  const symbol = stored.slice(idx + fileDotted.length + 2);
  return `${filePath}::${symbol}`;
}
```

- [ ] **Step 4: Run the tests (should pass)**

Run: `npm test -- qualified-name.test`
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/qualified-name.ts tests/mcp-contract/qualified-name.test.ts
git commit -m "feat(mcp): qualified-name normalize/denormalize pure module"
```

---

### Task 4: Test harness — globalSetup + in-process MCP pair

**Files:**
- Create: `tests/mcp-contract/globalSetup.ts`
- Create: `tests/mcp-contract/harness.ts`
- Create: `tests/mcp-contract/smoke.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write `globalSetup.ts`**

Path: `tests/mcp-contract/globalSetup.ts`

```ts
import { mkdtempSync, cpSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "codebase-memory-mcp");

export default async function setup() {
  if (!existsSync(BINARY)) {
    // Allow the suite to run in CI without the binary; subprocess-dependent tests will skip.
    writeFileSync(join(tmpdir(), "cortex-mcp-contract-skip"), "no binary");
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "cortex-mcp-contract-"));
  const fixtureCopy = join(workDir, "sample-project");
  cpSync(FIXTURE_SRC, fixtureCopy, { recursive: true });

  execFileSync(BINARY, ["cli", "index_repository", JSON.stringify({ path: fixtureCopy })], {
    stdio: "inherit",
    timeout: 60_000,
  });

  // CBM writes to a known location per project; derive the expected DB path from the binary's convention.
  // Convention: project name = basename(fixtureCopy); DB at ~/.cache/codebase-memory-mcp/<project>/graph.db
  // We probe for it with a list_projects call and find a project whose root_path matches fixtureCopy.
  const projectsJson = execFileSync(BINARY, ["cli", "list_projects", "{}"], { timeout: 10_000 }).toString();
  const projects = JSON.parse(projectsJson);
  const project = projects.find((p: { root_path: string }) => p.root_path === fixtureCopy);
  if (!project) {
    throw new Error(`globalSetup: fixture project not found after indexing. Projects: ${projectsJson}`);
  }

  process.env.CORTEX_CONTRACT_FIXTURE_DIR = fixtureCopy;
  process.env.CORTEX_CONTRACT_PROJECT = project.name;
  process.env.CORTEX_CONTRACT_CBM_DB = project.db_path ?? "";
}
```

**Note:** The binary's `list_projects` output shape may differ from assumed — verify with a manual run first (Step 2). Adjust field names if binary returns `root` or `database_path` rather than the assumed keys.

- [ ] **Step 2: Verify binary output shape**

Run manually:
```bash
./bin/codebase-memory-mcp cli list_projects '{}'
```

Expected: JSON array. Inspect fields; if `db_path` isn't present or named differently, update `globalSetup.ts` to use the correct field. Commit the correction.

- [ ] **Step 3: Write `harness.ts`**

Path: `tests/mcp-contract/harness.ts`

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphStore } from "../../src/graph/store.js";
import { registerCodeTools } from "../../src/mcp-server/tools/code-tools.js";
import { registerDecisionTools } from "../../src/mcp-server/tools/decision-tools.js";
import { registerPromotionTools } from "../../src/mcp-server/tools/promotion-tools.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface HarnessContext {
  client: Client;
  store: GraphStore;
  project: string;
  fixtureDir: string;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<HarnessContext> {
  const fixtureDir = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
  const project = process.env.CORTEX_CONTRACT_PROJECT;
  const cbmDbPath = process.env.CORTEX_CONTRACT_CBM_DB;
  if (!fixtureDir || !project || !cbmDbPath) {
    throw new Error("Harness: globalSetup did not run (binary missing or fixture index failed).");
  }

  const cortexDbDir = mkdtempSync(join(tmpdir(), "cortex-harness-"));
  const cortexDbPath = join(cortexDbDir, "graph.db");

  const store = new GraphStore(cortexDbPath);
  store.attachCbm(cbmDbPath);

  const service = new DecisionService(store);
  const search = new DecisionSearch(store);
  const promotion = new DecisionPromotion(store);

  const server = new McpServer({ name: "cortex-test", version: "0.0.0" });
  registerCodeTools(server, store, project);
  registerDecisionTools(server, service, search);
  registerPromotionTools(server, promotion);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "cortex-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    store,
    project,
    fixtureDir,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

export async function callTool(
  h: HarnessContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return (await h.client.callTool({ name, arguments: args })) as any;
}
```

**Note:** `GraphStore` may not expose `attachCbm(path)` — verify the existing API on `src/graph/store.ts` and adapt the constructor call. Use whatever method the existing `src/index.ts` uses when wiring the real server.

- [ ] **Step 4: Verify GraphStore CBM-attach API**

Read: `src/graph/store.ts` — find the constructor and the method(s) used to attach the CBM database. Read: `src/index.ts` — find how the real server wires `cbmProject` into `registerCodeTools`. Update `harness.ts` accordingly before moving on.

- [ ] **Step 5: Write the smoke test**

Path: `tests/mcp-contract/smoke.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, HarnessContext } from "./harness.js";

describe("mcp-contract smoke", () => {
  let h: HarnessContext;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("list_projects returns the fixture project", async () => {
    const res = await callTool(h, "list_projects", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("sample-project");
  });

  it("get_graph_schema returns labels and edge types", async () => {
    const res = await callTool(h, "get_graph_schema", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Function/);
  });
});
```

- [ ] **Step 6: Modify `vitest.config.ts` to register globalSetup**

Open `vitest.config.ts`. Inside the config object, add:

```ts
globalSetup: ["./tests/mcp-contract/globalSetup.ts"],
```

If a `globalSetup` field already exists, append the new path to the array.

- [ ] **Step 7: Run the smoke test**

Run: `npm test -- mcp-contract/smoke`
Expected: 2 passed. If binary is missing, the tests will throw from `createHarness` — that's fine, fix by installing the binary locally.

- [ ] **Step 8: Commit**

```bash
git add tests/mcp-contract/globalSetup.ts tests/mcp-contract/harness.ts tests/mcp-contract/smoke.test.ts vitest.config.ts
git commit -m "test(mcp-contract): in-process MCP harness + globalSetup"
```

---

### Task 5: Refactor code-tools.ts to use response helpers

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts`

No new tests here yet — this is a refactor; existing smoke test covers regressions. Per-tool contract tests land in subsequent tasks.

- [ ] **Step 1: Add imports**

Modify `src/mcp-server/tools/code-tools.ts` top of file. Add:

```ts
import { ok, empty, error as errorResponse } from "../response.js";
import { normalize, denormalize } from "../qualified-name.js";
```

- [ ] **Step 2: Replace every "no attach" branch**

In `code-tools.ts`, replace every occurrence of:
```ts
return { content: [{ type: "text" as const, text: "Repository not indexed. Run index_repository first." }] };
```
with:
```ts
return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
```

And replace:
```ts
return { content: [{ type: "text" as const, text: "No CBM database attached." }] };
```
with:
```ts
return errorResponse("internal_error", "No CBM database attached.");
```

- [ ] **Step 3: Update `formatNodes` to emit colon form**

Replace the existing `formatNodes` with:

```ts
function formatNodes(nodes: CbmNode[]): string {
  if (nodes.length === 0) return "";
  return nodes
    .map((n) => `${n.label} ${denormalize(n.qualified_name, n.file_path)} (${n.file_path}:${n.start_line}-${n.end_line})`)
    .join("\n");
}
```

Callers wrap the result: `const text = formatNodes(results); return text ? ok(text) : empty(<query-desc>);`

- [ ] **Step 4: Refactor `search_graph` handler**

Replace the existing `search_graph` handler body with:

```ts
async (params) => {
  if (!store.isCbmAttached() || !cbmProject) {
    return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
  }
  const qn = params.qn_pattern ? normalize(params.qn_pattern, cbmProject) : undefined;
  const results = searchGraph(store, cbmProject, { ...params, qn_pattern: qn });
  const text = formatNodes(results);
  const queryDesc = `search_graph(${JSON.stringify(params)})`;
  return text ? ok(text) : empty(queryDesc);
}
```

- [ ] **Step 5: Refactor `get_code_snippet` handler**

Replace the existing `get_code_snippet` handler body with:

```ts
async ({ qualified_name }) => {
  if (!store.isCbmAttached() || !cbmProject) {
    return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
  }
  const qn = normalize(qualified_name, cbmProject);
  const nodes = searchGraph(store, cbmProject, { qn_pattern: qn });
  if (nodes.length === 0) return empty(`get_code_snippet(${qualified_name})`);
  const node = nodes[0];
  try {
    const content = await readFile(node.file_path, "utf-8");
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

- [ ] **Step 6: Refactor `trace_path` handler with `max_depth` + depth annotation**

Change the tool schema:

```ts
{
  function_name: z.string(),
  mode: z.enum(["calls", "callers"]).describe("Trace mode: calls (outbound) or callers (inbound)"),
  max_depth: z.number().int().min(1).max(10).optional().default(3),
}
```

Replace the body:

```ts
async (params) => {
  if (!store.isCbmAttached() || !cbmProject) {
    return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
  }
  const results = tracePath(store, cbmProject, params);
  if (results.length === 0) return empty(`trace_path(${JSON.stringify(params)})`);
  const lines = results.map((r) =>
    `[d=${r.depth}] ${r.node.label} ${denormalize(r.node.qualified_name, r.node.file_path)} (${r.node.file_path}:${r.node.start_line}-${r.node.end_line})`
  );
  return ok(lines.join("\n"));
}
```

This requires `tracePath` to return `{ node: CbmNode; depth: number }[]` — update that in Task 5a below.

- [ ] **Step 6a: Update `tracePath` in `cbm-queries.ts`**

Modify `src/graph/cbm-queries.ts:78-118`. Change the SQL to return depth and the return type to `Array<{ node: CbmNode; depth: number }>`:

```ts
export function tracePath(
  store: GraphStore,
  project: string,
  params: { function_name: string; mode: string; max_depth?: number }
): Array<{ node: CbmNode; depth: number }> {
  const startNodes = store.queryRaw<CbmNode>(
    "SELECT * FROM cbm.nodes WHERE project = ? AND name = ? LIMIT 1",
    [project, params.function_name]
  );
  if (startNodes.length === 0) return [];

  const startId = startNodes[0].id;
  const direction = params.mode === "callers" ? "inbound" : "outbound";
  const maxDepth = params.max_depth ?? 3;

  const recursive =
    direction === "outbound"
      ? "SELECT e.target_id, t.depth + 1 FROM cbm.edges e JOIN trace t ON e.source_id = t.node_id"
      : "SELECT e.source_id, t.depth + 1 FROM cbm.edges e JOIN trace t ON e.target_id = t.node_id";

  const sql = `WITH RECURSIVE trace(node_id, depth) AS (
    SELECT ?, 0
    UNION ALL
    ${recursive}
    WHERE e.project = ? AND e.type IN ('CALLS', 'IMPORTS') AND t.depth < ?
  )
  SELECT n.*, MIN(t.depth) AS depth FROM cbm.nodes n
  JOIN trace t ON n.id = t.node_id
  WHERE n.id != ?
  GROUP BY n.id
  ORDER BY depth, n.name`;

  const rows = store.queryRaw<CbmNode & { depth: number }>(sql, [startId, project, maxDepth, startId]);
  return rows.map(({ depth, ...node }) => ({ node, depth }));
}
```

Update the existing `tests/graph/cbm-attach.test.ts` assertions if they inspect the shape of `tracePath` results (previously `CbmNode[]`, now `{node, depth}[]`). Run `npm test -- cbm-attach` after; fix any breakage.

- [ ] **Step 7: Refactor `get_graph_schema` handler with counts**

Change the body:

```ts
async () => {
  if (!store.isCbmAttached() || !cbmProject) {
    return errorResponse("project_not_found", "Repository not indexed. Run index_repository first.");
  }
  const schema = getGraphSchema(store, cbmProject);
  const labelLines = schema.labels.map((l) => `  ${l.name}: ${l.count}`).join("\n");
  const edgeLines = schema.edgeTypes.map((e) => `  ${e.name}: ${e.count}`).join("\n");
  return ok(`Labels:\n${labelLines}\nEdge types:\n${edgeLines}`);
}
```

- [ ] **Step 7a: Update `getGraphSchema` in `cbm-queries.ts`**

Modify `src/graph/cbm-queries.ts:57-76`. Change to return counts:

```ts
export function getGraphSchema(
  store: GraphStore,
  project: string
): { labels: Array<{ name: string; count: number }>; edgeTypes: Array<{ name: string; count: number }> } {
  const labels = store.queryRaw<{ name: string; count: number }>(
    "SELECT label AS name, COUNT(*) AS count FROM cbm.nodes WHERE project = ? GROUP BY label ORDER BY name",
    [project]
  );
  const edgeTypes = store.queryRaw<{ name: string; count: number }>(
    "SELECT type AS name, COUNT(*) AS count FROM cbm.edges WHERE project = ? GROUP BY type ORDER BY name",
    [project]
  );
  return { labels, edgeTypes };
}
```

Update `tests/graph/cbm-attach.test.ts` assertions on `getGraphSchema` shape if any exist.

- [ ] **Step 8: Refactor `search_code` handler**

Rewrite the body to distinguish missing-tooling errors:

```ts
async ({ pattern }) => {
  let grepOutput = "";
  let triedRg = false;
  let triedGrep = false;
  try {
    triedRg = true;
    const { stdout } = await execFileAsync("rg", [
      "--no-heading", "--line-number", "--color=never", pattern, ".",
    ], { timeout: 10_000 });
    grepOutput = stdout;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      try {
        triedGrep = true;
        const { stdout } = await execFileAsync("grep", ["-rn", pattern, "."], { timeout: 10_000 });
        grepOutput = stdout;
      } catch (err2: any) {
        if (err2.code === "ENOENT") {
          return errorResponse("internal_error", "Neither rg nor grep available on PATH.");
        }
        // grep exit 1 = no matches
        if (!err2.stdout) return empty(`search_code(${pattern})`);
        grepOutput = err2.stdout;
      }
    } else if (err.stdout) {
      grepOutput = err.stdout;
    } else if (err.code === 1) {
      // rg exit 1 = no matches
      return empty(`search_code(${pattern})`);
    } else {
      return errorResponse("internal_error", err.message ?? String(err));
    }
  }

  if (!grepOutput.trim()) return empty(`search_code(${pattern})`);

  if (!store.isCbmAttached() || !cbmProject) {
    return ok(grepOutput);
  }

  const lines = grepOutput.trim().split("\n").slice(0, 50);
  const enriched = lines.map((line) => {
    const match = line.match(/^\.\/(.+?):(\d+):/);
    if (!match) return line;
    const [, filePath, lineNum] = match;
    const lineNumber = parseInt(lineNum, 10);
    const enclosing = store.queryRaw<CbmNode>(
      `SELECT * FROM cbm.nodes
       WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
       ORDER BY (end_line - start_line) ASC LIMIT 1`,
      [cbmProject, filePath, lineNumber, lineNumber]
    );
    if (enclosing.length > 0) {
      return `${line}  // in ${enclosing[0].label} ${denormalize(enclosing[0].qualified_name, enclosing[0].file_path)}`;
    }
    return line;
  });

  return ok(enriched.join("\n"));
}
```

- [ ] **Step 9: Refactor `list_projects` handler**

```ts
async () => {
  if (!store.isCbmAttached()) return errorResponse("internal_error", "No CBM database attached.");
  const projects = listProjects(store);
  if (projects.length === 0) return empty("list_projects()");
  const text = projects.map((p) => `${p.name} — ${p.root_path} (indexed: ${p.indexed_at})`).join("\n");
  return ok(text);
}
```

- [ ] **Step 10: Refactor `index_status` handler**

```ts
async ({ path }) => {
  if (!store.isCbmAttached()) return errorResponse("internal_error", "No CBM database attached.");
  const cwd = path || process.cwd();
  const status = indexStatus(store, cwd);
  if (!status) return empty(`index_status(${cwd})`);
  return ok(`Indexed: ${status.name} at ${status.root_path} (last: ${status.indexed_at})`);
}
```

- [ ] **Step 11: Refactor subprocess tools `index_repository`, `detect_changes`, `delete_project`**

The `callCbm` helper currently returns a JSON blob on failure. Replace with structured error:

```ts
async function callCbm(tool: string, args: Record<string, unknown>) {
  try {
    const { stdout } = await execFileAsync(CBM_BINARY, ["cli", tool, JSON.stringify(args)], { timeout: 120_000 });
    return ok(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("binary_failed", `codebase-memory-mcp ${tool} failed: ${msg}`);
  }
}
```

Then update the three handlers to return `callCbm(...)` directly. For `detect_changes`, default `path` to `process.cwd()`:

```ts
async ({ path }) => callCbm("detect_changes", { path: path || process.cwd() })
```

- [ ] **Step 12: Run all existing tests**

Run: `npm test`
Expected: existing tests pass (any that broke from `tracePath` / `getGraphSchema` shape changes were updated in 6a / 7a); smoke test passes.

- [ ] **Step 13: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts src/graph/cbm-queries.ts tests/graph/
git commit -m "refactor(mcp): code-tools use response helpers + qualified-name normalization"
```

---

### Task 6: Contract tests for code-tools

**Files:**
- Create: `tests/mcp-contract/code-tools.test.ts`

- [ ] **Step 1: Write the full contract test file**

Path: `tests/mcp-contract/code-tools.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("code-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  describe("search_graph", () => {
    it("happy: name_pattern matches fixture function", async () => {
      const res = await callTool(h, "search_graph", { name_pattern: "handleRequest" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).toContain("src/server.ts::handleRequest");
    });

    it("empty: unknown name returns No results", async () => {
      const res = await callTool(h, "search_graph", { name_pattern: "zzzNonexistent" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("happy: colon-form qn_pattern normalizes correctly", async () => {
      const res = await callTool(h, "search_graph", { qn_pattern: "src/server.ts::handleRequest" });
      expect(res.content[0].text).toContain("src/server.ts::handleRequest");
    });

    it("happy: label filter", async () => {
      const res = await callTool(h, "search_graph", { label: "Class" });
      expect(res.content[0].text).toContain("Router");
    });
  });

  describe("get_code_snippet", () => {
    it("happy: colon form returns snippet", async () => {
      const res = await callTool(h, "get_code_snippet", { qualified_name: "src/server.ts::handleRequest" });
      expect(res.content[0].text).toContain("export function handleRequest");
    });

    it("round-trip: search_graph output feeds get_code_snippet", async () => {
      const search = await callTool(h, "search_graph", { name_pattern: "handleRequest" });
      const firstLine = search.content[0].text.split("\n")[0];
      const qnMatch = firstLine.match(/(\S+\.ts::\S+)/);
      expect(qnMatch).not.toBeNull();
      const res = await callTool(h, "get_code_snippet", { qualified_name: qnMatch![1] });
      expect(res.content[0].text).toContain("export function handleRequest");
    });

    it("empty: unknown symbol", async () => {
      const res = await callTool(h, "get_code_snippet", { qualified_name: "src/server.ts::zzz" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });
  });

  describe("trace_path", () => {
    it("happy: calls mode returns reachable nodes with depth annotation", async () => {
      const res = await callTool(h, "trace_path", { function_name: "handleRequest", mode: "calls" });
      expect(res.content[0].text).toMatch(/\[d=\d+\]/);
      expect(res.content[0].text).toContain("parseBody");
    });

    it("happy: max_depth limits results", async () => {
      const res = await callTool(h, "trace_path", { function_name: "handleRequest", mode: "calls", max_depth: 1 });
      const text = res.content[0].text;
      const depths = Array.from(text.matchAll(/\[d=(\d+)\]/g)).map((m) => parseInt(m[1], 10));
      expect(Math.max(...depths)).toBeLessThanOrEqual(1);
    });

    it("empty: unknown function", async () => {
      const res = await callTool(h, "trace_path", { function_name: "zzzNonexistent", mode: "calls" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });
  });

  describe("get_graph_schema", () => {
    it("happy: returns labels and counts", async () => {
      const res = await callTool(h, "get_graph_schema", {});
      expect(res.content[0].text).toMatch(/Function: \d+/);
      expect(res.content[0].text).toMatch(/Edge types:/);
    });
  });

  describe("search_code", () => {
    it("happy: pattern found with enclosing function", async () => {
      const res = await callTool(h, "search_code", { pattern: "handleRequest" });
      expect(res.content[0].text).toContain("handleRequest");
    });

    it("empty: pattern not found", async () => {
      const res = await callTool(h, "search_code", { pattern: "zzzNonexistentPatternString12345" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });
  });

  describe("list_projects", () => {
    it("happy: includes the fixture project", async () => {
      const res = await callTool(h, "list_projects", {});
      expect(res.content[0].text).toContain(h.project);
    });
  });

  describe("index_status", () => {
    it("happy: returns indexed status for fixture dir", async () => {
      const res = await callTool(h, "index_status", { path: h.fixtureDir });
      expect(res.content[0].text).toMatch(/^Indexed: /);
    });

    it("empty: unknown path returns No results", async () => {
      const res = await callTool(h, "index_status", { path: "/nonexistent/path" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });
  });

  describe("detect_changes", () => {
    it("happy: succeeds with explicit fixture path", async () => {
      const res = await callTool(h, "detect_changes", { path: h.fixtureDir });
      // Binary returns JSON or status; any non-error response is acceptable here.
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).not.toMatch(/^ERROR /);
    });

    it("default: uses cwd when path omitted (no error shape mismatch)", async () => {
      const res = await callTool(h, "detect_changes", {});
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      // Either succeeds (returns data) or fails with structured ErrorResponse — never bare prose.
    });
  });

  describe("index_repository", () => {
    it("happy: re-indexes fixture without erroring", async () => {
      const res = await callTool(h, "index_repository", { path: h.fixtureDir });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).not.toMatch(/^ERROR /);
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- mcp-contract/code-tools`
Expected: all tests pass. If any fail, the failure is a contract bug — fix the tool in `code-tools.ts`, do NOT weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-contract/code-tools.test.ts
git commit -m "test(mcp-contract): code-tools contract tests (happy/empty/error + round-trip)"
```

---

### Task 7: Refactor decision-tools.ts

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`

- [ ] **Step 1: Add imports and normalize helper**

At the top of `decision-tools.ts`, add:

```ts
import { ok, empty, error as errorResponse } from "../response.js";
import { normalize } from "../qualified-name.js";
```

- [ ] **Step 2: Rewrite every handler's error branch**

For each of the 7 tools, replace:

```ts
catch (e) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
}
```

with (choosing an appropriate reason slug per tool):

```ts
catch (e) {
  return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
}
```

For `get_decision`, `update_decision`, `delete_decision`, `link_decision` — if the error message indicates "not found," surface as `malformed_input` or check for a distinct "not found" error from the service and return `empty(...)` instead. Concrete pattern:

```ts
catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) return empty(`get_decision(${id})`);
  return errorResponse("internal_error", msg);
}
```

- [ ] **Step 3: Rewrite success branches to use `ok()`**

Replace every:
```ts
return { content: [{ type: "text" as const, text: JSON.stringify(decision, null, 2) }] };
```
with:
```ts
return ok(JSON.stringify(decision, null, 2));
```

- [ ] **Step 4: Normalize qualified_name in `why_was_this_built`**

Within the `why_was_this_built` handler, before calling the service:

```ts
async ({ qualified_name }) => {
  try {
    // Accept colon form or dotted form; service expects the stored dotted form.
    // Pass through normalize() if project is known; else pass raw (service has its own resolution).
    const resolved = qualified_name.includes("::")
      ? qualified_name  // colon form — service walks file/dir hierarchy, handles raw path
      : qualified_name;
    const results = search.whyWasThisBuilt(resolved);
    if (results.length === 0) return empty(`why_was_this_built(${qualified_name})`);
    return ok(JSON.stringify(results, null, 2));
  } catch (e) {
    return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
  }
}
```

**Note:** The service's `whyWasThisBuilt(qn)` already walks file/dir hierarchy for GOVERNS edges. It expects whatever format decisions were linked with. Verify by reading `src/decisions/search.ts` — if it assumes colon form specifically, no normalization needed. If it assumes dotted, normalize before passing.

- [ ] **Step 4a: Verify `DecisionSearch.whyWasThisBuilt` expectations**

Read: `src/decisions/search.ts`. Check the implementation of `whyWasThisBuilt`. Adjust Step 4 to match — if it expects colon form or raw path, leave as-is; if it expects dotted, insert `normalize(qualified_name, cbmProject)` (requires threading `cbmProject` into `registerDecisionTools` — if not currently plumbed, extend the function signature).

- [ ] **Step 5: Run existing decision tests**

Run: `npm test -- tests/decisions`
Expected: pre-existing decision tests still pass (response-shape changes don't affect service layer).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts
git commit -m "refactor(mcp): decision-tools use response helpers + normalize why_was_this_built input"
```

---

### Task 8: Contract tests for decision-tools

**Files:**
- Create: `tests/mcp-contract/decision-tools.test.ts`

- [ ] **Step 1: Write the test file**

Path: `tests/mcp-contract/decision-tools.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("decision-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  describe("lifecycle: create → get → update → link → search → delete", () => {
    let decisionId: string;

    it("create_decision: returns JSON with id", async () => {
      const res = await callTool(h, "create_decision", {
        title: "Test decision",
        description: "for contract test",
        rationale: "verifying lifecycle",
        alternatives: [{ name: "alt1", reason_rejected: "slower" }],
      });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.id).toMatch(/^[0-9A-Z]{26}$/); // ULID
      decisionId = parsed.id;
    });

    it("get_decision: returns created decision", async () => {
      const res = await callTool(h, "get_decision", { id: decisionId });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.title ?? parsed.decision?.title).toBe("Test decision");
    });

    it("update_decision: mutates title", async () => {
      const res = await callTool(h, "update_decision", { id: decisionId, title: "Updated title" });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.title).toBe("Updated title");
    });

    it("link_decision: attaches a GOVERNS edge to a fixture file", async () => {
      const res = await callTool(h, "link_decision", {
        decision_id: decisionId,
        target: "src/server.ts",
        relation: "GOVERNS",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("linked");
    });

    it("search_decisions: finds the decision by query", async () => {
      const res = await callTool(h, "search_decisions", { query: "Updated title" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(decisionId);
    });

    it("delete_decision: removes the decision", async () => {
      const res = await callTool(h, "delete_decision", { id: decisionId });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(decisionId);
    });

    it("get_decision after delete: returns empty or error", async () => {
      const res = await callTool(h, "get_decision", { id: decisionId });
      // Either empty or error is acceptable; bare prose with "error" JSON is not.
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("error paths", () => {
    it("get_decision: malformed id returns ErrorResponse or empty (structured)", async () => {
      const res = await callTool(h, "get_decision", { id: "not-a-ulid" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      if (res.isError) {
        expect(res.content[0].text).toMatch(/^ERROR reason=/);
      } else {
        expect(res.content[0].text).toMatch(/^No results: /);
      }
    });

    it("update_decision: unknown id returns structured error or empty", async () => {
      const res = await callTool(h, "update_decision", { id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX", title: "x" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });

    it("search_decisions: query with no matches returns empty", async () => {
      const res = await callTool(h, "search_decisions", { query: "zzzNonexistentQuery999" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      // Could be empty-array JSON in content or NoResultsResponse — document which.
    });
  });

  describe("why_was_this_built", () => {
    it("empty: path with no governing decision", async () => {
      const res = await callTool(h, "why_was_this_built", { qualified_name: "src/utils.js::formatLog" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });

    it("happy: finds decision for linked file after create+link", async () => {
      const create = await callTool(h, "create_decision", {
        title: "Server pattern",
        description: "uses parseBody",
        rationale: "separation",
      });
      const id = JSON.parse(create.content[0].text).id;
      await callTool(h, "link_decision", { decision_id: id, target: "src/server.ts", relation: "GOVERNS" });

      const res = await callTool(h, "why_was_this_built", { qualified_name: "src/server.ts::handleRequest" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(id);

      await callTool(h, "delete_decision", { id });
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- mcp-contract/decision-tools`
Expected: all pass. If the last `why_was_this_built` test fails because the service doesn't walk from file → enclosing symbol, the test documents expected behavior — open a follow-up issue and mark the test `.skip` with a TODO comment pointing to the issue. Do NOT weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-contract/decision-tools.test.ts
git commit -m "test(mcp-contract): decision-tools lifecycle + error paths + why_was_this_built"
```

---

### Task 9: Refactor promotion-tools.ts + contract test

**Files:**
- Modify: `src/mcp-server/tools/promotion-tools.ts`
- Create: `tests/mcp-contract/promotion-tools.test.ts`

- [ ] **Step 1: Refactor handler**

Replace the `promote_decision` handler body:

```ts
async ({ id, tier }) => {
  try {
    const decision = promotion.promote(id, tier);
    return ok(JSON.stringify(decision, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return empty(`promote_decision(${id})`);
    return errorResponse("internal_error", msg);
  }
}
```

Add the imports at the top:

```ts
import { ok, empty, error as errorResponse } from "../response.js";
```

- [ ] **Step 2: Write the contract test**

Path: `tests/mcp-contract/promotion-tools.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("promotion-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("promote_decision: happy path promotes an existing decision", async () => {
    const create = await callTool(h, "create_decision", {
      title: "Promotion test",
      description: "for promotion contract",
      rationale: "testing",
    });
    const id = JSON.parse(create.content[0].text).id;

    const res = await callTool(h, "promote_decision", { id, tier: "team" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();

    await callTool(h, "delete_decision", { id });
  });

  it("promote_decision: unknown id returns empty or structured error", async () => {
    const res = await callTool(h, "promote_decision", { id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX", tier: "team" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- mcp-contract/promotion-tools`
Expected: 2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools/promotion-tools.ts tests/mcp-contract/promotion-tools.test.ts
git commit -m "refactor+test(mcp): promotion-tools use response helpers + contract test"
```

---

### Task 10: Land decision record for qualified-name normalization

Use Cortex's own `create_decision` MCP tool (dogfooding) to record the C1 choice from brainstorm.

- [ ] **Step 1: Confirm cortex MCP tools are available**

In the current Claude session, verify `mcp__cortex__create_decision` is callable. If not, spawn a fresh Claude session inside this repo to run the call.

- [ ] **Step 2: Create the decision**

Call:
```
mcp__cortex__create_decision({
  title: "MCP qualified-name normalization",
  description: "Tool inputs accept colon form (src/file.ts::sym) or dotted form. Outputs always emit colon form. Internal SQL uses the dotted stored form.",
  rationale: "CBM binary stores dotted form; docs, humans, and prior Claude sessions produce colon form. Normalizer at the tool boundary reconciles both without breaking either. Dogfoods Cortex's own decision-capture.",
  alternatives: [
    { name: "Dotted form only everywhere", reason_rejected: "Forces every downstream consumer (skills, prompts, humans) to learn the DB shape; breaks CLAUDE.md and existing docs." },
    { name: "Separate resolve_symbol tool", reason_rejected: "Adds a tool call to every lookup; doubles the round-trip cost of code exploration." }
  ]
})
```

Capture the returned `id`.

- [ ] **Step 3: Link the decision to the normalizer module**

```
mcp__cortex__link_decision({
  decision_id: "<id-from-step-2>",
  target: "src/mcp-server/qualified-name.ts",
  relation: "GOVERNS"
})
```

- [ ] **Step 4: Verify via why_was_this_built**

```
mcp__cortex__why_was_this_built({
  qualified_name: "src/mcp-server/qualified-name.ts::normalize"
})
```

Expected: result includes the newly created decision id. If not, check whether the link walk-up logic handles file→symbol properly; the test in Task 8 covers this.

- [ ] **Step 5: No commit needed** — decisions are stored in `.cortex/graph.db`, which is gitignored. Note the decision id in the next commit message as provenance:

```bash
git commit --allow-empty -m "docs(mcp): decision record <id> — qualified-name normalization"
```

---

### Task 11: Final smoke — re-index cortex and verify tools see new symbols

- [ ] **Step 1: Re-index the cortex repo itself**

Using the Cortex MCP tool (not the binary directly):
```
mcp__cortex__index_repository({ path: "/Users/rka/Development/cortex" })
```

Expected: success. Binary writes to `.cortex/graph.db`.

- [ ] **Step 2: Verify `search_graph` sees post-2026-04-14 symbols**

```
mcp__cortex__search_graph({ name_pattern: "forceGovernance" })
```

Expected: non-empty result pointing to `src/viewer/shared/layout.js` (or wherever it lives). This is the true smoke test — if it passes, the broken flow that motivated this whole project is fixed.

- [ ] **Step 3: Verify `detect_changes` returns structured output**

```
mcp__cortex__detect_changes({})
```

Expected: **either** a successful response listing changed symbols, **or** a structured `ErrorResponse` with `reason=binary_failed` (if the binary itself has the bug). The failure mode we rejected is the bare `"project not found"` prose.

- [ ] **Step 4: Verify `get_code_snippet` round-trips via colon form**

```
mcp__cortex__get_code_snippet({ qualified_name: "src/viewer/shared/layout.js::forceGovernance" })
```

Expected: the actual source snippet.

- [ ] **Step 5: Commit plan-completion marker**

```bash
git commit --allow-empty -m "chore(mcp): contract repair complete — full re-index smoke passing"
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass. Note total runtime — `mcp-contract/` suite should finish under 15s.

---

## Acceptance checklist (repeats spec success criteria)

- [ ] Every tool in `src/mcp-server/tools/*` has a Zod `ResponseSchema` and ≥ 3 contract tests (happy/empty/error).
- [ ] Round-trip test for qualified-name tools present and passing.
- [ ] `detect_changes` returns structured response (never bare `"project not found"`).
- [ ] `get_code_snippet("src/mcp-server/tools/code-tools.ts::registerCodeTools")` returns the real snippet.
- [ ] `npm test -- mcp-contract/` runs green in < 15s.
- [ ] Decision record exists for qualified-name normalization, linked to `src/mcp-server/qualified-name.ts`.
- [ ] `mcp__cortex__search_graph({name_pattern:"forceGovernance"})` returns a result.
