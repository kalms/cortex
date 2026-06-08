# Decision Reconciliation Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a decision's code-alignment (`match`/`partial`/`drift`/`unknown`) from a working-tree hash of its governed source, judged by the in-session agent, surfaced on decision reads and a SessionStart banner — behind a feature flag.

**Architecture:** Two orthogonal axes on a decision: the stored `status` (human intent) and a derived, cached `reconciliation` verdict (code-alignment). A working-tree `governed_source_hash` is the invalidation trigger — recomputed at read time, and when it differs from the hash a verdict was judged against, the verdict is stale-pending. Judgment is agent-delegated: read tools hand the agent prose + current source with a "reconcile this" instruction; the agent calls `record_reconciliation`, which stamps a freshly server-computed hash. Everything is gated by `CORTEX_RECONCILE` (default off).

**Tech Stack:** TypeScript (ESM), better-sqlite3, vitest, Zod, the MCP SDK. Design spec: [docs/superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md](../specs/2026-06-08-decision-reconciliation-engine-design.md).

---

## Shared types & signatures (referenced across tasks)

Defined in Task 1 (`DecisionRecord` fields) and Task 3 (`reconciliation.ts`). Listed here so later tasks stay consistent:

- `DecisionRecord` gains (all `?: string | null`): `reconciliation_verdict`, `reconciled_at`, `reconciled_source_hash`, `reconciled_by`, `nonconformant_nodes`, `reconciliation_note`.
- `type Verdict = "match" | "partial" | "drift";`
- `type ReconciliationState = Verdict | "unknown";`
- `interface GovernedRef { target_kind: string; target_ref: string }`
- `hashGovernedSource(repoPath: string, refs: GovernedRef[]): string`
- `displayState(status: string, verdict: string | null | undefined): string`
- `interface ReconciliationFields { reconciliation_verdict: string; reconciled_at: string; reconciled_source_hash: string; reconciled_by: string; nonconformant_nodes: string | null; reconciliation_note: string | null; }`
- `DecisionsRepository.recordReconciliation(id: string, fields: ReconciliationFields): void`
- `RECONCILE_ENABLED(): boolean` → `process.env.CORTEX_RECONCILE === "1"`

---

## Task 1: Additive reconciliation schema

**Files:**
- Modify: `src/decisions/db.ts` (after `ensureProvenanceColumn`, ~line 115; call site in `openDecisionsDb` ~line 124)
- Test: `tests/decisions/db-reconciliation-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";

const RECON_COLS = [
  "reconciliation_verdict", "reconciled_at", "reconciled_source_hash",
  "reconciled_by", "nonconformant_nodes", "reconciliation_note",
];

function cols(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("reconciliation schema migration", () => {
  it("adds all reconciliation columns to a fresh DB", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recon-")), "decisions.db");
    const db = openDecisionsDb(path);
    const present = cols(db);
    for (const c of RECON_COLS) expect(present).toContain(c);
    db.close();
  });

  it("adds columns idempotently to a pre-existing DB lacking them", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recon-")), "decisions.db");
    // Simulate an old DB: create the base table WITHOUT reconciliation columns.
    const raw = new Database(path);
    raw.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    raw.close();
    const db = openDecisionsDb(path);          // first open migrates
    const db2 = openDecisionsDb(path);         // second open is a no-op
    for (const c of RECON_COLS) expect(cols(db2)).toContain(c);
    db.close(); db2.close();
  });

  it("leaves the FTS triggers intact (insert still mirrors to FTS)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recon-")), "decisions.db");
    const db = openDecisionsDb(path);
    db.prepare(`INSERT INTO decisions (id,title,description,rationale,problem,resolution,
      alternatives,tier,status,superseded_by,author,provenance,created_at,updated_at)
      VALUES ('d1','Bundle ripgrep',NULL,NULL,NULL,NULL,NULL,'personal','active',NULL,NULL,NULL,'t','t')`).run();
    const hit = db.prepare("SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'ripgrep'").all();
    expect(hit.length).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/db-reconciliation-migration.test.ts`
Expected: FAIL — the fresh-DB and pre-existing cases fail because columns don't exist.

- [ ] **Step 3: Add the migration function and call it**

In `src/decisions/db.ts`, add after `ensureProvenanceColumn` (~line 115):

```typescript
/** Additively add the reconciliation columns to pre-existing DBs. Idempotent. */
function ensureReconciliationColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  const additions: Array<[string, string]> = [
    ["reconciliation_verdict", "TEXT"],
    ["reconciled_at", "TEXT"],
    ["reconciled_source_hash", "TEXT"],
    ["reconciled_by", "TEXT"],
    ["nonconformant_nodes", "TEXT"],
    ["reconciliation_note", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!have.has(name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${type}`);
  }
}
```

In `openDecisionsDb`, add the call right after `ensureProvenanceColumn(db);` (~line 124):

```typescript
  ensureProvenanceColumn(db);
  ensureReconciliationColumns(db);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/db-reconciliation-migration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/db.ts tests/decisions/db-reconciliation-migration.test.ts
git commit -m "feat(db): additive reconciliation columns on decisions table"
```

---

## Task 2: Repository read columns + recordReconciliation

**Files:**
- Modify: `src/decisions/repository.ts`
- Test: `tests/decisions/repository-reconciliation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, type DecisionRecord } from "../../src/decisions/repository.js";

function rec(id: string): DecisionRecord {
  return { id, title: "t", description: null, rationale: null, problem: null,
    resolution: null, alternatives: null, tier: "personal", status: "active",
    superseded_by: null, author: null, provenance: null, created_at: "t", updated_at: "t" };
}

describe("DecisionsRepository reconciliation", () => {
  it("records a verdict and reads it back via get()", () => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "repo-")), "d.db"));
    const repo = new DecisionsRepository(db);
    repo.insert(rec("d1"));
    repo.recordReconciliation("d1", {
      reconciliation_verdict: "drift",
      reconciled_at: "2026-06-08T00:00:00Z",
      reconciled_source_hash: "abc123",
      reconciled_by: "claude-opus-4-8",
      nonconformant_nodes: JSON.stringify([{ ref: "src/x.ts", note: "renamed" }]),
      reconciliation_note: "function gone",
    });
    const got = repo.get("d1")!;
    expect(got.reconciliation_verdict).toBe("drift");
    expect(got.reconciled_source_hash).toBe("abc123");
    expect(got.reconciled_by).toBe("claude-opus-4-8");
    db.close();
  });

  it("get() returns null reconciliation fields for an unjudged decision", () => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "repo-")), "d.db"));
    const repo = new DecisionsRepository(db);
    repo.insert(rec("d2"));
    const got = repo.get("d2")!;
    expect(got.reconciliation_verdict ?? null).toBeNull();
    expect(got.reconciled_at ?? null).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/repository-reconciliation.test.ts`
Expected: FAIL — `recordReconciliation` is not a function; `reconciliation_verdict` undefined.

- [ ] **Step 3: Extend the record type, read columns, and add the method**

In `src/decisions/repository.ts`, add the fields to `DecisionRecord` (after `updated_at`, ~line 20):

```typescript
  // Reconciliation (code-alignment) — derived, cached. Null until first judged.
  reconciliation_verdict?: string | null;
  reconciled_at?: string | null;
  reconciled_source_hash?: string | null;
  reconciled_by?: string | null;
  nonconformant_nodes?: string | null; // JSON array of { ref, note }
  reconciliation_note?: string | null;
```

Add a read-columns constant below `SELECT_COLS` (~line 30) and a fields interface:

```typescript
const RECON_COLS =
  "reconciliation_verdict, reconciled_at, reconciled_source_hash, reconciled_by, nonconformant_nodes, reconciliation_note";
const READ_COLS = `${SELECT_COLS}, ${RECON_COLS}`;

export interface ReconciliationFields {
  reconciliation_verdict: string;
  reconciled_at: string;
  reconciled_source_hash: string;
  reconciled_by: string;
  nonconformant_nodes: string | null;
  reconciliation_note: string | null;
}
```

Change the three readers to select `READ_COLS` instead of `SELECT_COLS`. **`insert()` keeps `SELECT_COLS`** so new columns default NULL and the named-param set is unchanged:
- `get()` (~line 64): `` `SELECT ${READ_COLS} FROM decisions WHERE id = ?` ``
- `list()` (~line 71): `` `SELECT ${READ_COLS} FROM decisions ORDER BY created_at DESC` ``
- `search()` (~line 79): change the column map to `READ_COLS.split(", ").map((c) => "d." + c).join(", ")`

Add the method after `search()` (~line 86):

```typescript
  /** Stamp the latest reconciliation verdict. The caller (record_reconciliation
   *  tool) is responsible for computing reconciled_source_hash against the
   *  current working tree, so the verdict is always bound to real source. */
  recordReconciliation(id: string, f: ReconciliationFields): void {
    this.db
      .prepare(
        `UPDATE decisions SET
           reconciliation_verdict = @reconciliation_verdict,
           reconciled_at          = @reconciled_at,
           reconciled_source_hash = @reconciled_source_hash,
           reconciled_by          = @reconciled_by,
           nonconformant_nodes    = @nonconformant_nodes,
           reconciliation_note    = @reconciliation_note
         WHERE id = @id`,
      )
      .run({ ...f, id });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/repository-reconciliation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing decision suite to confirm no regression**

Run: `npx vitest run tests/decisions/ tests/mcp-contract/decision-tools.test.ts`
Expected: PASS (READ_COLS change must not break existing reads).

- [ ] **Step 6: Commit**

```bash
git add src/decisions/repository.ts tests/decisions/repository-reconciliation.test.ts
git commit -m "feat(db): DecisionsRepository.recordReconciliation + read columns"
```

---

## Task 3: Pure reconciliation module (hash + projection)

**Files:**
- Create: `src/decisions/reconciliation.ts`
- Test: `tests/decisions/reconciliation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashGovernedSource, displayState, RECONCILE_ENABLED } from "../../src/decisions/reconciliation.js";

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gov-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return dir;
}

describe("hashGovernedSource", () => {
  it("is deterministic for the same content", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "path", target_ref: "a.ts" }];
    expect(hashGovernedSource(dir, refs)).toBe(hashGovernedSource(dir, refs));
  });

  it("changes when a governed file's content changes", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "path", target_ref: "a.ts" }];
    const before = hashGovernedSource(dir, refs);
    writeFileSync(join(dir, "a.ts"), "beta");
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });

  it("is order-independent across refs", () => {
    const dir = repoWith({ "a.ts": "alpha", "b.ts": "beta" });
    const h1 = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "a.ts" }, { target_kind: "path", target_ref: "b.ts" }]);
    const h2 = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "b.ts" }, { target_kind: "path", target_ref: "a.ts" }]);
    expect(h1).toBe(h2);
  });

  it("resolves a qn ref to the file part before '::'", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const viaPath = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "a.ts" }]);
    const viaQn = hashGovernedSource(dir, [{ target_kind: "qn", target_ref: "a.ts::someFn" }]);
    // Same underlying file bytes, but the ref string differs, so hashes differ
    // by design (the ref is part of the hash). Assert both are stable, not equal.
    expect(viaQn).toBe(hashGovernedSource(dir, [{ target_kind: "qn", target_ref: "a.ts::someFn" }]));
    expect(viaQn).not.toBe(viaPath);
  });

  it("uses a <missing> sentinel for a deleted governed file (and changes when it disappears)", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "path", target_ref: "a.ts" }];
    const before = hashGovernedSource(dir, refs);
    rmSync(join(dir, "a.ts"));
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });
});

describe("displayState", () => {
  it.each([
    ["active", "match", "active"],
    ["active", "partial", "active · drifting"],
    ["active", "drift", "stale"],
    ["active", "unknown", "active · unreconciled"],
    ["active", null, "active · unreconciled"],
    ["superseded", "drift", "superseded"],
    ["deprecated", "match", "deprecated"],
    ["proposed", "drift", "proposed"],
  ])("status=%s verdict=%s → %s", (status, verdict, expected) => {
    expect(displayState(status, verdict)).toBe(expected);
  });
});

describe("RECONCILE_ENABLED", () => {
  it("is true only when CORTEX_RECONCILE=1", () => {
    const prev = process.env.CORTEX_RECONCILE;
    try {
      process.env.CORTEX_RECONCILE = "1"; expect(RECONCILE_ENABLED()).toBe(true);
      process.env.CORTEX_RECONCILE = "0"; expect(RECONCILE_ENABLED()).toBe(false);
      delete process.env.CORTEX_RECONCILE; expect(RECONCILE_ENABLED()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CORTEX_RECONCILE; else process.env.CORTEX_RECONCILE = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/reconciliation.test.ts`
Expected: FAIL — module `src/decisions/reconciliation.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/decisions/reconciliation.ts`:

```typescript
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

export type Verdict = "match" | "partial" | "drift";
export type ReconciliationState = Verdict | "unknown";

export interface GovernedRef {
  target_kind: string; // "qn" | "path" | "decision" | "pr"
  target_ref: string;
}

/** True only when reconciliation is explicitly enabled. Default off (v1). */
export function RECONCILE_ENABLED(): boolean {
  return process.env.CORTEX_RECONCILE === "1";
}

/**
 * Resolve a GOVERNS ref to a repo-relative file path, or null if it does not
 * name code (decision/pr refs, or a bare dotted qn we can't map to a file
 * without the graph). "path" refs pass through; "qn" refs use the file part
 * before "::".
 */
function refToFile(ref: GovernedRef): string | null {
  if (ref.target_kind === "decision" || ref.target_kind === "pr") return null;
  const r = ref.target_ref;
  if (r.includes("::")) return r.slice(0, r.indexOf("::"));
  if (r.includes("/") || /\.[a-z0-9]+$/i.test(r)) return r;
  return null; // bare dotted qn — unresolvable to a file in v1
}

/**
 * Working-tree hash of a decision's governed source. Reads CURRENT bytes from
 * disk (NOT git HEAD) so in-session edits flip a decision stale-pending before
 * any commit — the property that makes reconciliation live. Reuses the
 * sha256(sorted(ref \0 bytes)) shape from src/db/cache.ts:grammarPackHash.
 *
 * A directory ref is walked (sorted) so frame/folder governance hashes its
 * whole subtree. A missing file contributes a "<missing>" sentinel so deletion
 * registers as drift. Unresolvable refs contribute only their ref string, so
 * relinking still changes the hash deterministically.
 */
export function hashGovernedSource(repoPath: string, refs: GovernedRef[]): string {
  const h = createHash("sha256");
  // Sort by ref string for order-independence.
  const sorted = [...refs].sort((a, b) => (a.target_ref < b.target_ref ? -1 : a.target_ref > b.target_ref ? 1 : 0));
  for (const ref of sorted) {
    h.update(ref.target_ref);
    h.update("\0");
    const rel = refToFile(ref);
    if (rel == null) { h.update("<unresolved>\0"); continue; }
    const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
    if (!existsSync(abs)) { h.update("<missing>\0"); continue; }
    const st = statSync(abs);
    if (st.isDirectory()) hashDir(h, abs, abs); else h.update(readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

function hashDir(h: ReturnType<typeof createHash>, root: string, dir: string): void {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) hashDir(h, root, p);
    else { h.update(relative(root, p)); h.update("\0"); h.update(readFileSync(p)); }
  }
}

/**
 * Project the two stored axes (status, reconciliation verdict) into a single
 * human-facing display state. "stale" is active ∧ drift — never stored.
 */
export function displayState(status: string, verdict: string | null | undefined): string {
  if (status !== "active") return status;
  switch (verdict) {
    case "match": return "active";
    case "partial": return "active · drifting";
    case "drift": return "stale";
    default: return "active · unreconciled"; // "unknown" or null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/reconciliation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/reconciliation.ts tests/decisions/reconciliation.test.ts
git commit -m "feat(decisions): working-tree governed-source hash + displayState projection"
```

---

## Task 4: `record_reconciliation` MCP tool

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`
- Test: `tests/mcp-contract/reconciliation-tools.test.ts`

- [ ] **Step 1: Write the failing test**

This reuses the existing `tests/mcp-contract/harness.ts` (`createHarness` / `callTool`
auto-injects `repo_path`; `h.repoPath` is a real git root we can write governed
files into). Reconciliation runs flag-gated, so the suite sets `CORTEX_RECONCILE=1`.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("record_reconciliation", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); process.env.CORTEX_RECONCILE = "1"; });
  afterAll(async () => { delete process.env.CORTEX_RECONCILE; await h.close(); });

  it("rejects a decision with zero GOVERNS links", async () => {
    const created = await callTool(h, "create_decision", { title: "no-governs", description: "d", rationale: "r" });
    const id = JSON.parse(created.content[0].text).id;
    const res = await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });
    expect(res.isError).toBeTruthy();
    expect(res.content[0].text).toMatch(/governs/i);
  });

  it("match round-trip: record → get_decision shows verdict + display_state active", async () => {
    writeFileSync(join(h.repoPath, "x.ts"), "export const v = 1;\n");
    const created = await callTool(h, "create_decision", {
      title: "governs x", description: "d", rationale: "r", resolution: "x exports v = 1",
    });
    const id = JSON.parse(created.content[0].text).id;
    await callTool(h, "link_decision", { decision_id: id, target: "x.ts", relation: "GOVERNS" });
    const rec = await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });
    expect(rec.isError).toBeFalsy();
    const parsed = JSON.parse((await callTool(h, "get_decision", { id })).content[0].text);
    expect(parsed.reconciliation_verdict).toBe("match");
    expect(parsed.display_state).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-contract/reconciliation-tools.test.ts`
Expected: FAIL — module `reconciliation-tools.js` does not exist.

- [ ] **Step 3: Create the reconciliation tools module with `record_reconciliation`**

Create `src/mcp-server/tools/reconciliation-tools.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, empty, error as errorResponse } from "../response.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { hashGovernedSource, type GovernedRef } from "../../decisions/reconciliation.js";

const RepoPathField = z
  .string().min(1).optional()
  .describe("REQUIRED. Absolute path to the indexed git root this decision is about.");

const recordReconciliationShape = {
  repo_path: RepoPathField,
  decision_id: z.string().describe("Decision id to record a verdict for"),
  verdict: z.enum(["match", "partial", "drift"]).describe("Code-alignment judgment"),
  nonconformant: z.array(z.object({ ref: z.string(), note: z.string() })).optional()
    .describe("Specific governed refs that drifted, with a short note each"),
  note: z.string().optional().describe("One-line human summary of the drift"),
} as const;
const recordReconciliationSchema = z.object(recordReconciliationShape);

/** GOVERNS links for a decision, as GovernedRef[]. */
function governedRefs(ctx: RepoContext, decisionId: string): GovernedRef[] {
  return ctx.decisionLinksRepo
    .findByDecision(decisionId)
    .filter((l) => l.relation === "GOVERNS")
    .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
}

export function registerReconciliationTools(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "record_reconciliation",
    "Record a code-alignment verdict (match/partial/drift) for a decision after judging its prose against its governed source. The server recomputes the governed-source hash itself.",
    recordReconciliationShape,
    registerTool(
      "record_reconciliation",
      recordReconciliationSchema,
      async (ctx, args) => {
        const dec = ctx.decisionsRepo.get(args.decision_id);
        if (!dec) return empty(`record_reconciliation(${args.decision_id})`);
        const refs = governedRefs(ctx, args.decision_id);
        if (refs.length === 0) {
          return errorResponse(
            "not_reconcilable",
            `Decision ${args.decision_id} has no GOVERNS links — it is declarative (process-level) and cannot be reconciled against code.`,
          );
        }
        // Bind the verdict to the source the SERVER sees right now, never a
        // hash the agent passes. This is the integrity guarantee.
        const hash = hashGovernedSource(ctx.repoPath, refs);
        const nowIso = new Date().toISOString();
        ctx.decisionsRepo.recordReconciliation(args.decision_id, {
          reconciliation_verdict: args.verdict,
          reconciled_at: nowIso,
          reconciled_source_hash: hash,
          reconciled_by: process.env.CORTEX_AGENT_ID ?? "agent",
          nonconformant_nodes: args.nonconformant ? JSON.stringify(args.nonconformant) : null,
          reconciliation_note: args.note ?? null,
        });
        return ok(JSON.stringify({ decision_id: args.decision_id, verdict: args.verdict, reconciled_at: nowIso }, null, 2));
      },
      { resolver },
    ),
  );
}
```

> `new Date().toISOString()` is allowed in server runtime code (the no-`Date.now()`
> rule applies only to Workflow scripts, not to MCP handlers — `service.ts` already
> stamps timestamps this way).

- [ ] **Step 4: Register the module in the server bootstrap**

Open `src/mcp-server/server.ts`, find where `registerDecisionTools(...)` is called, and add directly after it:

```typescript
  registerReconciliationTools(server, resolver);
```

Add the import at the top of `server.ts`:

```typescript
import { registerReconciliationTools } from "./tools/reconciliation-tools.js";
```

**Also register it in the test harness** so contract tests can call it. In
`tests/mcp-contract/harness.ts`, add the import and a registration line beside
the others (~line 153, after `registerPRTools(...)`):

```typescript
import { registerReconciliationTools } from "../../src/mcp-server/tools/reconciliation-tools.js";
// …inside createHarness, after registerPRTools(server, resolver, project):
  registerReconciliationTools(server, resolver);
```

- [ ] **Step 5: Run the contract test**

Run: `npx vitest run tests/mcp-contract/reconciliation-tools.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/reconciliation-tools.ts src/mcp-server/server.ts tests/mcp-contract/reconciliation-tools.test.ts
git commit -m "feat(api): record_reconciliation tool (server-stamped governed hash)"
```

---

## Task 5: `pending_reconciliations` MCP tool

**Files:**
- Modify: `src/mcp-server/tools/reconciliation-tools.ts`
- Test: `tests/mcp-contract/reconciliation-tools.test.ts` (add cases)

- [ ] **Step 1: Write the failing test (add to the existing describe in reconciliation-tools.test.ts)**

```typescript
it("pending_reconciliations: lists active+drifted with source; excludes in-sync", async () => {
  writeFileSync(join(h.repoPath, "y.ts"), "export const y = 1;\n");
  const c = await callTool(h, "create_decision", { title: "governs y", description: "d", rationale: "r", resolution: "y is 1" });
  const id = JSON.parse(c.content[0].text).id;
  await callTool(h, "link_decision", { decision_id: id, target: "y.ts", relation: "GOVERNS" });
  await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });

  // In sync → not pending.
  let res = await callTool(h, "pending_reconciliations", {});
  let ids = res.isError ? [] : (JSON.parse(res.content[0].text).pending as Array<{ id: string }>).map((p) => p.id);
  expect(ids).not.toContain(id);

  // Edit the governed file → drifted → pending, with current source inlined.
  writeFileSync(join(h.repoPath, "y.ts"), "export const y = 2;\n");
  res = await callTool(h, "pending_reconciliations", {});
  const entry = (JSON.parse(res.content[0].text).pending as Array<any>).find((p) => p.id === id);
  expect(entry).toBeDefined();
  expect(entry.governed[0].source).toContain("y = 2");
});

it("pending_reconciliations: excludes superseded decisions", async () => {
  writeFileSync(join(h.repoPath, "z.ts"), "export const z = 1;\n");
  const c = await callTool(h, "create_decision", { title: "governs z", description: "d", rationale: "r" });
  const id = JSON.parse(c.content[0].text).id;
  await callTool(h, "link_decision", { decision_id: id, target: "z.ts", relation: "GOVERNS" });
  await callTool(h, "update_decision", { id, status: "superseded" });
  const res = await callTool(h, "pending_reconciliations", {});
  const ids = res.isError ? [] : (JSON.parse(res.content[0].text).pending as Array<{ id: string }>).map((p) => p.id);
  expect(ids).not.toContain(id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-contract/reconciliation-tools.test.ts`
Expected: FAIL — `pending_reconciliations` not registered.

- [ ] **Step 3: Implement the tool**

Add to `src/mcp-server/tools/reconciliation-tools.ts`. First a shared source-cap helper near the top:

```typescript
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_INLINE_BYTES = 16 * 1024; // per-file cap on inlined source

function inlineSource(repoPath: string, ref: GovernedRef): string {
  const r = ref.target_ref.includes("::") ? ref.target_ref.slice(0, ref.target_ref.indexOf("::")) : ref.target_ref;
  if (!(r.includes("/") || /\.[a-z0-9]+$/i.test(r))) return "<unresolved>";
  const abs = isAbsolute(r) ? r : join(repoPath, r);
  if (!existsSync(abs) || statSync(abs).isDirectory()) return existsSync(abs) ? "<directory>" : "<missing>";
  const buf = readFileSync(abs);
  return buf.length > MAX_INLINE_BYTES ? buf.subarray(0, MAX_INLINE_BYTES).toString("utf8") + "\n…<truncated>" : buf.toString("utf8");
}
```

Then the schema + tool:

```typescript
const pendingReconciliationsShape = {
  repo_path: RepoPathField,
  limit: z.number().int().positive().optional().describe("Max decisions to return (default 25)"),
} as const;
const pendingReconciliationsSchema = z.object(pendingReconciliationsShape);
```

Inside `registerReconciliationTools`, after the `record_reconciliation` registration:

```typescript
  server.tool(
    "pending_reconciliations",
    "List active decisions whose governed code drifted since their last verdict (or were never judged). Each entry carries prose + current governed source so the agent can judge the batch and call record_reconciliation per decision.",
    pendingReconciliationsShape,
    registerTool(
      "pending_reconciliations",
      pendingReconciliationsSchema,
      async (ctx, args) => {
        const limit = args.limit ?? 25;
        const out: unknown[] = [];
        for (const d of ctx.decisionsRepo.list()) {
          if (out.length >= limit) break;
          if (d.status !== "active") continue;
          const refs = governedRefs(ctx, d.id);
          if (refs.length === 0) continue; // declarative — not reconcilable
          const current = hashGovernedSource(ctx.repoPath, refs);
          if (current === d.reconciled_source_hash) continue; // verdict current
          out.push({
            id: d.id,
            title: d.title,
            problem: d.problem,
            resolution: d.resolution,
            rationale: d.rationale,
            last_verdict: d.reconciliation_verdict ?? "unknown",
            governed: refs.map((r) => ({ ref: r.target_ref, source: inlineSource(ctx.repoPath, r) })),
          });
        }
        if (out.length === 0) return empty(`pending_reconciliations(${ctx.repoPath})`);
        return ok(JSON.stringify({ pending: out }, null, 2));
      },
      { resolver },
    ),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-contract/reconciliation-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/reconciliation-tools.ts tests/mcp-contract/reconciliation-tools.test.ts
git commit -m "feat(api): pending_reconciliations batch enumerator"
```

---

## Task 6: On-read reconciliation block + displayState projection (flag-gated)

**Files:**
- Create: `src/mcp-server/reconciliation-attach.ts`
- Modify: `src/mcp-server/tools/decision-tools.ts` (`get_decision`, `why_was_this_built`, `search_decisions`)
- Test: `tests/mcp-contract/reconciliation-attach.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { attachDecisionReconciliation } from "../../src/mcp-server/reconciliation-attach.js";

// attachDecisionReconciliation(ctx, decisions, result): mutates result.content
// text + adds a `reconciliation` field ONLY when CORTEX_RECONCILE=1 and at
// least one active decision has drifted. Pure-ish: pass a fake ctx.
describe("attachDecisionReconciliation", () => {
  const fakeCtx = (hashNow: string) => ({
    repoPath: "/repo",
    decisionLinksRepo: { findByDecision: () => [{ relation: "GOVERNS", target_kind: "path", target_ref: "x.ts" }] },
  });

  it("is a no-op when CORTEX_RECONCILE is unset", () => {
    delete process.env.CORTEX_RECONCILE;
    const result = { content: [{ type: "text", text: "base" }] };
    const out = attachDecisionReconciliation(fakeCtx("h") as any, [{ id: "d1", status: "active", reconciled_source_hash: "old" }] as any, result);
    expect(out.content[0].text).toBe("base");
    expect((out as any).reconciliation).toBeUndefined();
  });

  it("attaches a block when enabled and a governed hash drifted", () => {
    process.env.CORTEX_RECONCILE = "1";
    try {
      // hashGovernedSource over a non-existent /repo/x.ts yields a stable hash
      // that won't equal "old", so the decision reads as drifted.
      const result = { content: [{ type: "text", text: "base" }] };
      const out = attachDecisionReconciliation(fakeCtx("h") as any, [{ id: "d1", status: "active", reconciled_source_hash: "old" }] as any, result);
      expect((out as any).reconciliation).toBeDefined();
      expect(out.content[0].text).toMatch(/reconcil/i);
    } finally { delete process.env.CORTEX_RECONCILE; }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-contract/reconciliation-attach.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the attach helper**

Create `src/mcp-server/reconciliation-attach.ts`:

```typescript
import type { RepoContext } from "./repo-context.js";
import type { DecisionRecord } from "../decisions/repository.js";
import { hashGovernedSource, displayState, RECONCILE_ENABLED, type GovernedRef } from "../decisions/reconciliation.js";

type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

function governedRefs(ctx: RepoContext, id: string): GovernedRef[] {
  return ctx.decisionLinksRepo.findByDecision(id)
    .filter((l) => l.relation === "GOVERNS")
    .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
}

/**
 * For each active decision in `decisions`, decide whether its cached verdict is
 * stale-pending (current governed hash != reconciled_source_hash, or never
 * judged with GOVERNS links present). When enabled and ≥1 is stale-pending,
 * append a one-line note + a structured `reconciliation` block instructing the
 * agent to judge and call record_reconciliation. No-op when CORTEX_RECONCILE
 * is off, or when no governed decision drifted. Mutates and returns `result`.
 */
export function attachDecisionReconciliation<T extends TextResult>(
  ctx: RepoContext, decisions: Array<Partial<DecisionRecord> & { id: string; status: string }>, result: T,
): T {
  if (!RECONCILE_ENABLED()) return result;
  const pending: Array<{ id: string; state: string; last_verdict: string }> = [];
  for (const d of decisions) {
    if (d.status !== "active") continue;
    const refs = governedRefs(ctx, d.id);
    if (refs.length === 0) continue;
    const current = hashGovernedSource(ctx.repoPath, refs);
    if (current === d.reconciled_source_hash) continue;
    pending.push({ id: d.id, state: "stale-pending", last_verdict: d.reconciliation_verdict ?? "unknown" });
  }
  if (pending.length === 0) return result;
  const line = `\n\n↻ cortex reconciliation: ${pending.length} governed decision(s) drifted since last verdict — judge match/partial/drift and call record_reconciliation(decision_id, verdict).`;
  const first = result.content?.find((c) => c.type === "text");
  if (first) first.text += line;
  (result as TextResult).reconciliation = { pending };
  return result;
}

/** Compute the display_state for a single decision (used by get_decision). */
export function decisionDisplayState(ctx: RepoContext, d: Partial<DecisionRecord> & { id: string; status: string }): string {
  if (!RECONCILE_ENABLED()) return d.status;
  const refs = governedRefs(ctx, d.id);
  if (refs.length === 0) return displayState(d.status, "unknown");
  const current = hashGovernedSource(ctx.repoPath, refs);
  const verdict = current === d.reconciled_source_hash ? (d.reconciliation_verdict ?? null) : null; // drifted ⇒ unknown
  return displayState(d.status, verdict);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-contract/reconciliation-attach.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the decision read handlers**

In `src/mcp-server/tools/decision-tools.ts`, import at top:

```typescript
import { attachDecisionReconciliation, decisionDisplayState } from "../reconciliation-attach.js";
```

In `get_decision`, before `return ok(...)`, augment the payload and attach:

```typescript
        const withRefs = {
          ...dec,
          display_state: decisionDisplayState(ctx, dec),
          governs: pick("GOVERNS"),
          // … unchanged …
        };
        return attachDecisionReconciliation(ctx, [dec], ok(JSON.stringify(withRefs, null, 2)));
```

In `why_was_this_built`, the result is an array of governing decisions (`results`). Replace the success `return`:

```typescript
          return attachDecisionReconciliation(ctx, results, ok(JSON.stringify(results, null, 2)));
```

In `search_decisions`, after computing `results` and before returning, append the drift count (lightweight — no source inlined):

```typescript
          if (results.length === 0) return empty(`search_decisions(${query})`);
          return attachDecisionReconciliation(ctx, results, ok(JSON.stringify(results, null, 2)));
```

- [ ] **Step 6: Run the full decision + reconciliation suites**

Run: `npx vitest run tests/decisions/ tests/mcp-contract/`
Expected: PASS — and with `CORTEX_RECONCILE` unset (default), existing decision-tool assertions are unaffected (attach is a no-op).

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server/reconciliation-attach.ts src/mcp-server/tools/decision-tools.ts tests/mcp-contract/reconciliation-attach.test.ts
git commit -m "feat(api): flag-gated on-read reconciliation block + display_state"
```

---

## Task 7: `cortex reconcile status` CLI

**Files:**
- Create: `src/cli/commands/reconcile.ts`
- Modify: `src/cli/main.ts` (`META_COMMANDS` ~line 20; dispatch ~line 52)
- Test: `tests/cli/reconcile-status.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { countDriftedDecisions } from "../../src/cli/commands/reconcile.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("countDriftedDecisions", () => {
  it("counts active, governed decisions whose hash differs from the stored one", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "rec-cli-"));
    writeFileSync(join(repoDir, "x.ts"), "v1");
    const db = openDecisionsDb(join(repoDir, "decisions.db"));
    const decisions = new DecisionsRepository(db);
    const links = new DecisionLinksRepository(db);
    decisions.insert({ id: "d1", title: "t", description: null, rationale: null, problem: null,
      resolution: null, alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null, provenance: null, created_at: "t", updated_at: "t" });
    links.add({ decision_id: "d1", target_kind: "path", target_ref: "x.ts", relation: "GOVERNS", created_at: "t" });
    // never judged ⇒ drifted (reconciled_source_hash is null)
    expect(countDriftedDecisions(repoDir, decisions, links)).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/reconcile-status.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the command + helper**

Create `src/cli/commands/reconcile.ts` (mirror the shape of `src/cli/commands/freshness.ts`):

```typescript
import { resolveDecisionsDbPath } from "../../db/resolve-path.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { hashGovernedSource, type GovernedRef } from "../../decisions/reconciliation.js";

/** Count active, reconcilable decisions whose governed hash drifted. Pure-ish:
 *  takes the repos so it is unit-testable without path resolution. */
export function countDriftedDecisions(
  repoPath: string, decisions: DecisionsRepository, links: DecisionLinksRepository,
): number {
  let n = 0;
  for (const d of decisions.list()) {
    if (d.status !== "active") continue;
    const refs: GovernedRef[] = links.findByDecision(d.id)
      .filter((l) => l.relation === "GOVERNS")
      .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
    if (refs.length === 0) continue;
    if (hashGovernedSource(repoPath, refs) !== d.reconciled_source_hash) n++;
  }
  return n;
}

/** `cortex reconcile status` — print the drifted-decision count for the cwd repo. */
export function runReconcileCommand(args: string[]): void {
  const sub = args[0] ?? "status";
  if (sub !== "status") { process.stderr.write(`unknown: cortex reconcile ${sub}\n`); process.exit(2); }
  const repoPath = process.cwd();
  const db = openDecisionsDb(resolveDecisionsDbPath(repoPath));
  try {
    const n = countDriftedDecisions(repoPath, new DecisionsRepository(db), new DecisionLinksRepository(db));
    process.stdout.write(`${n}\n`);
  } finally { db.close(); }
}
```

- [ ] **Step 4: Wire into the CLI dispatcher**

In `src/cli/main.ts`: add `"reconcile"` to the `META_COMMANDS` array (~line 20), add the import (~line 17), and add a dispatch branch alongside the `freshness` one (~line 52):

```typescript
import { runReconcileCommand } from "./commands/reconcile.js";
// …
  if (argv.namespace === "reconcile") {
    runReconcileCommand(argv.rest ?? []);
    return;
  }
```

> Match the exact `argv` shape the file uses for the `freshness` branch — read
> lines 45-60 of `main.ts` first and mirror the field names (`namespace`/`rest`
> may differ).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli/reconcile-status.test.ts`
Expected: PASS.

- [ ] **Step 6: Build and smoke-test the CLI**

Run: `npm run build && node dist/cli/main.js reconcile status`
Expected: prints a number (0 on a repo with no governed decisions), exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/reconcile.ts src/cli/main.ts tests/cli/reconcile-status.test.ts
git commit -m "feat(cli): cortex reconcile status — drifted-decision count"
```

---

## Task 8: SessionStart banner

**Files:**
- Modify: `hooks/check-index.sh` (near the freshness probe ~line 73 and the seed-decisions prompt ~line 134)

- [ ] **Step 1: Add the probe + banner (gated)**

After the decision-count block (~line 134), add — only emit when `CORTEX_RECONCILE=1` and a CLI is available:

```bash
# Reconciliation drift probe (opt-in). Cheap: deterministic hash compare, no LLM.
if [ "${CORTEX_RECONCILE:-0}" = "1" ] && [ -n "$CORTEX_BIN" ]; then
  DRIFTED="$(cd "$REPO" && "$CORTEX_BIN" reconcile status 2>/dev/null | tr -dc '0-9')"
  if [ -n "$DRIFTED" ] && [ "$DRIFTED" -gt 0 ]; then
    printf '↻ %s decision(s) drifted since last reconciliation. Call pending_reconciliations to refresh their verdicts.\n' "$DRIFTED"
  fi
fi
```

- [ ] **Step 2: Verify the hook still runs and is gated**

Run: `CORTEX_RECONCILE=0 bash hooks/check-index.sh` (from the repo) → no `↻` line.
Run: `CORTEX_RECONCILE=1 bash hooks/check-index.sh` → prints `↻ N …` only if N>0.
Expected: matches; hook exits 0 in both cases.

> Shell hook — not unit-testable in vitest. Verification is the manual run above.
> Honest note for the executor: confirm `$CORTEX_BIN` and `$REPO` are the variable
> names already used earlier in the script (read lines 53-84) before pasting.

- [ ] **Step 3: Commit**

```bash
git add hooks/check-index.sh
git commit -m "feat(hooks): SessionStart reconciliation-drift banner (CORTEX_RECONCILE-gated)"
```

---

## Task 9: Full-loop contract test + docs

**Files:**
- Test: `tests/mcp-contract/reconciliation-tools.test.ts` (add the end-to-end case)
- Modify: `CLAUDE.md` (decision tools list + a short reconciliation note), `docs/specs/progress.md` (flip the reconciliation row)

- [ ] **Step 1: Write the full-loop test (add to reconciliation-tools.test.ts)**

```typescript
it("full loop: create → judge match → drift → judge drift → fix → judge match", async () => {
  const parse = async (id: string) => JSON.parse((await callTool(h, "get_decision", { id })).content[0].text);
  const file = join(h.repoPath, "loop.ts");

  writeFileSync(file, "export const v = 1;\n");
  const c = await callTool(h, "create_decision", { title: "loop", description: "d", rationale: "r", resolution: "v is 1" });
  const id = JSON.parse(c.content[0].text).id;
  await callTool(h, "link_decision", { decision_id: id, target: "loop.ts", relation: "GOVERNS" });

  // 1. judge match → active
  await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });
  expect((await parse(id)).display_state).toBe("active");

  // 2. edit governed file → drifted ⇒ verdict treated as unknown until re-judged
  writeFileSync(file, "export const v = 2;\n");
  const drifted = await parse(id);
  expect(drifted.display_state).toBe("active · unreconciled");

  // 3. judge drift → stale
  await callTool(h, "record_reconciliation", { decision_id: id, verdict: "drift" });
  expect((await parse(id)).display_state).toBe("stale");

  // 4. fix code back to a judged-match state, then re-judge match → active
  writeFileSync(file, "export const v = 2;\n"); // current content matches the drift verdict's hash
  await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });
  expect((await parse(id)).display_state).toBe("active");
});
```

- [ ] **Step 2: Run it**

Run: `CORTEX_RECONCILE=1 npx vitest run tests/mcp-contract/reconciliation-tools.test.ts`
Expected: PASS.

- [ ] **Step 3: Update docs**

- In `CLAUDE.md`, add `record_reconciliation`, `pending_reconciliations` to the Decision tools list, and a two-line note that reconciliation is `CORTEX_RECONCILE`-gated and tracks the working tree.
- In `docs/specs/progress.md`, change the reconciliation row from ❌ Missing to ✅ Shipped (flag-gated), linking this plan.

- [ ] **Step 4: Full suite + build**

Run: `npm run build && npx vitest run`
Expected: build exit 0; all tests pass (default `CORTEX_RECONCILE` off ⇒ no behavior change to existing tools).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/specs/progress.md tests/mcp-contract/reconciliation-tools.test.ts
git commit -m "test(api): full-loop reconciliation contract + docs"
```

---

## Self-review checklist (for the implementer before opening review)

- [ ] **Spec coverage:** schema (T1), repo+verdict storage (T2), working-tree hash + displayState (T3), record_reconciliation server-stamped hash (T4), pending_reconciliations batch (T5), on-read block + projection + flag (T6), CLI status (T7), SessionStart banner (T8), full-loop test + docs (T9). Every §3–§9 spec item maps to a task.
- [ ] **Flag default off:** every new surface checks `RECONCILE_ENABLED()` / `CORTEX_RECONCILE`; with it unset, `npx vitest run` shows zero behavior change to existing decision tools.
- [ ] **Type consistency:** `GovernedRef`, `Verdict`, `ReconciliationFields`, `recordReconciliation`, `hashGovernedSource`, `displayState`, `RECONCILE_ENABLED` names match across T2–T7.
- [ ] **No HEAD dependency:** `hashGovernedSource` reads disk, never `git`. (The defining property — see spec §5.1.)
```
