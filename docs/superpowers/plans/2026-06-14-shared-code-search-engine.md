# Shared `code_search` Engine + CLI Ripgrep Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `cortex code search` through the same ripgrep + graph-annotation engine the MCP `search_code` tool uses, via a shared `src/graph/code-search.ts` module — fixing the CLI's capped/doc-biased indexer backend.

**Architecture:** Extract the rg helpers + a new `runCodeSearch` engine into `src/graph/code-search.ts`. The MCP tool becomes a thin wrapper (byte-identical output). The CLI's `cmdSearch` calls the engine, ranks hits code-first via `KIND_WEIGHT`, and renders structured rows.

**Tech Stack:** TypeScript, Vitest, `@vscode/ripgrep`, better-sqlite3 (`GraphStore`).

**Spec:** [docs/superpowers/specs/2026-06-14-shared-code-search-engine-design.md](../specs/2026-06-14-shared-code-search-engine-design.md)

---

## File Structure

- **Create** `src/graph/code-search.ts` — rg helpers (moved from `code-tools.ts`), `runCodeSearch`, `rankSearchHits`, and the search types.
- **Modify** `src/mcp-server/tools/code-tools.ts` — delete the moved helpers, re-export them from the new module, rewrite the `search_code` handler as a wrapper.
- **Modify** `src/cli/commands/code.ts` — rewrite `cmdSearch` to use `runCodeSearch`.
- **Modify** `src/cli/help.ts` — correct the `search` entry.
- **Create** `tests/graph/code-search.test.ts`; **Modify** `tests/cli/commands/code.test.ts`.

Reference (existing, unchanged): `IndexerNode` and `GraphStore` in `src/graph/`,
`KIND_WEIGHT` in `src/graph/node-ranker.ts`, `writeRows`/`chooseFormat` in
`src/cli/format.ts`, `clampLimit`/`clampOffset` in `src/graph/search-params.ts`.

---

## Task 1: Move rg helpers into `src/graph/code-search.ts` (pure refactor)

Move the search subprocess helpers out of `code-tools.ts` with **no behavior
change**. The existing tests `tests/mcp-contract/search-code-args.test.ts` and
`search-code-errors.test.ts` import these from `code-tools.js`, so `code-tools.ts`
must **re-export** them.

**Files:**
- Create: `src/graph/code-search.ts`
- Modify: `src/mcp-server/tools/code-tools.ts` (lines 221-376 region)

- [ ] **Step 1: Create `src/graph/code-search.ts` with the moved helpers**

Copy these **verbatim** from `code-tools.ts` (lines 221-376) into the new file,
with the imports they need at the top:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { accessSync, constants as fsConstants } from "node:fs";

const execFileAsync = promisify(execFile);

const RG_MAX_BUFFER = 64 * 1024 * 1024;

export function buildRgArgs(pattern: string): string[] {
  return ["--no-heading", "--line-number", "--color=never", "--max-count", "200", pattern, "."];
}

export function buildGrepFallbackArgs(pattern: string): string[] {
  return [
    "-rn", "-I", "-m", "200",
    "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist",
    "--exclude-dir=build", "--exclude-dir=.cache", "--exclude-dir=vendored",
    "--exclude-dir=.tmp", "--exclude-dir=.cortex", "--exclude-dir=.venv",
    pattern, ".",
  ];
}

const localRequire = createRequire(import.meta.url);
let cachedRgBinary: string | null | undefined;

export function resolveRgBinary(): string {
  const override = process.env.CORTEX_RG_PATH;
  if (override) return override;
  if (cachedRgBinary === undefined) {
    try {
      const { rgPath } = localRequire("@vscode/ripgrep") as { rgPath: string };
      accessSync(rgPath, fsConstants.X_OK);
      cachedRgBinary = rgPath;
    } catch {
      cachedRgBinary = null;
    }
  }
  return cachedRgBinary ?? "rg";
}

export type SearchExecError = {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
};

export type SearchExecOutcome =
  | { kind: "output"; stdout: string }
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };

const REGEX_ERROR_RE =
  /regex parse error|error parsing regex|regular expression|not balanced|trailing backslash|unclosed|invalid repetition|repetition[- ]operator|unmatched\s*[[\](){}]/i;

export function classifySearchExec(err: SearchExecError): SearchExecOutcome {
  if (err.code === "ENOENT") return { kind: "missing" };
  const stdout = typeof err.stdout === "string" ? err.stdout : "";
  const stderr = typeof err.stderr === "string" ? err.stderr : "";
  const hasOutput = stdout.trim().length > 0;
  if (err.code === 1) return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  if (err.code === 2) {
    if (!hasOutput && REGEX_ERROR_RE.test(stderr)) {
      return { kind: "invalid_pattern", detail: stderr.trim() };
    }
    return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  }
  if (err.killed || err.signal === "SIGTERM" || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  }
  if (hasOutput) return { kind: "output", stdout };
  return { kind: "error", detail: err.message ?? String(err) };
}
```

Keep the explanatory comment blocks from the original (the classifier docstring
lines 291-326 and 328-340) — paste them above the corresponding declarations.

- [ ] **Step 2: Delete the moved helpers from `code-tools.ts` and re-export them**

From `code-tools.ts`, delete only these moved declarations: `buildRgArgs`,
`buildGrepFallbackArgs`, `resolveRgBinary`, `localRequire`/`cachedRgBinary`,
`REGEX_ERROR_RE`, `classifySearchExec`, and the `SearchExecError` /
`SearchExecOutcome` type declarations (plus their comment blocks).

**Keep in `code-tools.ts` (untouched):** `const execFileAsync = promisify(execFile);`
(line 221), `const RG_MAX_BUFFER = …` (line 224), and the
`import { join, dirname } from "node:path";` (line 222). The `search_code`
handler still references `execFileAsync` and `RG_MAX_BUFFER` directly until
Task 4 rewrites it — leaving them avoids a temporary compile break. (Yes,
`code-search.ts` also defines its own `execFileAsync`/`RG_MAX_BUFFER` — that
duplication is intentional and temporary; Task 4 removes the copies in
`code-tools.ts`.)

Add an import + re-export near the top of `code-tools.ts` so the contract tests
(`tests/mcp-contract/search-code-args.test.ts`, `search-code-errors.test.ts`),
which import these from `code-tools.js`, keep working:

```ts
import {
  buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec,
} from "../../graph/code-search.js";
import type { SearchExecError, SearchExecOutcome } from "../../graph/code-search.js";
export { buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec };
export type { SearchExecError, SearchExecOutcome };
```

The `search_code` handler body still calls `buildRgArgs(pattern)`,
`resolveRgBinary()`, `classifySearchExec(...)`, `buildGrepFallbackArgs(...)` —
those now resolve to the imported (moved) versions. No handler change in Task 1.

(`runCodeSearch`/`rankSearchHits` arrive in Tasks 2-3; do NOT import them yet.)

- [ ] **Step 3: Verify the contract tests + typecheck still pass**

Run: `npx tsc --noEmit && npx vitest run tests/mcp-contract/search-code-args.test.ts tests/mcp-contract/search-code-errors.test.ts`
Expected: PASS — the helpers behave identically; only their file moved.

- [ ] **Step 4: Commit**

```bash
git add src/graph/code-search.ts src/mcp-server/tools/code-tools.ts
git commit -m "refactor(graph): move rg search helpers to graph/code-search"
```

---

## Task 2: `runCodeSearch` engine + tests

**Files:**
- Modify: `src/graph/code-search.ts`
- Test: `tests/graph/code-search.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/graph/code-search.test.ts`. It runs real ripgrep over a temp dir
and uses a hand-built `GraphStore` for enrichment (mirrors `code.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { runCodeSearch } from "../../src/graph/code-search.js";

describe("runCodeSearch", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-search-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export function extractThing() {\n  return doExtract();\n}\n");
    writeFileSync(join(dir, "notes.md"), "# Doc\nthis mentions extract in prose\n");
    const dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
    const fn = store.createNode({ kind: "function", name: "extractThing", qualified_name: "p.src.a.extractThing", file_path: "src/a.ts" });
    // span lines 1-3 so the match on line 1/2 falls inside it
    const db = new Database(dbPath);
    db.prepare("UPDATE nodes SET project = ?, start_line = 1, end_line = 3 WHERE id = ?").run("p", fn.id);
    db.close();
  });
  afterEach(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns hits with file/line/text parsed from rg output", async () => {
    const out = await runCodeSearch({ pattern: "extract", repoRoot: dir, maxHits: 50 });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    const files = out.hits.map((h) => h.file);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("notes.md");
    const aHit = out.hits.find((h) => h.file === "src/a.ts")!;
    expect(aHit.line).toBeGreaterThan(0);
    expect(aHit.text).toContain("extract");
  });

  it("annotates the enclosing symbol when store + project are given", async () => {
    const out = await runCodeSearch({ pattern: "extract", repoRoot: dir, store, project: "p", maxHits: 50 });
    if (out.kind !== "hits") throw new Error("expected hits");
    const aHit = out.hits.find((h) => h.file === "src/a.ts" && h.enclosing)!;
    expect(aHit.enclosing!.kind).toBe("function");
    expect(aHit.enclosing!.qualified_name).toBe("p.src.a.extractThing");
    // a markdown prose hit has no enclosing code symbol
    const mdHit = out.hits.find((h) => h.file === "notes.md")!;
    expect(mdHit.enclosing).toBeUndefined();
  });

  it("caps the number of hits at maxHits", async () => {
    const out = await runCodeSearch({ pattern: "extract", repoRoot: dir, maxHits: 1 });
    if (out.kind !== "hits") throw new Error("expected hits");
    expect(out.hits.length).toBe(1);
  });

  it("returns empty for a pattern with no matches", async () => {
    const out = await runCodeSearch({ pattern: "zzznomatchzzz", repoRoot: dir });
    expect(out.kind).toBe("empty");
  });

  it("returns invalid_pattern for a bad regex", async () => {
    const out = await runCodeSearch({ pattern: "(", repoRoot: dir });
    expect(out.kind).toBe("invalid_pattern");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/graph/code-search.test.ts`
Expected: FAIL — `runCodeSearch` is not exported.

- [ ] **Step 3: Implement `runCodeSearch` + types in `src/graph/code-search.ts`**

Add the imports for enrichment and the engine:

```ts
import type { GraphStore } from "./store.js";
import type { IndexerNode } from "./code-queries.js";

export type SearchHit = {
  file: string;
  line: number;
  text: string;
  enclosing?: { kind: string; qualified_name: string; file_path: string };
};

export type SearchOutcome =
  | { kind: "hits"; hits: SearchHit[] }
  | { kind: "empty" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };

const HIT_LINE_RE = /^\.\/(.+?):(\d+):(.*)$/;

export async function runCodeSearch(opts: {
  pattern: string;
  repoRoot: string;
  store?: GraphStore;
  project?: string;
  maxHits?: number;
}): Promise<SearchOutcome> {
  const maxHits = opts.maxHits ?? 50;
  const execOpts = { timeout: 10_000, maxBuffer: RG_MAX_BUFFER, cwd: opts.repoRoot };

  let stdout = "";
  try {
    const r = await execFileAsync(resolveRgBinary(), buildRgArgs(opts.pattern), execOpts);
    stdout = r.stdout;
  } catch (rgErr) {
    const outcome = classifySearchExec(rgErr as SearchExecError);
    if (outcome.kind === "output") stdout = outcome.stdout;
    else if (outcome.kind === "empty") return { kind: "empty" };
    else if (outcome.kind === "invalid_pattern") return { kind: "invalid_pattern", detail: outcome.detail };
    else if (outcome.kind === "missing") {
      try {
        const r2 = await execFileAsync("grep", buildGrepFallbackArgs(opts.pattern), execOpts);
        stdout = r2.stdout;
      } catch (grepErr) {
        const o2 = classifySearchExec(grepErr as SearchExecError);
        if (o2.kind === "output") stdout = o2.stdout;
        else if (o2.kind === "empty") return { kind: "empty" };
        else if (o2.kind === "invalid_pattern") return { kind: "invalid_pattern", detail: o2.detail };
        else if (o2.kind === "missing") return { kind: "error", detail: "Neither rg nor grep available on PATH." };
        else return { kind: "error", detail: o2.detail };
      }
    } else return { kind: "error", detail: outcome.detail };
  }

  if (!stdout.trim()) return { kind: "empty" };

  const hits: SearchHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(HIT_LINE_RE);
    if (!m) continue;
    hits.push({ file: m[1], line: parseInt(m[2], 10), text: m[3] });
    if (hits.length >= maxHits) break;
  }
  if (hits.length === 0) return { kind: "empty" };

  if (opts.store && opts.project) {
    for (const hit of hits) {
      const enclosing = opts.store.queryRaw<IndexerNode>(
        `SELECT * FROM nodes
         WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
           AND kind NOT IN ('decision', 'pr', 'todo')
         ORDER BY (end_line - start_line) ASC LIMIT 1`,
        [opts.project, hit.file, hit.line, hit.line],
      );
      if (enclosing.length > 0) {
        hit.enclosing = { kind: enclosing[0].kind, qualified_name: enclosing[0].qualified_name, file_path: enclosing[0].file_path };
      }
    }
  }
  return { kind: "hits", hits };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/graph/code-search.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/graph/code-search.ts tests/graph/code-search.test.ts
git commit -m "feat(graph): runCodeSearch ripgrep engine with enclosing-symbol enrichment"
```

---

## Task 3: `rankSearchHits` + test

**Files:**
- Modify: `src/graph/code-search.ts`
- Test: `tests/graph/code-search.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/graph/code-search.test.ts`:

```ts
import { rankSearchHits } from "../../src/graph/code-search.js";
import type { SearchHit } from "../../src/graph/code-search.js";

describe("rankSearchHits", () => {
  const fn = (over: Partial<SearchHit>): SearchHit => ({ file: "f", line: 1, text: "t", ...over });

  it("ranks function-enclosed hits above module-enclosed above unenclosed", () => {
    const hits = [
      fn({ file: "z.md", enclosing: undefined }),
      fn({ file: "m.ts", enclosing: { kind: "module", qualified_name: "m", file_path: "m.ts" } }),
      fn({ file: "a.ts", enclosing: { kind: "function", qualified_name: "a.fn", file_path: "a.ts" } }),
    ];
    const ranked = rankSearchHits(hits);
    expect(ranked.map((h) => h.file)).toEqual(["a.ts", "m.ts", "z.md"]);
  });

  it("is a stable file/line tiebreak at equal weight", () => {
    const e = { kind: "function", qualified_name: "x", file_path: "x" };
    const hits = [fn({ file: "b.ts", line: 2, enclosing: e }), fn({ file: "b.ts", line: 1, enclosing: e }), fn({ file: "a.ts", line: 9, enclosing: e })];
    const ranked = rankSearchHits(hits);
    expect(ranked.map((h) => `${h.file}:${h.line}`)).toEqual(["a.ts:9", "b.ts:1", "b.ts:2"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/graph/code-search.test.ts -t rankSearchHits`
Expected: FAIL — `rankSearchHits` not exported.

- [ ] **Step 3: Implement `rankSearchHits`**

Add to `src/graph/code-search.ts` (import `KIND_WEIGHT`):

```ts
import { KIND_WEIGHT } from "./node-ranker.js";

const UNENCLOSED_WEIGHT = 0;

/** Order hits code-first: by enclosing-symbol kind weight (function/class/method
 *  high, module low, unenclosed lowest), then file, then line. Pure; new array.
 *  This demotes Markdown/doc hits (which enclose to a `module` node or nothing)
 *  beneath real code hits without a doc-extension list. */
export function rankSearchHits(hits: SearchHit[]): SearchHit[] {
  const weight = (h: SearchHit) => (h.enclosing ? (KIND_WEIGHT[h.enclosing.kind] ?? 0.5) : UNENCLOSED_WEIGHT);
  return [...hits].sort(
    (a, b) =>
      weight(b) - weight(a) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/graph/code-search.test.ts`
Expected: PASS (all, incl. the 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/graph/code-search.ts tests/graph/code-search.test.ts
git commit -m "feat(graph): rankSearchHits orders code-symbol hits above doc/module"
```

---

## Task 4: MCP `search_code` handler → wrapper (output byte-identical)

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (the `search_code` handler, ~lines 1041-1143; and the Task-1 import block)

- [ ] **Step 1: Replace the handler body**

Replace the entire async handler (from `async (ctx, args) => {` through its
closing `}` before `{ resolver, freshnessAware: true }`) with:

```ts
      async (ctx, args) => {
        const { pattern } = args;
        const project = projectFromCtx(ctx);
        const outcome = await runCodeSearch({
          pattern,
          repoRoot: ctx.repoPath,
          store: ctx.store,
          project: project ?? undefined,
          maxHits: 50,
        });
        if (outcome.kind === "empty") return empty(`search_code(${pattern})`);
        if (outcome.kind === "invalid_pattern") {
          return errorResponse(
            "invalid_pattern",
            `Pattern rejected by ripgrep: ${outcome.detail}\n` +
              "search_code uses ripgrep regex syntax — escape regex metacharacters " +
              "(e.g. \\( \\[ \\. \\*) to match them literally.",
          );
        }
        if (outcome.kind === "error") return errorResponse("internal_error", outcome.detail);
        const text = outcome.hits
          .map((h) => {
            const base = `./${h.file}:${h.line}:${h.text}`;
            return h.enclosing
              ? `${base}  // in ${h.enclosing.kind} ${denormalize(h.enclosing.qualified_name, h.enclosing.file_path)}`
              : base;
          })
          .join("\n");
        return ok(text);
      },
```

- [ ] **Step 2: Clean up the Task-1 import**

Now that the handler uses `runCodeSearch`, update the import added in Task 1 to
include it and drop `RG_MAX_BUFFER` / `execFileAsync` if no longer referenced in
`code-tools.ts`:

```ts
import {
  buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec, runCodeSearch,
} from "../../graph/code-search.js";
import type { SearchExecError, SearchExecOutcome } from "../../graph/code-search.js";
export { buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec };
export type { SearchExecError, SearchExecOutcome };
```

Then remove the now-unused `const execFileAsync = promisify(execFile);` and the
`RG_MAX_BUFFER` import/usage from `code-tools.ts` **only if** `tsc` reports them
unused (the `execFile`/`promisify` imports may still be used elsewhere — check
before deleting). Leave whatever is still referenced.

- [ ] **Step 3: Typecheck + run the search_code contract tests (the regression gate)**

Run: `npx tsc --noEmit && npx vitest run tests/mcp-contract/code-tools.test.ts tests/mcp-contract/search-code-args.test.ts tests/mcp-contract/search-code-errors.test.ts`
Expected: PASS — search_code output is byte-identical (the `./file:line:text  // in kind qn` form, capped at 50, anchored to `ctx.repoPath`).

Note: the no-project path now also caps at 50 hits (previously it returned all
raw rg lines). This is an intentional, minor tightening; the contract tests use
an indexed project and are unaffected. If any test asserts >50 no-project lines,
stop and report it.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "refactor(mcp): search_code handler delegates to shared runCodeSearch"
```

---

## Task 5: CLI `cmdSearch` ripgrep swap + help + tests

**Files:**
- Modify: `src/cli/commands/code.ts` (`cmdSearch`, imports)
- Modify: `src/cli/help.ts` (the `search` entry)
- Test: `tests/cli/commands/code.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/cli/commands/code.test.ts`, make these exact edits to the existing
`beforeEach` (it currently creates DB-only nodes `n1`-`n4` and has no on-disk
files). First, ensure `writeFileSync` is imported:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

Add `gitRoot: dir` to the `ctx` object so search anchors to the temp dir:

```ts
    ctx = { state: "indexed", cwd: dir, gitRoot: dir, projectName: "test", graphDbPath: dbPath };
```

After the existing `store.createNode(...)` calls for `n1`-`n4`, add a fifth node
plus two real files, and extend the project `UPDATE` to include `n5.id` and set
its line span:

```ts
    const n5 = store.createNode({ kind: "function", name: "fooThing", qualified_name: "test.thing.fooThing", file_path: "thing.ts" });
    writeFileSync(join(dir, "thing.ts"), "export function fooThing() {\n  return 1;\n}\n");
    writeFileSync(join(dir, "notes.md"), "# Notes\nfoo appears in prose here\n");
```

Then change the existing project-stamping UPDATE to include `n5` and span its
lines (replace the existing `db.prepare("UPDATE nodes SET project = ? WHERE id IN (?, ?, ?, ?)")...`
line with):

```ts
    db.prepare("UPDATE nodes SET project = ? WHERE id IN (?, ?, ?, ?, ?)").run("test", n1.id, n2.id, n3.id, n4.id, n5.id);
    db.prepare("UPDATE nodes SET start_line = 1, end_line = 3 WHERE id = ?").run(n5.id);
```

(`fooThing` spanning lines 1-3 means the rg match on line 1 of `thing.ts` falls
inside it; `notes.md` has no node, so its `foo` prose hit is unenclosed and ranks
last.)

Tests (add a `describe("cmdSearch", …)` block):

```ts
  it("search: ranks code-symbol hits above doc/prose hits", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "search", positionals: ["foo"], flags: { format: "plain" } }, ctx);
    const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const firstLine = out.trim().split("\n")[0];
    expect(firstLine).toContain("thing.ts");  // function-enclosed hit ranks first
    expect(out.indexOf("thing.ts")).toBeLessThan(out.indexOf("notes.md")); // code before doc
    vi.restoreAllMocks();
  });

  it("search --kind: emits a redirect-to-find hint on stderr", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "search", positionals: ["foo"], flags: { kind: "function", format: "plain" } }, ctx);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(err).toContain("cortex code find");
    vi.restoreAllMocks();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli/commands/code.test.ts -t "search"`
Expected: FAIL — current `cmdSearch` dumps raw indexer JSON (no `thing.ts`
ranking, no redirect hint).

- [ ] **Step 3: Rewrite `cmdSearch` and update imports**

In `src/cli/commands/code.ts`, add imports:

```ts
import { runCodeSearch, rankSearchHits } from "../../graph/code-search.js";
```

Replace `cmdSearch` with:

```ts
async function cmdSearch(cmd: CodeCommand, ctx: ProjectContext): Promise<void> {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <pattern>", "Usage: cortex code search <pattern>");

  // `search` is full-text (ripgrep); kind filtering belongs to symbol search.
  if (cmd.flags.kind !== undefined || cmd.flags.kinds !== undefined) {
    process.stderr.write(
      "note: --kind has no effect on 'search' (full-text). " +
        `Use: cortex code find ${pattern} --kind=…  (symbol search)\n`,
    );
  }

  const store = new GraphStore(ctx.graphDbPath);
  const outcome = await runCodeSearch({
    pattern,
    repoRoot: ctx.gitRoot ?? ctx.cwd,
    store,
    project: ctx.projectName,
    maxHits: 500,
  });
  if (outcome.kind === "invalid_pattern") {
    throw new DomainError(`pattern rejected: ${outcome.detail}`, "Escape regex metacharacters (e.g. \\( \\[ \\. \\*) to match them literally.");
  }
  if (outcome.kind === "error") throw new DomainError(outcome.detail);

  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  const ranked = rankSearchHits(outcome.kind === "hits" ? outcome.hits : []);
  const limit = clampLimit(cmd.flags.limit !== undefined ? Number(cmd.flags.limit) : undefined);
  const offset = clampOffset(cmd.flags.offset !== undefined ? Number(cmd.flags.offset) : undefined);
  const page = ranked.slice(offset, offset + limit);
  const rows = page.map((h) => ({
    file: h.file,
    line: h.line,
    symbol: h.enclosing ? `${h.enclosing.kind} ${h.enclosing.qualified_name}` : "",
    text: h.text.trim(),
  }));
  writeRows(rows, fmt, ranked.length === 0
    ? `no matches for '${pattern}' in ${ctx.projectName}`
    : `offset ${offset} is past the ${ranked.length} match(es)`);
  if (page.length > 0) {
    process.stderr.write(`# showing ${offset + 1}–${offset + page.length} of ${ranked.length}\n`);
  }
}
```

`cmdSearch` is now `async`; the `runCodeCommand` switch already `return`s it, and
`runCodeCommand` is already `async`, so no caller change is needed.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/cli/commands/code.test.ts`
Expected: PASS (existing + 2 new search tests).

- [ ] **Step 5: Correct the `search` help entry**

In `src/cli/help.ts`, replace the `search` block with:

```ts
    search: {
      usage: "cortex code search <pattern> [--limit=N] [--offset=N]",
      description:
        "Full-text search across ALL indexed files (including docs/Markdown), " +
        "each hit annotated with its enclosing symbol and ranked code-first. " +
        "For symbols by name — and for --kind filtering — use 'cortex code find'.",
      examples: [
        "cortex code search ribbon",
        "cortex code search 'parseBody'",
      ],
      seeAlso: ["cortex code find", "cortex code show"],
    },
```

- [ ] **Step 6: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (all). Note `cmdSearch` no longer calls `runIndexer` for search;
if `runIndexer`/`unwrapIndexerResult`/`renderIndexerResult` become unused, leave
them — `cmdShow` still uses `runIndexer`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/code.ts src/cli/help.ts tests/cli/commands/code.test.ts
git commit -m "feat(cli): cortex code search uses shared ripgrep engine, ranked code-first"
```

---

## After all tasks

- **Gate 0 (live):** `npx tsx src/cli/main.ts code search extract --format=plain` against this repo — confirm **code hits now appear and rank above `.md`** (the original bug), `--kind` prints the redirect hint, `--limit`/`--offset` page. Also spot-check the MCP tool output is unchanged via `tests/mcp-contract/code-tools.test.ts`.
- **Gate 1:** `/review` on the diff since branch point.
- **Decision capture:** `create_decision` for the shared-engine extraction + CLI-ranks/MCP-doesn't asymmetry, linked to `D-fq9g` (the search_graph ranking decision) and citing this spec.
- **Gate 2 + merge:** full suite, version bump (patch → 0.3.13) across `package.json` / `plugin.json` / `.claude-plugin/marketplace.json` + CHANGELOG entry, `--no-ff` merge.
