# Durable-store Migration Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the durable primitives DB a single, name-tracked migration runner with a too-new guard and pre-migration snapshot/restore, so every store-opener (CLI + MCP) converges by construction.

**Architecture:** A DB-agnostic `runMigrations(db, list, {set, beforeApply})` records applied migrations by name in a `_cortex_migrations` table (simonw/sqlite-migrate pattern). `openDecisionsDb` is the single chokepoint: ensure schema → relocate legacy → snapshot-if-pending-and-non-empty → run migrations → restore-on-failure. The one current data migration (`migrateDecisionIdsToShortForm`) becomes the first list entry; its scattered MCP-entry calls are removed.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `better-sqlite3`, `vitest`, `tsx`.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` files.
- Ledger = `_cortex_migrations(migration_set, name, applied_at)`, PK `(migration_set, name)`. **Never** `PRAGMA user_version`.
- Migrations are keyed and tracked **by name** (no integer versions); authoring is **append-only** (never remove/reorder a shipped name). Names must be unique within a set.
- Migrations MUST be **idempotent** and **own their atomicity** (use `db.transaction` internally). `runMigrations` does **not** wrap them in an outer transaction (it would neutralise `PRAGMA foreign_keys` toggling inside `migrateDecisionIdsToShortForm`).
- Too-new = the ledger holds a name not in this binary's list → **hard refuse** (no reads/writes).
- Snapshot only when a migration is **pending AND the store is non-empty**; retain the **last 3** per store.
- Scope: the primitives DB only. Do **not** touch the graph DB, events DB, or registry. Keep `migrateDecisionsFromGraphDb` where it is (it needs the graph DB path).
- Run tests with `node_modules/.bin/vitest run <files>`. Worktree prereq: `node_modules` + `bin/cortex-indexer` are symlinked from the main checkout (already done in this worktree).

---

## Reference: existing APIs this plan consumes

- `src/decisions/id-migration.ts` → `migrateDecisionIdsToShortForm(db: Database): void` — idempotent (flag `decision_ids_shortform` in `schema_meta`); toggles `PRAGMA foreign_keys` around its own internal `db.transaction`.
- `src/decisions/db.ts` → `openDecisionsDb(path: string, legacyPath?: string): Database` — ends with `relocateLegacyDecisions(db, legacyPath)`. Tables include `decisions`, `todos`, `schema_meta`.
- `src/mcp-server/repo-context.ts` line ~284 and `src/index.ts` line ~168 each call `migrateDecisionIdsToShortForm(decisionsDb)` — to be removed.
- `src/cli/errors.ts` → `UsageError`/`DomainError`/`EnvironmentError`, `exitCodeFor(e)`, `renderError(e, stream)`. Exit codes: Usage 2, Domain 3, Environment 4, else 1.

---

## Task 1: The migration runner (`src/db/migrate.ts`)

**Files:**
- Create: `src/db/migrate.ts`
- Test: `tests/db/migrate.test.ts`

**Interfaces:**
- Produces:
  - `type Migration = { name: string; up: (db: Database.Database) => void }`
  - `class MigrationError extends Error` with `kind: "store-too-new" | "migration-failed"` and `detail?: { set?: string; unknown?: string[]; failed?: string; cause?: unknown }`
  - `function runMigrations(db, migrations: Migration[], opts: { set: string; beforeApply?: (pending: string[]) => void }): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/migrate.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, MigrationError, type Migration } from "../../src/db/migrate.js";

function mem() { return new Database(":memory:"); }
function applied(db: Database.Database, set = "t"): string[] {
  return (db.prepare("SELECT name FROM _cortex_migrations WHERE migration_set=? ORDER BY name").all(set) as Array<{name:string}>).map(r => r.name);
}

describe("runMigrations", () => {
  it("runs unrecorded migrations in order and records them", () => {
    const db = mem(); const order: string[] = [];
    const list: Migration[] = [
      { name: "a", up: () => { order.push("a"); } },
      { name: "b", up: () => { order.push("b"); } },
    ];
    runMigrations(db, list, { set: "t" });
    expect(order).toEqual(["a", "b"]);
    expect(applied(db)).toEqual(["a", "b"]);
  });

  it("skips already-recorded migrations (idempotent re-run)", () => {
    const db = mem(); let runs = 0;
    const list: Migration[] = [{ name: "a", up: () => { runs++; } }];
    runMigrations(db, list, { set: "t" });
    runMigrations(db, list, { set: "t" });
    expect(runs).toBe(1);
  });

  it("calls beforeApply once with pending names when there is work, never when none", () => {
    const db = mem(); const calls: string[][] = [];
    const list: Migration[] = [{ name: "a", up: () => {} }];
    runMigrations(db, list, { set: "t", beforeApply: (p) => calls.push(p) });
    runMigrations(db, list, { set: "t", beforeApply: (p) => calls.push(p) });
    expect(calls).toEqual([["a"]]); // only the first open had pending work
  });

  it("throws store-too-new when the ledger holds an unknown name", () => {
    const db = mem();
    runMigrations(db, [{ name: "a", up: () => {} }, { name: "b", up: () => {} }], { set: "t" });
    // simulate a newer binary having added "c"
    db.prepare("INSERT INTO _cortex_migrations(migration_set,name,applied_at) VALUES('t','c','now')").run();
    expect(() => runMigrations(db, [{ name: "a", up: () => {} }], { set: "t" }))
      .toThrowError(MigrationError);
    try { runMigrations(db, [{ name: "a", up: () => {} }], { set: "t" }); }
    catch (e) { expect((e as MigrationError).kind).toBe("store-too-new"); expect((e as MigrationError).detail?.unknown).toContain("b"); }
  });

  it("a failing migration is not recorded and aborts the run", () => {
    const db = mem(); let bRan = false;
    const list: Migration[] = [
      { name: "a", up: (d) => { d.exec("CREATE TABLE x(v)"); throw new Error("boom"); } },
      { name: "b", up: () => { bRan = true; } },
    ];
    expect(() => runMigrations(db, list, { set: "t" })).toThrowError(/migration 'a' failed/);
    expect(applied(db)).toEqual([]); // nothing recorded
    expect(bRan).toBe(false);        // later migration never ran
  });

  it("rejects duplicate migration names (developer error)", () => {
    const db = mem();
    expect(() => runMigrations(db, [{ name: "a", up: () => {} }, { name: "a", up: () => {} }], { set: "t" }))
      .toThrowError(/duplicate migration name/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run tests/db/migrate.test.ts`
Expected: FAIL — cannot resolve `../../src/db/migrate.js`.

- [ ] **Step 3: Implement `src/db/migrate.ts`**

```ts
import type Database from "better-sqlite3";

export type Migration = { name: string; up: (db: Database.Database) => void };

export type MigrationErrorKind = "store-too-new" | "migration-failed";

export class MigrationError extends Error {
  constructor(
    readonly kind: MigrationErrorKind,
    message: string,
    readonly detail?: { set?: string; unknown?: string[]; failed?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _cortex_migrations (
  migration_set TEXT NOT NULL,
  name          TEXT NOT NULL,
  applied_at    TEXT NOT NULL,
  PRIMARY KEY (migration_set, name)
);`;

export type RunOpts = {
  set: string;
  /** Called once, after the too-new guard passes, iff >=1 migration is pending,
   *  BEFORE any migration runs. The chokepoint uses it to take a snapshot. */
  beforeApply?: (pending: string[]) => void;
};

export function runMigrations(db: Database.Database, migrations: Migration[], opts: RunOpts): void {
  const names = migrations.map((m) => m.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) throw new Error(`runMigrations: duplicate migration name(s): ${dupes.join(", ")}`);

  db.exec(LEDGER_DDL);
  const applied = new Set(
    (db.prepare("SELECT name FROM _cortex_migrations WHERE migration_set = ?").all(opts.set) as Array<{ name: string }>)
      .map((r) => r.name),
  );

  const known = new Set(names);
  const unknown = [...applied].filter((n) => !known.has(n));
  if (unknown.length) {
    throw new MigrationError(
      "store-too-new",
      `this ${opts.set} store has migration(s) [${unknown.join(", ")}] this Cortex doesn't recognize — it was written by a newer version`,
      { set: opts.set, unknown },
    );
  }

  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;
  opts.beforeApply?.(pending.map((m) => m.name));

  const record = db.prepare("INSERT INTO _cortex_migrations(migration_set, name, applied_at) VALUES (?, ?, ?)");
  for (const m of pending) {
    try {
      m.up(db); // migration owns its own atomicity (db.transaction inside)
    } catch (cause) {
      throw new MigrationError("migration-failed", `migration '${m.name}' failed in set '${opts.set}'`, { set: opts.set, failed: m.name, cause });
    }
    record.run(opts.set, m.name, new Date().toISOString());
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node_modules/.bin/vitest run tests/db/migrate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts tests/db/migrate.test.ts
git commit -m "feat(db): name-tracked migration runner with too-new guard"
```

---

## Task 2: Snapshot / restore / prune (`src/db/snapshot.ts`)

**Files:**
- Create: `src/db/snapshot.ts`
- Test: `tests/db/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `function snapshotDb(db: Database.Database, dest: string): void` — consistent single-file copy via `VACUUM INTO` (dest must not already exist).
  - `function restoreDb(storePath: string, snapshotPath: string): void` — overwrite `storePath` from the snapshot and clear stale `-wal`/`-shm` (caller must have closed the handle first).
  - `function pruneSnapshots(dir: string, keep: number): void` — keep the newest `keep` files named `decisions.db.bak.*`, delete the rest.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/snapshot.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { snapshotDb, restoreDb, pruneSnapshots } from "../../src/db/snapshot.js";

describe("snapshot/restore/prune", () => {
  it("snapshotDb makes a consistent copy with the same rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-snap-"));
    try {
      const dbPath = join(dir, "store.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE t(v); INSERT INTO t VALUES (1),(2),(3);");
      const dest = join(dir, "snap.db");
      snapshotDb(db, dest);
      db.close();
      expect(existsSync(dest)).toBe(true);
      const copy = new Database(dest, { readonly: true });
      expect((copy.prepare("SELECT COUNT(*) n FROM t").get() as {n:number}).n).toBe(3);
      copy.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("restoreDb brings back the snapshot content", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-snap-"));
    try {
      const dbPath = join(dir, "store.db");
      let db = new Database(dbPath);
      db.exec("CREATE TABLE t(v); INSERT INTO t VALUES (1);");
      const snap = join(dir, "snap.db");
      snapshotDb(db, snap);
      db.exec("INSERT INTO t VALUES (2);"); // diverge after snapshot
      db.close();
      restoreDb(dbPath, snap);
      db = new Database(dbPath, { readonly: true });
      expect((db.prepare("SELECT COUNT(*) n FROM t").get() as {n:number}).n).toBe(1);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("pruneSnapshots keeps the newest N by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-snap-"));
    try {
      for (const ts of ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]) {
        writeFileSync(join(dir, `decisions.db.bak.${ts}`), "x");
      }
      pruneSnapshots(dir, 3);
      const left = readdirSync(dir).filter((f) => f.startsWith("decisions.db.bak.")).sort();
      expect(left).toEqual(["decisions.db.bak.2026-02-01", "decisions.db.bak.2026-03-01", "decisions.db.bak.2026-04-01"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run tests/db/snapshot.test.ts`
Expected: FAIL — cannot resolve `../../src/db/snapshot.js`.

- [ ] **Step 3: Implement `src/db/snapshot.ts`**

```ts
import type Database from "better-sqlite3";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/** Consistent single-file copy of an open DB. `VACUUM INTO` is WAL-correct and
 *  synchronous; it requires `dest` to NOT already exist. */
export function snapshotDb(db: Database.Database, dest: string): void {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

/** Overwrite `storePath` from a snapshot. The caller MUST have closed the live
 *  handle first. Stale WAL/SHM sidecars are removed so the restored file is the
 *  sole source of truth. */
export function restoreDb(storePath: string, snapshotPath: string): void {
  copyFileSync(snapshotPath, storePath);
  for (const sidecar of [`${storePath}-wal`, `${storePath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

/** Keep the newest `keep` `decisions.db.bak.*` files in `dir` (names carry an
 *  ISO timestamp, so lexical sort == chronological), delete the rest. */
export function pruneSnapshots(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  const baks = readdirSync(dir)
    .filter((f) => basename(f).startsWith("decisions.db.bak."))
    .sort(); // ascending: oldest first
  for (const f of baks.slice(0, Math.max(0, baks.length - keep))) {
    rmSync(join(dir, f), { force: true });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node_modules/.bin/vitest run tests/db/snapshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/snapshot.ts tests/db/snapshot.test.ts
git commit -m "feat(db): consistent snapshot/restore/prune helpers"
```

---

## Task 3: Wire the runner into `openDecisionsDb`; remove scattered calls; map the error

**Files:**
- Modify: `src/decisions/db.ts` (define `PRIMITIVES_MIGRATIONS`, integrate snapshot-guarded `runMigrations`)
- Modify: `src/mcp-server/repo-context.ts` (remove `migrateDecisionIdsToShortForm` call + import)
- Modify: `src/index.ts` (remove `migrateDecisionIdsToShortForm` call + import)
- Modify: `src/cli/errors.ts` (map `MigrationError` → exit 4 + message)
- Test: `tests/decisions/migration-runner-integration.test.ts`

**Interfaces:**
- Consumes: `runMigrations`, `MigrationError` (Task 1); `snapshotDb`, `restoreDb`, `pruneSnapshots` (Task 2); `migrateDecisionIdsToShortForm`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/decisions/migration-runner-integration.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";

function backupsDir(storePath: string) { return join(storePath, "..", "backups"); }

describe("openDecisionsDb migration runner", () => {
  it("records the migration set on a fresh store and takes NO snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      const db = openDecisionsDb(p);
      const names = (db.prepare("SELECT name FROM _cortex_migrations WHERE migration_set='primitives'").all() as Array<{name:string}>).map(r=>r.name);
      db.close();
      expect(names).toContain("id-short-form");
      expect(existsSync(backupsDir(p))).toBe(false); // empty store → no snapshot
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("converts a wild UUID store to short ids and snapshots it (populated upgrade)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      // seed a pre-runner store: schema via openDecisionsDb, then drop the ledger
      // + insert a UUID decision directly to simulate an un-migrated wild store.
      let db = openDecisionsDb(p);
      db.exec("DROP TABLE _cortex_migrations");
      db.prepare("DELETE FROM schema_meta WHERE key='decision_ids_shortform'").run();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO decisions(id,title,created_at,updated_at) VALUES(?,?,?,?)")
        .run("0155458d-af39-4701-b03e-fd570809a9d8", "wild", now, now);
      db.close();

      db = openDecisionsDb(p); // re-open → runner adopts + converts
      const ids = (db.prepare("SELECT id FROM decisions").all() as Array<{id:string}>).map(r=>r.id);
      db.close();
      expect(ids.every((id) => id.startsWith("D-"))).toBe(true);
      expect(readdirSync(backupsDir(p)).some((f)=>f.startsWith("decisions.db.bak."))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("hard-refuses a too-new store", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      const db = openDecisionsDb(p);
      db.prepare("INSERT INTO _cortex_migrations(migration_set,name,applied_at) VALUES('primitives','future-thing',?)").run(new Date().toISOString());
      db.close();
      expect(() => openDecisionsDb(p)).toThrowError(/newer version|doesn't recognize/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("preserves a directly-inserted UUID id (rehome-fixture invariant)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-"));
    try {
      const p = join(dir, "decisions.db");
      const db = openDecisionsDb(p); // empty → id-short-form recorded now
      const now = new Date().toISOString();
      db.prepare("INSERT INTO decisions(id,title,created_at,updated_at) VALUES(?,?,?,?)")
        .run("11111111-2222-3333-4444-555555555555", "fixture", now, now);
      db.close();
      const db2 = openDecisionsDb(p); // already recorded → no conversion
      const id = (db2.prepare("SELECT id FROM decisions").get() as {id:string}).id;
      db2.close();
      expect(id).toBe("11111111-2222-3333-4444-555555555555");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run tests/decisions/migration-runner-integration.test.ts`
Expected: FAIL — `_cortex_migrations` doesn't exist / no `id-short-form` recorded (runner not wired yet).

- [ ] **Step 3: Wire `openDecisionsDb` in `src/decisions/db.ts`**

Add imports at the top:
```ts
import { copyFileSync } from "node:fs"; // (only if not already importing fs bits; see existing imports)
import { mkdirSync } from "node:fs";    // already imported — keep single import
import { runMigrations, MigrationError } from "../db/migrate.js";
import { snapshotDb, restoreDb, pruneSnapshots } from "../db/snapshot.js";
import { migrateDecisionIdsToShortForm } from "./id-migration.js";
```

Define the list near the top of the module:
```ts
export const PRIMITIVES_MIGRATIONS = [
  { name: "id-short-form", up: migrateDecisionIdsToShortForm },
];
```

Add helpers above `openDecisionsDb`:
```ts
function storeHasRows(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT (SELECT COUNT(*) FROM decisions) + (SELECT COUNT(*) FROM todos) AS n",
  ).get() as { n: number };
  return row.n > 0;
}
```

Replace the tail of `openDecisionsDb` (currently the `if (legacyPath && legacyPath !== path) relocateLegacyDecisions(...); return db;`) with:
```ts
  if (legacyPath && legacyPath !== path) {
    relocateLegacyDecisions(db, legacyPath);
  }

  const backupsDir = join(dirname(path), "backups");
  let snapshotPath: string | null = null;
  try {
    runMigrations(db, PRIMITIVES_MIGRATIONS, {
      set: "primitives",
      beforeApply: () => {
        if (!storeHasRows(db)) return; // nothing to protect on an empty store
        mkdirSync(backupsDir, { recursive: true });
        snapshotPath = join(backupsDir, `decisions.db.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`);
        snapshotDb(db, snapshotPath);
        pruneSnapshots(backupsDir, 3);
      },
    });
  } catch (e) {
    if (e instanceof MigrationError && e.kind === "migration-failed" && snapshotPath) {
      db.close();
      restoreDb(path, snapshotPath);
      throw new MigrationError("migration-failed", `${e.message} — store restored from snapshot`, e.detail);
    }
    throw e; // store-too-new (no snapshot) and anything else propagate as-is
  }
  return db;
```
Add `import { dirname, join } from "node:path";` (the file already imports `dirname`; add `join`).

- [ ] **Step 4: Remove the scattered calls**

In `src/mcp-server/repo-context.ts`: delete the line `migrateDecisionIdsToShortForm(decisionsDb);` and its import `import { migrateDecisionIdsToShortForm } from "../decisions/id-migration.js";`. Leave `migrateDecisionsFromGraphDb(...)` untouched.

In `src/index.ts`: delete the line `migrateDecisionIdsToShortForm(decisionsDb);` and its import. (The `migrateDecisionsFromGraphDb` comment/behavior stays.)

- [ ] **Step 5: Map `MigrationError` → exit 4 in `src/cli/errors.ts`**

In `exitCodeFor`, add before the final `return 1;`:
```ts
  if (e instanceof MigrationError) return 4;
```
In `renderError`, add a branch (after the `EnvironmentError` branch):
```ts
  if (e instanceof MigrationError) {
    writeLabel(e.message);
    writeHint("Upgrade the plugin (git pull / npm i -g) to use this store.", "To fix: ");
    return;
  }
```
Add `import { MigrationError } from "../db/migrate.js";` at the top.

- [ ] **Step 6: Run the integration test + the touched suites**

Run: `node_modules/.bin/vitest run tests/decisions/ tests/cli/ tests/mcp-server/repo-context-resolver.test.ts`
Expected: PASS. In particular, `tests/cli/commands/decision-rehome.test.ts` (UUID-id round-trips) and `tests/decisions/migration-runner-integration.test.ts` must both pass. If rehome fails, the fixture inserts its UUID through a path that opens the store while empty — confirm the ordering (empty open records `id-short-form` before the UUID insert); do NOT weaken the migration.

- [ ] **Step 7: Full suite + typecheck**

Run: `node_modules/.bin/vitest run` then `node_modules/.bin/tsc --noEmit`
Expected: all green; no new type errors. (CI runs the full `tests/` suite — don't rely on a subset.)

- [ ] **Step 8: Commit**

```bash
git add src/decisions/db.ts src/mcp-server/repo-context.ts src/index.ts src/cli/errors.ts tests/decisions/migration-runner-integration.test.ts
git commit -m "feat(db): run primitives migrations at the openDecisionsDb chokepoint"
```

---

## Final verification (before review / release)

- [ ] `node_modules/.bin/vitest run` — all green (this is what CI gates on; do not check only a subset).
- [ ] `node_modules/.bin/tsc --noEmit` — clean.
- [ ] Manual: open a fresh store via the CLI in a temp git repo with `CORTEX_DECISIONS_DB` set — `cortex decision list` works, `_cortex_migrations` has `id-short-form`, no `backups/` dir. Seed a UUID decision into a wild store (drop the ledger), reopen — ids become `D-…` and a `backups/decisions.db.bak.*` exists.
- [ ] Gate-1 `/review` on `git diff main`.
- [ ] Release: patch bump (`1.2.0` → `1.2.1`) across `package.json` + `plugin.json` + `.claude-plugin/marketplace.json` + `CHANGELOG.md`; PR; wait for **"CI gate"**; hand to user for verification before merge. **Re-check `main` hasn't moved before bumping** (last time it had — rebase/merge first to avoid a version-file conflict).

## Self-review notes (author)

- **Spec coverage:** runner + ledger + too-new + unique-names (Task 1); snapshot/restore/prune (Task 2); chokepoint wiring + scattered-call removal + error mapping + fresh/wild/too-new/fixture integration (Task 3). All spec sections mapped.
- **Type consistency:** `Migration`/`MigrationError`/`runMigrations`/`RunOpts`, `snapshotDb`/`restoreDb`/`pruneSnapshots`, `PRIMITIVES_MIGRATIONS`, `storeHasRows` used consistently across tasks.
- **Known interaction:** `migrateDecisionIdsToShortForm` toggles `PRAGMA foreign_keys`, so the runner must NOT wrap migrations in an outer transaction (Global Constraints). The rehome UUID-fixture invariant is covered by an explicit integration test.
