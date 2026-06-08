# Durable Primitive Store Relocation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the durable decisions store out of the gitignored, per-worktree `<repo>/.cortex/decisions.db` cache to a stable, out-of-repo home at `~/.cortex/<repo-id>/decisions.db` shared by every worktree of a repo, so authored decisions stop being stranded per branch.

**Architecture:** A generated UUID `repo-id` is minted once and committed to the repo root (`cortex.json`), so it is identical across all worktrees and clones and survives moves/renames. `resolveDecisionsDbPath` reads that id (from the main worktree, via `git --git-common-dir`) and resolves to `~/.cortex/<repo-id>/decisions.db`. A one-shot, idempotent migration copies any existing `<repo>/.cortex/decisions.db` into the new store (union by canonical id) on first open.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, vitest, `node:crypto` (`randomUUID`), `node:child_process` (`git --git-common-dir`). Builds on the already-merged `short-primitive-ids` work (`src/ids/`, `D-` canonical + `seq`).

**Out of scope (deferred):** the store-agnostic repository/mutation interface from the design spec §3 — deferred until the team-realtime sync backend exists (YAGNI; abstracting over a single backend is premature). The `short-primitive-ids` ID scheme is reused as-is, not changed.

---

## File Structure

- **Create** `src/db/repo-id.ts` — mint/read the committed stable repo-id (`readRepoId`, `ensureRepoId`, `repoIdFile`). One responsibility: the repo-id ↔ `cortex.json` mapping.
- **Create** `src/db/git-root.ts` — `mainWorktreeRoot(startDir)`: resolve the *primary* worktree root via `git rev-parse --git-common-dir` so all linked worktrees agree on one repo identity. (Kept separate from `repo-id.ts` so the git dependency is isolated and mockable.)
- **Modify** `src/db/resolve-path.ts` — `resolveDecisionsDbPath` resolves to `~/.cortex/<repo-id>/decisions.db`; add `durableStoreRoot()`.
- **Create** `src/decisions/relocation.ts` — one-shot migration copying `<repo>/.cortex/decisions.db` → the new store (union by id), `schema_meta`-guarded.
- **Modify** `src/decisions/db.ts` — call the relocation inside `openDecisionsDb` (defensive, idempotent), mirroring how the graph-DB migration runs at open.
- **Modify** `tests/db/resolve-path.test.ts` — update the `resolveDecisionsDbPath` suite for the new location.
- **Create** `tests/db/repo-id.test.ts`, `tests/decisions/relocation.test.ts`, `tests/decisions/cross-worktree.test.ts`.

All callers (`src/index.ts:159`, `src/mcp-server/repo-context.ts:270`, `src/mcp-server/tools/code-tools.ts:425`, `src/cli/commands/reconcile.ts:29`) go through `resolveDecisionsDbPath` and need **no change** — relocation is centralized in the resolver.

---

## Task 1: Stable repo-id (mint + read, committed to `cortex.json`)

**Files:**
- Create: `src/db/repo-id.ts`
- Test: `tests/db/repo-id.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/db/repo-id.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepoId, ensureRepoId, repoIdFile } from "../../src/db/repo-id.js";

describe("repo-id", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cortex-repoid-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns null when no cortex.json exists", () => {
    expect(readRepoId(root)).toBeNull();
  });

  it("reads the repoId from an existing cortex.json", () => {
    writeFileSync(repoIdFile(root), JSON.stringify({ repoId: "abc-123" }));
    expect(readRepoId(root)).toBe("abc-123");
  });

  it("returns null when cortex.json exists but has no repoId", () => {
    writeFileSync(repoIdFile(root), JSON.stringify({ other: 1 }));
    expect(readRepoId(root)).toBeNull();
  });

  it("ensureRepoId mints, persists, and returns a UUID when absent", () => {
    const id = ensureRepoId(root);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // persisted to cortex.json
    expect(JSON.parse(readFileSync(repoIdFile(root), "utf-8")).repoId).toBe(id);
  });

  it("ensureRepoId is idempotent — second call returns the same id", () => {
    const first = ensureRepoId(root);
    const second = ensureRepoId(root);
    expect(second).toBe(first);
  });

  it("ensureRepoId preserves other keys already in cortex.json", () => {
    writeFileSync(repoIdFile(root), JSON.stringify({ name: "demo" }, null, 2));
    ensureRepoId(root);
    const parsed = JSON.parse(readFileSync(repoIdFile(root), "utf-8"));
    expect(parsed.name).toBe("demo");
    expect(parsed.repoId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/repo-id.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/repo-id.js'`.

- [ ] **Step 3: Implement `src/db/repo-id.ts`**

```typescript
// src/db/repo-id.ts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Committed, repo-root config file that carries the stable repo identity. */
export function repoIdFile(repoRoot: string): string {
  return join(repoRoot, "cortex.json");
}

/** Read the committed repo-id, or null if absent / malformed / missing key. */
export function readRepoId(repoRoot: string): string | null {
  const file = repoIdFile(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { repoId?: unknown };
    return typeof parsed.repoId === "string" && parsed.repoId.length > 0
      ? parsed.repoId
      : null;
  } catch {
    return null;
  }
}

/**
 * Return the repo-id, minting and persisting a fresh UUID into `cortex.json`
 * (preserving any existing keys) when none is present. Idempotent.
 */
export function ensureRepoId(repoRoot: string): string {
  const existing = readRepoId(repoRoot);
  if (existing) return existing;

  const file = repoIdFile(repoRoot);
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { obj = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>; }
    catch { obj = {}; }
  }
  const repoId = randomUUID();
  obj.repoId = repoId;
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return repoId;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db/repo-id.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/repo-id.ts tests/db/repo-id.test.ts
git commit -m "feat(db): stable committed repo-id (cortex.json) for durable-store keying

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Resolve the main worktree root (worktree-invariant identity)

**Files:**
- Create: `src/db/git-root.ts`
- Test: `tests/db/git-root.test.ts`

**Why:** Linked worktrees must agree on one repo-id. `git rev-parse --git-common-dir` always points at the *primary* repo's `.git`, whose parent is the main worktree — a stable anchor every worktree shares.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/git-root.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { mainWorktreeRoot } from "../../src/db/git-root.js";

describe("mainWorktreeRoot", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-gitroot-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns the repo root from the repo root", () => {
    expect(mainWorktreeRoot(root)).toBe(root);
  });

  it("returns the main worktree root from a linked worktree", () => {
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
    const wt = join(root, "..", "wt-" + Math.abs(root.length));
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: root });
    try {
      expect(mainWorktreeRoot(realpathSync(wt))).toBe(root);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root });
    }
  });

  it("returns null outside any git repo", () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit-")));
    try { expect(mainWorktreeRoot(bare)).toBeNull(); }
    finally { rmSync(bare, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/git-root.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/git-root.js'`.

- [ ] **Step 3: Implement `src/db/git-root.ts`**

```typescript
// src/db/git-root.ts
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/**
 * Resolve the MAIN worktree root for `startDir` — the directory containing the
 * primary repo's `.git`. For a linked worktree this is the original checkout,
 * not the worktree, so every worktree of a repo resolves to one identity.
 * Returns null when `startDir` is not inside a git repo.
 */
export function mainWorktreeRoot(startDir: string): string | null {
  try {
    const commonDir = execFileSync(
      "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: startDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!commonDir) return null;
    // commonDir is "<mainRoot>/.git" → parent is the main worktree root.
    return resolve(dirname(commonDir));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/git-root.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/git-root.ts tests/db/git-root.test.ts
git commit -m "feat(db): resolve main worktree root via git --git-common-dir

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Relocate `resolveDecisionsDbPath` to `~/.cortex/<repo-id>/`

**Files:**
- Modify: `src/db/resolve-path.ts` (the `resolveDecisionsDbPath` function + a new `durableStoreRoot` helper)
- Modify: `tests/db/resolve-path.test.ts:123-153` (the `resolveDecisionsDbPath` suite)

- [ ] **Step 1: Rewrite the failing test suite**

Replace the entire `describe("resolveDecisionsDbPath", …)` block (currently `tests/db/resolve-path.test.ts:123-153`) with:

```typescript
describe("resolveDecisionsDbPath", () => {
  let root: string;
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-dec-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-")));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves to ~/.cortex/<repo-id>/decisions.db, minting the id", () => {
    const p = resolveDecisionsDbPath(root);
    const id = JSON.parse(readFileSync(join(root, "cortex.json"), "utf-8")).repoId;
    expect(p).toBe(join(home, ".cortex", id, "decisions.db"));
  });

  it("is stable across calls (same minted id)", () => {
    expect(resolveDecisionsDbPath(root)).toBe(resolveDecisionsDbPath(root));
  });

  it("honors $CORTEX_DECISIONS_DB override verbatim", () => {
    const override = join(root, "custom", "decisions.db");
    process.env.CORTEX_DECISIONS_DB = override;
    try { expect(resolveDecisionsDbPath(root)).toBe(override); }
    finally { delete process.env.CORTEX_DECISIONS_DB; }
  });

  it("falls back to <startDir>/.cortex/decisions.db outside any git repo", () => {
    const noGit = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit2-")));
    try { expect(resolveDecisionsDbPath(noGit)).toBe(join(noGit, ".cortex", "decisions.db")); }
    finally { rmSync(noGit, { recursive: true, force: true }); }
  });
});
```

Add the imports this suite needs to the top of the file (merge into existing import lines): `readFileSync` from `node:fs`, `execFileSync` from `node:child_process`, `realpathSync` from `node:fs`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/resolve-path.test.ts`
Expected: FAIL — the new location assertions fail (current code returns `<root>/.cortex/decisions.db`).

- [ ] **Step 3: Rewrite `resolveDecisionsDbPath` + add `durableStoreRoot`**

In `src/db/resolve-path.ts`, add imports and replace the existing `resolveDecisionsDbPath` (currently lines 91-99):

```typescript
// add to the existing node:os import:
import { homedir } from "node:os";
// add new imports:
import { ensureRepoId } from "./repo-id.js";
import { mainWorktreeRoot } from "./git-root.js";

/** Out-of-repo durable home for authored primitives: ~/.cortex (advertised,
 *  discoverable). Distinct from the in-repo `.cortex/` derived cache. */
export function durableStoreRoot(): string {
  return join(homedir(), ".cortex");
}

/**
 * Resolve the durable decisions DB for the repo containing `startDir`.
 *
 * Durable primitives live OUT of the repo at `~/.cortex/<repo-id>/decisions.db`,
 * keyed by a generated, committed, repo-stable id so every worktree/clone of a
 * repo shares one store (fixing per-worktree stranding). `$CORTEX_DECISIONS_DB`
 * overrides verbatim (tests/isolation). Outside any git repo, falls back to the
 * legacy `<startDir>/.cortex/decisions.db`.
 */
export function resolveDecisionsDbPath(startDir?: string): string {
  const override = process.env.CORTEX_DECISIONS_DB;
  if (override) return override;

  const start = startDir ?? process.cwd();
  const repoRoot = mainWorktreeRoot(start);
  if (repoRoot === null) {
    // Not a git repo — keep the legacy in-dir path as a best-effort fallback.
    return join(start, ".cortex", "decisions.db");
  }
  const repoId = ensureRepoId(repoRoot);
  return join(durableStoreRoot(), repoId, "decisions.db");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/db/resolve-path.test.ts`
Expected: PASS (all suites; the relocated `resolveDecisionsDbPath` tests included).

- [ ] **Step 5: Commit**

```bash
git add src/db/resolve-path.ts tests/db/resolve-path.test.ts
git commit -m "feat(db): resolve decisions store to ~/.cortex/<repo-id> (out of repo, worktree-shared)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: One-shot relocation migration (old per-repo DB → new store, union by id)

**Files:**
- Create: `src/decisions/relocation.ts`
- Test: `tests/decisions/relocation.test.ts`

**Behavior:** Given the new (target) decisions DB and the legacy path `<repo>/.cortex/decisions.db`, if the legacy DB exists and relocation hasn't run, copy its `decisions` + `decision_links` + `id_sequences` rows into the target, `INSERT OR IGNORE` (union by primary key — distinct random canonicals merge; identical ids dedupe). Guard with a `schema_meta` flag so it runs once. The legacy DB is left in place (orphaned); `.cortex/` stays gitignored.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decisions/relocation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { relocateLegacyDecisions } from "../../src/decisions/relocation.js";

describe("relocateLegacyDecisions", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-reloc-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedLegacy(path: string, ids: string[]): void {
    const db = openDecisionsDb(path);
    const insert = db.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES (?, ?, '', '', '', 'active', 'personal', 'tester', '2026-01-01', '2026-01-01', ?)`,
    );
    ids.forEach((id, i) => insert.run(id, `t-${id}`, i + 1));
    db.close();
  }

  it("copies legacy decisions into the new store and is idempotent", () => {
    const legacy = join(dir, "legacy", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy", ".cortex"), { recursive: true });
    seedLegacy(legacy, ["D-9m2x", "D-7k3p"]);

    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    const first = relocateLegacyDecisions(target, legacy);
    expect(first.copied).toBe(2);
    expect(target.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 2 });

    // idempotent: second run copies nothing
    const second = relocateLegacyDecisions(target, legacy);
    expect(second.copied).toBe(0);
    expect(target.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 2 });
    target.close();
  });

  it("unions without clobbering existing target rows (dedupe by id)", () => {
    const legacy = join(dir, "legacy", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy", ".cortex"), { recursive: true });
    seedLegacy(legacy, ["D-aaaa", "D-bbbb"]);

    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    target.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES ('D-aaaa', 'existing', '', '', '', 'active', 'personal', 'me', '2026-01-01', '2026-01-01', 5)`,
    ).run();

    relocateLegacyDecisions(target, legacy);
    // D-aaaa kept (existing), D-bbbb added → 2 total; existing title preserved
    expect(target.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 2 });
    expect((target.prepare("SELECT title FROM decisions WHERE id='D-aaaa'").get() as { title: string }).title).toBe("existing");
    target.close();
  });

  it("no-ops when the legacy DB does not exist", () => {
    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    expect(relocateLegacyDecisions(target, join(dir, "nope", "decisions.db")).copied).toBe(0);
    target.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/decisions/relocation.test.ts`
Expected: FAIL — `Cannot find module '../../src/decisions/relocation.js'`.

- [ ] **Step 3: Implement `src/decisions/relocation.ts`**

```typescript
// src/decisions/relocation.ts
import Database from "better-sqlite3";
import { existsSync } from "node:fs";

const META_KEY = "relocated_from_repo_cache";

export interface RelocationResult { copied: number; }

function alreadyRelocated(db: Database.Database): boolean {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(META_KEY) as
    | { value: string } | undefined;
  return row?.value === "true";
}
function markRelocated(db: Database.Database): void {
  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(META_KEY, "true");
}

/**
 * One-shot, idempotent relocation: union the legacy in-repo decisions DB
 * (`<repo>/.cortex/decisions.db`) into `target` (the new out-of-repo store).
 * INSERT OR IGNORE on primary keys → distinct decisions merge, identical ids
 * dedupe (target wins). Guarded by a schema_meta flag. Legacy file is left in
 * place. Returns the number of decision rows copied.
 */
export function relocateLegacyDecisions(
  target: Database.Database,
  legacyPath: string,
): RelocationResult {
  if (alreadyRelocated(target)) return { copied: 0 };
  if (!existsSync(legacyPath)) { markRelocated(target); return { copied: 0 }; }

  const before = (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c;
  target.exec(`ATTACH '${legacyPath.replace(/'/g, "''")}' AS legacy`);
  try {
    target.transaction(() => {
      target.exec(`INSERT OR IGNORE INTO decisions SELECT * FROM legacy.decisions`);
      target.exec(`INSERT OR IGNORE INTO decision_links SELECT * FROM legacy.decision_links`);
      // Carry the seq high-water mark so new local ids don't collide with copied ones.
      target.exec(
        `INSERT INTO id_sequences (entity_type, next_val)
         SELECT entity_type, next_val FROM legacy.id_sequences WHERE true
         ON CONFLICT(entity_type) DO UPDATE SET
           next_val = MAX(id_sequences.next_val, excluded.next_val)`,
      );
      markRelocated(target);
    })();
  } finally {
    target.exec(`DETACH legacy`);
  }
  const after = (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c;
  return { copied: after - before };
}
```

> Note: `INSERT … SELECT *` relies on the `decisions`/`decision_links` column order being identical between legacy and target — guaranteed because both are created by the same `openDecisionsDb` schema. If a column was added only via `ALTER` in one DB, list columns explicitly. Verify in Step 4.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/decisions/relocation.test.ts`
Expected: PASS (3 tests). If `SELECT *` errors on column mismatch, switch to explicit column lists for `decisions` and `decision_links` (read them from `openDecisionsDb`'s `BASE_SCHEMA`).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/relocation.ts tests/decisions/relocation.test.ts
git commit -m "feat(decisions): one-shot relocation migration (legacy .cortex db -> out-of-repo store, union by id)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Run relocation on open (defensive, idempotent)

**Files:**
- Modify: `src/decisions/db.ts` (`openDecisionsDb`, currently ends at line ~165)
- Test: `tests/decisions/relocation-on-open.test.ts`

**Approach:** `openDecisionsDb(path)` learns to relocate from the legacy in-repo location. The legacy path is derived from the new path is *not* possible (the new path is `~/.cortex/<id>/`), so the caller passes the legacy path. Add an optional second arg `legacyPath?: string`; when provided and different from `path`, run `relocateLegacyDecisions` after schema setup.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decisions/relocation-on-open.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

describe("openDecisionsDb relocation", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-open-reloc-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pulls legacy decisions into the new store when legacyPath is given", () => {
    const legacyPath = join(dir, "repo", ".cortex", "decisions.db");
    mkdirSync(join(dir, "repo", ".cortex"), { recursive: true });
    const legacy = openDecisionsDb(legacyPath);
    legacy.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES ('D-zzzz','t','','','','active','personal','me','2026-01-01','2026-01-01',1)`,
    ).run();
    legacy.close();

    const store = openDecisionsDb(join(dir, "store", "decisions.db"), legacyPath);
    expect(store.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 1 });
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/decisions/relocation-on-open.test.ts`
Expected: FAIL — `openDecisionsDb` takes one arg; the legacy rows are not pulled in (`c` is 0).

- [ ] **Step 3: Modify `openDecisionsDb`**

In `src/decisions/db.ts`, add the import and the optional param + call (the function currently returns `db` after the FTS migration):

```typescript
import { relocateLegacyDecisions } from "./relocation.js";

export function openDecisionsDb(path: string, legacyPath?: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_SCHEMA);
  ensureProvenanceColumn(db);
  ensureSeqColumn(db);
  ensureReconciliationColumns(db);
  if (readSchemaMeta(db, "fts_version") !== FTS_VERSION) {
    migrateFtsToTriggers(db);
  }
  if (legacyPath && legacyPath !== path) {
    relocateLegacyDecisions(db, legacyPath);
  }
  return db;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/decisions/relocation-on-open.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/db.ts tests/decisions/relocation-on-open.test.ts
git commit -m "feat(decisions): openDecisionsDb pulls in legacy in-repo store on first open

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire the legacy path at the open sites

**Files:**
- Modify: `src/index.ts:159`
- Modify: `src/mcp-server/repo-context.ts:270`
- Modify: `src/mcp-server/tools/code-tools.ts:425`
- Modify: `src/cli/commands/reconcile.ts:29`
- Test: `tests/decisions/cross-worktree.test.ts`

**Approach:** Each site that opens the decisions DB now passes the legacy in-repo path so the one-time relocation fires. The legacy path is `<repoRoot>/.cortex/decisions.db` — add a tiny helper to `resolve-path.ts` so the string isn't duplicated.

- [ ] **Step 1: Add `legacyDecisionsDbPath` helper + a failing cross-worktree test**

In `src/db/resolve-path.ts`:

```typescript
/** The pre-relocation in-repo decisions path, used only as a one-time
 *  migration source. */
export function legacyDecisionsDbPath(startDir?: string): string {
  const start = startDir ?? process.cwd();
  const gitRoot = findGitRoot(start);
  return join(gitRoot ?? start, ".cortex", "decisions.db");
}
```

```typescript
// tests/decisions/cross-worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("decisions store is shared across worktrees", () => {
  let root: string; let home: string; let prevHome: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cw-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
    home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cwhome-")));
    prevHome = process.env.HOME; process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("a linked worktree resolves to the SAME decisions DB as main", () => {
    // Mint the id on main first (and commit cortex.json so the worktree sees it).
    const mainPath = resolveDecisionsDbPath(root);
    execFileSync("git", ["add", "cortex.json"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "repo-id"], { cwd: root });

    const wt = join(root, "..", "cw-wt");
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: root });
    try {
      expect(resolveDecisionsDbPath(realpathSync(wt))).toBe(mainPath);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails (or passes)**

Run: `npx vitest run tests/decisions/cross-worktree.test.ts`
Expected: PASS already if Tasks 2-3 are correct (the id is read from the main worktree). If it FAILS because `cortex.json` isn't committed before the worktree is added, that confirms the commit ordering in the test; keep the commit step. This test is the **acceptance check** for the whole plan.

- [ ] **Step 3: Update the four open sites to pass the legacy path**

For each site, change `openDecisionsDb(resolveDecisionsDbPath(X))` to pass the legacy path. Concretely:

`src/cli/commands/reconcile.ts:29`:
```typescript
const db = openDecisionsDb(resolveDecisionsDbPath(repoPath), legacyDecisionsDbPath(repoPath));
```
(add `legacyDecisionsDbPath` to the existing import from `../../db/resolve-path.js`.)

`src/index.ts:159` — change:
```typescript
const decisionsDbPath = resolveDecisionsDbPath(cwd);
```
to compute and pass the legacy path wherever `openDecisionsDb(decisionsDbPath)` is called (grep the file for the open call and add the second arg `legacyDecisionsDbPath(cwd)`; import the helper).

`src/mcp-server/repo-context.ts:270` — `resolveDecisionsDbPath(canonical)` feeds an `openDecisionsDb` call in the same module; add `legacyDecisionsDbPath(canonical)` as the second arg there. Import the helper.

`src/mcp-server/tools/code-tools.ts:425` — same pattern with `repoPath`: pass `legacyDecisionsDbPath(repoPath)` to the corresponding `openDecisionsDb`.

> If any site uses the path string for something other than `openDecisionsDb` (logging, existence checks), leave those uses on `resolveDecisionsDbPath`; only the `openDecisionsDb` call gains the second arg.

- [ ] **Step 4: Run the full decisions + db suites**

Run: `npx vitest run tests/db tests/decisions`
Expected: PASS. Pay attention to `tests/decisions/cache-survival.test.ts` (it asserts on `resolveDecisionsDbPath` location — update its expectation to the `~/.cortex/<id>` form, setting `process.env.HOME` to a temp dir as in Task 3 if it doesn't already).

- [ ] **Step 5: Commit**

```bash
git add src/db/resolve-path.ts src/index.ts src/mcp-server/repo-context.ts src/mcp-server/tools/code-tools.ts src/cli/commands/reconcile.ts tests/decisions/cross-worktree.test.ts tests/decisions/cache-survival.test.ts
git commit -m "feat(decisions): wire one-time relocation at all decisions-DB open sites

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full suite + manual smoke

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS. Investigate any failure referencing decisions paths or `cortex.json`.

- [ ] **Step 2: Manual smoke on this repo**

```bash
# Back up the current in-repo decisions DB first.
cp .cortex/decisions.db /tmp/decisions-backup.db
# Start the server / run a decisions read; confirm cortex.json gets a repoId
# and ~/.cortex/<repoId>/decisions.db is created with the 29 existing decisions.
cat cortex.json
ls -la ~/.cortex/*/decisions.db
./bin/cortex decision count --path="$PWD"   # expect 29
```
Expected: `cortex.json` has a `repoId`; `~/.cortex/<repoId>/decisions.db` exists; decision count matches the pre-migration count (29).

- [ ] **Step 3: Commit `cortex.json`**

```bash
git add cortex.json
git commit -m "chore: add committed repo-id (cortex.json) for durable decisions store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** location `~/.cortex/<repo-id>` (Task 3) ✓; generated committed stable id (Task 1) ✓; worktree-invariant via git-common-dir (Task 2) ✓; relocation/union migration (Tasks 4-6) ✓; reuse short-primitive-ids ids (no change) ✓; sync + store-agnostic interface explicitly deferred (header) — **flagged for user**.
- **Deferred from spec:** §3 store-agnostic interface (YAGNI until a 2nd backend). Confirm with user.
- **Open risk to confirm during execution:** column-order parity for `INSERT … SELECT *` in Task 4 (note in Step 3/4); the `cache-survival.test.ts` expectation update (Task 6 Step 4).
- **`cortex.json` is committed and not gitignored** (`.gitignore` only ignores `.cortex/`, the directory) — verify with `git check-ignore cortex.json` returning nothing.
