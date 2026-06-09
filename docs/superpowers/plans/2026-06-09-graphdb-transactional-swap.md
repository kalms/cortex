# Graph DB Transactional-Swap Publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Why are we doing this?** On 2026-06-09 the graph store silently corrupted: every reindex run failed contract extraction with `database disk image is malformed` and served stale/partial frame data. The root cause is structural, not incidental — the native C indexer writes `.cortex/db` with `fopen(path, "wb")`, truncating and rewriting the whole file out-of-band while the long-lived MCP server holds it open in WAL mode. That violates SQLite's coherence protocol, so the next libsqlite3 write desyncs the index B-trees (`row N missing from index`). We recovered manually with a clean reindex, but the bug recurs on every index-while-the-server-is-running, and a corrupt graph quietly degrades every downstream read (search, traces, frames, contracts). This plan removes the vector at its source: the live file is never mutated out-of-band again — all writes go through a single libsqlite3 transaction — so corruption becomes structurally impossible while the server's open handle still sees fresh data with no restart.

**Goal:** Make every reindex publish into the canonical `<repo>/.cortex/db` through a single libsqlite3 WAL transaction from a private staging DB, so a long-lived open handle can never be corrupted by the C writer's out-of-band truncate.

**Architecture:** The C indexer (and cache import) build a per-index staging file `<repo>/.cortex/db.stage-<pid>` that no long-lived handle holds. Frame + contract passes run against staging. Then `publishStagedDb` ATTACHes staging to the live DB and replaces every staging-present table inside one `BEGIN IMMEDIATE … COMMIT`. All bytes reaching the live file go through libsqlite3, so corruption is impossible, the cutover is crash-atomic, and the server's open WAL handle sees the new snapshot with no reopen. The C writer (`sqlite_writer.c`) is unchanged.

**Tech Stack:** TypeScript, `better-sqlite3`, `vitest`, the native C indexer (invoked as a subprocess via `CORTEX_DB`).

**Spec:** [docs/superpowers/specs/2026-06-09-graphdb-transactional-swap-design.md](../specs/2026-06-09-graphdb-transactional-swap-design.md)

---

## File structure

- **Create** `src/db/swap-graph-db.ts` — the publish chokepoint: `publishStagedDb({ stagePath, liveDbPath })`. One responsibility: atomically replace live-DB contents from a staging DB via SQL.
- **Create** `src/db/index-lock.ts` — `withIndexLock(repoPath, fn)`: a per-repo `BEGIN EXCLUSIVE` advisory lock on `<repo>/.cortex/index.lock.db` (auto-releases on process death).
- **Create** `tests/db/swap-graph-db.test.ts`, `tests/db/index-lock.test.ts`.
- **Modify** `src/graph/store.ts` — add `busy_timeout` on open.
- **Modify** `src/mcp-server/repo-context.ts` — `busy_timeout` on the raw pooled handle.
- **Modify** `src/frame-extraction/inject-frames.ts`, `src/contracts/inject.ts`, `src/graph/index-meta.ts` — `busy_timeout` on their handles.
- **Modify** `src/db/staging-path.ts` (new tiny helper) or co-locate in `swap-graph-db.ts` — `stagingDbPath(repoPath)`.
- **Modify** `src/cli/commands/index.ts` — build into staging, publish to canonical.
- **Modify** `src/mcp-server/tools/code-tools.ts` — build into staging, publish; re-route the cache-hit + cache-write branches through staging.
- **Modify** `src/db/cache.ts` — no signature change; callers pass the staging path.

---

## Phase 1 — `busy_timeout` on every graph-DB connection

Independent hardening: a losing writer waits instead of throwing `SQLITE_BUSY`. Ships and tests on its own.

### Task 1.1: `busy_timeout` on GraphStore

**Files:**
- Modify: `src/graph/store.ts:44-53`
- Test: `tests/graph/store-busy-timeout.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/graph/store-busy-timeout.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";

describe("GraphStore busy_timeout", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("opens with a non-zero busy_timeout", () => {
    dir = mkdtempSync(join(tmpdir(), "gs-busy-"));
    const store = new GraphStore(join(dir, "db"));
    // queryRaw exposes the underlying connection via a PRAGMA round-trip.
    const [{ timeout }] = store.queryRaw<{ timeout: number }>("PRAGMA busy_timeout", []);
    store.close();
    expect(timeout).toBeGreaterThanOrEqual(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/store-busy-timeout.test.ts`
Expected: FAIL — `timeout` is `0` (SQLite default).

- [ ] **Step 3: Add the pragma**

In `src/graph/store.ts`, in the constructor, set the pragma for BOTH the readonly and read-write branches. Replace the constructor body:

```typescript
  constructor(dbPath: string, options: GraphStoreOptions = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma("busy_timeout = 5000");
      return;
    }
    this.db = new Database(dbPath);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/store-busy-timeout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/store.ts tests/graph/store-busy-timeout.test.ts
git commit -m "fix(db): set busy_timeout=5000 on GraphStore connections"
```

### Task 1.2: `busy_timeout` on the remaining raw handles

**Files:**
- Modify: `src/mcp-server/repo-context.ts:280` (the raw `graphDb`)
- Modify: `src/frame-extraction/inject-frames.ts:416`
- Modify: `src/contracts/inject.ts:12`
- Modify: `src/graph/index-meta.ts:21`

- [ ] **Step 1: Add the pragma at each raw `new Database(...)` site**

`src/mcp-server/repo-context.ts` — after `const graphDb = new BetterSqlite3(graphDbPath);`:

```typescript
    const graphDb = new BetterSqlite3(graphDbPath);
    graphDb.pragma("busy_timeout = 5000");
```

`src/frame-extraction/inject-frames.ts` — in `injectFrames`, after `const db = new Database(args.dbPath);`:

```typescript
  const db = new Database(args.dbPath);
  db.pragma("busy_timeout = 5000");
```

`src/contracts/inject.ts` — in `injectContracts`, after `const db = new Database(args.dbPath);`:

```typescript
  const db = new Database(args.dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
```

`src/graph/index-meta.ts` — in `writeIndexMeta`, after `db = new Database(dbPath);`:

```typescript
    db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    ensureTable(db);
```

- [ ] **Step 2: Verify the suite still passes**

Run: `npx vitest run`
Expected: PASS (no behavior change beyond timeout).

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server/repo-context.ts src/frame-extraction/inject-frames.ts src/contracts/inject.ts src/graph/index-meta.ts
git commit -m "fix(db): set busy_timeout=5000 on all raw graph-DB handles"
```

---

## Phase 2 — the `publishStagedDb` swap chokepoint

The heart. Built and tested in isolation; no orchestrator wiring yet.

### Task 2.1: staging-path helper

**Files:**
- Create: `src/db/staging-path.ts`
- Test: `tests/db/staging-path.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/staging-path.test.ts
import { describe, it, expect } from "vitest";
import { stagingDbPath } from "../../src/db/staging-path.js";
import { join } from "node:path";

describe("stagingDbPath", () => {
  it("is a sibling of .cortex/db, pid-scoped, under .cortex/", () => {
    const p = stagingDbPath("/repo", 4242);
    expect(p).toBe(join("/repo", ".cortex", "db.stage-4242"));
  });
  it("defaults to the current pid", () => {
    const p = stagingDbPath("/repo");
    expect(p.startsWith(join("/repo", ".cortex", "db.stage-"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/staging-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/db/staging-path.ts
import { join } from "node:path";

/** Per-index staging DB path: a sibling of the canonical .cortex/db that no
 *  long-lived handle holds open. pid-scoped so concurrent indexers never
 *  collide. The C writer + frame/contract passes build HERE; publishStagedDb
 *  then swaps the contents into the canonical db. Lives under .cortex/ so it is
 *  on the same filesystem as the live db (local ATTACH + row copy). */
export function stagingDbPath(repoRoot: string, pid: number = process.pid): string {
  return join(repoRoot, ".cortex", `db.stage-${pid}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/staging-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/staging-path.ts tests/db/staging-path.test.ts
git commit -m "feat(db): stagingDbPath helper for per-index staging files"
```

### Task 2.2: `publishStagedDb` — replaces staging-present tables, leaves live-only tables intact

**Files:**
- Create: `src/db/swap-graph-db.ts`
- Test: `tests/db/swap-graph-db.test.ts`

- [ ] **Step 1: Write the failing test (core swap + live-only-table invariant)**

```typescript
// tests/db/swap-graph-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { publishStagedDb } from "../../src/db/swap-graph-db.js";

const NODES_DDL = `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  qualified_name TEXT, file_path TEXT, data TEXT NOT NULL DEFAULT '{}', tier TEXT NOT NULL DEFAULT 'personal',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, start_line INTEGER, end_line INTEGER, project TEXT)`;

function writeStage(path: string, ids: string[]) {
  const db = new BetterSqlite3(path);
  db.exec(NODES_DDL);
  const ins = db.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?)");
  for (const id of ids) ins.run(id, "file", id, "t", "t");
  db.close();
}

describe("publishStagedDb", () => {
  let dir: string, live: string, stage: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swap-"));
    live = join(dir, "db");
    stage = join(dir, "db.stage-1");
    // Seed a live DB with OLD data + a live-only table that staging lacks.
    const db = new BetterSqlite3(live);
    db.exec(NODES_DDL);
    db.exec("CREATE TABLE edge_annotations (id TEXT PRIMARY KEY, decision_id TEXT, edge_id TEXT, created_at TEXT)");
    db.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at) VALUES ('old','file','old','t','t')").run();
    db.prepare("INSERT INTO edge_annotations VALUES ('a1','d1','e1','t')").run();
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces staging-present tables and leaves live-only tables intact", () => {
    writeStage(stage, ["n1", "n2", "n3"]);
    publishStagedDb({ stagePath: stage, liveDbPath: live });

    const db = new BetterSqlite3(live, { readonly: true });
    expect(db.prepare("SELECT count(*) c FROM nodes").get().c).toBe(3);
    expect(db.prepare("SELECT 1 FROM nodes WHERE id='old'").get()).toBeUndefined();
    // live-only table (absent from staging) preserved:
    expect(db.prepare("SELECT count(*) c FROM edge_annotations").get().c).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/swap-graph-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `publishStagedDb`**

```typescript
// src/db/swap-graph-db.ts
import BetterSqlite3 from "better-sqlite3";

export interface PublishResult {
  /** Tables copied from staging into the live DB (staging's table set). */
  tablesReplaced: string[];
}

/**
 * Atomically replace the contents of the live graph DB with the staging DB's
 * contents, through a single libsqlite3 WAL transaction.
 *
 * Why this exists: the canonical .cortex/db must NEVER be mutated out-of-band
 * (the C writer's fopen("wb") truncate) while the long-lived MCP server holds
 * it open — that corrupts the index b-trees. Here, every byte reaching the live
 * file goes through libsqlite3 in WAL mode (the safe single-writer / N-reader
 * case), so an already-open reader sees the new committed snapshot on its next
 * read with no reopen, and a crash before COMMIT leaves the old state intact.
 *
 * Only tables present in STAGING are replaced. Live-only tables (e.g. the
 * lazily-migrated edge_annotations / cortex_index_meta) are left untouched —
 * the omission is the preservation. INSERT...SELECT copies rows (not pages), so
 * a page-size mismatch between staging (64 KiB, C writer) and live (4 KiB,
 * libsqlite3 default) is irrelevant.
 */
export function publishStagedDb(opts: { stagePath: string; liveDbPath: string }): PublishResult {
  const db = new BetterSqlite3(opts.liveDbPath); // creates the live DB on first index
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    // FK off for the bulk replace: edges.source_id/target_id REFERENCE nodes(id)
    // ON DELETE CASCADE, so per-table DELETE would otherwise cascade/over-order.
    db.pragma("foreign_keys = OFF");
    db.exec(`ATTACH '${opts.stagePath.replace(/'/g, "''")}' AS stage`);
    try {
      const tables = (db
        .prepare("SELECT name FROM stage.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>).map((r) => r.name);

      const tx = db.transaction(() => {
        for (const t of tables) {
          // Ensure the table exists live (first index / new C-writer table).
          const createSql = (db
            .prepare("SELECT sql FROM stage.sqlite_master WHERE type='table' AND name=?")
            .get(t) as { sql: string }).sql;
          db.exec(createSql.replace(/CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS"));
          // Column list from staging (authoritative new schema).
          const cols = (db.prepare(`PRAGMA stage.table_info(${q(t)})`).all() as Array<{ name: string }>)
            .map((c) => q(c.name));
          db.exec(`DELETE FROM main.${q(t)}`);
          db.exec(`INSERT INTO main.${q(t)} (${cols.join(",")}) SELECT ${cols.join(",")} FROM stage.${q(t)}`);
        }
      });
      tx(); // BEGIN IMMEDIATE … COMMIT, atomic

      db.pragma("wal_checkpoint(PASSIVE)");
      return { tablesReplaced: tables };
    } finally {
      db.exec("DETACH stage");
    }
  } finally {
    db.close();
  }
}

/** Quote a SQLite identifier. */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/swap-graph-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/swap-graph-db.ts tests/db/swap-graph-db.test.ts
git commit -m "feat(db): publishStagedDb — transactional staging->live content swap"
```

### Task 2.3: freshness-without-reopen + crash-atomicity tests

**Files:**
- Modify: `tests/db/swap-graph-db.test.ts`

- [ ] **Step 1: Add the load-bearing tests**

```typescript
  it("an already-open WAL reader sees the new snapshot WITHOUT reopening", () => {
    writeStage(stage, ["n1", "n2"]);
    const reader = new BetterSqlite3(live); // long-lived, like the server's pooled handle
    reader.pragma("journal_mode = WAL");
    expect(reader.prepare("SELECT count(*) c FROM nodes").get().c).toBe(1); // old
    publishStagedDb({ stagePath: stage, liveDbPath: live });
    // same connection, never reopened:
    expect(reader.prepare("SELECT count(*) c FROM nodes").get().c).toBe(2); // new
    expect(reader.pragma("integrity_check", { simple: true })).toBe("ok");
    reader.close();
  });

  it("leaves the OLD state intact if the swap transaction does not commit", () => {
    writeStage(stage, ["n1", "n2"]);
    // Simulate a crash: open live, ATTACH, BEGIN, mutate, then abandon (rollback).
    const db = new BetterSqlite3(live);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    db.exec(`ATTACH '${stage}' AS stage`);
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM nodes");
    db.exec("INSERT INTO nodes (id,kind,name,created_at,updated_at) SELECT id,kind,name,created_at,updated_at FROM stage.nodes");
    db.exec("ROLLBACK"); // kill -9 equivalent: never COMMITs
    db.exec("DETACH stage");
    expect(db.prepare("SELECT 1 FROM nodes WHERE id='old'").get()).toBeTruthy();
    expect(db.prepare("SELECT count(*) c FROM nodes").get().c).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
```

- [ ] **Step 2: Run and verify PASS**

Run: `npx vitest run tests/db/swap-graph-db.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 3: Commit**

```bash
git add tests/db/swap-graph-db.test.ts
git commit -m "test(db): publishStagedDb freshness-without-reopen + crash-atomicity"
```

---

## Phase 3 — wire the CLI index path

**Files:**
- Modify: `src/cli/commands/index.ts:45-95`

### Task 3.1: build into staging, publish to canonical

- [ ] **Step 1: Add imports** at the top of `src/cli/commands/index.ts`:

```typescript
import { unlinkSync } from "node:fs";
import { stagingDbPath } from "../../db/staging-path.js";
import { publishStagedDb } from "../../db/swap-graph-db.js";
```

- [ ] **Step 2: Rewrite the no-subcommand index block** (currently lines ~48-95). Replace the body that runs the indexer + frames + contracts against `dbPath` with a staging build + publish:

```typescript
    const repoPath = resolve(cmd.positionals[0] ?? ctx.cwd);
    const mode = resolveIndexMode(cmd.flags);
    const dbPath = resolveCortexDbPath(repoPath); // <repo>/.cortex/db — canonical READ/PUBLISH target
    const stagePath = stagingDbPath(repoPath);    // build target — no live handle holds it
    for (const ext of ["", "-wal", "-shm"]) {
      try { unlinkSync(stagePath + ext); } catch { /* no stale staging */ }
    }

    const indexerArgs = mode ? { repo_path: repoPath, mode } : { repo_path: repoPath };
    const raw = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify(indexerArgs)],
      { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"], env: { ...process.env, CORTEX_DB: stagePath } },
    );
    const result = unwrapIndexerResult(raw);
    process.stdout.write(renderIndexerResult(result) + "\n");
    if (result.isError) return;

    // Frames + contracts build INTO staging, so the published graph is complete.
    const project = deriveProjectName(repoPath);
    const frames = await runFrameExtraction({ repoPath, project, dbPath: stagePath });
    process.stdout.write(renderFramesLine(frames) + "\n");
    const contracts = await runContractExtraction({ repoPath, project, dbPath: stagePath });
    process.stdout.write(renderContractsLine(contracts) + "\n");

    // Checkpoint staging, then publish its contents into the canonical db via
    // one libsqlite3 transaction (corruption-impossible; visible to open handles).
    try {
      const conn = new Database(stagePath);
      try { conn.pragma("wal_checkpoint(TRUNCATE)"); } finally { conn.close(); }
    } catch { /* non-fatal */ }
    publishStagedDb({ stagePath, liveDbPath: dbPath });
    for (const ext of ["", "-wal", "-shm"]) {
      try { unlinkSync(stagePath + ext); } catch { /* best-effort cleanup */ }
    }

    captureIndexMeta(dbPath, repoPath); // freshness baseline on the canonical path
    try {
      const reg = new Registry();
      try { reg.register(project, repoPath); } finally { reg.close(); }
    } catch { /* non-fatal */ }
    return;
```

- [ ] **Step 3: Manual end-to-end verification (the reported repro)**

Run, with the dev MCP server holding the repo open:

```bash
npm run build && ./bin/cortex index . --mode=full
sqlite3 .cortex/db "PRAGMA integrity_check;"
sqlite3 .cortex/db "SELECT count(DISTINCT json_extract(data,'\$.frame_id')) FROM nodes WHERE kind='file';"
```

Expected: `ok`, and a non-trivial frame count; `contracts:` line reports `ok` (not `database disk image is malformed`).

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/index.ts
git commit -m "feat(cli): index builds into staging, publishes to canonical via swap"
```

---

## Phase 4 — wire the MCP `index_repository` path, including the cache twin

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (the `index_repository` handler ~405-505; `withFrames` ~360-375)

### Task 4.1: route `withFrames` + publish through staging

- [ ] **Step 1: Add imports** near the other `src/db` imports in `code-tools.ts`:

```typescript
import { stagingDbPath } from "../../db/staging-path.js";
import { publishStagedDb } from "../../db/swap-graph-db.js";
```

- [ ] **Step 2: Change `withFrames` to build on staging and publish.** Replace `withFrames` (~360-375) with a version that takes the staging path and the canonical path, runs the passes on staging, then publishes:

```typescript
async function withFrames(
  baseText: string,
  repoPath: string,
  stagePath: string,
  liveDbPath: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const project = deriveProjectName(repoPath);
  let frames: FrameResult;
  try {
    frames = await runFrameExtraction({ repoPath, project, dbPath: stagePath });
  } catch (e) {
    frames = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
  const contracts = await runContractExtraction({ repoPath, project, dbPath: stagePath });
  publishStagedDb({ stagePath, liveDbPath });
  return { content: [{ type: "text", text: `${baseText}\nframes: ${JSON.stringify(frames)}\ncontracts: ${JSON.stringify(contracts)}` }] };
}
```

- [ ] **Step 3: Rewrite the handler body** so both the cache-hit and the cache-miss branches build into staging and publish. Replace from the cache-key computation through the final `return await withFrames(...)`:

```typescript
        const stagePath = stagingDbPath(repoPath);
        for (const ext of ["", "-wal", "-shm"]) {
          try { unlinkSync(stagePath + ext); } catch { /* no stale staging */ }
        }

        let cacheKey: string | null = null;
        if (existsSync(join(repoPath, ".git"))) {
          try { cacheKey = computeCacheKey(repoPath, mode); } catch { cacheKey = null; }
        }

        if (cacheKey && hasCacheEntry(cacheKey)) {
          mkdirSync(dirname(stagePath), { recursive: true });
          readCacheEntry(cacheKey, stagePath); // import INTO staging, never onto the live db
          const out = await withFrames(`imported from cache key ${cacheKey.slice(0, 12)}…`, repoPath, stagePath, dbPath);
          for (const ext of ["", "-wal", "-shm"]) { try { unlinkSync(stagePath + ext); } catch { /* cleanup */ } }
          captureIndexMeta(dbPath, repoPath);
          invalidateFreshness(repoPath);
          registerRepo();
          return out;
        }

        const result = await callIndexer("index_repository", { repo_path: repoPath, mode: mode }, stagePath);
        if (!result.isError && cacheKey) {
          let checkpointed = false;
          try {
            const conn = new Database(stagePath);
            try { conn.pragma("wal_checkpoint(TRUNCATE)"); checkpointed = true; } finally { conn.close(); }
          } catch { /* non-fatal; skip cache write */ }
          if (checkpointed) {
            try { writeCacheEntry(cacheKey, stagePath); } catch { /* non-fatal */ }
          }
        }
        if (result.isError) return result;
        const baseText = result.content?.[0]?.text ?? "indexed";
        const out = await withFrames(baseText, repoPath, stagePath, dbPath);
        for (const ext of ["", "-wal", "-shm"]) { try { unlinkSync(stagePath + ext); } catch { /* cleanup */ } }
        captureIndexMeta(dbPath, repoPath);
        invalidateFreshness(repoPath);
        registerRepo();
        return out;
```

Note: `dbPath` stays `resolveCortexDbPath(repoPath)` (the canonical publish target). The cache is now written FROM staging (never a raw read of a live WAL db). The cache-hit branch imports INTO staging then publishes — closing the second corruption vector.

- [ ] **Step 4: Verify the suite still compiles + passes**

Run: `npx vitest run` then `npm run build`
Expected: PASS, build exit 0.

- [ ] **Step 5: Manual verification (warm + cold cache, server handle open)**

```bash
# cold:
rm -f .cortex/db*; # then trigger index_repository via the MCP tool or `cortex index .`
sqlite3 .cortex/db "PRAGMA integrity_check;"
# warm (cache hit): index again; assert integrity ok + contracts ok
```

Expected: `ok` both times.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat(mcp): index_repository builds into staging + publishes; cache import via staging"
```

---

## Phase 5 — per-repo index lock (serialize concurrent indexers)

**Files:**
- Create: `src/db/index-lock.ts`
- Test: `tests/db/index-lock.test.ts`
- Modify: `src/cli/commands/index.ts`, `src/mcp-server/tools/code-tools.ts` (wrap the index body)

### Task 5.1: the lock

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/index-lock.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIndexLock } from "../../src/db/index-lock.js";

describe("withIndexLock", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("runs the critical section and returns its result", async () => {
    dir = mkdtempSync(join(tmpdir(), "lock-"));
    mkdirSync(join(dir, ".cortex"));
    const out = await withIndexLock(dir, async () => 42);
    expect(out).toBe(42);
  });

  it("serializes overlapping holders (second waits for the first)", async () => {
    dir = mkdtempSync(join(tmpdir(), "lock-"));
    mkdirSync(join(dir, ".cortex"));
    const order: string[] = [];
    const a = withIndexLock(dir, async () => { order.push("a-start"); await new Promise(r => setTimeout(r, 50)); order.push("a-end"); });
    const b = withIndexLock(dir, async () => { order.push("b"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/index-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/db/index-lock.ts
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Per-repo advisory index lock via a SQLite BEGIN EXCLUSIVE on a tiny
 * <repo>/.cortex/index.lock.db. Serializes concurrent index operations (CLI +
 * MCP) of the same repo. Chosen over a mkdir/lockfile because the OS releases
 * the exclusive lock when the process dies (kill -9), so it can never strand.
 * busy_timeout makes a second holder WAIT rather than throw.
 */
export async function withIndexLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(repoRoot, ".cortex", "index.lock.db");
  mkdirSync(dirname(lockPath), { recursive: true });
  const db = new BetterSqlite3(lockPath);
  db.pragma("busy_timeout = 30000");
  db.exec("BEGIN EXCLUSIVE"); // blocks until the prior holder COMMITs/closes
  try {
    return await fn();
  } finally {
    try { db.exec("COMMIT"); } catch { /* released on close regardless */ }
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/index-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/index-lock.ts tests/db/index-lock.test.ts
git commit -m "feat(db): withIndexLock — per-repo BEGIN EXCLUSIVE index serialization"
```

### Task 5.2: wrap both orchestrators

- [ ] **Step 1: CLI** — in `src/cli/commands/index.ts`, import `withIndexLock` and wrap the entire no-subcommand index body (from staging unlink through `return`) in `await withIndexLock(repoPath, async () => { … })`.

- [ ] **Step 2: MCP** — in `src/mcp-server/tools/code-tools.ts`, wrap the `index_repository` handler body (from `stagingDbPath` through the final `return out`) in `return await withIndexLock(repoPath, async () => { … })`.

- [ ] **Step 3: Verify**

Run: `npx vitest run && npm run build`
Expected: PASS, build exit 0. Manually: two `cortex index .` in parallel both finish, `integrity_check ok`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/index.ts src/mcp-server/tools/code-tools.ts
git commit -m "feat(index): serialize CLI + MCP indexing under the per-repo lock"
```

---

## Phase 6 — docs + decision capture (freshness fallback is optional)

### Task 6.1: docs + decision

- [ ] **Step 1: Update `docs/architecture/graph-storage.md`** — add a "Write path: staging build + transactional publish" section describing the model (staging file, `publishStagedDb`, WAL visibility, the per-repo lock) and noting the C writer is unchanged.

- [ ] **Step 2: Update `CLAUDE.md`** — replace the in-place / inode-preserving paragraph (the `04c848f0` note) with the staging+swap model: incremental indexing builds a private staging DB and publishes via one libsqlite3 transaction, so the server's open handle sees the refresh and can never be corrupted.

- [ ] **Step 3: Capture the decision**

```
search_decisions({ query: "graph db write path staging swap in-place" })
create_decision({
  title: "Graph DB published via transactional staging-swap (supersedes in-place truncate)",
  description: "Each reindex builds a private staging .cortex/db.stage-<pid>; publishStagedDb ATTACHes it and replaces every staging-present table inside one BEGIN IMMEDIATE on the live db, so all writes go through libsqlite3 WAL.",
  rationale: "The C writer's fopen(wb) truncate-rewrite under the server's long-lived open WAL handle corrupted index b-trees. Routing publication through a libsqlite3 transaction makes corruption impossible, the cutover crash-atomic, and the open handle sees the new snapshot with no reopen — cross-platform (incl. Windows, no rename/delete of open files).",
  alternatives: "versioned-files+pointer (fails crash/Windows, unbounded GC leakage); SQLite backup API (disqualified — throws on the 4096<-65536 page-size mismatch); keep in-place (the corruption vector).",
  governs: ["src/db/swap-graph-db.ts", "src/cli/commands/index.ts", "src/mcp-server/tools/code-tools.ts"],
})
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/graph-storage.md CLAUDE.md
git commit -m "docs: graph DB staging-swap publish model; supersede in-place"
```

### Task 6.2 (OPTIONAL — only if non-local-fs Windows support is required)

Add a `PRAGMA user_version` bump inside the publish transaction and a refcount-safe reopen-on-change fallback in `repo-context.ts`, used only when WAL `-shm` visibility is unavailable (OneDrive/network/Docker bind mounts). Deferred unless explicitly needed; the primary path needs no reopen.

---

## Self-review

- **Spec coverage:** Phase 1 ↔ busy_timeout; Phase 2 ↔ publishStagedDb (staging build + atomic SQL publish + live-only-table preservation + crash/freshness tests); Phase 3 ↔ CLI wiring; Phase 4 ↔ MCP wiring **including the cache twin** (the second vector); Phase 5 ↔ concurrency lock; Phase 6 ↔ docs + decision + optional reopen fallback. `cortex_index_meta` / `edge_annotations` handling: covered by the "live-only tables left intact" invariant (Task 2.2) + post-publish `captureIndexMeta` (Tasks 3.1/4.1).
- **Signature consistency:** `publishStagedDb({ stagePath, liveDbPath })` and `stagingDbPath(repoRoot, pid?)` are used identically in Tasks 2.2, 3.1, 4.1, 5.2. `withFrames(baseText, repoPath, stagePath, liveDbPath)` is the new 4-arg form used only in Phase 4.
- **No placeholders:** every code step shows complete code; every run step shows the command + expected output.
- **Known deviation from spec (intentional):** the spec says fold `captureIndexMeta` *inside* the swap txn; the plan instead writes it immediately after publish on the canonical path. Rationale: `cortex_index_meta` is a live-only table, freshness metadata is advisory, and a crash in the COMMIT→meta gap only triggers a harmless reindex. This keeps `publishStagedDb` single-purpose.
