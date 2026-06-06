# Cross-Language Contract Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the C↔TS RPC seam a first-class, queryable graph fact so impact/trace queries cross the boundary and a check mechanically catches arg-key mismatches (the `detect_changes` bug class).

**Architecture:** A TS post-index pass (sibling to `frame-extraction`) scans the known RPC call sites — `callIndexer("tool", {keys})` in TS and `ctx_mcp_get_*_arg(args, "key")` inside `handle_<tool>` in C — and writes a general `Anchor` node + `BINDS_KEY` edges (`{role, keys}`) per tool into `.cortex/db`. A TS-native `check_contracts` MCP tool reads those edges and reports key-set mismatches + coverage. A regression test runs the pure extractor over the repo and guards against new mismatches.

**Tech Stack:** TypeScript, `better-sqlite3` (graph DB, same as `inject-frames`), `vitest`, the MCP `registerTool` helper.

**Spec:** [docs/superpowers/specs/2026-06-07-cross-language-contract-edges-design.md](../specs/2026-06-07-cross-language-contract-edges-design.md)

---

## File Structure

- `src/contracts/types.ts` — shared types (`Binding`, `Role`, `ContractMismatch`, `CoverageReport`, `ContractResult`).
- `src/contracts/diff.ts` — pure: `groupBindings`, `diffKeys`, `findMismatches`, `summarizeCoverage`.
- `src/contracts/parse.ts` — pure: `parseTsConsumers(src, file)`, `parseCProviders(src, file)`.
- `src/contracts/extract.ts` — `scanRepoContracts(repoPath)`: reads the known globs, runs parsers, aggregates `{ bindings, unrecognized }`.
- `src/contracts/inject.ts` — `injectContracts({ bindings, project, dbPath })`: idempotent upsert of `Anchor` nodes + `BINDS_KEY` edges (raw `better-sqlite3`, mirrors `inject-frames`).
- `src/contracts/run-contracts.ts` — `runContractExtraction({ repoPath, project, dbPath })`: orchestrator, never throws, returns discriminated `ContractResult` (mirrors `run-frames`).
- `src/mcp-server/tools/contract-tools.ts` — `check_contracts` MCP tool (reads persisted edges, diffs, returns report).
- Wiring: `src/mcp-server/tools/code-tools.ts:309` and `src/cli/commands/index.ts:46` (call after `runFrameExtraction`); MCP tool registration alongside existing code tools.
- Tests: `tests/contracts/diff.test.ts`, `tests/contracts/parse.test.ts`, `tests/contracts/inject.test.ts`, `tests/regression/contracts-rpc-seam.test.ts`.

Convention reference (read before starting): [src/frame-extraction/inject-frames.ts:346-405](../../../src/frame-extraction/inject-frames.ts#L346) (raw-SQL graph writes), [src/frame-extraction/run-frames.ts](../../../src/frame-extraction/run-frames.ts) (orchestrator shape), [src/mcp-server/repo-context.ts:390](../../../src/mcp-server/repo-context.ts#L390) (`registerTool`).

---

### Task 1: Contract model + diff (pure)

**Files:**
- Create: `src/contracts/types.ts`
- Create: `src/contracts/diff.ts`
- Test: `tests/contracts/diff.test.ts`

- [ ] **Step 1: Write the types**

`src/contracts/types.ts`:
```ts
export type Role = "provides" | "consumes";

/** One side of a contract: a tool's keys as seen at one call/handler. */
export interface Binding {
  tool: string;        // anchor key, e.g. "detect_changes"
  role: Role;
  keys: string[];      // arg keys sent (consumer) or read (provider)
  file: string;        // repo-relative source path
  symbol: string;      // enclosing symbol, e.g. "handle_detect_changes"
  line: number;        // 1-based line of the call/handler
}

export interface ContractMismatch {
  tool: string;
  provider_keys: string[];
  consumer_keys: string[];
  missing_on_provider: string[]; // sent by a consumer, never read by the provider
  missing_on_consumer: string[]; // read by the provider, never sent by a consumer
}

export interface CoverageReport {
  anchors: number;        // distinct tools seen
  providers: number;      // provider bindings
  consumers: number;      // consumer bindings
  matched: number;        // tools with >=1 provider AND >=1 consumer
  provider_only: string[];// tools with a handler but no caller
  consumer_only: string[];// tools called but with no handler
  unrecognized: number;   // call shapes seen but not parseable into keys
}

export type ContractResult =
  | { status: "ok"; anchors: number; mismatches: number; elapsedMs: number }
  | { status: "skipped"; reason: "disabled" | "no_db" }
  | { status: "failed"; reason: string };
```

- [ ] **Step 2: Write the failing test**

`tests/contracts/diff.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { groupBindings, diffKeys, findMismatches, summarizeCoverage } from "../../src/contracts/diff.js";
import type { Binding } from "../../src/contracts/types.js";

const b = (tool: string, role: "provides" | "consumes", keys: string[]): Binding =>
  ({ tool, role, keys, file: "f", symbol: "s", line: 1 });

describe("diffKeys", () => {
  it("reports sent-but-not-read and read-but-not-sent", () => {
    expect(diffKeys(["project"], ["repo_path"])).toEqual({
      missing_on_provider: ["repo_path"],
      missing_on_consumer: ["project"],
    });
  });
  it("is empty when key sets match", () => {
    expect(diffKeys(["a", "b"], ["b", "a"])).toEqual({ missing_on_provider: [], missing_on_consumer: [] });
  });
});

describe("findMismatches", () => {
  it("flags detect_changes (repo_path sent, project read)", () => {
    const bindings = [
      b("detect_changes", "provides", ["project"]),
      b("detect_changes", "consumes", ["repo_path"]),
    ];
    const m = findMismatches(bindings);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tool: "detect_changes", missing_on_provider: ["repo_path"], missing_on_consumer: ["project"] });
  });
  it("does not flag a matching contract", () => {
    const bindings = [b("x", "provides", ["repo_path"]), b("x", "consumes", ["repo_path"])];
    expect(findMismatches(bindings)).toEqual([]);
  });
  it("treats union of consumer keys across multiple call sites", () => {
    // two callers send different subsets; provider reads both → no mismatch
    const bindings = [
      b("y", "provides", ["a", "b"]),
      b("y", "consumes", ["a"]),
      b("y", "consumes", ["b"]),
    ];
    expect(findMismatches(bindings)).toEqual([]);
  });
});

describe("summarizeCoverage", () => {
  it("counts sides and flags one-sided anchors", () => {
    const bindings = [
      b("matched", "provides", ["a"]), b("matched", "consumes", ["a"]),
      b("dead", "provides", ["a"]),
      b("orphan", "consumes", ["a"]),
    ];
    expect(summarizeCoverage(bindings, 2)).toEqual({
      anchors: 3, providers: 2, consumers: 2, matched: 1,
      provider_only: ["dead"], consumer_only: ["orphan"], unrecognized: 2,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/contracts/diff.test.ts`
Expected: FAIL — cannot import `../../src/contracts/diff.js` (module missing).

- [ ] **Step 4: Write the implementation**

`src/contracts/diff.ts`:
```ts
import type { Binding, ContractMismatch, CoverageReport } from "./types.js";

export interface GroupedContract { providerKeys: Set<string>; consumerKeys: Set<string>; providers: number; consumers: number; }

/** Group bindings by tool, unioning keys across multiple call sites per side. */
export function groupBindings(bindings: readonly Binding[]): Map<string, GroupedContract> {
  const out = new Map<string, GroupedContract>();
  for (const b of bindings) {
    let g = out.get(b.tool);
    if (!g) { g = { providerKeys: new Set(), consumerKeys: new Set(), providers: 0, consumers: 0 }; out.set(b.tool, g); }
    const dst = b.role === "provides" ? g.providerKeys : g.consumerKeys;
    for (const k of b.keys) dst.add(k);
    if (b.role === "provides") g.providers++; else g.consumers++;
  }
  return out;
}

export function diffKeys(providerKeys: readonly string[], consumerKeys: readonly string[]): { missing_on_provider: string[]; missing_on_consumer: string[] } {
  const p = new Set(providerKeys), c = new Set(consumerKeys);
  return {
    missing_on_provider: [...c].filter((k) => !p.has(k)).sort(),
    missing_on_consumer: [...p].filter((k) => !c.has(k)).sort(),
  };
}

/** Mismatches over tools that have BOTH a provider and a consumer. */
export function findMismatches(bindings: readonly Binding[]): ContractMismatch[] {
  const out: ContractMismatch[] = [];
  for (const [tool, g] of groupBindings(bindings)) {
    if (g.providers === 0 || g.consumers === 0) continue; // one-sided → coverage, not mismatch
    const d = diffKeys([...g.providerKeys], [...g.consumerKeys]);
    if (d.missing_on_provider.length || d.missing_on_consumer.length) {
      out.push({ tool, provider_keys: [...g.providerKeys].sort(), consumer_keys: [...g.consumerKeys].sort(), ...d });
    }
  }
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}

export function summarizeCoverage(bindings: readonly Binding[], unrecognized: number): CoverageReport {
  const g = groupBindings(bindings);
  let providers = 0, consumers = 0, matched = 0;
  const provider_only: string[] = [], consumer_only: string[] = [];
  for (const [tool, c] of g) {
    providers += c.providers; consumers += c.consumers;
    if (c.providers > 0 && c.consumers > 0) matched++;
    else if (c.providers > 0) provider_only.push(tool);
    else consumer_only.push(tool);
  }
  return { anchors: g.size, providers, consumers, matched, provider_only: provider_only.sort(), consumer_only: consumer_only.sort(), unrecognized };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/contracts/diff.test.ts`
Expected: PASS (8 assertions across 6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/contracts/types.ts src/contracts/diff.ts tests/contracts/diff.test.ts
git commit -m "feat(contracts): contract model + key-diff (pure)"
```

---

### Task 2: TS consumer parser

**Files:**
- Create: `src/contracts/parse.ts`
- Test: `tests/contracts/parse.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/contracts/parse.test.ts` (TS section):
```ts
import { describe, it, expect } from "vitest";
import { parseTsConsumers } from "../../src/contracts/parse.js";

describe("parseTsConsumers", () => {
  it("extracts tool name and object-literal keys", () => {
    const src = `await callIndexer("detect_changes", { repo_path: ctx.repoPath });`;
    const { bindings } = parseTsConsumers(src, "code-tools.ts");
    expect(bindings).toMatchObject([{ tool: "detect_changes", role: "consumes", keys: ["repo_path"] }]);
  });
  it("handles callIndexerCache and multiple keys", () => {
    const src = `callIndexerCache("index_repository", { repo_path: p, mode: m });`;
    const { bindings } = parseTsConsumers(src, "f.ts");
    expect(bindings[0]).toMatchObject({ tool: "index_repository", keys: ["repo_path", "mode"] });
  });
  it("counts a non-literal arg as unrecognized (keys unknown)", () => {
    const src = `return callIndexer("query_graph", indexerArgs, dbPath);`;
    const { bindings, unrecognized } = parseTsConsumers(src, "f.ts");
    expect(bindings).toEqual([]);
    expect(unrecognized).toBe(1);
  });
  it("records the 1-based line number", () => {
    const src = `x\ny\ncallIndexer("delete_project", { project: n });`;
    expect(parseTsConsumers(src, "f.ts").bindings[0].line).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/parse.test.ts`
Expected: FAIL — `parseTsConsumers` not exported.

- [ ] **Step 3: Write the implementation**

`src/contracts/parse.ts` (add TS half):
```ts
import type { Binding } from "./types.js";

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

// callIndexer("tool", { ...literal... })  — object-literal arg → keys
const TS_LITERAL = /\bcallIndexer(?:Cache)?\s*\(\s*"([^"]+)"\s*,\s*\{([^}]*)\}/g;
// callIndexer("tool", identifier)         — non-literal arg → unrecognized
const TS_NONLITERAL = /\bcallIndexer(?:Cache)?\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const TS_KEY = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;

export function parseTsConsumers(src: string, file: string): { bindings: Binding[]; unrecognized: number } {
  const bindings: Binding[] = [];
  let unrecognized = 0;
  const litSpans: Array<[number, number]> = [];
  for (const m of src.matchAll(TS_LITERAL)) {
    const tool = m[1]!, body = m[2]!;
    litSpans.push([m.index!, m.index! + m[0].length]);
    const keys: string[] = [];
    for (const km of body.matchAll(TS_KEY)) keys.push(km[1]!);
    bindings.push({ tool, role: "consumes", keys, file, symbol: file, line: lineOf(src, m.index!) });
  }
  for (const m of src.matchAll(TS_NONLITERAL)) {
    // skip if this match overlaps a literal match already counted
    if (litSpans.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
    unrecognized++;
  }
  return { bindings, unrecognized };
}
```

> Note: the regex assumes the object literal contains no nested `}` on the same call (true for every current `callIndexer` site — they pass flat `{ repo_path, mode, project, traces }` objects). If a future call nests an object, it is conservatively counted via `TS_NONLITERAL` or dropped — never mis-parsed silently; the coverage report surfaces the gap.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/parse.test.ts -t parseTsConsumers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/parse.ts tests/contracts/parse.test.ts
git commit -m "feat(contracts): TS callIndexer consumer parser"
```

---

### Task 3: C provider parser

**Files:**
- Modify: `src/contracts/parse.ts`
- Test: `tests/contracts/parse.test.ts`

- [ ] **Step 1: Write the failing test** (append to `parse.test.ts`):
```ts
import { parseCProviders } from "../../src/contracts/parse.js";

describe("parseCProviders", () => {
  const src = [
    `static char *handle_detect_changes(ctx_mcp_server_t *srv, const char *args) {`,
    `  char *project = ctx_mcp_get_string_arg(args, "project");`,
    `  int n = ctx_mcp_get_int_arg(args, "limit");`,
    `  return ok;`,
    `}`,
    `static char *handle_delete_project(ctx_mcp_server_t *srv, const char *args) {`,
    `  char *name = ctx_mcp_get_string_arg(args, "project");`,
    `}`,
  ].join("\n");

  it("maps each handler to its read keys, stripping the handle_ prefix", () => {
    const { bindings } = parseCProviders(src, "handlers.c");
    expect(bindings).toEqual([
      { tool: "detect_changes", role: "provides", keys: ["project", "limit"], file: "handlers.c", symbol: "handle_detect_changes", line: 1 },
      { tool: "delete_project", role: "provides", keys: ["project"], file: "handlers.c", symbol: "handle_delete_project", line: 6 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/parse.test.ts -t parseCProviders`
Expected: FAIL — `parseCProviders` not exported.

- [ ] **Step 3: Write the implementation** (append to `src/contracts/parse.ts`):
```ts
const C_HANDLER = /\bstatic\s+char\s*\*\s*handle_([a-z0-9_]+)\s*\(/g;
const C_ARG = /ctx_mcp_get_(?:string|int|bool)_arg\s*\(\s*args\s*,\s*"([^"]+)"\s*\)/g;

export function parseCProviders(src: string, file: string): { bindings: Binding[]; unrecognized: number } {
  const heads = [...src.matchAll(C_HANDLER)];
  const bindings: Binding[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const start = h.index!;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : src.length;
    const body = src.slice(start, end);
    const keys: string[] = [];
    for (const am of body.matchAll(C_ARG)) if (!keys.includes(am[1]!)) keys.push(am[1]!);
    bindings.push({ tool: h[1]!, role: "provides", keys, file, symbol: `handle_${h[1]}`, line: lineOf(src, start) });
  }
  return { bindings, unrecognized: 0 };
}
```

> Note: the handler body is delimited by the next `handle_*` head (or EOF). Arg reads occurring before the first handler (none today) are ignored. Tool name = handler suffix; confirm against the dispatch table in `handlers.c` / `main.c::run_cli` that the dispatched name equals `handle_<name>` (it does for `detect_changes`, `delete_project`, etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/parse.test.ts`
Expected: PASS (both TS and C describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/parse.ts tests/contracts/parse.test.ts
git commit -m "feat(contracts): C handler provider parser"
```

---

### Task 4: Repo scanner (extract)

**Files:**
- Create: `src/contracts/extract.ts`
- Test: `tests/contracts/extract.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/contracts/extract.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepoContracts } from "../../src/contracts/extract.js";

describe("scanRepoContracts", () => {
  it("collects TS consumers and C providers across the known dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "contracts-"));
    try {
      mkdirSync(join(root, "src/mcp-server/tools"), { recursive: true });
      mkdirSync(join(root, "internal/indexer/src/handlers"), { recursive: true });
      writeFileSync(join(root, "src/mcp-server/tools/code-tools.ts"),
        `callIndexer("detect_changes", { repo_path: x });`);
      writeFileSync(join(root, "internal/indexer/src/handlers/handlers.c"),
        `static char *handle_detect_changes(s,a){ ctx_mcp_get_string_arg(args, "project"); }`);
      const { bindings, unrecognized } = scanRepoContracts(root);
      const tools = bindings.map((b) => `${b.role}:${b.tool}`).sort();
      expect(tools).toEqual(["consumes:detect_changes", "provides:detect_changes"]);
      expect(bindings.find((b) => b.role === "consumes")!.file).toBe("src/mcp-server/tools/code-tools.ts");
      expect(unrecognized).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/extract.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

`src/contracts/extract.ts`:
```ts
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseTsConsumers, parseCProviders } from "./parse.js";
import type { Binding } from "./types.js";

// Dirs scanned for each side. Kept narrow on purpose: these are the only places
// the indexer RPC convention appears. Extend here if new call sites are added.
const TS_DIRS = ["src", "scripts/frame-extraction"];
const C_DIRS = ["internal/indexer/src/handlers"];

function walk(dir: string, exts: string[], out: string[]) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
}

export function scanRepoContracts(repoPath: string): { bindings: Binding[]; unrecognized: number } {
  const bindings: Binding[] = [];
  let unrecognized = 0;
  const rel = (p: string) => relative(repoPath, p).split(sep).join("/");

  const tsFiles: string[] = [];
  for (const d of TS_DIRS) walk(join(repoPath, d), [".ts"], tsFiles);
  for (const f of tsFiles) {
    if (f.endsWith(".test.ts")) continue;
    const r = parseTsConsumers(readFileSync(f, "utf-8"), rel(f));
    bindings.push(...r.bindings); unrecognized += r.unrecognized;
  }

  const cFiles: string[] = [];
  for (const d of C_DIRS) walk(join(repoPath, d), [".c"], cFiles);
  for (const f of cFiles) {
    const r = parseCProviders(readFileSync(f, "utf-8"), rel(f));
    bindings.push(...r.bindings); unrecognized += r.unrecognized;
  }
  return { bindings, unrecognized };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/extract.ts tests/contracts/extract.test.ts
git commit -m "feat(contracts): repo scanner over known RPC dirs"
```

---

### Task 5: Regression guard over the real repo

**Files:**
- Test: `tests/regression/contracts-rpc-seam.test.ts`

- [ ] **Step 1: Write the test** (this is the proof-on-the-actual-bug; it asserts the extractor finds the seam and that mismatches equal a known allowlist):

`tests/regression/contracts-rpc-seam.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { scanRepoContracts } from "../../src/contracts/extract.js";
import { findMismatches, summarizeCoverage } from "../../src/contracts/diff.js";

// Known, documented mismatch awaiting HANDOFF #4 (detect_changes: TS sends
// repo_path, C reads project). Remove this entry when that fix lands; the test
// then enforces zero mismatches. See decision on detect_changes routing.
const KNOWN_MISMATCHES = new Set<string>(["detect_changes"]);

describe("RPC contract seam (real repo)", () => {
  const repo = resolve(__dirname, "../..");
  const { bindings, unrecognized } = scanRepoContracts(repo);

  it("finds the seam (non-empty contracts on both sides)", () => {
    const cov = summarizeCoverage(bindings, unrecognized);
    expect(cov.matched).toBeGreaterThan(0);
    expect(cov.providers).toBeGreaterThan(0);
    expect(cov.consumers).toBeGreaterThan(0);
  });

  it("has no contract mismatches beyond the known allowlist", () => {
    const unexpected = findMismatches(bindings).filter((m) => !KNOWN_MISMATCHES.has(m.tool));
    expect(unexpected).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/regression/contracts-rpc-seam.test.ts`
Expected: PASS. If the first test fails, the scanner's `TS_DIRS`/`C_DIRS` or regexes need adjustment to match the real files; if the second fails with a tool other than `detect_changes`, you found a real new mismatch — investigate before allowlisting.

- [ ] **Step 3: Commit**

```bash
git add tests/regression/contracts-rpc-seam.test.ts
git commit -m "test(contracts): regression guard over the real RPC seam"
```

---

### Task 6: Graph injection (Anchor + BINDS_KEY)

**Files:**
- Create: `src/contracts/inject.ts`
- Test: `tests/contracts/inject.test.ts`

- [ ] **Step 1: Write the failing test** (uses a temp DB with the real schema):

`tests/contracts/inject.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CREATE_TABLES } from "../../src/graph/schema.js";
import { injectContracts } from "../../src/contracts/inject.js";
import type { Binding } from "../../src/contracts/types.js";

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "contracts-db-"));
  const path = join(dir, "db");
  const db = new Database(path);
  db.exec(CREATE_TABLES);
  const now = new Date().toISOString();
  // a file node for the consumer source to attach to
  db.prepare(`INSERT INTO nodes (id,kind,name,file_path,data,tier,created_at,updated_at,project)
              VALUES ('n1','file','code-tools.ts','src/mcp-server/tools/code-tools.ts','{}','personal',?,?,'P')`).run(now, now);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const consumer: Binding = { tool: "detect_changes", role: "consumes", keys: ["repo_path"], file: "src/mcp-server/tools/code-tools.ts", symbol: "code-tools.ts", line: 5 };

describe("injectContracts", () => {
  it("creates an Anchor node and a BINDS_KEY edge from the file node", () => {
    const { path, cleanup } = tmpDb();
    try {
      injectContracts({ bindings: [consumer], project: "P", dbPath: path });
      const db = new Database(path, { readonly: true });
      const anchor = db.prepare(`SELECT id,kind,name FROM nodes WHERE kind='anchor' AND project='P'`).get() as any;
      expect(anchor).toMatchObject({ kind: "anchor", name: "detect_changes" });
      const edge = db.prepare(`SELECT source_id,target_id,relation,data FROM edges WHERE relation='BINDS_KEY' AND project='P'`).get() as any;
      expect(edge.source_id).toBe("n1");
      expect(edge.target_id).toBe(anchor.id);
      expect(JSON.parse(edge.data)).toMatchObject({ role: "consumes", keys: ["repo_path"] });
      db.close();
    } finally { cleanup(); }
  });

  it("is idempotent — re-running replaces prior anchors/edges, not appends", () => {
    const { path, cleanup } = tmpDb();
    try {
      injectContracts({ bindings: [consumer], project: "P", dbPath: path });
      injectContracts({ bindings: [consumer], project: "P", dbPath: path });
      const db = new Database(path, { readonly: true });
      const n = db.prepare(`SELECT COUNT(*) c FROM edges WHERE relation='BINDS_KEY' AND project='P'`).get() as any;
      expect(n.c).toBe(1);
      db.close();
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/inject.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

`src/contracts/inject.ts`:
```ts
import Database from "better-sqlite3";
import type { Binding } from "./types.js";

const anchorId = (tool: string) => `anchor:rpc_tool:${tool}`;

/** Idempotently write Anchor nodes + BINDS_KEY edges for the project. Edges
 *  attach to the FILE node of the binding's source file (resolved by path);
 *  bindings whose file has no node are skipped (counted by the caller's
 *  coverage if needed). Mirrors inject-frames' raw-better-sqlite3 + transaction
 *  style. Re-running first deletes the project's prior anchors/edges. */
export function injectContracts(args: { bindings: readonly Binding[]; project: string; dbPath: string }): number {
  const db = new Database(args.dbPath);
  try {
    const now = new Date().toISOString();
    const fileNodeId = db.prepare(`SELECT id FROM nodes WHERE project=? AND kind='file' AND file_path=?`);
    const upsertAnchor = db.prepare(`
      INSERT INTO nodes (id,kind,name,qualified_name,data,tier,created_at,updated_at,project)
      VALUES (@id,'anchor',@name,@name,@data,'personal',@now,@now,@project)
      ON CONFLICT(id) DO UPDATE SET updated_at=@now`);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id,source_id,target_id,relation,data,created_at,project)
      VALUES (@id,@source_id,@target_id,'BINDS_KEY',@data,@now,@project)`);

    let written = 0;
    const tx = db.transaction(() => {
      // idempotent reset for this project
      db.prepare(`DELETE FROM edges WHERE relation='BINDS_KEY' AND project=?`).run(args.project);
      db.prepare(`DELETE FROM nodes WHERE kind='anchor' AND project=?`).run(args.project);

      const seenAnchor = new Set<string>();
      for (const b of args.bindings) {
        const aid = anchorId(b.tool);
        if (!seenAnchor.has(aid)) {
          upsertAnchor.run({ id: aid, name: b.tool, data: JSON.stringify({ kind: "rpc_tool" }), now, project: args.project });
          seenAnchor.add(aid);
        }
        const fileRow = fileNodeId.get(args.project, b.file) as { id: string } | undefined;
        if (!fileRow) continue; // no node for this file in the graph — skip edge
        insertEdge.run({
          id: `binds:${b.role}:${b.tool}:${b.file}:${b.line}`,
          source_id: fileRow.id, target_id: aid,
          data: JSON.stringify({ role: b.role, keys: b.keys, symbol: b.symbol, line: b.line }),
          now, project: args.project,
        });
        written++;
      }
    });
    tx();
    return written;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/inject.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/inject.ts tests/contracts/inject.test.ts
git commit -m "feat(contracts): idempotent Anchor + BINDS_KEY graph injection"
```

---

### Task 7: Orchestrator + wire into the index path

**Files:**
- Create: `src/contracts/run-contracts.ts`
- Modify: `src/mcp-server/tools/code-tools.ts` (after the `runFrameExtraction` call, ~line 309)
- Modify: `src/cli/commands/index.ts` (after the `runFrameExtraction` call, ~line 46)
- Test: `tests/contracts/run-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/contracts/run-contracts.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runContractExtraction } from "../../src/contracts/run-contracts.js";

describe("runContractExtraction", () => {
  it("returns skipped (no_db) when the db path does not exist, never throws", async () => {
    const r = await runContractExtraction({ repoPath: "/nonexistent", project: "P", dbPath: "/nonexistent/db" });
    expect(r.status).toBe("skipped");
  });

  it("is disabled when CORTEX_CONTRACTS=0", async () => {
    const prev = process.env.CORTEX_CONTRACTS;
    process.env.CORTEX_CONTRACTS = "0";
    try {
      const r = await runContractExtraction({ repoPath: ".", project: "P", dbPath: "/tmp/whatever" });
      expect(r).toEqual({ status: "skipped", reason: "disabled" });
    } finally { process.env.CORTEX_CONTRACTS = prev; }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/run-contracts.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the orchestrator**

`src/contracts/run-contracts.ts`:
```ts
import { existsSync } from "node:fs";
import { scanRepoContracts } from "./extract.js";
import { injectContracts } from "./inject.js";
import { findMismatches } from "./diff.js";
import type { ContractResult } from "./types.js";

export interface RunContractOptions { repoPath: string; project: string; dbPath: string; }

/** Post-index pass: scan the RPC seam → write Anchor/BINDS_KEY edges. NEVER
 *  throws into the index path (mirrors run-frames); returns a discriminated
 *  result the caller surfaces. Gate: CORTEX_CONTRACTS≠0. */
export async function runContractExtraction(opts: RunContractOptions): Promise<ContractResult> {
  if (process.env.CORTEX_CONTRACTS === "0") return { status: "skipped", reason: "disabled" };
  if (!existsSync(opts.dbPath)) return { status: "skipped", reason: "no_db" };
  const started = Date.now();
  try {
    const { bindings } = scanRepoContracts(opts.repoPath);
    injectContracts({ bindings, project: opts.project, dbPath: opts.dbPath });
    const mismatches = findMismatches(bindings).length;
    const anchors = new Set(bindings.map((b) => b.tool)).size;
    return { status: "ok", anchors, mismatches, elapsedMs: Date.now() - started };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/run-contracts.test.ts`
Expected: PASS. (Note: `Date.now()` is fine in app code; only workflow scripts forbid it.)

- [ ] **Step 5: Wire into the MCP index path**

In `src/mcp-server/tools/code-tools.ts`, immediately after the existing `frames = await runFrameExtraction({ repoPath, project, dbPath });` (~line 309), add:
```ts
        const contracts = await runContractExtraction({ repoPath, project, dbPath });
```
Add the import near the `run-frames` import (~line 22):
```ts
import { runContractExtraction } from "../../contracts/run-contracts.js";
```
And include `contracts` in the JSON the tool already logs/returns next to `frames` (match the existing surfacing — e.g. append `contracts` to the result text/object so the index output shows `contracts: {...}` like it shows `frames: {...}`).

- [ ] **Step 6: Wire into the CLI index path**

In `src/cli/commands/index.ts`, after `const frames = await runFrameExtraction({ repoPath, project, dbPath });` (~line 46), add the import (top of file, beside the run-frames import) and:
```ts
    const contracts = await runContractExtraction({ repoPath, project, dbPath });
```
and print it beside the frames line, e.g.:
```ts
    if (contracts.status === "ok") console.log(`contracts: ${contracts.anchors} anchors, ${contracts.mismatches} mismatches`);
```

- [ ] **Step 7: Verify the full build + index path**

Run: `npx tsc --noEmit` → Expected: exit 0.
Run: `npm run dev` briefly, then in another shell `cortex index repository --path=$(pwd)` (or trigger `index_repository` via MCP) → Expected: output includes a `contracts:` line; no thrown errors. Then:
Run: `sqlite3 .cortex/db "SELECT COUNT(*) FROM nodes WHERE kind='anchor'; SELECT COUNT(*) FROM edges WHERE relation='BINDS_KEY';"` → Expected: both > 0.

- [ ] **Step 8: Commit**

```bash
git add src/contracts/run-contracts.ts tests/contracts/run-contracts.test.ts src/mcp-server/tools/code-tools.ts src/cli/commands/index.ts
git commit -m "feat(contracts): post-index extraction pass wired into CLI + MCP index"
```

---

### Task 8: `check_contracts` MCP tool

**Files:**
- Create: `src/mcp-server/tools/contract-tools.ts` (the pure `computeContractReport`)
- Modify: `src/mcp-server/tools/code-tools.ts` — add a `checkContractsShape`/`checkContractsSchema` (top, beside `queryGraphShape` ~line 88) and register the tool inside `registerCodeTools` (~line 327, beside the `query_graph`/`get_architecture` `server.tool(...)` calls)
- Test: `tests/contracts/check-contracts.test.ts`

- [ ] **Step 1: Write the failing test** (pure handler over a temp DB):

`tests/contracts/check-contracts.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CREATE_TABLES } from "../../src/graph/schema.js";
import { injectContracts } from "../../src/contracts/inject.js";
import { computeContractReport } from "../../src/mcp-server/tools/contract-tools.js";

describe("computeContractReport", () => {
  it("reports the detect_changes mismatch from persisted edges", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-")); const path = join(dir, "db");
    try {
      const db = new Database(path); db.exec(CREATE_TABLES);
      const now = new Date().toISOString();
      for (const [id, fp] of [["c","src/mcp-server/tools/code-tools.ts"],["h","internal/indexer/src/handlers/handlers.c"]] as const)
        db.prepare(`INSERT INTO nodes (id,kind,name,file_path,data,tier,created_at,updated_at,project) VALUES (?,'file',?,?,'{}','personal',?,?,'P')`).run(id, id, fp, now, now);
      db.close();
      injectContracts({ project: "P", dbPath: path, bindings: [
        { tool: "detect_changes", role: "consumes", keys: ["repo_path"], file: "src/mcp-server/tools/code-tools.ts", symbol: "c", line: 1 },
        { tool: "detect_changes", role: "provides", keys: ["project"], file: "internal/indexer/src/handlers/handlers.c", symbol: "handle_detect_changes", line: 1 },
      ]});
      const report = computeContractReport(path, "P");
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0]).toMatchObject({ tool: "detect_changes", missing_on_provider: ["repo_path"], missing_on_consumer: ["project"] });
      expect(report.coverage.matched).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/check-contracts.test.ts`
Expected: FAIL — `computeContractReport` not exported.

- [ ] **Step 3: Write the report fn + tool**

`src/mcp-server/tools/contract-tools.ts`:
```ts
import Database from "better-sqlite3";
import { findMismatches, summarizeCoverage } from "../../contracts/diff.js";
import type { Binding, ContractMismatch, CoverageReport } from "../../contracts/types.js";

export interface ContractReport { mismatches: ContractMismatch[]; coverage: CoverageReport; }

/** Rebuild bindings from persisted BINDS_KEY edges and diff them. */
export function computeContractReport(dbPath: string, project: string): ContractReport {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT a.name AS tool, e.data AS data
      FROM edges e JOIN nodes a ON a.id = e.target_id
      WHERE e.relation='BINDS_KEY' AND e.project=? AND a.kind='anchor'`).all(project) as Array<{ tool: string; data: string }>;
    const bindings: Binding[] = rows.map((r) => {
      const d = JSON.parse(r.data) as { role: "provides" | "consumes"; keys: string[]; symbol: string; line: number };
      return { tool: r.tool, role: d.role, keys: d.keys, file: "", symbol: d.symbol, line: d.line };
    });
    return { mismatches: findMismatches(bindings), coverage: summarizeCoverage(bindings, 0) };
  } finally {
    db.close();
  }
}
```

Then register the tool in `code-tools.ts`, mirroring the `query_graph` wiring verbatim. Add the shape/schema near `queryGraphShape` (~line 88):
```ts
const checkContractsShape = { repo_path: RepoPathField } as const;
const checkContractsSchema = z.object(checkContractsShape);
```
Add the import at the top of `code-tools.ts`:
```ts
import { computeContractReport } from "./contract-tools.js";
```
Register inside `registerCodeTools(...)` (~line 327), beside the other `server.tool(...)` blocks — note `ctx.graphDbPath` is the addressed db path and `projectFromCtx(ctx)` derives the in-graph project, exactly as `query_graph`/`get_architecture` use them:
```ts
  server.tool(
    "check_contracts",
    "Report cross-language RPC contract mismatches (arg-key diffs) + coverage",
    checkContractsShape,
    registerTool(
      "check_contracts",
      checkContractsSchema,
      async (ctx) => {
        const report = computeContractReport(ctx.graphDbPath, projectFromCtx(ctx) ?? "");
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      },
      { resolver },
    ),
  );
```
(`RepoPathField`, `registerTool`, `resolver`, and `projectFromCtx` are already in scope in `code-tools.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/check-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the tool end-to-end**

Run: `npx tsc --noEmit` → exit 0.
Re-index the repo (Task 7 step 7), then call `check_contracts` via MCP with `repo_path` = the cortex root. Expected: JSON with `coverage.matched > 0` and `mismatches` containing `detect_changes` (until HANDOFF #4 is fixed).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/contract-tools.ts tests/contracts/check-contracts.test.ts src/mcp-server/tools/code-tools.ts
git commit -m "feat(contracts): check_contracts MCP tool over persisted edges"
```

---

## Final verification

- [ ] `npx tsc --noEmit` → exit 0
- [ ] `npm test` → full suite green (new: diff, parse, extract, inject, run-contracts, check-contracts, regression)
- [ ] `cortex index` shows a `contracts:` line; `.cortex/db` has `anchor` nodes + `BINDS_KEY` edges
- [ ] `check_contracts` (MCP) returns the `detect_changes` mismatch + coverage
- [ ] Capture a decision (`create_decision`) recording the Anchor/BINDS_KEY model and the scan-based extractor choice; link it to this plan + the spec
- [ ] Update HANDOFF: add cross-language contract edges to shipped; note the `detect_changes` fix now has a guard waiting

## Notes for the implementer

- **Path alignment:** the scanner emits repo-relative paths with `/` separators; `nodes.file_path` is stored the same way. If `injectContracts` finds zero file nodes for known files, verify the stored `file_path` format against a sample (`SELECT file_path FROM nodes WHERE kind='file' LIMIT 5`) and align.
- **`detect_changes` allowlist:** Task 5's regression test allowlists the one known mismatch. When HANDOFF #4 fixes the C handler to read `repo_path`, remove the allowlist entry — the test then enforces zero mismatches permanently.
- **Why scan, not graph-query, for call sites:** the graph has no call-site nodes (only symbol defs + `CALLS`/`USAGE` edges), so the consumer side can't be located via the graph; a scoped source scan is both necessary and simpler. Confirmed via `get_graph_schema`.
