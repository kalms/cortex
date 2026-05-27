# Cold-Start Decision Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap an empty `decisions.db` on first index by deterministically framing decision *candidates* from git history + docs, then letting an LLM skill turn them into `proposed` decisions a human ratifies — with machine-derived provenance.

**Architecture:** A deterministic, read-only candidate-framing module (`src/decisions/seed/`) discovers ADR/design docs and clusters conventional-commit history into a compact manifest. It is exposed as a read-only MCP tool (`decision_candidates`) that the `seed-decisions` skill calls, plus a thin `cortex decision candidates` CLI for humans. Seeded decisions are written via the existing `propose_decision` MCP tool, extended to carry a new durable `provenance` column and an `author` marker (`cortex:seed`). A SessionStart hook detects indexed-but-zero-decisions (via `cortex decision count`) and prompts the agent to run the skill. Nothing reaches `active` without explicit human ratification (`update_decision`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, Zod, `@modelcontextprotocol/sdk`, Vitest, bash (hook), `git` CLI.

---

## File Structure

**Create:**
- `src/decisions/seed/types.ts` — candidate/manifest types (`DecisionCandidate`, `CandidateProvenance`, etc.)
- `src/decisions/seed/doc-discovery.ts` — find ADR/design-doc candidates
- `src/decisions/seed/commit-clustering.ts` — cluster git history into candidates (reuses `parseGitLogOutput`)
- `src/decisions/seed/frame-candidates.ts` — combine + rank + cap into a manifest
- `skills/seed-decisions/SKILL.md` — the LLM orchestration skill
- Test files mirroring each module under `tests/`

**Modify:**
- `src/decisions/db.ts` — add `provenance` column + idempotent migration
- `src/decisions/repository.ts` — `DecisionRecord.provenance` + SELECT/insert
- `src/decisions/service.ts` — persist/surface `provenance` on create/propose
- `src/decisions/types.ts` — `ProvenanceMeta`, `Decision.provenance`, input types
- `src/mcp-server/tools/decision-tools.ts` — `provenance`+`author` on `propose_decision`; register `decision_candidates`
- `src/mcp-server/api-decisions.ts` — surface `provenance` in decision read shape
- `src/cli/commands/decision.ts` — `count` + `candidates` subcommands
- `hooks/check-index.sh` — cold-start decision-count probe + prompt
- `CLAUDE.md`, `docs/architecture/decisions-storage.md`, `src/cli/help.ts`, plugin README — docs

---

## Task 1: Provenance column + repository round-trip

**Files:**
- Modify: `src/decisions/db.ts:11-44` (BASE_SCHEMA), `src/decisions/db.ts:108-119` (openDecisionsDb)
- Modify: `src/decisions/repository.ts:3-40` (DecisionRecord, SELECT_COLS, insert)
- Test: `tests/decisions/provenance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/decisions/provenance.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, DecisionRecord } from "../../src/decisions/repository.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "cortex-prov-"));
}

const baseRec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: "d1", title: "T", description: null, rationale: null,
  problem: null, resolution: null, alternatives: null,
  tier: "personal", status: "proposed", superseded_by: null,
  author: "cortex:seed", created_at: "2026-05-28", updated_at: "2026-05-28",
  ...over,
});

describe("decisions.provenance column", () => {
  it("fresh DB has a provenance column", () => {
    const root = tmp();
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("provenance");
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("idempotently adds provenance to a pre-existing column-less DB", () => {
    const root = tmp();
    try {
      const path = join(root, "decisions.db");
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, rationale TEXT,
        problem TEXT, resolution TEXT, alternatives TEXT,
        tier TEXT NOT NULL DEFAULT 'personal', status TEXT NOT NULL DEFAULT 'active',
        superseded_by TEXT, author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
      legacy.close();
      const db = openDecisionsDb(path);                       // migration runs
      const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("provenance");
      db.close();
      // second open must not throw
      const db2 = openDecisionsDb(path);
      db2.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("round-trips provenance JSON through insert/get", () => {
    const root = tmp();
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const repo = new DecisionsRepository(db);
      const prov = JSON.stringify({ source: "adr", doc_path: "docs/adr/1.md", confidence: "high" });
      repo.insert(baseRec({ provenance: prov }));
      expect(repo.get("d1")?.provenance).toBe(prov);
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("inserts NULL provenance when the field is omitted", () => {
    const root = tmp();
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const repo = new DecisionsRepository(db);
      repo.insert(baseRec());                                  // no provenance key
      expect(repo.get("d1")?.provenance ?? null).toBeNull();
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/provenance.test.ts`
Expected: FAIL — `provenance` not in `table_info`; `repo.get(...).provenance` undefined.

- [ ] **Step 3: Add the column + migration in `src/decisions/db.ts`**

In `BASE_SCHEMA`, add `provenance` to the `decisions` table (after `author`):

```ts
  superseded_by TEXT,
  author       TEXT,
  provenance   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

Add this idempotent migration helper (near `migrateFtsToTriggers`):

```ts
/** Additively add the provenance column to pre-existing DBs. Idempotent. */
function ensureProvenanceColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "provenance")) {
    db.exec("ALTER TABLE decisions ADD COLUMN provenance TEXT");
  }
}
```

Call it inside `openDecisionsDb`, right after `db.exec(BASE_SCHEMA)` and before the FTS check:

```ts
  db.exec(BASE_SCHEMA);
  ensureProvenanceColumn(db);
  if (readSchemaMeta(db, "fts_version") !== FTS_VERSION) {
    migrateFtsToTriggers(db);
  }
```

> Note: `provenance` is intentionally NOT added to `decisions_fts` — it isn't searchable prose, so the existing FTS triggers (which name the 5 indexed columns explicitly) are unaffected. No `FTS_VERSION` bump.

- [ ] **Step 4: Thread provenance through `src/decisions/repository.ts`**

Add the field to `DecisionRecord` (optional, so existing literals/migration/tests need no change):

```ts
export interface DecisionRecord {
  // ...existing fields...
  author: string | null;
  provenance?: string | null; // JSON string; NULL for human-authored decisions
  created_at: string;
  updated_at: string;
}
```

Add `provenance` to `SELECT_COLS`:

```ts
const SELECT_COLS =
  "id, title, description, rationale, problem, resolution, alternatives, tier, status, superseded_by, author, provenance, created_at, updated_at";
```

Update `insert` to list the column and default the param (so callers that omit it still bind):

```ts
  insert(rec: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (${SELECT_COLS}) VALUES
         (@id, @title, @description, @rationale, @problem, @resolution, @alternatives,
          @tier, @status, @superseded_by, @author, @provenance, @created_at, @updated_at)`,
      )
      .run({ ...rec, provenance: rec.provenance ?? null });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/decisions/provenance.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Guard against regressions in the rest of the decisions suite**

Run: `npx vitest run tests/decisions/`
Expected: PASS — existing `DecisionRecord` literals still typecheck (field is optional) and insert as NULL provenance.

- [ ] **Step 7: Commit**

```bash
git add src/decisions/db.ts src/decisions/repository.ts tests/decisions/provenance.test.ts
git commit -m "feat(decisions): add durable provenance column to decisions.db

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Service + types — persist and surface provenance/author

**Files:**
- Modify: `src/decisions/types.ts:9-39` (add `ProvenanceMeta`, extend `Decision` + inputs)
- Modify: `src/decisions/service.ts:29-70` (create), `:212-251` (propose), `:323-339` (toDecision)
- Test: `tests/decisions/provenance-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/decisions/provenance-service.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

function svc() {
  const root = mkdtempSync(join(tmpdir(), "cortex-prov-svc-"));
  const db = openDecisionsDb(join(root, "decisions.db"));
  const service = new DecisionService({
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
  });
  return { root, db, service };
}

describe("DecisionService provenance + author", () => {
  it("propose persists provenance + author and surfaces them on read", () => {
    const { root, db, service } = svc();
    try {
      const prov = { source: "commits" as const, commit_shas: ["abc"], confidence: "low" as const };
      const d = service.propose({
        title: "Seeded", problem: "p", resolution: "r", rationale: "why",
        author: "cortex:seed", provenance: prov,
      });
      expect(d.status).toBe("proposed");
      expect(d.author).toBe("cortex:seed");
      expect(d.provenance).toEqual(prov);
      expect(service.get(d.id)?.provenance).toEqual(prov);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("create without provenance reads back null", () => {
    const { root, db, service } = svc();
    try {
      const d = service.create({ title: "Manual", description: "d", rationale: "r" });
      expect(d.provenance).toBeNull();
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/provenance-service.test.ts`
Expected: FAIL — `provenance` not accepted by `propose`/not on returned `Decision`.

- [ ] **Step 3: Extend types in `src/decisions/types.ts`**

Add the provenance shape and field. Place `ProvenanceMeta` above `Decision`:

```ts
export interface ProvenanceMeta {
  source: "adr" | "prose" | "commits";
  doc_path?: string;
  commit_shas?: string[];
  confidence: "high" | "medium" | "low";
}
```

Add to `Decision` (after `resolution`):

```ts
  problem: string | null;
  resolution: string | null;
  provenance: ProvenanceMeta | null;
```

Add the optional input to `CreateDecisionInput` and `ProposeDecisionInput`:

```ts
  // in CreateDecisionInput:
  provenance?: ProvenanceMeta;
  // in ProposeDecisionInput:
  provenance?: ProvenanceMeta;
```

Also update `nodeToDecision` (legacy mapper at the bottom of the file) to set `provenance: data.provenance ?? null` so it satisfies the now-required `Decision.provenance` field.

- [ ] **Step 4: Persist + surface in `src/decisions/service.ts`**

In `create()`, add to the `rec` literal (after `author`):

```ts
      author: input.author ?? "claude",
      provenance: input.provenance ? JSON.stringify(input.provenance) : null,
```

In `propose()`, add to the `rec` literal (after `author`):

```ts
      author: input.author ?? "claude",
      provenance: input.provenance ? JSON.stringify(input.provenance) : null,
```

In `toDecision()`, add (after `resolution`):

```ts
    problem: rec.problem,
    resolution: rec.resolution,
    provenance: rec.provenance ? JSON.parse(rec.provenance) : null,
```

- [ ] **Step 5: Fix the other `toDecision` mappers for type-consistency**

`Decision.provenance` is now required, so the two sibling mappers must set it.

In `src/decisions/search.ts` (the `toDecision` at ~line 52) add `provenance: rec.provenance ? JSON.parse(rec.provenance) : null,`.
In `src/decisions/promotion.ts` (the `toDecision` at ~line 50) add the same line.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/decisions/provenance-service.test.ts tests/decisions/`
Expected: PASS — new tests green, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/decisions/types.ts src/decisions/service.ts src/decisions/search.ts src/decisions/promotion.ts tests/decisions/provenance-service.test.ts
git commit -m "feat(decisions): persist provenance + author on create/propose

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Expose provenance + author on the `propose_decision` MCP tool

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts:54-82` (propose_decision schema)
- Modify: `src/mcp-server/api-decisions.ts:48-...` (surface provenance in read shape)
- Test: `tests/mcp-contract/decision-provenance.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror an existing mcp-contract test's harness. Inspect `tests/mcp-contract/decision-tools.test.ts` for the exact server-construction helper, then:

```ts
// tests/mcp-contract/decision-provenance.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

// The MCP tool is a thin wrapper over service.propose; assert the service
// contract the tool relies on (params it forwards). If the existing suite has
// a real in-memory MCP client harness, prefer calling propose_decision through
// it and asserting the JSON payload includes provenance + author.
describe("propose_decision forwards provenance + author", () => {
  it("stores provenance + cortex:seed author", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-mcp-prov-"));
    const db = openDecisionsDb(join(root, "decisions.db"));
    const service = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
    try {
      const d = service.propose({
        title: "X", problem: "p", resolution: "r", rationale: "why",
        author: "cortex:seed",
        provenance: { source: "adr", doc_path: "docs/adr/1.md", confidence: "high" },
      });
      expect(d.author).toBe("cortex:seed");
      expect(d.provenance?.source).toBe("adr");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it passes at the service layer**

Run: `npx vitest run tests/mcp-contract/decision-provenance.test.ts`
Expected: PASS already (service supports it from Task 2). This test pins the contract the tool forwards; Steps 3–4 widen the tool schema so the agent can actually pass these fields.

- [ ] **Step 3: Widen the `propose_decision` Zod schema**

In `src/mcp-server/tools/decision-tools.ts`, add a provenance schema near `AlternativeSchema`:

```ts
const ProvenanceSchema = z.object({
  source: z.enum(["adr", "prose", "commits"]),
  doc_path: z.string().optional(),
  commit_shas: z.array(z.string()).optional(),
  confidence: z.enum(["high", "medium", "low"]),
});
```

Add two fields to the `propose_decision` tool's parameter object:

```ts
      pr_number: z.number().int().optional(),
      author: z.string().optional().describe("Author marker; seeded candidates use 'cortex:seed'"),
      provenance: ProvenanceSchema.optional().describe("Machine-derived source (commits/docs) for review verification"),
```

`service.propose(params)` already forwards `author`/`provenance`, so no handler change is needed.

- [ ] **Step 4: Surface provenance in the read shape (`api-decisions.ts`)**

In the `DecisionRecord → API` mapper (around line 48), include provenance in the emitted object so `get_decision` / `why_was_this_built` show it:

```ts
    provenance: rec.provenance ? JSON.parse(rec.provenance) : null,
```

(Place it alongside the other mapped fields; if the mapper builds a `data` object, add it there.)

- [ ] **Step 5: Run the MCP contract suite**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS — no regressions; schema widening is additive (both new fields optional).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts src/mcp-server/api-decisions.ts tests/mcp-contract/decision-provenance.test.ts
git commit -m "feat(mcp): propose_decision accepts provenance + author; surface in reads

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `cortex decision count` CLI command

**Files:**
- Modify: `src/cli/commands/decision.ts:48-70` (dispatch), add `cmdCount`
- Test: `tests/cli/decision-count.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/decision-count.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

const CLI = join(process.cwd(), "src/cli/main.ts");

function runCli(cwd: string): string {
  return execFileSync("npx", ["tsx", CLI, "decision", "count"], {
    cwd, encoding: "utf-8",
  }).trim();
}

describe("cortex decision count", () => {
  it("prints 0 in a repo with no decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-count-"));
    try {
      mkdirSync(join(root, ".git")); // make it look like a git repo for context
      expect(runCli(root)).toBe("0");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prints the number of decisions present", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-count-"));
    try {
      mkdirSync(join(root, ".git"));
      const db = openDecisionsDb(join(root, ".cortex", "decisions.db"));
      const service = new DecisionService({
        decisions: new DecisionsRepository(db),
        links: new DecisionLinksRepository(db),
      });
      service.create({ title: "a", description: "d", rationale: "r" });
      service.create({ title: "b", description: "d", rationale: "r" });
      db.close();
      expect(runCli(root)).toBe("2");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/decision-count.test.ts`
Expected: FAIL — `unknown command 'cortex decision count'`.

- [ ] **Step 3: Implement `count` in `src/cli/commands/decision.ts`**

Add a dispatch case in the `switch (cmd.command)` block:

```ts
    case "count":     return cmdCount(cmd, ctx);
```

Add the handler (prints a bare integer to stdout — the hook parses it):

```ts
function cmdCount(_cmd: DecisionCommand, ctx: ProjectContext): void {
  // Cold-start probe for hooks/scripts. Print 0 (not an error) when the repo
  // has no decisions yet, so the caller can branch on a clean integer.
  if (ctx.state === "no-project") {
    process.stdout.write("0\n");
    return;
  }
  const { db, svc } = openService(ctx);
  try {
    process.stdout.write(`${svc.list().length}\n`);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/decision-count.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/decision.ts tests/cli/decision-count.test.ts
git commit -m "feat(cli): add 'cortex decision count' cold-start probe

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Cold-start prompt in `hooks/check-index.sh`

**Files:**
- Modify: `hooks/check-index.sh` (the `indexed)` branch)
- Test: `tests/hooks/check-index.test.ts`

- [ ] **Step 1: Write the failing test**

The hook resolves the cortex launcher and shells `decision count`. The test stubs the launcher on `PATH` so it returns a controlled count, and asserts the prompt appears only when the count is 0.

```ts
// tests/hooks/check-index.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/check-index.sh");

/** Make a fake `cortex` launcher on a temp bin dir that echoes a fixed count. */
function fakeCortexBin(dir: string, count: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "cortex");
  writeFileSync(launcher, `#!/usr/bin/env bash\n# args: decision count\necho "${count}"\n`);
  chmodSync(launcher, 0o755);
  return dir; // CLAUDE_PLUGIN_ROOT
}

function runHook(repo: string, pluginRoot: string): string {
  return execFileSync("bash", [HOOK], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
  });
}

function indexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-hook-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".cortex"), { recursive: true });
  closeSync(openSync(join(root, ".cortex", "graph.db"), "w")); // presence => "indexed"
  return root;
}

describe("check-index.sh cold-start prompt", () => {
  it("prompts to seed when indexed with zero decisions", () => {
    const repo = indexedRepo();
    const plugin = fakeCortexBin(mkdtempSync(join(tmpdir(), "cortex-plugin-")), "0");
    try {
      expect(runHook(repo, plugin)).toMatch(/No decisions captured yet/i);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(plugin, { recursive: true, force: true }); }
  });

  it("does NOT prompt when decisions already exist", () => {
    const repo = indexedRepo();
    const plugin = fakeCortexBin(mkdtempSync(join(tmpdir(), "cortex-plugin-")), "7");
    try {
      expect(runHook(repo, plugin)).not.toMatch(/No decisions captured yet/i);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(plugin, { recursive: true, force: true }); }
  });

  it("does NOT error or prompt when the launcher is unavailable", () => {
    const repo = indexedRepo();
    const emptyPlugin = mkdtempSync(join(tmpdir(), "cortex-plugin-")); // no bin/cortex
    try {
      const out = runHook(repo, emptyPlugin);
      expect(out).not.toMatch(/No decisions captured yet/i);
      expect(out).toMatch(/Index state: indexed/);             // still emits normal routing
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(emptyPlugin, { recursive: true, force: true }); }
  });
});
```

> Note: the dev-repo `bin/cortex` runs `tsx` and is slow; the test deliberately stubs a fast fake launcher. Give the hook test a generous timeout if needed via `it(..., { timeout: 20000 })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hooks/check-index.test.ts`
Expected: FAIL — no "No decisions captured yet" text emitted.

- [ ] **Step 3: Add the cold-start probe to `hooks/check-index.sh`**

Inside the `indexed)` case, after the existing heredoc that lists the MCP tools, append:

```bash
        # Cold-start decision seeding: if the durable decisions store is empty,
        # nudge the agent to bootstrap it. Degrade-safe — never errors, and only
        # prompts when we can confirm a zero count.
        CORTEX_CLI=""
        if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/cortex" ]; then
            CORTEX_CLI="$CLAUDE_PLUGIN_ROOT/bin/cortex"
        elif [ -x "$REPO/bin/cortex" ]; then
            CORTEX_CLI="$REPO/bin/cortex"
        fi
        if [ -n "$CORTEX_CLI" ]; then
            DECISION_COUNT="$(cd "$REPO" && "$CORTEX_CLI" decision count 2>/dev/null | tr -dc '0-9')"
            if [ "$DECISION_COUNT" = "0" ]; then
                cat <<'EOF'

--- Cold-start: no decisions captured yet ---
This repo is indexed but has zero decisions, so why_was_this_built and
search_decisions are empty. Offer to bootstrap them:

  Run the `seed-decisions` skill — it frames candidates from git history and
  docs (via the decision_candidates MCP tool), writes them as `proposed`
  decisions with provenance, and asks you to ratify a subset.
EOF
            fi
        fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hooks/check-index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/check-index.sh tests/hooks/check-index.test.ts
git commit -m "feat(hook): prompt to seed decisions on indexed-but-empty cold start

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Candidate types + doc discovery

**Files:**
- Create: `src/decisions/seed/types.ts`, `src/decisions/seed/doc-discovery.ts`
- Test: `tests/decisions/seed/doc-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/decisions/seed/doc-discovery.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDocCandidates } from "../../../src/decisions/seed/doc-discovery.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-docs-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("discoverDocCandidates", () => {
  it("classifies an ADR-pathed file as high-confidence adr", () => {
    const root = repoWith({ "docs/adr/0007-use-sqlite.md": "# Use SQLite\n## Context\nx\n## Decision\ny\n" });
    try {
      const cands = discoverDocCandidates(root);
      expect(cands).toHaveLength(1);
      expect(cands[0].kind).toBe("adr");
      expect(cands[0].confidence).toBe("high");
      expect(cands[0].provenance.doc_path).toBe("docs/adr/0007-use-sqlite.md");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("classifies a doc with ADR-shaped headings as adr even outside an adr/ dir", () => {
    const root = repoWith({ "notes/choice.md": "# Choice\n## Context\na\n## Decision\nb\n## Consequences\nc\n" });
    try {
      const cands = discoverDocCandidates(root);
      expect(cands.map((c) => c.kind)).toContain("adr");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("classifies docs/architecture prose as medium-confidence prose", () => {
    const root = repoWith({ "docs/architecture/graph-ui.md": "# Graph UI\nLong design narrative without ADR headings.\n" });
    try {
      const cands = discoverDocCandidates(root);
      expect(cands).toHaveLength(1);
      expect(cands[0].kind).toBe("prose");
      expect(cands[0].confidence).toBe("medium");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores non-doc dirs (node_modules, .git, .cortex)", () => {
    const root = repoWith({
      "node_modules/pkg/readme.md": "## Context\n## Decision\n",
      ".git/x.md": "## Decision\n",
      "README.md": "# Top-level readme, not a decision doc\n",
    });
    try {
      expect(discoverDocCandidates(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/seed/doc-discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/decisions/seed/types.ts`**

```ts
export type CandidateKind = "adr" | "prose" | "commit_cluster";
export type Confidence = "high" | "medium" | "low";

export interface CandidateProvenance {
  doc_path?: string;
  commit_shas?: string[];
  files_touched: string[];
}

export interface DecisionCandidate {
  kind: CandidateKind;
  confidence: Confidence;
  title_hint: string;
  provenance: CandidateProvenance;
  raw_excerpt: string;
}

export interface FrameCandidatesOptions {
  repo_path: string;
  max_candidates?: number; // default 20
  max_commits?: number;    // default 500
}
```

- [ ] **Step 4: Create `src/decisions/seed/doc-discovery.ts`**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DecisionCandidate } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".cortex", "dist", "build", ".tmp", ".playwright-mcp"]);
const ADR_PATH = /(^|\/)(adr|decisions)(\/|$)/i;
const ADR_FILE = /(^|\/)(adr-|\d{4}-).+\.md$/i;
const DOC_ROOT = /(^|\/)docs(\/|$)/i;
const ADR_HEADINGS = /^##\s+(context|decision|consequences)\b/im;
const EXCERPT_CHARS = 1500;

/** Recursively collect *.md paths, skipping vendored/derived dirs. */
function walkMarkdown(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(root, abs, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(abs);
    }
  }
}

/**
 * Discover documentation-derived decision candidates. ADR-shaped docs (by path
 * or by Context/Decision/Consequences headings) are high confidence; other
 * docs under a docs/ tree are medium-confidence prose. Top-level READMEs and
 * non-doc markdown are ignored — they are rarely decision records.
 */
export function discoverDocCandidates(repoPath: string): DecisionCandidate[] {
  const files: string[] = [];
  walkMarkdown(repoPath, repoPath, files);
  const candidates: DecisionCandidate[] = [];

  for (const abs of files) {
    const rel = relative(repoPath, abs).split(sep).join("/");
    let body = "";
    try {
      if (statSync(abs).size > 512 * 1024) continue; // skip huge generated docs
      body = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }

    const isAdrPath = ADR_PATH.test(rel) || ADR_FILE.test(rel);
    const isAdrShaped = ADR_HEADINGS.test(body);
    const isDoc = DOC_ROOT.test(rel);

    if (isAdrPath || isAdrShaped) {
      candidates.push({
        kind: "adr",
        confidence: "high",
        title_hint: firstHeading(body) ?? rel,
        provenance: { doc_path: rel, files_touched: [] },
        raw_excerpt: body.slice(0, EXCERPT_CHARS),
      });
    } else if (isDoc) {
      candidates.push({
        kind: "prose",
        confidence: "medium",
        title_hint: firstHeading(body) ?? rel,
        provenance: { doc_path: rel, files_touched: [] },
        raw_excerpt: body.slice(0, EXCERPT_CHARS),
      });
    }
  }
  return candidates;
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/decisions/seed/doc-discovery.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/decisions/seed/types.ts src/decisions/seed/doc-discovery.ts tests/decisions/seed/doc-discovery.test.ts
git commit -m "feat(decisions): doc-discovery for cold-start candidate framing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Commit clustering

**Files:**
- Create: `src/decisions/seed/commit-clustering.ts` (reuses `parseGitLogOutput`)
- Test: `tests/decisions/seed/commit-clustering.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/decisions/seed/commit-clustering.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterCommitCandidates } from "../../../src/decisions/seed/commit-clustering.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(cwd: string, file: string, msg: string): void {
  writeFileSync(join(cwd, file), `${Math.random()}`);
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg]);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-commits-"));
  git(root, ["init"]);
  return root;
}

describe("clusterCommitCandidates", () => {
  it("groups conventional commits by scope", () => {
    const root = repo();
    try {
      commit(root, "a.ts", "feat(frames): add extraction");
      commit(root, "b.ts", "fix(frames): venv path");
      commit(root, "c.ts", "feat(decisions): provenance column");
      const cands = clusterCommitCandidates(root, 100);
      const scopes = cands.map((c) => c.title_hint);
      expect(scopes.some((s) => s.includes("frames"))).toBe(true);
      expect(scopes.some((s) => s.includes("decisions"))).toBe(true);
      const frames = cands.find((c) => c.title_hint.includes("frames"))!;
      expect(frames.kind).toBe("commit_cluster");
      expect(frames.confidence).toBe("low");
      expect(frames.provenance.commit_shas?.length).toBe(2);
      expect(frames.provenance.files_touched.sort()).toEqual(["a.ts", "b.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns an empty array for a repo with no commits", () => {
    const root = repo();
    try {
      expect(clusterCommitCandidates(root, 100)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/seed/commit-clustering.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/decisions/seed/commit-clustering.ts`**

```ts
import { execFileSync } from "node:child_process";
import { parseGitLogOutput, ParsedCommit } from "../../events/worker/git-log-parser.js";
import type { DecisionCandidate } from "./types.js";

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const EXCERPT_SUBJECTS = 12;

/** Run git log in the NUL-delimited format parseGitLogOutput expects. */
function readGitLog(repoPath: string, maxCommits: number): ParsedCommit[] {
  let raw = "";
  try {
    raw = execFileSync(
      "git",
      ["-C", repoPath, "log", `-n${maxCommits}`, "--format=%H%x00%s%x00%an%x00%at", "--name-status"],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return []; // no commits / not a git repo
  }
  return parseGitLogOutput(raw);
}

/** Bucket key: conventional-commit scope, else type, else "misc". */
function clusterKey(message: string): string {
  const m = message.match(CONVENTIONAL);
  if (!m) return "misc";
  const [, type, scope] = m;
  return scope ? scope : type;
}

/**
 * Cluster recent commits into low-confidence candidates grouped by
 * conventional-commit scope. Commit messages reliably signal *that* a
 * decision-worthy change happened and which files it touched; the LLM supplies
 * the rationale the messages lack.
 */
export function clusterCommitCandidates(repoPath: string, maxCommits: number): DecisionCandidate[] {
  const commits = readGitLog(repoPath, maxCommits);
  const buckets = new Map<string, ParsedCommit[]>();
  for (const c of commits) {
    const key = clusterKey(c.message);
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(c);
  }

  const candidates: DecisionCandidate[] = [];
  for (const [scope, group] of buckets) {
    const shas = group.map((c) => c.hash);
    const files = [...new Set(group.flatMap((c) => c.files.map((f) => f.path)))].sort();
    const subjects = group.slice(0, EXCERPT_SUBJECTS).map((c) => `- ${c.message}`).join("\n");
    candidates.push({
      kind: "commit_cluster",
      confidence: "low",
      title_hint: `${scope}: ${group.length} commit${group.length === 1 ? "" : "s"}`,
      provenance: { commit_shas: shas, files_touched: files },
      raw_excerpt: subjects,
    });
  }
  return candidates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/seed/commit-clustering.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/seed/commit-clustering.ts tests/decisions/seed/commit-clustering.test.ts
git commit -m "feat(decisions): conventional-commit clustering for candidate framing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `frameCandidates` — combine, rank, cap

**Files:**
- Create: `src/decisions/seed/frame-candidates.ts`
- Test: `tests/decisions/seed/frame-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/decisions/seed/frame-candidates.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameCandidates } from "../../../src/decisions/seed/frame-candidates.js";

function git(cwd: string, args: string[]) { execFileSync("git", args, { cwd, stdio: "ignore" }); }

function repoWithDocsAndCommits(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-frame-"));
  git(root, ["init"]);
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n## Context\na\n## Decision\nb\n");
  writeFileSync(join(root, "a.ts"), "x");
  git(root, ["add", "."]);
  git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feat(core): seed"]);
  return root;
}

describe("frameCandidates", () => {
  it("includes both doc and commit candidates, docs ranked first", () => {
    const root = repoWithDocsAndCommits();
    try {
      const out = frameCandidates({ repo_path: root });
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out[0].kind).toBe("adr");          // high-confidence first
      expect(out.some((c) => c.kind === "commit_cluster")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("caps the manifest at max_candidates", () => {
    const root = repoWithDocsAndCommits();
    try {
      expect(frameCandidates({ repo_path: root, max_candidates: 1 })).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/seed/frame-candidates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/decisions/seed/frame-candidates.ts`**

```ts
import { discoverDocCandidates } from "./doc-discovery.js";
import { clusterCommitCandidates } from "./commit-clustering.js";
import type { DecisionCandidate, FrameCandidatesOptions, Confidence } from "./types.js";

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** Cluster size proxy used to break ties within a confidence band. */
function weight(c: DecisionCandidate): number {
  return (c.provenance.commit_shas?.length ?? 0) + c.provenance.files_touched.length;
}

/**
 * Build the cold-start candidate manifest: discover doc candidates + cluster
 * commit history, rank by confidence then weight, and cap. This is the only
 * machine-derived step — the skill turns these into proposed decisions and
 * carries the provenance forward verbatim.
 */
export function frameCandidates(opts: FrameCandidatesOptions): DecisionCandidate[] {
  const max = opts.max_candidates ?? 20;
  const maxCommits = opts.max_commits ?? 500;

  const all: DecisionCandidate[] = [
    ...discoverDocCandidates(opts.repo_path),
    ...clusterCommitCandidates(opts.repo_path, maxCommits),
  ];

  all.sort((a, b) => {
    const byConf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    return byConf !== 0 ? byConf : weight(b) - weight(a);
  });

  return all.slice(0, max);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/seed/frame-candidates.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/seed/frame-candidates.ts tests/decisions/seed/frame-candidates.test.ts
git commit -m "feat(decisions): assemble + rank + cap the candidate manifest

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `decision_candidates` MCP tool (read-only)

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts` (register the tool inside `registerDecisionTools`, uses the `dbPath` param)
- Test: `tests/mcp-contract/decision-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

The tool resolves the repo root from `dbPath` (`<repo>/.cortex/decisions.db` → `<repo>`). Assert that resolution + delegation to `frameCandidates`:

```ts
// tests/mcp-contract/decision-candidates.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { frameCandidates } from "../../src/decisions/seed/frame-candidates.js";

// The tool body is: repoRoot = resolve(dirname(dbPath), "..");
// return ok(JSON.stringify(frameCandidates({ repo_path: repoRoot, max_candidates })))
// This test pins that contract end-to-end via the pure function + path math.
describe("decision_candidates repo-root resolution", () => {
  it("frames candidates relative to the repo that owns the decisions db", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cand-tool-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n## Context\na\n## Decision\nb\n");
    const dbPath = join(root, ".cortex", "decisions.db");
    try {
      const repoRoot = resolve(dirname(dbPath), "..");
      expect(repoRoot).toBe(root);
      const out = frameCandidates({ repo_path: repoRoot });
      expect(out.some((c) => c.provenance.doc_path === "docs/adr/0001-x.md")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it passes (contract pin)**

Run: `npx vitest run tests/mcp-contract/decision-candidates.test.ts`
Expected: PASS (pins the path math + delegation). Step 3 wires the actual tool.

- [ ] **Step 3: Register the tool in `src/mcp-server/tools/decision-tools.ts`**

Add imports at the top:

```ts
import { resolve, dirname } from "node:path";
import { frameCandidates } from "../../decisions/seed/frame-candidates.js";
```

Inside `registerDecisionTools`, after the existing `server.tool(...)` registrations, add:

```ts
  server.tool(
    "decision_candidates",
    "Read-only: frame cold-start decision candidates from git history + docs. Returns a manifest the seed-decisions skill turns into proposed decisions. Writes nothing.",
    {
      max_candidates: z.number().int().positive().optional().describe("Cap on returned candidates (default 20)"),
    },
    async (params) => {
      if (!dbPath) {
        return errorResponse("internal_error", "decision_candidates requires a resolved decisions db path");
      }
      try {
        const repoRoot = resolve(dirname(dbPath), "..");
        const manifest = frameCandidates({ repo_path: repoRoot, max_candidates: params.max_candidates });
        return ok(JSON.stringify(manifest, null, 2));
      } catch (e) {
        return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
      }
    }
  );
```

- [ ] **Step 4: Run the MCP contract suite**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS — additive tool registration, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts tests/mcp-contract/decision-candidates.test.ts
git commit -m "feat(mcp): add read-only decision_candidates tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `cortex decision candidates` CLI wrapper

**Files:**
- Modify: `src/cli/commands/decision.ts` (dispatch + `cmdCandidates`)
- Test: `tests/cli/decision-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/decision-candidates.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/main.ts");

describe("cortex decision candidates", () => {
  it("prints a JSON manifest framed from docs + commits", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-cand-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n## Context\na\n## Decision\nb\n");
    try {
      const out = execFileSync("npx", ["tsx", CLI, "decision", "candidates", "--format=json"], {
        cwd: root, encoding: "utf-8",
      });
      const manifest = JSON.parse(out);
      expect(Array.isArray(manifest)).toBe(true);
      expect(manifest.some((c: any) => c.provenance.doc_path === "docs/adr/0001-x.md")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/decision-candidates.test.ts`
Expected: FAIL — `unknown command 'cortex decision candidates'`.

- [ ] **Step 3: Implement `candidates` in `src/cli/commands/decision.ts`**

Add an import at the top:

```ts
import { frameCandidates } from "../../decisions/seed/frame-candidates.js";
```

Add a dispatch case:

```ts
    case "candidates": return cmdCandidates(cmd, ctx);
```

Add the handler (thin wrapper over the shared module; humans/debug use this — the skill uses the MCP tool):

```ts
function cmdCandidates(cmd: DecisionCommand, ctx: ProjectContext): void {
  if (ctx.state === "no-project") {
    throw new EnvironmentError(
      "decision candidates require a git repository — cd into a repo first",
      "cortex tour    to see what's available without a project",
    );
  }
  const max = typeof cmd.flags["max"] === "string" ? Number(cmd.flags["max"]) : undefined;
  const manifest = frameCandidates({ repo_path: ctx.cwd, max_candidates: max });
  // Always JSON — this is a machine manifest, not a human row list.
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/decision-candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/decision.ts tests/cli/decision-candidates.test.ts
git commit -m "feat(cli): add 'cortex decision candidates' debug wrapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `seed-decisions` skill

**Files:**
- Create: `skills/seed-decisions/SKILL.md`

This task ships agent instructions, not code — verification is the walkthrough in Task 12's QA, not a unit test.

- [ ] **Step 1: Write the skill**

```markdown
---
name: seed-decisions
description: Bootstrap an empty decision store on cold start. Use when a repo is freshly indexed and has zero decisions (the check-index hook prompts this), to propose decisions framed from git history and documentation for human ratification.
---

# Seed Decisions (cold start)

Bootstrap `decisions.db` from existing git history and docs. Every decision you
create is `proposed` and carries machine-derived provenance — **nothing becomes
`active` without the user approving it.**

## Step 1: Frame candidates (deterministic, read-only)

Call the MCP tool — it parses git + docs and returns a compact manifest. Do NOT
read raw `git log` yourself; the manifest already carries source SHAs/doc paths.

```
decision_candidates({ max_candidates: 20 })
```

Each candidate has `kind` (adr | prose | commit_cluster), `confidence`,
`title_hint`, `provenance` (doc_path / commit_shas / files_touched), and a
`raw_excerpt`.

## Step 2: Dedupe

For each candidate, before proposing, check for an existing decision:

```
search_decisions({ query: "<keywords from title_hint / excerpt>" })
```

Skip candidates already covered. On a re-run, only net-new candidates should be
proposed.

## Step 3: Author proposed decisions

Use judgment: a candidate may be one decision or several; merge or split as the
evidence warrants. Be conservative — do not invent alternatives the source
doesn't support.

- **adr (high confidence):** lift problem / rationale / alternatives close to
  verbatim from the doc.
- **prose / commit_cluster (medium/low):** summarize; keep claims tied to the excerpt.

Create each via `propose_decision`, forwarding provenance and the seed marker:

```
propose_decision({
  title, problem, resolution, rationale,
  alternatives: [...],                // only if evidenced
  governs: [<files_touched, resolved to qualified names where precise>],
  references: [<provenance.doc_path>], // for adr/prose
  author: "cortex:seed",
  provenance: { source, doc_path?, commit_shas?, confidence }
})
```

Resolve `files_touched` to qualified names with `search_graph` / `search_code`
when a precise symbol is warranted; otherwise link the file path.

## Step 4: Present the batch for ratification

List what you proposed as a numbered table: `title · confidence · provenance`.
Ask the user which to keep. Then:

- **Approved →** `update_decision({ id, status: "active" })`
- **Unapproved →** `delete_decision({ id })` by default (a graveyard of stale
  `proposed` records erodes trust). Keep as `proposed` only if the user asks.

Never promote to `active` without explicit approval.
```

- [ ] **Step 2: Sanity-check discovery**

Confirm the skill file is well-formed and lists in the skill catalog:

Run: `ls skills/seed-decisions/SKILL.md && head -4 skills/seed-decisions/SKILL.md`
Expected: file exists; frontmatter `name: seed-decisions` present.

- [ ] **Step 3: Commit**

```bash
git add skills/seed-decisions/SKILL.md
git commit -m "feat(skill): add seed-decisions cold-start bootstrap skill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Docs, READMEs & CLI help

**Files:**
- Modify: `CLAUDE.md` (Tools Available + a Cold-start seeding subsection)
- Modify: `docs/architecture/decisions-storage.md` (provenance column + seeding flow)
- Modify: `src/cli/help.ts` (help text for `decision count` / `decision candidates`)
- Modify: plugin README (if present at repo root — `README.md`)

- [ ] **Step 1: Update CLAUDE.md**

Under **### Decision tools**, append `decision_candidates` to the tool list. Add a short subsection after "Decision storage":

```markdown
## Cold-start decision seeding

A freshly-indexed repo has zero decisions. The `check-index` hook detects this
(`cortex decision count == 0`) and prompts running the `seed-decisions` skill,
which frames candidates from git + docs via the read-only `decision_candidates`
MCP tool and proposes them with machine-derived provenance. Seeded decisions are
`status: "proposed"`, `author: "cortex:seed"`, and never become `active` without
explicit user ratification (`update_decision`). See
[the design spec](docs/superpowers/specs/2026-05-28-cold-start-decision-seeding-design.md).
```

- [ ] **Step 2: Update `docs/architecture/decisions-storage.md`**

Document: (a) the new nullable `provenance` column (JSON: `source`/`doc_path`/`commit_shas`/`confidence`), additive via idempotent `ALTER TABLE`, not FTS-indexed; (b) the seeding flow (hook → skill → `decision_candidates` → `propose_decision` → ratify); (c) the `cortex:seed` author marker convention.

- [ ] **Step 3: Update CLI help text in `src/cli/help.ts`**

Inspect how `decision` subcommands are described (grep for `"decision"` / `list`/`create` in `help.ts`), then add lines for:
- `cortex decision count` — "Print the number of decisions (cold-start probe)."
- `cortex decision candidates [--max=N] [--format=json]` — "Frame decision candidates from git history + docs (machine manifest; no writes)."

- [ ] **Step 4: Update the plugin README (if `README.md` exists at repo root)**

Add a short "Decision seeding" bullet to the feature list pointing at the skill and the design spec.

- [ ] **Step 5: Verify nothing references removed/renamed symbols**

Run: `npx vitest run` (full suite) and `npx tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/architecture/decisions-storage.md src/cli/help.ts README.md
git commit -m "docs(decisions): document cold-start seeding + provenance column

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before merge)

- [ ] `npx vitest run` — full suite green
- [ ] `npx tsc --noEmit` — no type errors
- [ ] Manual walkthrough (the skill has no unit test): in a scratch repo with an ADR + a few conventional commits, run `cortex decision candidates` and confirm a sensible manifest; then exercise the `seed-decisions` skill end-to-end (frame → propose → present → ratify a subset → confirm only approved are `active`).
- [ ] Re-run the seed flow and confirm idempotency (only net-new candidates proposed).
- [ ] Gate 2 QA per `.claude/rules/workflow.md`, then merge `feature/decisions/cold-start-seeding`.
