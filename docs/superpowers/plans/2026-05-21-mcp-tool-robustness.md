# MCP Tool Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two MCP tool robustness gaps from the 2026-05-21 field report: `create_decision` silently persisting garbage rationale, `update_decision` unable to set governs, and `search_code` exploding on common patterns in monorepos.

**Architecture:** Three independent fixes in two files (`src/mcp-server/tools/decision-tools.ts`, `src/mcp-server/tools/code-tools.ts`) plus a new shared validator module. Each fix is its own commit. Implementation order: search_code hardening → rationale validator → governs on update_decision. The validator is pure-function and trivially testable. Governance replacement reuses existing `DecisionLinksRepository.add`/`remove` primitives.

**Tech Stack:** TypeScript, vitest, zod for tool schemas, better-sqlite3 for decision storage.

**Spec:** [docs/superpowers/specs/2026-05-21-mcp-tool-robustness-design.md](../specs/2026-05-21-mcp-tool-robustness-design.md)

---

## File structure

**New files:**

- `src/mcp-server/tools/decision-input-validation.ts` — pure validator. Single exported function `validateDecisionFields(input: Record<string, unknown>): { marker: string; field: string } | null`. Returns marker info on first match, null on clean input.
- `tests/mcp-contract/decision-input-validation.test.ts` — unit tests for the validator (markers, fields, clean inputs).
- `tests/mcp-contract/search-code-args.test.ts` — unit tests for the argv builders.

**Modified files:**

- `src/mcp-server/tools/code-tools.ts` — extract `buildRgArgs` and `buildGrepFallbackArgs` helpers; use them in `search_code`. Add `--max-count=200`, raise `RG_MAX_BUFFER`, add `--exclude-dir` flags to grep fallback.
- `src/mcp-server/tools/decision-tools.ts` — wire validator into all four write tools (`create_decision`, `propose_decision`, `supersede_decision`, `update_decision`); add `governs` and `references` to `update_decision` schema.
- `src/decisions/types.ts` — extend `UpdateDecisionInput` with `governs?: string[]` and `references?: string[]`.
- `src/decisions/service.ts` — extend `update()` with governance replacement (computes diff, calls `links.add`/`remove`, wraps in transaction).
- `tests/mcp-contract/decision-tools.test.ts` — extend lifecycle test to exercise `governs` on update + validator rejection cases.

**New test files:**

- `tests/decisions/service-update-governs.test.ts` — unit-level test for the service's governance replacement logic.

---

## Task 1: `search_code` argv builders (extraction + unit test)

Goal: refactor `search_code` to compute its rg/grep argv lists via pure helpers, so we can unit-test the new flags without shelling out.

**Files:**

- Modify: `src/mcp-server/tools/code-tools.ts` (search_code at lines 365–420)
- Test: `tests/mcp-contract/search-code-args.test.ts` (new)

- [ ] **Step 1: Write the failing unit test**

Create `tests/mcp-contract/search-code-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRgArgs, buildGrepFallbackArgs } from "../../src/mcp-server/tools/code-tools.js";

describe("search_code argv builders", () => {
  it("buildRgArgs: caps results with --max-count=200", () => {
    const args = buildRgArgs("ribbon");
    expect(args).toContain("--max-count");
    const idx = args.indexOf("--max-count");
    expect(args[idx + 1]).toBe("200");
  });

  it("buildRgArgs: includes pattern and current dir", () => {
    const args = buildRgArgs("ribbon");
    expect(args).toContain("ribbon");
    expect(args).toContain(".");
  });

  it("buildGrepFallbackArgs: excludes node_modules", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("--exclude-dir=node_modules");
  });

  it("buildGrepFallbackArgs: excludes .git, dist, build, .cache, vendored", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("--exclude-dir=.git");
    expect(args).toContain("--exclude-dir=dist");
    expect(args).toContain("--exclude-dir=build");
    expect(args).toContain("--exclude-dir=.cache");
    expect(args).toContain("--exclude-dir=vendored");
  });

  it("buildGrepFallbackArgs: preserves -rn and pattern", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("-rn");
    expect(args).toContain("ribbon");
    expect(args).toContain(".");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp-contract/search-code-args.test.ts`
Expected: FAIL — `buildRgArgs` / `buildGrepFallbackArgs` not exported.

- [ ] **Step 3: Add the argv builders to code-tools.ts**

In `src/mcp-server/tools/code-tools.ts`, add near the top of the file (before `registerCodeTools`):

```ts
export function buildRgArgs(pattern: string): string[] {
  return [
    "--no-heading",
    "--line-number",
    "--color=never",
    "--max-count", "200",
    pattern,
    ".",
  ];
}

export function buildGrepFallbackArgs(pattern: string): string[] {
  return [
    "-rn",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.cache",
    "--exclude-dir=vendored",
    pattern,
    ".",
  ];
}
```

Then replace the inline argv arrays in the `search_code` handler (around line 375 and line 382) with calls to these helpers:

```ts
const { stdout } = await execFileAsync("rg", buildRgArgs(pattern), { timeout: 10_000, maxBuffer: RG_MAX_BUFFER });
```

and

```ts
const { stdout } = await execFileAsync("grep", buildGrepFallbackArgs(pattern), { timeout: 10_000, maxBuffer: RG_MAX_BUFFER });
```

Also raise `RG_MAX_BUFFER` to `16 * 1024 * 1024` (16 MiB) — find its declaration in the file and update it. If it's not declared yet, declare it as a `const` near the top.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/mcp-contract/search-code-args.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 5: Run the existing search_code contract test to verify no regression**

Run: `npx vitest run tests/mcp-contract/code-tools.test.ts`
Expected: PASS — the existing "search_code: happy: pattern found with enclosing function" test still passes.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/mcp-contract/search-code-args.test.ts
git commit -m "fix(mcp): search_code argv hardening — exclude-dir + max-count

Extract rg/grep argv into testable helpers. Cap rg at 200 matches via
--max-count; raise maxBuffer to 16 MiB. Grep fallback now excludes
node_modules, .git, dist, build, .cache, vendored — previously a bare
\`grep -rn\` against \`.\` timed out or buffer-overflowed on common
patterns in any monorepo with node_modules.

Closes Fix 3 of the 2026-05-21 MCP tool robustness spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Decision input shape validator (pure function + unit tests)

Goal: a single pure function that scans every string-valued field of a decision write payload for caller-side XML marshalling leakage.

**Files:**

- Create: `src/mcp-server/tools/decision-input-validation.ts`
- Test: `tests/mcp-contract/decision-input-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-contract/decision-input-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateDecisionFields } from "../../src/mcp-server/tools/decision-input-validation.js";

describe("validateDecisionFields", () => {
  it("returns null for clean input", () => {
    const result = validateDecisionFields({
      title: "Use Postgres for primary storage",
      description: "Switch from SQLite for write throughput.",
      rationale: "10x writes/sec headroom; replication available.",
    });
    expect(result).toBeNull();
  });

  it("detects </rationale> marker in rationale", () => {
    const result = validateDecisionFields({
      rationale: "Good reasoning</rationale>\n<problem>X</problem>",
    });
    expect(result).toEqual({ marker: "</rationale>", field: "rationale" });
  });

  it("detects </invoke> marker in any string field", () => {
    const result = validateDecisionFields({
      description: "Trailing junk </invoke>",
    });
    expect(result).toEqual({ marker: "</invoke>", field: "description" });
  });

  it("detects <problem> marker (opening tag)", () => {
    const result = validateDecisionFields({
      rationale: "Body <problem>nested</problem>",
    });
    expect(result?.marker).toBe("<problem>");
    expect(result?.field).toBe("rationale");
  });

  it("returns first marker found, not all of them", () => {
    const result = validateDecisionFields({
      rationale: "first </rationale>",
      problem: "second </invoke>",
    });
    expect(result).not.toBeNull();
    // result reflects whichever field/marker was checked first; both are wrong
  });

  it("ignores non-string fields", () => {
    const result = validateDecisionFields({
      title: "OK title",
      alternatives: [{ name: "alt", reason_rejected: "slower" }],
      pr_number: 42,
    });
    expect(result).toBeNull();
  });

  it("scans description, rationale, problem, resolution fields", () => {
    for (const field of ["description", "rationale", "problem", "resolution"] as const) {
      const result = validateDecisionFields({ [field]: "garbage </governs>" });
      expect(result?.field).toBe(field);
      expect(result?.marker).toBe("</governs>");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp-contract/decision-input-validation.test.ts`
Expected: FAIL — `validateDecisionFields` not found.

- [ ] **Step 3: Write the validator**

Create `src/mcp-server/tools/decision-input-validation.ts`:

```ts
const MARKERS = [
  "</rationale>",
  "</description>",
  "</problem>",
  "</resolution>",
  "</alternatives>",
  "</governs>",
  "</invoke>",
  "<problem>",
  "<resolution>",
  "<alternatives>",
  "<governs>",
] as const;

const SCANNED_FIELDS = [
  "title",
  "description",
  "rationale",
  "problem",
  "resolution",
] as const;

export function validateDecisionFields(
  input: Record<string, unknown>,
): { marker: string; field: string } | null {
  for (const field of SCANNED_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    for (const marker of MARKERS) {
      if (value.includes(marker)) {
        return { marker, field };
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp-contract/decision-input-validation.test.ts`
Expected: PASS — all 7 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/decision-input-validation.ts tests/mcp-contract/decision-input-validation.test.ts
git commit -m "feat(mcp): add decision input shape validator

Pure function that scans rationale/description/problem/resolution
string fields for caller-side XML marshalling leakage. Returns the
first matching marker + field, or null on clean input. No integration
yet — wired up in next commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Wire validator into all four decision write tools

Goal: every decision write tool (`create_decision`, `propose_decision`, `supersede_decision`, `update_decision`) calls the validator before invoking the service. Validation failure returns `malformed_input` error; the decision is not persisted.

**Files:**

- Modify: `src/mcp-server/tools/decision-tools.ts`
- Test: `tests/mcp-contract/decision-tools.test.ts` (extend)

- [ ] **Step 1: Write the failing contract test**

Append to `tests/mcp-contract/decision-tools.test.ts`, inside the top-level `describe("decision-tools contract", ...)`:

```ts
  describe("input validation", () => {
    it("create_decision: rejects rationale containing </invoke>", async () => {
      const res = await callTool(h, "create_decision", {
        title: "Bad decision",
        description: "test",
        rationale: "ok body</rationale>\n<problem>x</problem></invoke>",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
      expect(res.content[0].text).toContain("rationale");
    });

    it("create_decision: rejects description containing <problem> marker", async () => {
      const res = await callTool(h, "create_decision", {
        title: "Bad",
        description: "leakage <problem>x</problem>",
        rationale: "fine",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
    });

    it("update_decision: rejects rationale with </rationale> marker", async () => {
      // First create a clean decision
      const created = await callTool(h, "create_decision", {
        title: "To-be-updated",
        description: "ok",
        rationale: "ok",
      });
      const id = JSON.parse(created.content[0].text).id;
      // Try update with bad rationale
      const res = await callTool(h, "update_decision", {
        id,
        rationale: "leak </rationale>",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
      // Clean up
      await callTool(h, "delete_decision", { id });
    });

    it("propose_decision: rejects bad problem field", async () => {
      const res = await callTool(h, "propose_decision", {
        title: "Bad",
        problem: "leak </governs>",
        resolution: "fine",
        rationale: "fine",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
    });
  });
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npx vitest run tests/mcp-contract/decision-tools.test.ts`
Expected: FAIL — `create_decision` does not reject the bad input; decision gets persisted.

- [ ] **Step 3: Wire the validator into all four write tools**

In `src/mcp-server/tools/decision-tools.ts`, add an import near the top:

```ts
import { validateDecisionFields } from "./decision-input-validation.js";
```

Then in each of the four write-tool handlers (`create_decision`, `propose_decision`, `supersede_decision`, `update_decision`), add validation as the **first** thing inside the `async` handler, before the `try` block:

```ts
async (params) => {
  const bad = validateDecisionFields(params as Record<string, unknown>);
  if (bad) {
    return errorResponse(
      "malformed_input",
      `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
    );
  }
  try {
    // ... existing body unchanged
  } catch (e) {
    // ...
  }
}
```

Note: `errorResponse` is the alias for `error` imported as `error as errorResponse` — verify the import line at the top of the file shows that. If not, add: `import { error as errorResponse } from "../response.js";` (or use the existing local name).

The handler signature for `update_decision` destructures `{ id, ...updates }`. For that tool, validate `params` (the full record passed in), not `updates`. The validator only checks string-valued fields by name, so passing `id` through is fine.

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `npx vitest run tests/mcp-contract/decision-tools.test.ts`
Expected: PASS — all four new "input validation" assertions green, all pre-existing tests still pass.

- [ ] **Step 5: Run the full mcp-contract suite to verify no regression**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts tests/mcp-contract/decision-tools.test.ts
git commit -m "fix(mcp): validate decision write inputs for XML marshalling leakage

create_decision, propose_decision, supersede_decision, and
update_decision now reject input where any of {title, description,
rationale, problem, resolution} contains an unambiguous marker of
caller-side XML serialization failure (closing decision-field tags,
opening structured markers, or </invoke>). Returns malformed_input
with the field name and offending marker; no persistence happens.

Closes Fix 1 of the 2026-05-21 MCP tool robustness spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Add `governs` to `UpdateDecisionInput` type

Goal: extend the TypeScript type that drives the service. No behavior change yet — that lands in Task 5. Splitting this out keeps the type-vs-logic diff legible.

**Files:**

- Modify: `src/decisions/types.ts`

- [ ] **Step 1: Add the fields to UpdateDecisionInput**

In `src/decisions/types.ts`, locate the `UpdateDecisionInput` interface (around line 41) and add two new optional fields:

```ts
export interface UpdateDecisionInput {
  title?: string;
  description?: string;
  rationale?: string;
  alternatives?: Alternative[];
  status?: DecisionStatus;
  superseded_by?: string;
  reason?: string;
  problem?: string | null;
  resolution?: string | null;
  author?: string;
  // NEW — full-replacement semantics: if provided, this set replaces the current GOVERNS edges
  governs?: string[];
  // NEW — full-replacement semantics for REFERENCES edges
  references?: string[];
}
```

- [ ] **Step 2: Run typecheck to verify the type compiles**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors. (The service.update implementation doesn't reference governs/references yet, so no usage to break.)

- [ ] **Step 3: Commit**

```bash
git add src/decisions/types.ts
git commit -m "refactor(decisions): add governs and references to UpdateDecisionInput

Type-only change. Service logic for governance replacement lands in
the next commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Implement governance replacement in DecisionService.update

Goal: when `update()` is called with a `governs` array, replace the existing GOVERNS edges with that exact set. Same for `references`. Wrapped in a transaction so partial failure does not corrupt the link table.

**Files:**

- Modify: `src/decisions/service.ts`
- Test: `tests/decisions/service-update-governs.test.ts` (new)

- [ ] **Step 1: Write the failing service test**

Create `tests/decisions/service-update-governs.test.ts`. This mirrors the existing test setup pattern from `tests/decisions/relations.test.ts` — tempdir + `openDecisionsDb`, NOT in-memory:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService.update — governs replacement", () => {
  let dir: string;
  let db: Database.Database;
  let links: DecisionLinksRepository;
  let svc: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-update-governs-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    links = new DecisionLinksRepository(db);
    svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links,
    });
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function targetsFor(decisionId: string, relation: "GOVERNS" | "REFERENCES"): string[] {
    return links.findByDecision(decisionId)
      .filter((l) => l.relation === relation)
      .map((l) => l.target_ref)
      .sort();
  }

  it("adds new governs when none existed before", () => {
    const d = svc.create({ title: "T", description: "D", rationale: "R" });
    svc.update(d.id, { governs: ["src/a.ts", "src/b.ts"] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("removes governs that are not in the new set", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    svc.update(d.id, { governs: ["src/a.ts"] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts"]);
  });

  it("clears all governs when governs: [] is passed", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts"],
    });
    svc.update(d.id, { governs: [] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual([]);
  });

  it("leaves governs untouched when undefined", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts"],
    });
    svc.update(d.id, { title: "T2" });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/a.ts"]);
  });

  it("computes minimal diff (no duplicate inserts on overlap)", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      governs: ["src/a.ts", "src/b.ts"],
    });
    svc.update(d.id, { governs: ["src/b.ts", "src/c.ts"] });
    expect(targetsFor(d.id, "GOVERNS")).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("references replacement: same semantics as governs", () => {
    const d = svc.create({
      title: "T", description: "D", rationale: "R",
      references: ["doc/spec.md"],
    });
    svc.update(d.id, { references: ["doc/other.md"] });
    expect(targetsFor(d.id, "REFERENCES")).toEqual(["doc/other.md"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/decisions/service-update-governs.test.ts`
Expected: FAIL — none of the assertions about `governs` on update pass, because the service ignores those fields today.

- [ ] **Step 3: Implement governance replacement in service.update**

In `src/decisions/service.ts`, locate the `update()` method (around line 77). Find the line `this.decisions.update(id, patch);` and add the replacement logic AFTER that line but BEFORE the event emission. The whole block should look like:

```ts
this.decisions.update(id, patch);

// Governance replacement — full set semantics.
// Not wrapped in a transaction because the existing service layer
// doesn't take a db handle, and the rest of the codebase's link
// operations are not transactional either. If transactional safety
// becomes a requirement, refactor the whole link-write surface in one
// pass.
if (input.governs !== undefined) {
  this.replaceLinks(id, "GOVERNS", input.governs, now);
}
if (input.references !== undefined) {
  this.replaceLinks(id, "REFERENCES", input.references, now);
}
```

Then add a new private method on the service class (place it near `addLink`/`linkGoverns`):

```ts
private replaceLinks(
  decisionId: string,
  relation: "GOVERNS" | "REFERENCES",
  newTargets: string[],
  now: string,
): void {
  const current = this.links.findByDecision(decisionId).filter((l) => l.relation === relation);
  const currentRefs = new Set(current.map((l) => l.target_ref));
  const newRefs = new Set(newTargets);

  const toRemove = current.filter((l) => !newRefs.has(l.target_ref));
  const toAdd = newTargets.filter((t) => !currentRefs.has(t));

  for (const link of toRemove) {
    this.links.remove(decisionId, link.target_kind, link.target_ref, link.relation);
  }
  for (const target of toAdd) {
    this.addLink(decisionId, classifyTarget(target), target, relation, now);
  }
}
```

`classifyTarget` is already imported at the top of service.ts (it's used in the existing `linkGoverns` method). If the import is missing, add it from wherever the existing `classifyTarget` call resolves.

- [ ] **Step 4: Run the service test to verify it passes**

Run: `npx vitest run tests/decisions/service-update-governs.test.ts`
Expected: PASS — all 6 assertions green.

- [ ] **Step 5: Run the full decisions test suite to verify no regression**

Run: `npx vitest run tests/decisions/`
Expected: PASS — every existing decisions test still passes.

- [ ] **Step 6: Commit**

```bash
git add src/decisions/service.ts tests/decisions/service-update-governs.test.ts
git commit -m "feat(decisions): governance replacement on update

DecisionService.update now accepts governs and references arrays;
when present, treats them as a full replacement of the current
GOVERNS/REFERENCES link set. Diff is computed (to_add, to_remove)
and applied in a single transaction. Undefined leaves links
untouched; empty array clears all links of that relation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Surface `governs` on `update_decision` MCP tool

Goal: make the new service capability reachable via the MCP tool. Schema extension + contract test.

**Files:**

- Modify: `src/mcp-server/tools/decision-tools.ts`
- Test: `tests/mcp-contract/decision-tools.test.ts` (extend)

- [ ] **Step 1: Write the failing contract test**

Append to `tests/mcp-contract/decision-tools.test.ts`, inside the top-level `describe("decision-tools contract", ...)`:

```ts
  describe("update_decision governs replacement", () => {
    it("sets governs on update when create-time governs was empty", async () => {
      const created = await callTool(h, "create_decision", {
        title: "Governs-on-update test",
        description: "d", rationale: "r",
      });
      const id = JSON.parse(created.content[0].text).id;

      const updated = await callTool(h, "update_decision", {
        id, governs: ["src/foo.ts", "src/bar.ts"],
      });
      expect(updated.isError).toBeFalsy();

      const fetched = await callTool(h, "get_decision", { id });
      const parsed = JSON.parse(fetched.content[0].text);
      const governsTargets = (parsed.governs ?? []).map((n: any) => n.target_ref ?? n.file_path ?? n.name);
      expect(governsTargets).toEqual(expect.arrayContaining(["src/foo.ts", "src/bar.ts"]));

      // Clean up
      await callTool(h, "delete_decision", { id });
    });

    it("clears governs when governs: [] is passed", async () => {
      const created = await callTool(h, "create_decision", {
        title: "Clear-governs test",
        description: "d", rationale: "r",
        governs: ["src/x.ts"],
      });
      const id = JSON.parse(created.content[0].text).id;

      await callTool(h, "update_decision", { id, governs: [] });
      const fetched = await callTool(h, "get_decision", { id });
      const parsed = JSON.parse(fetched.content[0].text);
      expect(parsed.governs ?? []).toEqual([]);

      await callTool(h, "delete_decision", { id });
    });
  });
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npx vitest run tests/mcp-contract/decision-tools.test.ts`
Expected: FAIL — `update_decision` schema rejects `governs` as an unknown property, or accepts and ignores it.

- [ ] **Step 3: Add governs and references to the update_decision schema**

In `src/mcp-server/tools/decision-tools.ts`, locate the `update_decision` tool registration (around line 92). Modify the schema object to add the two fields:

```ts
server.tool(
  "update_decision",
  "Update an existing decision's fields (governs and references are full-set replacements when provided)",
  {
    id: z.string().describe("Decision node ID"),
    title: z.string().optional(),
    description: z.string().optional(),
    rationale: z.string().optional(),
    alternatives: z.array(AlternativeSchema).optional(),
    status: z.enum(["active", "superseded", "deprecated"]).optional(),
    superseded_by: z.string().optional().describe("ID of the superseding decision"),
    problem: z.string().nullable().optional().describe("Narrative: what question this decision answers"),
    resolution: z.string().nullable().optional().describe("Narrative: what was decided"),
    governs: z.array(z.string()).optional().describe("Full set replacement of GOVERNS targets. [] clears all."),
    references: z.array(z.string()).optional().describe("Full set replacement of REFERENCES targets. [] clears all."),
  },
  async ({ id, ...updates }) => {
    // ... existing validation + service call unchanged
  }
);
```

The handler body does not need to change — `updates` already spreads all schema-known fields into the call to `service.update(id, updates)`, and `update()` now handles `governs`/`references` (from Task 5).

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `npx vitest run tests/mcp-contract/decision-tools.test.ts`
Expected: PASS — both new "update_decision governs replacement" assertions green.

- [ ] **Step 5: Run the full mcp-contract suite to verify no regression**

Run: `npx vitest run tests/mcp-contract/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts tests/mcp-contract/decision-tools.test.ts
git commit -m "feat(mcp): governs on update_decision

update_decision schema now accepts governs and references arrays
(both optional, both full-set replacement semantics). Closes the
recovery gap from the 2026-05-21 field report: a decision with
wrong governance no longer requires delete+recreate.

Closes Fix 2 of the 2026-05-21 MCP tool robustness spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — every existing test still passes, three new test files all green.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 3: Update the spec's open questions if any landed differently**

Open the spec at `docs/superpowers/specs/2026-05-21-mcp-tool-robustness-design.md` and check the "Open questions" section. If the validator's field allowlist or the governs semantics ended up different from what was sketched there, fix the spec inline and commit:

```bash
git add docs/superpowers/specs/2026-05-21-mcp-tool-robustness-design.md
git commit -m "docs(specs): close open questions from mcp tool robustness implementation"
```

If everything landed as specced, skip this step.
