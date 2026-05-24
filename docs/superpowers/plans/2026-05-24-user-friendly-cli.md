# User-Friendly Cortex CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `cortex` — a polished command-line front door wrapping the existing TS MCP tool handlers and the native `cortex-indexer` binary behind a namespaced verb-object surface, with smart input resolution and a context-aware tour.

**Architecture:** New `src/cli/` package, single `bin/cortex` launcher (dev → `tsx`, built → `node dist/cli/main.js`). Commands import existing low-level helpers (`searchGraph`, `tracePath`, `DecisionService`) directly — no MCP transport, no JSON-RPC. Indexer-only tools (`index_repository`, `query_graph`, `search_code`) shell out to `bin/cortex-indexer cli`. Five user-facing namespaces: `code`, `decision`, `graph`, `index`, `eval`.

**Tech Stack:** TypeScript, vitest, no CLI framework (custom ~50-line router). Imports `src/graph/code-queries.ts`, `src/decisions/service.ts`, `src/mcp-server/qualified-name.ts`.

**Spec:** [docs/superpowers/specs/2026-05-24-user-friendly-cli-design.md](../specs/2026-05-24-user-friendly-cli-design.md)

---

## File structure

**New files:**

```
src/cli/
  main.ts                          # entry — argv parse + dispatch
  router.ts                        # namespace + command registry
  context.ts                       # ProjectContext loader
  resolve-input.ts                 # smart input → canonical qn resolver
  format.ts                        # output formatters
  help.ts                          # --help renderer
  tour.ts                          # cortex tour (context-aware)
  install.ts                       # cortex install / --uninstall
  errors.ts                        # error classes + renderers
  commands/
    code.ts                        # cortex code [search|find|show|where|calls|arch|schema]
    decision.ts                    # cortex decision [list|show|why|create|update|delete|link|promote|supersede|propose]
    graph.ts                       # cortex graph [query|sql]
    index.ts                       # cortex index [run|status|changes|list|delete]
    eval.ts                        # cortex eval [run|baseline|report]
    help.ts                        # cortex help <topic>
bin/
  cortex                           # launcher script
tests/cli/
  context.test.ts
  resolve-input.test.ts
  format.test.ts
  errors.test.ts
  router.test.ts
  tour.test.ts
  install.test.ts
  commands/
    code.test.ts
    decision.test.ts
    graph.test.ts
    index.test.ts
  integration/
    happy-paths.test.ts
    disambiguation.test.ts
```

**Modified files:**

- `package.json` — add `"bin": { "cortex": "bin/cortex" }`, no new dependencies
- `scripts/build-indexer.sh` — append a call to `bin/cortex install --quiet` (best-effort, doesn't fail the postinstall)
- `evals/tsconfig.json` — extend the include to cover `src/cli/**/*.ts` (the CLI imports from same paths as evals)

---

## Task 1: Scaffold `src/cli/` and bin launcher

Goal: directory + launcher + stub `main.ts` that prints "not implemented yet"; npm `cortex` binary wires up.

**Files:**

- Create: `bin/cortex`
- Create: `src/cli/main.ts` (stub)
- Modify: `package.json` (add bin entry)

- [ ] **Step 1: Create the bin launcher**

Create `bin/cortex` with this exact content:

```bash
#!/usr/bin/env bash
# bin/cortex — launcher for the cortex CLI.
# Dev (uncompiled): runs via tsx.
# Built (dist/ present): runs the compiled JS.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/dist/cli/main.js" ]; then
  exec node "$ROOT/dist/cli/main.js" "$@"
else
  exec npx tsx "$ROOT/src/cli/main.ts" "$@"
fi
```

Make it executable:

```bash
chmod +x bin/cortex
```

- [ ] **Step 2: Create the stub `src/cli/main.ts`**

```ts
#!/usr/bin/env tsx
console.error("cortex: not implemented yet");
process.exit(1);
```

- [ ] **Step 3: Add the bin entry to package.json**

Open `package.json` and add a top-level `bin` field, alphabetically placed:

```json
"bin": {
  "cortex": "bin/cortex"
}
```

Place it after `"main"` and before `"scripts"`.

- [ ] **Step 4: Verify the launcher works**

Run: `bin/cortex`
Expected: stderr `cortex: not implemented yet`; exit code 1.

- [ ] **Step 5: Commit**

```bash
git add bin/cortex src/cli/main.ts package.json
git commit -m "feat(cli): scaffold bin/cortex launcher + stub main.ts

Adds bin/cortex script that dispatches to tsx (dev) or node (built).
Package.json gains a bin entry so npm install -g would put cortex on
PATH. Stub main.ts exits 1 — actual command surface lands in later
tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `context.ts` — project state detection

Goal: shared module that determines what state the cwd is in (indexed project, unindexed git repo, no project) and resolves the project name + graph.db path. Used by router, tour, and most commands.

**Files:**

- Create: `src/cli/context.ts`
- Create: `tests/cli/context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/context.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectState, deriveProjectName } from "../../src/cli/context.js";

describe("context — project state detection", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "cortex-ctx-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("detects 'no-project' when cwd has no .git", () => {
    expect(detectProjectState(tmp)).toBe("no-project");
  });

  it("detects 'unindexed-repo' when cwd has .git but no indexed project for it", () => {
    mkdirSync(join(tmp, ".git"));
    writeFileSync(join(tmp, ".git/HEAD"), "ref: refs/heads/main\n");
    // No project entry in ~/.cache/cortex; detect returns unindexed-repo.
    expect(detectProjectState(tmp)).toBe("unindexed-repo");
  });

  it("derives project name from absolute path", () => {
    expect(deriveProjectName("/Users/rka/Development/anthill-cloud"))
      .toBe("Users-rka-Development-anthill-cloud");
  });

  it("derives project name from relative path by resolving first", () => {
    // Just verify the format — exact value depends on cwd
    const derived = deriveProjectName("/some/path");
    expect(derived).toBe("some-path");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `context.ts`**

Create `src/cli/context.ts`:

```ts
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type ProjectState = "indexed" | "unindexed-repo" | "no-project";

export type ProjectContext = {
  state: ProjectState;
  cwd: string;
  projectName: string | null;       // null when state === "no-project"
  graphDbPath: string | null;       // null when state !== "indexed"
};

/** Convert an absolute path into the indexer's project naming convention. */
export function deriveProjectName(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/** Walk up looking for a .git directory. Returns the first match or null. */
function findGitRoot(start: string): string | null {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Check if a graph.db exists for this project in the indexer's cache. */
function findIndexedDb(projectName: string): string | null {
  // Indexer writes to ~/.cache/cortex-indexer/<projectName>.db when CORTEX_DB
  // is not set. (cortex itself may set CORTEX_DB to a project-local file but
  // we don't depend on that here.)
  const cachePath = join(homedir(), ".cache/cortex-indexer", `${projectName}.db`);
  if (existsSync(cachePath)) return cachePath;
  return null;
}

export function detectProjectState(cwd: string): ProjectState {
  const ctx = loadContext(cwd);
  return ctx.state;
}

export function loadContext(cwd: string): ProjectContext {
  const absCwd = resolve(cwd);
  const gitRoot = findGitRoot(absCwd);
  if (!gitRoot) {
    return { state: "no-project", cwd: absCwd, projectName: null, graphDbPath: null };
  }
  const projectName = deriveProjectName(gitRoot);
  const graphDbPath = findIndexedDb(projectName);
  if (!graphDbPath) {
    return { state: "unindexed-repo", cwd: absCwd, projectName, graphDbPath: null };
  }
  return { state: "indexed", cwd: absCwd, projectName, graphDbPath };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/context.test.ts`
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/context.ts tests/cli/context.test.ts
git commit -m "feat(cli): context module — project state detection

Detects whether cwd is inside an indexed project, an unindexed git
repo, or no project at all. Resolves the indexer's slash-replaced
project name from the git root, and locates the graph.db in
~/.cache/cortex-indexer/.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `errors.ts` — error classes + renderer

Goal: four error classes (usage, domain, environment, unexpected) with distinct exit codes, single `tryCommand` wrapper used by all command handlers, stderr-only output so stdout stays pipe-clean.

**Files:**

- Create: `src/cli/errors.ts`
- Create: `tests/cli/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/errors.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  UsageError,
  DomainError,
  EnvironmentError,
  exitCodeFor,
  renderError,
} from "../../src/cli/errors.js";

describe("errors", () => {
  it("UsageError sets exit code 2", () => {
    const e = new UsageError("missing arg", "Did you mean: cortex code show");
    expect(exitCodeFor(e)).toBe(2);
  });

  it("DomainError sets exit code 3", () => {
    const e = new DomainError("symbol not found", "Try: cortex code find foo");
    expect(exitCodeFor(e)).toBe(3);
  });

  it("EnvironmentError sets exit code 4", () => {
    const e = new EnvironmentError("indexer binary missing", "To fix: npm install");
    expect(exitCodeFor(e)).toBe(4);
  });

  it("unexpected Error sets exit code 1", () => {
    expect(exitCodeFor(new Error("kablooie"))).toBe(1);
  });

  it("renderError writes to stderr (not stdout)", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    renderError(new DomainError("not found", "Try: cortex code find foo"));
    expect(errSpy).toHaveBeenCalled();
    expect(outSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  it("renderError on DomainError includes the tip block", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    renderError(new DomainError("symbol not found", "Try: cortex code find foo"));
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(joined).toContain("symbol not found");
    expect(joined).toContain("Try: cortex code find foo");
    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `errors.ts`**

Create `src/cli/errors.ts`:

```ts
export class UsageError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class DomainError extends Error {
  constructor(message: string, public tip?: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class EnvironmentError extends Error {
  constructor(message: string, public fix?: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export function exitCodeFor(e: unknown): number {
  if (e instanceof UsageError) return 2;
  if (e instanceof DomainError) return 3;
  if (e instanceof EnvironmentError) return 4;
  return 1;
}

export function renderError(e: unknown): void {
  if (e instanceof UsageError) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    if (e.hint) process.stderr.write(`\n${e.hint}\n`);
    return;
  }
  if (e instanceof DomainError) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    if (e.tip) process.stderr.write(`\n${e.tip}\n`);
    return;
  }
  if (e instanceof EnvironmentError) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    if (e.fix) process.stderr.write(`\nTo fix: ${e.fix}\n`);
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`Error: ${msg}\n  (run with --debug to see stack)\n`);
  if (process.env.CORTEX_CLI_DEBUG === "1" && e instanceof Error && e.stack) {
    process.stderr.write(`\n${e.stack}\n`);
  }
}

export async function tryCommand(handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (e) {
    renderError(e);
    process.exit(exitCodeFor(e));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/errors.test.ts`
Expected: PASS — all 6 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/errors.ts tests/cli/errors.test.ts
git commit -m "feat(cli): error classes + renderer

Four error classes — UsageError, DomainError, EnvironmentError, and
plain Error fallback — each with a distinct exit code (2/3/4/1).
All errors render to stderr; stdout stays clean for piping. tryCommand
wraps every command handler and forces process.exit with the right
code. --debug surfaced via CORTEX_CLI_DEBUG=1 env var.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `format.ts` — output formatters

Goal: pick output format based on `--format` flag and TTY detection; emit JSON, plain newline-separated text, or aligned table.

**Files:**

- Create: `src/cli/format.ts`
- Create: `tests/cli/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatRows, type Row } from "../../src/cli/format.js";

describe("format", () => {
  const rows: Row[] = [
    { name: "foo", kind: "function", file_path: "src/foo.ts" },
    { name: "barlong", kind: "module", file_path: "apps/b.vue" },
  ];

  it("plain format: tab-separated rows", () => {
    const out = formatRows(rows, "plain");
    expect(out).toBe("foo\tfunction\tsrc/foo.ts\nbarlong\tmodule\tapps/b.vue");
  });

  it("json format: JSON array", () => {
    const out = formatRows(rows, "json");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("foo");
  });

  it("table format: aligned columns with header", () => {
    const out = formatRows(rows, "table");
    expect(out).toMatch(/name\s+kind\s+file_path/);
    // Alignment: barlong is 7 chars, foo is 3 — column width must be at least 7
    expect(out).toMatch(/foo\s{4,}function/);
  });

  it("empty input returns empty string", () => {
    expect(formatRows([], "plain")).toBe("");
    expect(formatRows([], "json")).toBe("[]");
    expect(formatRows([], "table")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/format.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `format.ts`**

Create `src/cli/format.ts`:

```ts
export type Row = Record<string, unknown>;
export type Format = "table" | "json" | "plain";

export function chooseFormat(flag: string | undefined, isTTY: boolean): Format {
  if (flag === "json") return "json";
  if (flag === "plain") return "plain";
  if (flag === "table") return "table";
  return isTTY ? "table" : "plain";
}

export function formatRows(rows: Row[], format: Format): string {
  if (format === "json") return JSON.stringify(rows, null, rows.length === 0 ? 0 : 2);
  if (rows.length === 0) return "";
  if (format === "plain") {
    return rows.map((r) => Object.values(r).map((v) => String(v ?? "")).join("\t")).join("\n");
  }
  // table
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const sep = "  ";
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const header = keys.map((k, i) => pad(k, widths[i])).join(sep);
  const body = rows.map((r) => keys.map((k, i) => pad(String(r[k] ?? ""), widths[i])).join(sep)).join("\n");
  return `${header}\n${body}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/format.test.ts`
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/format.ts tests/cli/format.test.ts
git commit -m "feat(cli): output formatters — table, json, plain

formatRows handles three shapes: table (aligned columns for TTY),
json (machine-readable), plain (tab-separated for pipes). chooseFormat
picks based on --format flag and TTY detection — defaults to table
on TTY, plain when piped.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `resolve-input.ts` — smart input resolver

Goal: the friction-killer. Takes any user input (file path, canonical qn, dotted path, bare name) and returns a `ResolvedSymbol` or a `Disambiguation`. Pure function tested against a fixture graph.db.

**Files:**

- Create: `src/cli/resolve-input.ts`
- Create: `tests/cli/resolve-input.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/resolve-input.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInput } from "../../src/cli/resolve-input.js";
import { DomainError } from "../../src/cli/errors.js";

describe("resolveInput", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  const project = "test-project";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-resolve-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("file path: looks up by file_path", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const result = resolveInput("apps/Card.vue", project, dbPath);
    expect("qn" in result).toBe(true);
    if ("qn" in result) expect(result.qn).toBe("test-project.apps.Card");
  });

  it("canonical qn (starts with project prefix): direct lookup", () => {
    store.createNode({
      kind: "module", name: "Card.vue",
      file_path: "apps/Card.vue",
      qualified_name: "test-project.apps.Card",
    });
    const result = resolveInput("test-project.apps.Card", project, dbPath);
    expect("qn" in result).toBe(true);
  });

  it("bare name: search_graph fallback", () => {
    store.createNode({
      kind: "function", name: "handleRequest",
      file_path: "src/handler.ts",
      qualified_name: "test-project.src.handler.handleRequest",
    });
    const result = resolveInput("handleRequest", project, dbPath);
    expect("qn" in result).toBe(true);
    if ("qn" in result) expect(result.qn).toBe("test-project.src.handler.handleRequest");
  });

  it("multiple matches → disambiguation", () => {
    store.createNode({ kind: "function", name: "render", file_path: "a.ts", qualified_name: "test-project.a.render" });
    store.createNode({ kind: "function", name: "render", file_path: "b.ts", qualified_name: "test-project.b.render" });
    const result = resolveInput("render", project, dbPath);
    expect("candidates" in result).toBe(true);
    if ("candidates" in result) expect(result.candidates.length).toBe(2);
  });

  it("zero matches throws DomainError", () => {
    expect(() => resolveInput("apps/missing.vue", project, dbPath))
      .toThrow(DomainError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/resolve-input.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `resolve-input.ts`**

Create `src/cli/resolve-input.ts`:

```ts
import { GraphStore } from "../graph/store.js";
import { DomainError } from "./errors.js";

export type ResolvedSymbol = { qn: string; file_path: string; kind: string };
export type Disambiguation = { candidates: ResolvedSymbol[]; input: string };

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
  const store = new GraphStore(dbPath);

  let candidates: ResolvedSymbol[] = [];

  // 1. File path
  if (input.includes("/") || SOURCE_EXTS.test(input)) {
    candidates = lookupByFilePath(store, input);
  }

  // 2. Canonical qn (project prefix)
  if (candidates.length === 0 && input.startsWith(`${project}.`)) {
    candidates = lookupByQn(store, input);
  }

  // 3. Dotted path with no slash — try qn match, then suffix
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

  if (candidates.length === 0) {
    throw new DomainError(`no symbol matched '${input}'`, tipFor(input));
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  return { candidates, input };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/resolve-input.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/resolve-input.ts tests/cli/resolve-input.test.ts
git commit -m "feat(cli): resolve-input — smart input → canonical qn

Single function handles four input shapes: file paths (looked up by
file_path), canonical qns (direct match), dotted paths (qn + suffix
fallback), and bare names (search by name). Returns a ResolvedSymbol
on single match, a Disambiguation on multiple matches, throws
DomainError on zero matches with a context-specific tip.

This is the friction-killer for the field-report-observed UX:
'apps/foo.vue' input no longer fails with 'symbol not found'.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: `router.ts` — namespace + command registry

Goal: the only file that knows the full command grid. Dispatches `argv` to a handler. Implements the `did you mean` suggestion via Levenshtein distance on namespace + command names.

**Files:**

- Create: `src/cli/router.ts`
- Create: `tests/cli/router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseArgv, findSuggestion } from "../../src/cli/router.js";

describe("router", () => {
  it("parses 'cortex code search ribbon' into namespace + command + positional", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon"]);
    expect(r.namespace).toBe("code");
    expect(r.command).toBe("search");
    expect(r.positionals).toEqual(["ribbon"]);
  });

  it("parses --flag=value", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon", "--format=json"]);
    expect(r.flags.format).toBe("json");
  });

  it("parses --flag value (separate)", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon", "--format", "json"]);
    expect(r.flags.format).toBe("json");
  });

  it("treats bare --flag as boolean true", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon", "--explain"]);
    expect(r.flags.explain).toBe(true);
  });

  it("findSuggestion returns nearest command name", () => {
    expect(findSuggestion("seerch", ["search", "find", "show"])).toBe("search");
  });

  it("findSuggestion returns null when nothing is close", () => {
    expect(findSuggestion("xyzzy", ["search", "find", "show"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `router.ts`**

Create `src/cli/router.ts`:

```ts
export type ParsedArgv = {
  namespace: string | null;     // e.g. "code", or null for meta
  command: string | null;       // e.g. "search"
  positionals: string[];        // non-flag args after command
  flags: Record<string, string | boolean>;
};

export function parseArgv(argv: string[]): ParsedArgv {
  // argv[0] is the binary name (e.g. "cortex"); strip it.
  const args = argv.slice(1);
  let namespace: string | null = null;
  let command: string | null = null;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (a.startsWith("-")) {
      // Short flags — treat as boolean for now.
      flags[a.slice(1)] = true;
    } else if (namespace === null) {
      namespace = a;
    } else if (command === null) {
      command = a;
    } else {
      positionals.push(a);
    }
  }

  return { namespace, command, positionals, flags };
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function findSuggestion(typed: string, candidates: string[], maxDistance = 2): string | null {
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(typed, c);
    if (d <= maxDistance && (best === null || d < best.d)) {
      best = { name: c, d };
    }
  }
  return best?.name ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/router.test.ts`
Expected: PASS — all 6 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/router.ts tests/cli/router.test.ts
git commit -m "feat(cli): router — argv parser + Levenshtein suggestion

parseArgv extracts namespace + command + positionals + flags from
process.argv. Handles --flag=value, --flag value, and bare --flag
(boolean) forms. findSuggestion returns the nearest candidate by
Levenshtein distance — used by the dispatch layer to render
'did you mean X?' on unknown commands.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: `commands/code.ts` — code namespace handlers

Goal: implement the 7 `cortex code` commands by calling the existing `searchGraph`, `tracePath`, `getGraphSchema` helpers from `src/graph/code-queries.ts` and shelling out to `bin/cortex-indexer cli` for `search_code` + `index_repository`.

**Files:**

- Create: `src/cli/commands/code.ts`
- Create: `tests/cli/commands/code.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/commands/code.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../../src/graph/store.js";
import { runCodeCommand } from "../../../src/cli/commands/code.js";
import type { ProjectContext } from "../../../src/cli/context.js";

describe("cortex code commands", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  let ctx: ProjectContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-cmd-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
    ctx = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: dbPath };
    store.createNode({ kind: "function", name: "foo", qualified_name: "test.src.foo", file_path: "src/foo.ts" });
    store.createNode({ kind: "function", name: "bar", qualified_name: "test.src.bar", file_path: "src/bar.ts" });
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("find: returns matching nodes", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "find", positionals: ["foo"], flags: {} }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("test.src.foo");
    writeSpy.mockRestore();
  });

  it("schema: emits node + edge counts", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "schema", positionals: [], flags: {} }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("function");
    writeSpy.mockRestore();
  });

  it("unknown sub-command throws UsageError", async () => {
    await expect(runCodeCommand({ command: "badcmd", positionals: [], flags: {} }, ctx))
      .rejects.toThrow("unknown command");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/commands/code.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `commands/code.ts`**

Create `src/cli/commands/code.ts`:

```ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { GraphStore } from "../../graph/store.js";
import { searchGraph, getGraphSchema, tracePath } from "../../graph/code-queries.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { resolveInput, type Disambiguation } from "../resolve-input.js";
import { formatRows, chooseFormat } from "../format.js";

const INDEXER_BIN = resolve(process.cwd(), "bin/cortex-indexer");

export type CodeCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function requireIndexed(ctx: ProjectContext): asserts ctx is ProjectContext & { graphDbPath: string; projectName: string } {
  if (ctx.state !== "indexed" || !ctx.graphDbPath || !ctx.projectName) {
    throw new EnvironmentError(
      "no indexed project for the current directory",
      "cortex index .  (to index the current repo)",
    );
  }
}

function renderDisambiguation(d: Disambiguation): never {
  const lines = [`Multiple matches for '${d.input}'. Pick one:`, ""];
  d.candidates.forEach((c, i) => {
    lines.push(`  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`);
  });
  lines.push("");
  lines.push(`Run: cortex code show '<full qn from above>'`);
  throw new DomainError("ambiguous input", lines.join("\n"));
}

export async function runCodeCommand(cmd: CodeCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "search":
      return cmdSearch(cmd, ctx);
    case "find":
      return cmdFind(cmd, ctx);
    case "show":
      return cmdShow(cmd, ctx);
    case "where":
      return cmdTrace(cmd, ctx, "callers");
    case "calls":
      return cmdTrace(cmd, ctx, "calls");
    case "arch":
      return cmdArch(cmd, ctx);
    case "schema":
      return cmdSchema(cmd, ctx);
    default:
      throw new UsageError(`unknown command 'cortex code ${cmd.command}'`, "Run: cortex code --help");
  }
}

function cmdSearch(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <pattern>", "Usage: cortex code search <pattern>");
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", "search_code", JSON.stringify({ pattern, project: ctx.projectName })],
    { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
  );
  process.stdout.write(out);
}

function cmdFind(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <name-pattern>", "Usage: cortex code find <name>");
  const store = new GraphStore(ctx.graphDbPath);
  const results = searchGraph(store, ctx.projectName, { name_pattern: pattern });
  const rows = results.map((r) => ({
    name: r.name, kind: r.kind, qualified_name: r.qualified_name, file_path: r.file_path,
  }));
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  process.stdout.write(formatRows(rows, fmt) + "\n");
}

function cmdShow(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const input = cmd.positionals[0];
  if (!input) throw new UsageError("missing <input>", "Usage: cortex code show <input>");
  const resolved = resolveInput(input, ctx.projectName, ctx.graphDbPath);
  if ("candidates" in resolved) renderDisambiguation(resolved);
  // Shell out to indexer for snippet retrieval — it has the file-read + content logic.
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", "get_code_snippet", JSON.stringify({ qualified_name: resolved.qn, project: ctx.projectName })],
    { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
  );
  process.stdout.write(out);
}

function cmdTrace(cmd: CodeCommand, ctx: ProjectContext, mode: "calls" | "callers"): void {
  requireIndexed(ctx);
  const input = cmd.positionals[0];
  if (!input) throw new UsageError(`missing <input>`, `Usage: cortex code ${mode === "callers" ? "where" : "calls"} <input>`);
  const resolved = resolveInput(input, ctx.projectName, ctx.graphDbPath);
  if ("candidates" in resolved) renderDisambiguation(resolved);
  const store = new GraphStore(ctx.graphDbPath);
  // tracePath wants the function name; extract from qn.
  const fnName = resolved.qn.split(".").pop()!;
  const results = tracePath(store, ctx.projectName, { function_name: fnName, mode });
  const rows = results.map((r) => ({
    depth: r.depth, name: r.node.name, kind: r.node.kind, file_path: r.node.file_path,
  }));
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  process.stdout.write(formatRows(rows, fmt) + "\n");
}

function cmdArch(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const aspects = (cmd.flags.aspects as string | undefined)?.split(",") ?? ["all"];
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", "get_architecture", JSON.stringify({ aspects, project: ctx.projectName })],
    { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
  );
  process.stdout.write(out);
}

function cmdSchema(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const store = new GraphStore(ctx.graphDbPath);
  const schema = getGraphSchema(store, ctx.projectName);
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  const rows = schema.node_labels.map((l) => ({ label: l.label, count: l.count }));
  process.stdout.write(formatRows(rows, fmt) + "\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/commands/code.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/code.ts tests/cli/commands/code.test.ts
git commit -m "feat(cli): code namespace — search/find/show/where/calls/arch/schema

Seven subcommands wrapping the existing graph helpers (searchGraph,
tracePath, getGraphSchema). Indexer-only ops (search_code,
get_code_snippet, get_architecture) shell out to bin/cortex-indexer.
show/where/calls auto-resolve raw inputs through resolveInput;
multi-match throws DomainError with a numbered candidate list.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: `commands/decision.ts` — decision namespace handlers

Goal: implement the 10 `cortex decision` commands by instantiating `DecisionService` and calling its methods directly.

**Files:**

- Create: `src/cli/commands/decision.ts`
- Create: `tests/cli/commands/decision.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/commands/decision.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDecisionCommand } from "../../../src/cli/commands/decision.js";
import type { ProjectContext } from "../../../src/cli/context.js";

describe("cortex decision commands", () => {
  let dir: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-dec-cmd-"));
    ctx = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: join(dir, "graph.db") };
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("list with no decisions returns empty output", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({ command: "list", positionals: [], flags: {} }, ctx);
    writeSpy.mockRestore();
    // Nothing thrown, that's the success path.
  });

  it("create with required flags persists the decision", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({
      command: "create",
      positionals: [],
      flags: { title: "Test", description: "d", rationale: "r" },
    }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Test");
    writeSpy.mockRestore();
  });

  it("create without --title throws UsageError", async () => {
    await expect(runDecisionCommand({
      command: "create",
      positionals: [],
      flags: { description: "d", rationale: "r" },
    }, ctx)).rejects.toThrow("missing --title");
  });

  it("unknown sub-command throws UsageError", async () => {
    await expect(runDecisionCommand({ command: "frobnicate", positionals: [], flags: {} }, ctx))
      .rejects.toThrow("unknown command");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/commands/decision.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `commands/decision.ts`**

Create `src/cli/commands/decision.ts`:

```ts
import { join } from "node:path";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { DecisionService } from "../../decisions/service.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError } from "../errors.js";
import { formatRows, chooseFormat } from "../format.js";

export type DecisionCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function openService(ctx: ProjectContext) {
  // Decisions db sits next to the graph db. If no indexed project, fall back
  // to a cwd-local file at .cortex/decisions.db.
  const dbPath = ctx.state === "indexed"
    ? join(ctx.cwd, ".cortex", "decisions.db")
    : join(ctx.cwd, ".cortex", "decisions.db");
  const db = openDecisionsDb(dbPath);
  const links = new DecisionLinksRepository(db);
  const svc = new DecisionService({
    decisions: new DecisionsRepository(db),
    links,
  });
  return { db, svc, links };
}

function requireFlag(name: string, flags: Record<string, unknown>): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new UsageError(`missing --${name}`, `Usage: cortex decision create --title=... --description=... --rationale=...`);
  }
  return v;
}

export async function runDecisionCommand(cmd: DecisionCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "list":   return cmdList(cmd, ctx);
    case "show":   return cmdShow(cmd, ctx);
    case "why":    return cmdWhy(cmd, ctx);
    case "create": return cmdCreate(cmd, ctx);
    case "update": return cmdUpdate(cmd, ctx);
    case "delete": return cmdDelete(cmd, ctx);
    case "link":   return cmdLink(cmd, ctx);
    case "promote":    throw new UsageError("promote not yet wired up", "Use bin/cortex-indexer cli promote_decision for now");
    case "propose":    return cmdPropose(cmd, ctx);
    case "supersede":  return cmdSupersede(cmd, ctx);
    default:
      throw new UsageError(`unknown command 'cortex decision ${cmd.command}'`, "Run: cortex decision --help");
  }
}

function cmdList(cmd: DecisionCommand, ctx: ProjectContext): void {
  const { db, svc } = openService(ctx);
  try {
    const query = (cmd.flags.query as string) ?? "";
    const results = query ? svc.search(query) : svc.search("");
    const rows = results.map((d) => ({ id: d.id, title: d.title, status: d.status }));
    const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
    process.stdout.write(formatRows(rows, fmt) + "\n");
  } finally { db.close(); }
}

function cmdShow(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex decision show <id>");
  const { db, svc } = openService(ctx);
  try {
    const d = svc.get(id);
    if (!d) throw new DomainError(`no decision with id '${id}'`, "Try: cortex decision list");
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdWhy(cmd: DecisionCommand, _ctx: ProjectContext): void {
  // For now, delegate to indexer's why_was_this_built once that's plumbed.
  // Minimal stub: error so users know it's not yet implemented end-to-end.
  throw new UsageError("'cortex decision why' is not yet wired up",
    "Use: bin/cortex-indexer cli why_was_this_built '{\"qualified_name\":\"...\"}'");
}

function cmdCreate(cmd: DecisionCommand, ctx: ProjectContext): void {
  const title = requireFlag("title", cmd.flags);
  const description = requireFlag("description", cmd.flags);
  const rationale = requireFlag("rationale", cmd.flags);
  const { db, svc } = openService(ctx);
  try {
    const d = svc.create({ title, description, rationale });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdUpdate(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex decision update <id> --field=value ...");
  const { db, svc } = openService(ctx);
  try {
    const patch: Record<string, unknown> = {};
    for (const k of ["title", "description", "rationale", "problem", "resolution"]) {
      if (typeof cmd.flags[k] === "string") patch[k] = cmd.flags[k];
    }
    const d = svc.update(id, patch);
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdDelete(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex decision delete <id>");
  const { db, svc } = openService(ctx);
  try {
    svc.delete(id);
    process.stdout.write(`deleted ${id}\n`);
  } finally { db.close(); }
}

function cmdLink(cmd: DecisionCommand, ctx: ProjectContext): void {
  const [id, target] = cmd.positionals;
  if (!id || !target) throw new UsageError("missing args", "Usage: cortex decision link <id> <target> [--relation=GOVERNS]");
  const relation = (cmd.flags.relation as string) ?? "GOVERNS";
  const { db, svc } = openService(ctx);
  try {
    if (relation === "GOVERNS") svc.linkGoverns(id, target);
    else if (relation === "REFERENCES") svc.linkReferences(id, target);
    else throw new UsageError(`unknown --relation '${relation}'`, "Allowed: GOVERNS, REFERENCES");
    process.stdout.write(`linked ${id} -[${relation}]-> ${target}\n`);
  } finally { db.close(); }
}

function cmdPropose(cmd: DecisionCommand, ctx: ProjectContext): void {
  const title = requireFlag("title", cmd.flags);
  const problem = requireFlag("problem", cmd.flags);
  const resolution = requireFlag("resolution", cmd.flags);
  const rationale = requireFlag("rationale", cmd.flags);
  const { db, svc } = openService(ctx);
  try {
    const d = svc.propose({ title, problem, resolution, rationale });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdSupersede(cmd: DecisionCommand, ctx: ProjectContext): void {
  const oldId = cmd.positionals[0];
  if (!oldId) throw new UsageError("missing <old-id>", "Usage: cortex decision supersede <old-id> --title=... --problem=... --resolution=... --rationale=...");
  const title = requireFlag("title", cmd.flags);
  const problem = requireFlag("problem", cmd.flags);
  const resolution = requireFlag("resolution", cmd.flags);
  const rationale = requireFlag("rationale", cmd.flags);
  const { db, svc } = openService(ctx);
  try {
    const d = svc.supersede({ old_decision_id: oldId, title, problem, resolution, rationale });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally { db.close(); }
}
```

Note: `svc.linkReferences` is referenced but may not exist as a public method on DecisionService. If `tsc --noEmit` flags it, replace with the equivalent inline call to `links.add({ decision_id, target_kind, target_ref, relation, created_at })` — see [src/decisions/service.ts](../src/decisions/service.ts) line ~147 for the existing `linkGoverns` pattern.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/commands/decision.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/decision.ts tests/cli/commands/decision.test.ts
git commit -m "feat(cli): decision namespace — 10 subcommands

list/show/why/create/update/delete/link/promote/supersede/propose,
calling DecisionService directly. why_was_this_built and promote
emit UsageError pointing at the indexer CLI for now; the rest of the
surface is end-to-end functional.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: `commands/graph.ts`, `commands/index.ts`, `commands/eval.ts`

Goal: three small command files bundled together — graph (query/sql), index (5 subcommands), eval (delegates to existing evals/src/cli.ts).

**Files:**

- Create: `src/cli/commands/graph.ts`
- Create: `src/cli/commands/index.ts`
- Create: `src/cli/commands/eval.ts`

- [ ] **Step 1: Write `commands/graph.ts`**

```ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { UsageError, EnvironmentError } from "../errors.js";

const INDEXER_BIN = resolve(process.cwd(), "bin/cortex-indexer");

export type GraphCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runGraphCommand(cmd: GraphCommand, ctx: ProjectContext): Promise<void> {
  if (ctx.state !== "indexed" || !ctx.graphDbPath || !ctx.projectName) {
    throw new EnvironmentError("no indexed project for the current directory", "cortex index .");
  }
  switch (cmd.command) {
    case "query": {
      const query = cmd.positionals[0];
      if (!query) throw new UsageError("missing <cypher>", "Usage: cortex graph query '<cypher>'");
      const out = execFileSync(
        INDEXER_BIN,
        ["cli", "query_graph", JSON.stringify({ query, project: ctx.projectName })],
        { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
      );
      process.stdout.write(out);
      return;
    }
    case "sql": {
      const sql = cmd.positionals[0];
      if (!sql) throw new UsageError("missing <sql>", "Usage: cortex graph sql '<sql>'");
      // Shell out to sqlite3 directly — no MCP equivalent.
      const out = execFileSync("sqlite3", [ctx.graphDbPath, sql], { encoding: "utf-8" });
      process.stdout.write(out);
      return;
    }
    default:
      throw new UsageError(`unknown command 'cortex graph ${cmd.command}'`, "Run: cortex graph --help");
  }
}
```

- [ ] **Step 2: Write `commands/index.ts`**

```ts
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";

const INDEXER_BIN = resolvePath(process.cwd(), "bin/cortex-indexer");

export type IndexCommand = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runIndexCommand(cmd: IndexCommand, ctx: ProjectContext): Promise<void> {
  // 'cortex index' with no subcommand → index the cwd (or given path)
  if (cmd.command === null || cmd.command === undefined || cmd.command === ".") {
    const repoPath = cmd.positionals[0] ?? ctx.cwd;
    const out = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify({ repo_path: repoPath })],
      { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] },
    );
    process.stdout.write(out);
    return;
  }
  switch (cmd.command) {
    case "status":
      shell("index_status", { project: ctx.projectName ?? "" });
      return;
    case "changes":
      shell("detect_changes", { repo_path: ctx.cwd });
      return;
    case "list":
      shell("list_projects", {});
      return;
    case "delete": {
      const project = cmd.positionals[0];
      if (!project) throw new UsageError("missing <project>", "Usage: cortex index delete <project>");
      shell("delete_project", { project });
      return;
    }
    default:
      throw new UsageError(`unknown command 'cortex index ${cmd.command}'`, "Run: cortex index --help");
  }
}

function shell(tool: string, args: Record<string, unknown>): void {
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", tool, JSON.stringify(args)],
    { encoding: "utf-8" },
  );
  process.stdout.write(out);
}
```

- [ ] **Step 3: Write `commands/eval.ts`**

```ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EVAL_CLI = resolve(process.cwd(), "evals/src/cli.ts");

export type EvalCommand = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runEvalCommand(cmd: EvalCommand, _ctx: ProjectContext): Promise<void> {
  const subcommand = cmd.command;
  if (subcommand === null || subcommand === "run") {
    const args: string[] = [];
    if (cmd.positionals[0]) args.push(`--target=${cmd.positionals[0]}`);
    if (typeof cmd.flags.path === "string") args.push(`--path=${cmd.flags.path}`);
    execFileSync("npx", ["tsx", EVAL_CLI, ...args], { stdio: "inherit" });
    return;
  }
  if (subcommand === "baseline") {
    const target = cmd.positionals[0];
    if (!target) throw new UsageError("missing <target>", "Usage: cortex eval baseline <target> [--path=...]");
    const args = [`--capture-baseline=${target}`];
    if (typeof cmd.flags.path === "string") args.push(`--path=${cmd.flags.path}`);
    execFileSync("npx", ["tsx", EVAL_CLI, ...args], { stdio: "inherit" });
    return;
  }
  if (subcommand === "report") {
    const reportsDir = resolve(process.cwd(), "evals/reports");
    if (!existsSync(reportsDir)) throw new UsageError("no reports yet", "Run: cortex eval [target]");
    let chosen: string | undefined;
    if (cmd.flags.at && typeof cmd.flags.at === "string") chosen = join(reportsDir, cmd.flags.at);
    else {
      const dirs = readdirSync(reportsDir).filter((d) => statSync(join(reportsDir, d)).isDirectory()).sort();
      chosen = dirs.length > 0 ? join(reportsDir, dirs[dirs.length - 1]) : undefined;
    }
    if (!chosen || !existsSync(join(chosen, "summary.md"))) throw new UsageError("no matching report", "Run: cortex eval [target]");
    process.stdout.write(readFileSync(join(chosen, "summary.md"), "utf-8"));
    return;
  }
  throw new UsageError(`unknown command 'cortex eval ${subcommand}'`, "Run: cortex eval --help");
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --project evals/tsconfig.json --noEmit` (assuming evals tsconfig is extended to cover src/cli/**)

If not yet extended, also run: `npx tsc --noEmit` from cortex repo root.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/graph.ts src/cli/commands/index.ts src/cli/commands/eval.ts
git commit -m "feat(cli): graph + index + eval namespace handlers

graph: query (Cypher via indexer) + sql (direct sqlite3).
index: bare 'cortex index' indexes cwd; subcommands status/changes/
list/delete shell out to indexer.
eval: delegates to evals/src/cli.ts via tsx; report --latest prints
the most recent summary.md.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: `help.ts` + `commands/help.ts` — help system

Goal: top-level `cortex --help`, per-command `cortex <ns> <cmd> --help`, and `cortex help <topic>` for concept explainers.

**Files:**

- Create: `src/cli/help.ts`
- Create: `src/cli/commands/help.ts`
- Create: `tests/cli/help.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/help.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "../../src/cli/help.js";
import { renderTopic } from "../../src/cli/commands/help.js";

describe("help renderers", () => {
  it("top-level help lists all namespaces", () => {
    const out = renderTopLevelHelp();
    expect(out).toContain("code");
    expect(out).toContain("decision");
    expect(out).toContain("graph");
    expect(out).toContain("index");
    expect(out).toContain("eval");
  });

  it("namespace help lists commands", () => {
    const out = renderNamespaceHelp("code");
    expect(out).toContain("search");
    expect(out).toContain("find");
    expect(out).toContain("show");
  });

  it("command help includes examples", () => {
    const out = renderCommandHelp("code", "search");
    expect(out).toContain("Examples:");
    expect(out).toContain("cortex code search");
  });

  it("renderTopic returns markdown for known topic", () => {
    const out = renderTopic("qualified-names");
    expect(out).toContain("qualified name");
  });

  it("renderTopic on unknown topic throws", () => {
    expect(() => renderTopic("xyzzy")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/help.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `help.ts`**

Create `src/cli/help.ts`:

```ts
type CommandDoc = {
  usage: string;
  description: string;
  examples: string[];
  seeAlso?: string[];
};

const NAMESPACES: Record<string, Record<string, CommandDoc>> = {
  code: {
    search: {
      usage: "cortex code search <pattern>",
      description: "Full-text search across indexed source.",
      examples: [
        "cortex code search ribbon",
        "cortex code search 'useFetch' --kind=function",
      ],
      seeAlso: ["cortex code find", "cortex code show"],
    },
    find: {
      usage: "cortex code find <name>",
      description: "Find a symbol by name (function, module, class).",
      examples: [
        "cortex code find handleRequest",
        "cortex code find 'use%' --kind=function",
      ],
      seeAlso: ["cortex code show", "cortex code search"],
    },
    show: {
      usage: "cortex code show <input>",
      description: "Show source for a symbol. <input> can be a file path, a qualified name, or a bare name.",
      examples: [
        "cortex code show apps/components/Card.vue",
        "cortex code show 'src/api.ts::handleRequest'",
      ],
      seeAlso: ["cortex code where", "cortex code calls"],
    },
    where: {
      usage: "cortex code where <input>",
      description: "Find what calls a symbol.",
      examples: ["cortex code where handleRequest"],
      seeAlso: ["cortex code calls"],
    },
    calls: {
      usage: "cortex code calls <input>",
      description: "Find what a symbol calls.",
      examples: ["cortex code calls handleRequest"],
      seeAlso: ["cortex code where"],
    },
    arch: {
      usage: "cortex code arch [--aspects=structure,dependencies,routes,all]",
      description: "Get architectural overview.",
      examples: ["cortex code arch", "cortex code arch --aspects=routes"],
    },
    schema: {
      usage: "cortex code schema",
      description: "List node labels and edge types with counts.",
      examples: ["cortex code schema"],
    },
  },
  decision: {
    list:    { usage: "cortex decision list [--query=...]",   description: "List or search decisions.", examples: ["cortex decision list", "cortex decision list --query='auth'"] },
    show:    { usage: "cortex decision show <id>",            description: "Show a decision by id.", examples: ["cortex decision show abc-123"] },
    why:     { usage: "cortex decision why <input>",          description: "Show decisions governing a file or symbol.", examples: ["cortex decision why src/api.ts"] },
    create:  { usage: "cortex decision create --title=... --description=... --rationale=...", description: "Create a new decision.", examples: ["cortex decision create --title='use Postgres' --description=... --rationale=..."] },
    update:  { usage: "cortex decision update <id> --field=value",  description: "Update fields on an existing decision.", examples: ["cortex decision update abc-123 --rationale='updated'"] },
    delete:  { usage: "cortex decision delete <id>",                description: "Delete a decision.", examples: ["cortex decision delete abc-123"] },
    link:    { usage: "cortex decision link <id> <target> [--relation=GOVERNS]", description: "Link a decision to a file or symbol.", examples: ["cortex decision link abc-123 src/auth.ts"] },
    promote: { usage: "cortex decision promote <id>",               description: "Promote a proposed decision to active.", examples: ["cortex decision promote abc-123"] },
    propose: { usage: "cortex decision propose --title=... --problem=... --resolution=... --rationale=...", description: "Propose a decision (status=proposed).", examples: ["cortex decision propose --title=... ..."] },
    supersede: { usage: "cortex decision supersede <old-id> --title=... --problem=... --resolution=... --rationale=...", description: "Atomically supersede an existing decision.", examples: ["cortex decision supersede abc-123 ..."] },
  },
  graph: {
    query: { usage: "cortex graph query '<cypher>'", description: "Run a Cypher query against the graph.", examples: ["cortex graph query 'MATCH (f:function) RETURN count(f)'"] },
    sql:   { usage: "cortex graph sql '<sql>'",       description: "Run raw SQL against the graph.db (escape hatch when Cypher misbehaves).", examples: ["cortex graph sql 'SELECT kind, COUNT(*) FROM nodes GROUP BY kind'"] },
  },
  index: {
    status:  { usage: "cortex index status",                 description: "Show index state for the current project.", examples: ["cortex index status"] },
    changes: { usage: "cortex index changes",                description: "List files changed since last index.", examples: ["cortex index changes"] },
    list:    { usage: "cortex index list",                   description: "List all indexed projects.", examples: ["cortex index list"] },
    delete:  { usage: "cortex index delete <project>",       description: "Delete an indexed project.", examples: ["cortex index delete some-project"] },
  },
  eval: {
    run:      { usage: "cortex eval [<target>] [--path=...]",       description: "Run the eval harness against all targets, or one.", examples: ["cortex eval", "cortex eval anthill-cloud --path=/Users/rka/Development/anthill-cloud"] },
    baseline: { usage: "cortex eval baseline <target> [--path=...]", description: "Capture the baseline for a target.", examples: ["cortex eval baseline anthill-cloud --path=..."] },
    report:   { usage: "cortex eval report [--latest|--at=<timestamp>]", description: "Print the latest (or specified) eval summary.", examples: ["cortex eval report"] },
  },
};

export function renderTopLevelHelp(): string {
  const lines = [
    "cortex — knowledge graph for your codebase, on the command line",
    "",
    "Usage:",
    "  cortex <namespace> <command> [args] [--flags]",
    "",
    "Namespaces:",
    "  code        Search, view, and trace code in indexed projects",
    "  decision    Architectural decisions and provenance",
    "  graph       Raw Cypher / SQL queries (advanced)",
    "  index       Manage which projects are indexed",
    "  eval        Run the eval harness",
    "",
    "Common commands:",
    "  cortex code find <name>     find a symbol by name",
    "  cortex code show <input>    show source for a symbol or file",
    "  cortex code where <input>   find what calls a symbol",
    "  cortex decision why <input> show governing decisions",
    "  cortex eval                 run the eval harness",
    "",
    "Meta:",
    "  cortex tour                 60-second guided walkthrough",
    "  cortex help <topic>         concept-level help (qualified-names, projects, …)",
    "  cortex install              add cortex to PATH",
    "",
    "  --version                   print version",
    "  --help                      show help for any command",
  ];
  return lines.join("\n");
}

export function renderNamespaceHelp(namespace: string): string {
  const cmds = NAMESPACES[namespace];
  if (!cmds) return `unknown namespace '${namespace}'`;
  const lines = [`cortex ${namespace} — ${describeNamespace(namespace)}`, "", "Commands:"];
  for (const [name, doc] of Object.entries(cmds)) {
    lines.push(`  ${name.padEnd(12)}${doc.description}`);
  }
  lines.push("", `Run \`cortex ${namespace} <command> --help\` for details on any command.`);
  return lines.join("\n");
}

export function renderCommandHelp(namespace: string, command: string): string {
  const doc = NAMESPACES[namespace]?.[command];
  if (!doc) return `unknown command 'cortex ${namespace} ${command}'`;
  const lines = [
    `cortex ${namespace} ${command} — ${doc.description}`,
    "",
    "Usage:",
    `  ${doc.usage}`,
    "",
    "Examples:",
    ...doc.examples.map((e) => `  ${e}`),
  ];
  if (doc.seeAlso?.length) {
    lines.push("", "See also:");
    for (const ref of doc.seeAlso) lines.push(`  ${ref}`);
  }
  return lines.join("\n");
}

function describeNamespace(ns: string): string {
  return ({
    code: "Search, view, and trace code in indexed projects",
    decision: "Architectural decisions and provenance",
    graph: "Raw Cypher / SQL queries (advanced)",
    index: "Manage which projects are indexed",
    eval: "Run the eval harness",
  })[ns] ?? "";
}
```

- [ ] **Step 4: Write `commands/help.ts`**

Create `src/cli/commands/help.ts`:

```ts
import { UsageError } from "../errors.js";

const TOPICS: Record<string, string> = {
  "qualified-names": `qualified names — what they look like and why they matter

Cortex stores every code symbol under a canonical qualified name (qn). It
looks like this:

    Users-rka-Development-anthill-cloud.apps.activator.app.components.ADesignSystemCard

Format: <slash-replaced absolute path>.<dotted path to symbol>

The CLI auto-resolves common input shapes:

  • file paths             apps/foo.vue                  → looked up by file_path
  • canonical qns          Users-...-foo.bar             → direct match
  • dotted suffixes        components.foo                → matches by suffix
  • bare names             handleRequest                 → searched as a name

If multiple match, you'll see a numbered list. Pick one and re-run with
the full qn.
`,
  projects: `projects — how cortex names and finds them

Project name is derived from the git root's absolute path with slashes
replaced by hyphens. For example:

    /Users/rka/Development/anthill-cloud
    → Users-rka-Development-anthill-cloud

The CLI picks the project automatically from the cwd. To override:

    cortex code find foo --project=some-other-project

Listing what's indexed:

    cortex index list
`,
  indexing: `indexing — what gets indexed and where it lives

Cortex's native indexer extracts nodes (functions, modules, files,
decisions, …) and edges (CALLS, IMPORTS, GOVERNS, …) from your repo.

To index the current repo:

    cortex index .

To check status:

    cortex index status

The graph.db lives at one of two paths (in order of preference):

  • <repo>/.cortex/db                              (when CORTEX_DB is set)
  • ~/.cache/cortex-indexer/<project-name>.db     (fallback)
`,
  decisions: `decisions — what they are and how to capture them

A decision is a tracked architectural choice with rationale, alternatives,
and links to the code it governs. Create one when you make a choice that's
not obvious from the code itself.

Three states:

  • create:   directly create an active decision
  • propose:  create a 'proposed' decision (e.g. tied to a PR)
  • supersede: replace an existing decision with a new one (transactional)

Link to code:

    cortex decision link <id> src/auth.ts --relation=GOVERNS
    cortex decision link <id> docs/spec.md --relation=REFERENCES

See: cortex decision --help
`,
  eval: `eval — what the harness measures

The eval harness runs a fixed battery of assertions against an indexed
target (a Nuxt repo, anthill-cloud, etc.) and reports surprises — places
where the outcome differs from the baseline expectation.

To run:

    cortex eval                     # all targets in evals/targets.json
    cortex eval anthill-cloud       # one target
    cortex eval baseline <target>   # capture a new baseline

Read the latest summary:

    cortex eval report

See: docs/architecture/eval-harness.md
`,
};

export function renderTopic(topic: string): string {
  const text = TOPICS[topic];
  if (!text) {
    throw new UsageError(
      `unknown topic '${topic}'`,
      `Try: ${Object.keys(TOPICS).map((t) => `cortex help ${t}`).join(", ")}`,
    );
  }
  return text;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/cli/help.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/help.ts src/cli/commands/help.ts tests/cli/help.test.ts
git commit -m "feat(cli): help system — top-level, per-command, topic explainers

renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp drive
--help at three levels. renderTopic backs 'cortex help <topic>' with
narrative explainers for five concepts that bite users:
qualified-names, projects, indexing, decisions, eval.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: `tour.ts` — context-aware tour

Goal: render a guided walkthrough adapted to the cwd's state. Picks a real symbol from the indexed project so the example is native, not canned.

**Files:**

- Create: `src/cli/tour.ts`
- Create: `tests/cli/tour.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/tour.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { renderTour } from "../../src/cli/tour.js";
import type { ProjectContext } from "../../src/cli/context.js";

describe("tour", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-tour-"));
    dbPath = join(dir, "graph.db");
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("indexed state: starts at step 3 and uses a real function name", () => {
    const store = new GraphStore(dbPath);
    store.createNode({ kind: "function", name: "myRealFn", qualified_name: "test.src.myRealFn", file_path: "src/x.ts" });
    const ctx: ProjectContext = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: dbPath };
    const out = renderTour(ctx);
    expect(out).toContain("myRealFn");
    expect(out).not.toContain("Step 1 — index");
  });

  it("unindexed-repo state: starts at index step", () => {
    const ctx: ProjectContext = { state: "unindexed-repo", cwd: dir, projectName: "test", graphDbPath: null };
    const out = renderTour(ctx);
    expect(out).toContain("cortex index");
    expect(out).toContain("not indexed yet");
  });

  it("no-project state: hints to cd into a repo or list", () => {
    const ctx: ProjectContext = { state: "no-project", cwd: dir, projectName: null, graphDbPath: null };
    const out = renderTour(ctx);
    expect(out).toContain("cortex index list");
    expect(out).toContain("cd");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/tour.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `tour.ts`**

Create `src/cli/tour.ts`:

```ts
import { GraphStore } from "../graph/store.js";
import type { ProjectContext } from "./context.js";

function pickSampleFunction(dbPath: string, project: string): string {
  try {
    const store = new GraphStore(dbPath);
    const rows = store.queryRaw<{ name: string }>(
      "SELECT name FROM nodes WHERE kind = 'function' AND project = ? LIMIT 1",
      [project],
    );
    if (rows[0]?.name) return rows[0].name;
    // Fallback when 'project' column is empty.
    const any = store.queryRaw<{ name: string }>(
      "SELECT name FROM nodes WHERE kind = 'function' LIMIT 1",
    );
    return any[0]?.name ?? "handleRequest";
  } catch {
    return "handleRequest";
  }
}

export function renderTour(ctx: ProjectContext): string {
  if (ctx.state === "indexed" && ctx.graphDbPath && ctx.projectName) {
    const sample = pickSampleFunction(ctx.graphDbPath, ctx.projectName);
    return [
      `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
      ``,
      `You're in an indexed project: ${ctx.projectName}.`,
      `Skipping index setup — let's explore what's here.`,
      ``,
      `Step 1 — find a symbol by name`,
      `  cortex code find ${sample}`,
      ``,
      `Step 2 — show its source`,
      `  cortex code show <qn from step 1>`,
      ``,
      `Step 3 — who calls it`,
      `  cortex code where ${sample}`,
      ``,
      `Step 4 — what calls it depends on`,
      `  cortex code calls ${sample}`,
      ``,
      `Step 5 — why it was built this way`,
      `  cortex decision why src/some/file.ts`,
      ``,
      `Step 6 — the deep end`,
      `  cortex graph query 'MATCH (f:function) WHERE f.name = "${sample}" RETURN f'`,
      ``,
      `Next: \`cortex help projects\`, \`cortex --help\` for the full surface.`,
    ].join("\n");
  }
  if (ctx.state === "unindexed-repo") {
    return [
      `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
      ``,
      `This looks like a git repo, but it's not indexed yet.`,
      ``,
      `Step 1 — index it`,
      `  cortex index`,
      `  (takes 5–30 seconds depending on size)`,
      ``,
      `Step 2 — then re-run \`cortex tour\` to continue.`,
      ``,
      `Or jump straight in:`,
      `  cortex code find <name>`,
      `  cortex code show <qn>`,
    ].join("\n");
  }
  // no-project
  return [
    `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
    ``,
    `You're not in a project right now. Two ways to start:`,
    ``,
    `  • cd into a git repo you want to explore, then run: cortex index`,
    `  • Or look at an existing indexed project:`,
    `      cortex index list      see what's indexed`,
    `      cortex code find ...   try a query (use --project=<name>)`,
    ``,
    `Run \`cortex tour\` again once you're in an indexed project for the full walkthrough.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/tour.test.ts`
Expected: PASS — all 3 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/tour.ts tests/cli/tour.test.ts
git commit -m "feat(cli): context-aware tour

renderTour produces one of three flows based on ProjectState. The
'indexed' flow picks a real function name from the user's actual
graph so the example is native. 'unindexed-repo' starts at the index
step; 'no-project' suggests cd or index list.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: `install.ts` — PATH integration

Goal: `cortex install` symlinks `bin/cortex` into `~/.local/bin` if that's on PATH, else appends an alias to the shell rc. `--uninstall` reverses both.

**Files:**

- Create: `src/cli/install.ts`
- Create: `tests/cli/install.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/install.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectInstallTarget } from "../../src/cli/install.js";

describe("install — detection", () => {
  it("detectInstallTarget returns 'symlink' when ~/.local/bin is on PATH", () => {
    const target = detectInstallTarget({ home: "/home/test", path: "/usr/bin:/home/test/.local/bin", localBinExists: true });
    expect(target).toBe("symlink");
  });

  it("detectInstallTarget returns 'alias' when ~/.local/bin is not on PATH", () => {
    const target = detectInstallTarget({ home: "/home/test", path: "/usr/bin", localBinExists: true });
    expect(target).toBe("alias");
  });

  it("detectInstallTarget returns 'alias' when ~/.local/bin does not exist", () => {
    const target = detectInstallTarget({ home: "/home/test", path: "/usr/bin:/home/test/.local/bin", localBinExists: false });
    expect(target).toBe("alias");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/install.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `install.ts`**

Create `src/cli/install.ts`:

```ts
import { existsSync, symlinkSync, unlinkSync, lstatSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentError } from "./errors.js";

export type InstallTarget = "symlink" | "alias";

export type DetectInput = {
  home: string;
  path: string;
  localBinExists: boolean;
};

export function detectInstallTarget(input: DetectInput): InstallTarget {
  const dirs = input.path.split(":");
  const localBin = join(input.home, ".local/bin");
  if (input.localBinExists && dirs.includes(localBin)) return "symlink";
  return "alias";
}

function shellRcPath(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("zsh")) return join(homedir(), ".zshrc");
  if (shell.endsWith("fish")) return join(homedir(), ".config/fish/config.fish");
  return join(homedir(), ".bashrc");
}

const ALIAS_MARKER = "# Added by `cortex install`";

export function runInstall(opts: { quiet?: boolean; uninstall?: boolean }): void {
  const repoRoot = resolve(process.cwd());
  const cortexBin = join(repoRoot, "bin/cortex");
  if (!existsSync(cortexBin)) {
    throw new EnvironmentError(
      `bin/cortex not found at ${cortexBin}`,
      "Run this from the cortex repo root.",
    );
  }

  const home = homedir();
  const localBin = join(home, ".local/bin");
  const target = detectInstallTarget({
    home,
    path: process.env.PATH ?? "",
    localBinExists: existsSync(localBin),
  });

  if (opts.uninstall) {
    const symlink = join(localBin, "cortex");
    if (existsSync(symlink) && lstatSync(symlink).isSymbolicLink()) {
      unlinkSync(symlink);
      if (!opts.quiet) process.stdout.write(`removed ${symlink}\n`);
    }
    const rc = shellRcPath();
    if (existsSync(rc)) {
      const content = readFileSync(rc, "utf-8");
      const cleaned = content
        .split("\n")
        .filter((line) => !line.includes(ALIAS_MARKER) && !line.includes(`alias cortex=`))
        .join("\n");
      if (cleaned !== content) {
        writeFileSync(rc, cleaned);
        if (!opts.quiet) process.stdout.write(`updated ${rc}\n`);
      }
    }
    return;
  }

  if (target === "symlink") {
    const symlink = join(localBin, "cortex");
    if (existsSync(symlink) && lstatSync(symlink).isSymbolicLink()) {
      if (!opts.quiet) process.stdout.write(`already installed: ${symlink}\n`);
      return;
    }
    symlinkSync(cortexBin, symlink);
    if (!opts.quiet) process.stdout.write(`installed: ${symlink} → ${cortexBin}\n`);
    return;
  }

  // alias
  const rc = shellRcPath();
  const aliasLine = `alias cortex="${cortexBin}"  ${ALIAS_MARKER}`;
  const existing = existsSync(rc) ? readFileSync(rc, "utf-8") : "";
  if (existing.includes(`alias cortex=`)) {
    if (!opts.quiet) process.stdout.write(`already installed in ${rc}\n`);
    return;
  }
  appendFileSync(rc, `\n${aliasLine}\n`);
  if (!opts.quiet) {
    process.stdout.write(`installed: alias added to ${rc}\n`);
    process.stdout.write(`Open a new terminal or run: source ${rc}\n`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/install.test.ts`
Expected: PASS — all 3 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/install.ts tests/cli/install.test.ts
git commit -m "feat(cli): cortex install — PATH integration

Symlinks bin/cortex into ~/.local/bin when that's on PATH;
otherwise appends an alias to the user's shell rc (zsh/bash/fish).
Idempotent — re-running detects existing install. --uninstall
reverses both branches.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: `main.ts` — wire everything together

Goal: argv parsing → context loading → router dispatch → command handler invocation, with help/tour/install/version handled before namespace dispatch.

**Files:**

- Modify: `src/cli/main.ts` (replace the stub from Task 1)

- [ ] **Step 1: Replace the stub `src/cli/main.ts`**

```ts
#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgv, findSuggestion } from "./router.js";
import { loadContext } from "./context.js";
import { tryCommand, UsageError } from "./errors.js";
import { runCodeCommand } from "./commands/code.js";
import { runDecisionCommand } from "./commands/decision.js";
import { runGraphCommand } from "./commands/graph.js";
import { runIndexCommand } from "./commands/index.js";
import { runEvalCommand } from "./commands/eval.js";
import { renderTopic } from "./commands/help.js";
import { renderTopLevelHelp, renderNamespaceHelp, renderCommandHelp } from "./help.js";
import { renderTour } from "./tour.js";
import { runInstall } from "./install.js";

const NAMESPACES = ["code", "decision", "graph", "index", "eval"];
const META_COMMANDS = ["tour", "help", "install"];

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(1)); // strip node arg too; arg 0 is the tsx/script

  // Meta flags
  if (argv.flags.version || argv.flags.v) {
    process.stdout.write(`cortex ${getVersion()}\n`);
    return;
  }

  // Top-level help
  if ((argv.namespace === null || argv.namespace === "help") && (argv.flags.help || argv.flags.h || argv.namespace === null)) {
    process.stdout.write(renderTopLevelHelp() + "\n");
    return;
  }

  // Meta commands
  if (argv.namespace === "tour") {
    const ctx = loadContext(process.cwd());
    process.stdout.write(renderTour(ctx) + "\n");
    return;
  }
  if (argv.namespace === "help") {
    const topic = argv.command;
    if (!topic) {
      process.stdout.write(renderTopLevelHelp() + "\n");
      return;
    }
    process.stdout.write(renderTopic(topic) + "\n");
    return;
  }
  if (argv.namespace === "install") {
    runInstall({ quiet: argv.flags.quiet === true, uninstall: argv.flags.uninstall === true });
    return;
  }

  // Per-namespace --help
  if (argv.namespace && NAMESPACES.includes(argv.namespace)) {
    if (argv.flags.help || argv.flags.h) {
      if (argv.command) {
        process.stdout.write(renderCommandHelp(argv.namespace, argv.command) + "\n");
      } else {
        process.stdout.write(renderNamespaceHelp(argv.namespace) + "\n");
      }
      return;
    }
  }

  if (!argv.namespace) {
    process.stdout.write(renderTopLevelHelp() + "\n");
    return;
  }
  if (!NAMESPACES.includes(argv.namespace)) {
    const suggestion = findSuggestion(argv.namespace, [...NAMESPACES, ...META_COMMANDS]);
    throw new UsageError(
      `unknown namespace '${argv.namespace}'`,
      suggestion ? `Did you mean: cortex ${suggestion}?` : "Run: cortex --help",
    );
  }

  const ctx = loadContext(process.cwd());

  switch (argv.namespace) {
    case "code":
      return runCodeCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
    case "decision":
      return runDecisionCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
    case "graph":
      return runGraphCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
    case "index":
      return runIndexCommand({ command: argv.command, positionals: argv.positionals, flags: argv.flags }, ctx);
    case "eval":
      return runEvalCommand({ command: argv.command, positionals: argv.positionals, flags: argv.flags }, ctx);
  }
}

tryCommand(main);
```

- [ ] **Step 2: Verify everything compiles**

Run: `npx tsc --noEmit` from cortex repo root.
Expected: PASS.

If `src/cli/**` isn't covered by the existing tsconfig, you may need to either: (a) include it in the main `tsconfig.json` (recommended) or (b) create a `src/cli/tsconfig.json`. Quick check: existing files like `src/index.ts` are picked up; if `src/cli/main.ts` lights up the same way, no config change needed.

- [ ] **Step 3: Smoke test the basic flows**

```bash
bin/cortex --version
# expected: prints a version string + exit 0

bin/cortex --help
# expected: prints top-level help

bin/cortex code --help
# expected: prints code namespace help

bin/cortex code search --help
# expected: prints command help for `code search` with examples

bin/cortex help qualified-names
# expected: prints the qualified-names topic

bin/cortex tour
# expected: prints the no-project tour (run from /tmp); index-state tour (from /Users/rka/Development/cortex)

bin/cortex frobnicate
# expected: stderr 'unknown namespace frobnicate' + 'Did you mean ...' (no close match → exits 2)
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat(cli): wire main.ts — dispatch + meta handling

Argv parse → meta short-circuit (--version, --help, tour, help, install)
→ namespace dispatch. tryCommand wraps everything for unified error
rendering. Unknown namespaces get a 'did you mean' suggestion via
Levenshtein.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: Integration tests + final verification

Goal: spawn `bin/cortex` as a subprocess against the cortex repo's own indexed graph, verify happy paths across all namespaces, then commit + run install end-to-end.

**Files:**

- Create: `tests/cli/integration/happy-paths.test.ts`
- Modify: `scripts/build-indexer.sh` (append best-effort install)

- [ ] **Step 1: Write integration tests**

Create `tests/cli/integration/happy-paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const CORTEX = resolve(process.cwd(), "bin/cortex");

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(CORTEX, args, { encoding: "utf-8" });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

describe("cli integration — happy paths", () => {
  it("--version prints a version", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cortex \d+\.\d+\.\d+/);
  });

  it("--help prints top-level help", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Namespaces:");
    expect(r.stdout).toContain("code");
  });

  it("code --help prints namespace help", () => {
    const r = run(["code", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("search");
  });

  it("help qualified-names prints the topic", () => {
    const r = run(["help", "qualified-names"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("qualified name");
  });

  it("unknown namespace returns code 2", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown namespace");
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/cli/integration/happy-paths.test.ts`
Expected: PASS — 5/5 green.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS. (One pre-existing failure in `tests/frame-extraction/cluster-tfidf-hdbscan.test.ts` is acceptable — it's a Python-venv timing flake unrelated to this work.)

- [ ] **Step 4: Append cortex install to the postinstall script**

Modify `scripts/build-indexer.sh`: at the very end (after the indexer build succeeds), append:

```bash
# Best-effort: register the cortex CLI on PATH. Failure is non-fatal.
if [ -x "$ROOT/bin/cortex" ]; then
  "$ROOT/bin/cortex" install --quiet || \
    echo "cortex CLI was not auto-installed. Run \`$ROOT/bin/cortex install\` manually to add it to PATH."
fi
```

- [ ] **Step 5: Run the install command for real**

Run: `bin/cortex install`
Expected: either `installed: ~/.local/bin/cortex → <repo>/bin/cortex` (on systems where ~/.local/bin is on PATH) or `installed: alias added to ~/.zshrc` (with instructions to source the rc file).

Re-run: `bin/cortex install`
Expected: `already installed`.

- [ ] **Step 6: Commit**

```bash
git add tests/cli/integration/happy-paths.test.ts scripts/build-indexer.sh
git commit -m "test(cli): integration happy paths + auto-install on postinstall

Spawns bin/cortex as a subprocess; verifies --version, --help, namespace
help, topic help, and unknown-command exit codes. scripts/build-indexer.sh
now runs cortex install --quiet at the end of the npm postinstall;
failure prints a one-line manual-install instruction without failing
the install.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
npm test
```

Expected: all tests pass (excluding the pre-existing frame-extraction flake).

- [ ] **Run cortex against the cortex repo's own graph**

```bash
cd /Users/rka/Development/cortex
bin/cortex tour
# Expected: indexed-state tour with a real function name pulled from the graph.

bin/cortex code find handleRequest
# Expected: zero or more rows (depending on whether cortex has handleRequest); not an error.

bin/cortex code schema
# Expected: table of node labels + counts.

bin/cortex eval report
# Expected: prints the most recent eval summary.md (from the existing reports dir).
```

- [ ] **Run from anthill-cloud** (the original UX target)

```bash
cd /Users/rka/Development/anthill-cloud
cortex tour
# Expected: indexed-state tour, real symbol from the anthill-cloud graph.

cortex code show apps/activator/app/components/ADesignSystemCard.vue
# Expected: source code of the .vue file (no more "symbol not found" — the friction the field report flagged).
```

If anything in these checks fails, return to the relevant task and fix before declaring done.
