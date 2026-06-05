# Frames / Viewer Storage Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<repo>/.cortex/db` the single canonical graph store per repo, decouple project enumeration into a small SQLite registry, and route every reader/writer through one path resolver so viewer and MCP can never diverge again.

**Architecture:** A new `Registry` (`~/.cache/cortex-indexer/_registry.db`) answers "what repos exist and where." Both writers (CLI `cortex index`, MCP `index_repository`) write graph to `.cortex/db` (via the binary's `CORTEX_DB` env), checkpoint WAL, and `register(name, root_path)`. Readers (`openProjectStore`, enumerators) resolve `root_path` from the registry, then open via the existing `resolveGraphDbForRead` (which already prefers `.cortex/db`, with the cache as last-resort fallback for un-migrated repos). A one-shot idempotent migration seeds the registry from legacy cache `<slug>.db` files.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `better-sqlite3`, `vitest`. The native indexer binary already honors `CORTEX_DB` to choose its output path.

**Design spec:** [docs/superpowers/specs/2026-06-05-frames-viewer-storage-unification-design.md](../specs/2026-06-05-frames-viewer-storage-unification-design.md)

---

## Background the implementer needs

- **Two unrelated caches share a prefix.** The *build* cache is `~/.cache/cortex/<hash>.db` (`src/db/cache.ts`, content-hash keyed) — leave it untouched. The *project graph* cache is `~/.cache/cortex-indexer/<slug>.db` (`cachePathForProject`) — this is what we are retiring as a graph store and what currently doubles as the registry.
- **The binary picks its output path from `CORTEX_DB`.** `callIndexer` (MCP) sets `CORTEX_DB=<repo>/.cortex/db`, so MCP already writes `.cortex/db`, already WAL-checkpoints (`code-tools.ts:400-408`), and already runs frames there. The CLI shells the binary *without* `CORTEX_DB`, so the binary defaults to the project cache — that is the divergence.
- **Project name = slug.** `deriveProjectName(absPath)` (exported from `src/frame-extraction/cluster-tfidf-hdbscan.ts`, re-exported via `src/cli/context.ts`) flattens the abs path to the slug used as `ctx_projects.name` and as the viewer's `?project=` param. The registry keys on this same name, so `openProjectStore`'s `requestedProject` matches a registry row directly.
- **Run the suite** with `npm test`; build with `npm run build` (`tsc`). Dev server: `npm run dev` (port 3334, `/viewer`).

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/db/registry.ts` | The repo registry (what/where). CRUD + `.tmp` guard. | Create |
| `tests/db/registry.test.ts` | Registry unit tests. | Create |
| `src/db/registry-migration.ts` | One-shot seed of registry from legacy cache `<slug>.db`. | Create |
| `tests/db/registry-migration.test.ts` | Migration unit tests. | Create |
| `src/cli/commands/index.ts` | CLI write path → `.cortex/db` + WAL + register. | Modify |
| `src/mcp-server/tools/code-tools.ts` | MCP register on index; `delete_project` → registry.remove. | Modify |
| `src/graph/code-queries.ts` | `openProjectStore` + `listProjectsUnified` → registry + resolver. | Modify |
| `src/mcp-server/repo-context.ts` | `listKnownRepos` → registry. | Modify |
| `src/mcp-server/api.ts` | Own a `Registry`, pass to `openProjectStore`; run migration at startup. | Modify |
| `tests/graph/open-project-store.test.ts` | `openProjectStore` prefers `.cortex/db` over cache. | Create |

---

## Task 1: Registry module

**Files:**
- Create: `src/db/registry.ts`
- Test: `tests/db/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry, isTmpPath } from "../../src/db/registry.js";

describe("Registry", () => {
  let dir: string;
  let reg: Registry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-registry-"));
    reg = new Registry(join(dir, "_registry.db"));
  });
  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers and lists a repo", () => {
    reg.register("a-b-c", "/a/b/c", "2026-06-05T00:00:00.000Z");
    expect(reg.list()).toEqual([
      { name: "a-b-c", root_path: "/a/b/c", indexed_at: "2026-06-05T00:00:00.000Z" },
    ]);
  });

  it("upserts on repeated register (no duplicate rows)", () => {
    reg.register("a-b-c", "/a/b/c", "2026-06-05T00:00:00.000Z");
    reg.register("a-b-c", "/a/b/c", "2026-06-06T00:00:00.000Z");
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexed_at).toBe("2026-06-06T00:00:00.000Z");
  });

  it("rejects paths under a .tmp segment", () => {
    reg.register("tmp-proj", "/Users/x/cortex/.tmp/frame-extraction-corpus/foo", "t");
    expect(reg.list()).toEqual([]);
    expect(isTmpPath("/a/.tmp/b")).toBe(true);
    expect(isTmpPath("/a/tmpfoo/b")).toBe(false);
  });

  it("removes a repo by name", () => {
    reg.register("a", "/a", "t");
    reg.remove("a");
    expect(reg.list()).toEqual([]);
  });

  it("two registrations both land (no lost update)", () => {
    reg.register("a", "/a", "t");
    reg.register("b", "/b", "t");
    expect(reg.list().map((r) => r.name)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/registry.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/db/registry.ts
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RegistryRepo {
  name: string;
  root_path: string;
  indexed_at: string;
}

/** Canonical registry location. `_`-prefixed so existing cache scanners that
 *  skip `_`/`tmp-` files never mistake it for a project graph DB. */
export function defaultRegistryPath(): string {
  return join(homedir(), ".cache", "cortex-indexer", "_registry.db");
}

/** True if any path segment is exactly ".tmp". Eval-corpus clones live under
 *  `cortex/.tmp/frame-extraction-corpus/*` and must never enter the registry. */
export function isTmpPath(p: string): boolean {
  return p.split("/").includes(".tmp");
}

export class Registry {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string = defaultRegistryPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS repos (
      name TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      indexed_at TEXT NOT NULL
    )`);
  }

  register(name: string, root_path: string, indexed_at: string = new Date().toISOString()): void {
    if (isTmpPath(root_path)) return;
    this.db
      .prepare(
        `INSERT INTO repos (name, root_path, indexed_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path, indexed_at = excluded.indexed_at`,
      )
      .run(name, root_path, indexed_at);
  }

  list(): RegistryRepo[] {
    return this.db
      .prepare(`SELECT name, root_path, indexed_at FROM repos ORDER BY name`)
      .all() as RegistryRepo[];
  }

  findByName(name: string): RegistryRepo | null {
    return (this.db
      .prepare(`SELECT name, root_path, indexed_at FROM repos WHERE name = ?`)
      .get(name) as RegistryRepo | undefined) ?? null;
  }

  remove(name: string): void {
    this.db.prepare(`DELETE FROM repos WHERE name = ?`).run(name);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/registry.ts tests/db/registry.test.ts
git commit -m "feat(registry): add SQLite repo registry (what/where)"
```

---

## Task 2: Registry migration from legacy cache

**Files:**
- Create: `src/db/registry-migration.ts`
- Test: `tests/db/registry-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/registry-migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { Registry } from "../../src/db/registry.js";
import { migrateCacheToRegistry } from "../../src/db/registry-migration.js";

function writeCacheDb(dir: string, file: string, name: string, root_path: string) {
  const db = new BetterSqlite3(join(dir, file));
  db.exec(`CREATE TABLE ctx_projects (name TEXT, root_path TEXT, indexed_at TEXT)`);
  db.prepare(`INSERT INTO ctx_projects VALUES (?, ?, ?)`).run(name, root_path, "2026-01-01T00:00:00.000Z");
  db.close();
}

describe("migrateCacheToRegistry", () => {
  let cacheDir: string;
  let regDir: string;
  let reg: Registry;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "cortex-cache-"));
    regDir = mkdtempSync(join(tmpdir(), "cortex-reg-"));
    reg = new Registry(join(regDir, "_registry.db"));
  });
  afterEach(() => {
    reg.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
  });

  it("seeds registry rows from cache <slug>.db ctx_projects", () => {
    writeCacheDb(cacheDir, "proj-a.db", "proj-a", "/repos/a");
    writeCacheDb(cacheDir, "proj-b.db", "proj-b", "/repos/b");
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list().map((r) => r.name).sort()).toEqual(["proj-a", "proj-b"]);
  });

  it("is idempotent across re-runs", () => {
    writeCacheDb(cacheDir, "proj-a.db", "proj-a", "/repos/a");
    migrateCacheToRegistry(reg, cacheDir);
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toHaveLength(1);
  });

  it("skips _-prefixed, tmp- prefixed, sidecars, and non-db files", () => {
    writeCacheDb(cacheDir, "_registry.db", "_registry", "/should/skip");
    writeCacheDb(cacheDir, "tmp-staging.db", "tmp-staging", "/should/skip");
    mkdirSync(join(cacheDir, "ignore-me"));
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toEqual([]);
  });

  it("skips cache DBs whose root_path is under .tmp", () => {
    writeCacheDb(cacheDir, "corpus.db", "corpus", "/x/cortex/.tmp/frame-extraction-corpus/foo");
    migrateCacheToRegistry(reg, cacheDir);
    expect(reg.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/registry-migration.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/registry-migration.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/db/registry-migration.ts
import BetterSqlite3 from "better-sqlite3";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Registry } from "./registry.js";

/** One-shot, idempotent: seed the registry from every legacy project graph DB
 *  in the cache dir. Reads each `<slug>.db`'s ctx_projects row to recover the
 *  original root_path (the slug filename is lossy). Best-effort: unreadable /
 *  pre-migration files are skipped. Does NOT copy graph data — repos re-index
 *  into `.cortex/db` and `resolveGraphDbForRead`'s cache fallback covers reads
 *  until they do. The `.tmp` guard lives in Registry.register. */
export function migrateCacheToRegistry(
  registry: Registry,
  cacheDir: string = join(homedir(), ".cache", "cortex-indexer"),
): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".db") || name.startsWith("_") || name.startsWith("tmp-")) continue;
    const dbPath = join(cacheDir, name);
    let probe: BetterSqlite3.Database | null = null;
    try {
      probe = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
      const hasTable = probe
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ctx_projects'")
        .get();
      if (!hasTable) continue;
      const projectName = name.slice(0, -3);
      const row = probe
        .prepare("SELECT name, root_path, indexed_at FROM ctx_projects WHERE name = ? LIMIT 1")
        .get(projectName) as { name: string; root_path: string; indexed_at?: string } | undefined;
      if (!row?.root_path) continue;
      registry.register(row.name, row.root_path, row.indexed_at ?? new Date().toISOString());
    } catch {
      // best-effort
    } finally {
      probe?.close();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/registry-migration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/registry-migration.ts tests/db/registry-migration.test.ts
git commit -m "feat(registry): one-shot idempotent migration from legacy cache"
```

---

## Task 3: CLI write path → `.cortex/db` + WAL + register

**Files:**
- Modify: `src/cli/commands/index.ts` (the `cmd.command === null` block, ~lines 19-32)

- [ ] **Step 1: Add imports**

At the top of `src/cli/commands/index.ts`, alongside the existing imports, add:

```typescript
import Database from "better-sqlite3";
import { resolveCortexDbPath } from "../../db/resolve-path.js";
import { Registry } from "../../db/registry.js";
```

- [ ] **Step 2: Replace the no-subcommand index block**

Replace the body of the `if (cmd.command === null || cmd.command === undefined || cmd.command === ".")` block with:

```typescript
    const repoPath = resolve(cmd.positionals[0] ?? ctx.cwd);
    const dbPath = resolveCortexDbPath(repoPath); // <repo>/.cortex/db — canonical
    const raw = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify({ repo_path: repoPath })],
      {
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "inherit"],
        // Tell the indexer binary to write the canonical per-repo store, not
        // the legacy ~/.cache/cortex-indexer/<slug>.db default.
        env: { ...process.env, CORTEX_DB: dbPath },
      },
    );
    process.stdout.write(renderIndexerResult(unwrapIndexerResult(raw)) + "\n");

    // Auto frame extraction into the SAME canonical store (additive; never blocks).
    const project = deriveProjectName(repoPath);
    const frames = await runFrameExtraction({ repoPath, project, dbPath });
    process.stdout.write(renderFramesLine(frames) + "\n");

    // Checkpoint WAL so a reader opening .cortex/db immediately sees a complete
    // state (no pending frame writes stranded in the -wal sidecar).
    try {
      const conn = new Database(dbPath);
      try { conn.pragma("wal_checkpoint(TRUNCATE)"); } finally { conn.close(); }
    } catch { /* non-fatal */ }

    // Register in the master registry (best-effort; never fail the index).
    try {
      const reg = new Registry();
      try { reg.register(project, repoPath); } finally { reg.close(); }
    } catch { /* non-fatal */ }
    return;
```

Note: `cachePathForProject` import becomes unused — remove it from the import line `import { cachePathForProject } from "../context.js";` (delete that import).

- [ ] **Step 3: Build to verify types + unused-import removal**

Run: `npm run build`
Expected: exit 0, no `cachePathForProject` unused error.

- [ ] **Step 4: Run the full suite (no CLI unit test exists for this path; guard against regressions)**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/index.ts
git commit -m "fix(cli): index into canonical .cortex/db, checkpoint WAL, register"
```

---

## Task 4: MCP register on index + delete_project → registry.remove

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` (index_repository handler ~419-421; delete_project handler ~460-470)

MCP already writes `.cortex/db` and WAL-checkpoints; it only needs to register on success and remove on delete.

- [ ] **Step 1: Add import**

Near the other imports in `src/mcp-server/tools/code-tools.ts`, add:

```typescript
import { Registry } from "../../db/registry.js";
```

- [ ] **Step 2: Register after a successful index**

In the `index_repository` handler, the two success return points both call `withFrames(...)`. Add registration immediately before each `return await withFrames(...)` (the cache-hit branch ~line 392 and the fresh-index branch ~line 421). Extract a tiny local helper at the top of the handler body (right after `const dbPath = resolveCortexDbPath(repoPath);`):

```typescript
        const registerRepo = () => {
          try {
            const reg = new Registry();
            try { reg.register(deriveProjectName(repoPath), repoPath); } finally { reg.close(); }
          } catch { /* non-fatal */ }
        };
```

Then before the cache-hit `return await withFrames("imported from cache key …", repoPath, dbPath);` add `registerRepo();`, and before the final `return await withFrames(baseText, repoPath, dbPath);` add `registerRepo();`.

- [ ] **Step 3: Remove from registry on delete_project**

Replace the `delete_project` handler body:

```typescript
      async (_resolver, args) => {
        const result = await callIndexer("delete_project", { project: args.project });
        try {
          const reg = new Registry();
          try { reg.remove(args.project); } finally { reg.close(); }
        } catch { /* non-fatal */ }
        return result;
      },
```

- [ ] **Step 4: Build + full suite**

Run: `npm run build && npm test`
Expected: exit 0; all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "feat(mcp): register repo on index, remove on delete_project"
```

---

## Task 5: Read path — `openProjectStore` via registry + resolver

**Files:**
- Modify: `src/graph/code-queries.ts` (`openProjectStore` ~190-206; `listProjectsUnified` ~136-177)
- Test: `tests/graph/open-project-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/graph/open-project-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { openProjectStore } from "../../src/graph/code-queries.js";
import { Registry } from "../../src/db/registry.js";

function seedGraph(path: string, project: string, label: string) {
  const db = new BetterSqlite3(path);
  db.exec(`CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, qualified_name TEXT,
    file_path TEXT, data TEXT, project TEXT)`);
  db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?)`).run(
    "n1", "file", "a.ts", "p.a", "src/a.ts", JSON.stringify({ frame_label: label }), project);
  db.close();
}

describe("openProjectStore — registry-driven resolution", () => {
  let repoDir: string;
  let cacheDir: string;
  let regDir: string;
  let bound: GraphStore;
  let registry: Registry;
  const project = "Users-x-repo";

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "repo-"));
    cacheDir = mkdtempSync(join(tmpdir(), "cache-"));
    regDir = mkdtempSync(join(tmpdir(), "reg-"));
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    mkdirSync(join(repoDir, ".cortex"), { recursive: true });
    // .cortex/db = NEW label; cache = STALE label.
    seedGraph(join(repoDir, ".cortex", "db"), project, "infrastructure");
    seedGraph(join(cacheDir, `${project}.db`), project, "cluster:21");
    bound = new GraphStore(":memory:");
    registry = new Registry(join(regDir, "_registry.db"));
    registry.register(project, repoDir, "t");
  });
  afterEach(() => {
    bound.close();
    registry.close();
    for (const d of [repoDir, cacheDir, regDir]) rmSync(d, { recursive: true, force: true });
  });

  it("reads .cortex/db (not the stale cache) for a registered non-bound project", () => {
    const resolved = openProjectStore(bound, "other-bound-project", project, { registry });
    expect(resolved).not.toBeNull();
    try {
      const row = resolved!.store.queryRaw<{ label: string }>(
        "SELECT json_extract(data,'$.frame_label') AS label FROM nodes LIMIT 1", [])[0];
      expect(row?.label).toBe("infrastructure");
    } finally {
      if (resolved!.owned) resolved!.store.close();
    }
  });

  it("returns the bound store unchanged for the bound project", () => {
    const resolved = openProjectStore(bound, project, project, { registry });
    expect(resolved).toEqual({ store: bound, owned: false });
  });

  it("returns null for an unknown project", () => {
    const resolved = openProjectStore(bound, "bound", "no-such-project", { registry });
    expect(resolved).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/open-project-store.test.ts`
Expected: FAIL — the current `openProjectStore` ignores the registry and reads the cache, so the first test gets `cluster:21` (or null, since the cache path it builds is `~/.cache/...` not our temp dir).

- [ ] **Step 3: Implement registry-driven resolution**

In `src/graph/code-queries.ts`, add imports at the top:

```typescript
import { Registry } from "../db/registry.js";
import { resolveGraphDbForRead } from "../db/resolve-path.js";
```

Replace `openProjectStore` with:

```typescript
export function openProjectStore(
  boundStore: GraphStore,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
  opts: { registry?: Registry } = {},
): { store: GraphStore; owned: boolean } | null {
  if (!requestedProject || requestedProject === boundProject) {
    return { store: boundStore, owned: false };
  }

  // Resolve the requested project's root_path from the registry, then open the
  // freshest store via resolveGraphDbForRead (prefers .cortex/db; cache is the
  // last-resort fallback for un-migrated repos). Falls back to the legacy
  // cache path only when the project is unknown to the registry.
  const registry = opts.registry ?? new Registry();
  let rootPath: string | null = null;
  try {
    rootPath = registry.findByName(requestedProject)?.root_path ?? null;
  } finally {
    if (!opts.registry) registry.close();
  }

  let dbPath: string | null = null;
  if (rootPath) {
    dbPath = resolveGraphDbForRead(rootPath);
  }
  if (!dbPath) {
    const legacy = join(homedir(), ".cache", "cortex-indexer", `${requestedProject}.db`);
    dbPath = existsSync(legacy) ? legacy : null;
  }
  if (!dbPath) return null;

  try {
    const store = new GraphStore(dbPath, { readonly: true });
    return { store, owned: true };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/open-project-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Point `listProjectsUnified` at the registry**

Replace the cache-scanning loop in `listProjectsUnified` (the `for (const name of entries)` block, ~155-174) so that, instead of scanning the cache dir, it merges registry rows. Replace the body after the bound-store loop with:

```typescript
  try {
    const registry = new Registry();
    try {
      for (const r of registry.list()) {
        if (out.has(r.name)) continue;
        out.set(r.name, { name: r.name, indexed_at: r.indexed_at, root_path: r.root_path } as IndexerProject);
      }
    } finally {
      registry.close();
    }
  } catch {
    // Registry unavailable — bound store entries only.
  }

  return Array.from(out.values());
```

Remove the now-unused `readdirSync`/`cacheDir`/`homedir` references in this function if they are not used elsewhere in the file (build will flag them).

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npm test`
Expected: exit 0; all pass.

- [ ] **Step 7: Commit**

```bash
git add src/graph/code-queries.ts tests/graph/open-project-store.test.ts
git commit -m "fix(viewer): resolve project store via registry + resolveGraphDbForRead"
```

---

## Task 6: `listKnownRepos` via registry + startup wiring & migration

**Files:**
- Modify: `src/mcp-server/repo-context.ts` (`listKnownRepos` ~323-380)
- Modify: `src/mcp-server/api.ts` (`startViewerServer` — own a Registry, run migration, pass to `openProjectStore`)

- [ ] **Step 1: Replace the cache-scan in `listKnownRepos`**

In `src/mcp-server/repo-context.ts`, add import:

```typescript
import { Registry } from "../db/registry.js";
```

Replace section `(b)` (the cache-dir scan, ~337-377) with:

```typescript
    // (b) Master registry — the persistent record of every known repo and its
    // root_path, independent of graph storage.
    try {
      const registry = new Registry();
      try {
        for (const r of registry.list()) {
          if (byPath.has(r.root_path)) continue;
          byPath.set(r.root_path, { name: r.name, path: r.root_path, indexed: true });
        }
      } finally {
        registry.close();
      }
    } catch {
      // Registry unavailable — pooled repos only.
    }

    return Array.from(byPath.values());
```

Remove now-unused `readdirSync`/`BetterSqlite3`/`homedir`/`join` imports from this file only if the build flags them as unused (they may still be used elsewhere — let `npm run build` decide).

- [ ] **Step 2: Wire registry + migration into the viewer server**

In `src/mcp-server/api.ts`, add imports:

```typescript
import { Registry } from "../db/registry.js";
import { migrateCacheToRegistry } from "../db/registry-migration.js";
```

Inside `startViewerServer`, before `createHttpServer`, add:

```typescript
    // Master registry, opened once for the server's lifetime. Seed it from any
    // legacy cache <slug>.db on first run (idempotent).
    const registry = new Registry();
    try { migrateCacheToRegistry(registry); } catch { /* best-effort */ }
```

Update each `openProjectStore(store, indexerProject, <proj>)` call (lines ~55, 120, 147, 167, 190) to pass the registry: `openProjectStore(store, indexerProject, <proj>, { registry })`.

Ensure the registry is closed on shutdown: in the returned `ViewerServerHandle`'s close path, add `registry.close();` alongside the existing teardown.

- [ ] **Step 3: Build + full suite**

Run: `npm run build && npm test`
Expected: exit 0; all pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/repo-context.ts src/mcp-server/api.ts
git commit -m "feat(mcp): enumerate repos from registry; seed at viewer startup"
```

---

## Task 7: Gate-0 visual QA + final verification

**No code.** Per `.claude/rules/workflow.md` Gate 0, this touches viewer read paths, so verify in the running app.

- [ ] **Step 1: Build + full suite once more**

Run: `npm run build && npm test`
Expected: exit 0; all pass.

- [ ] **Step 2: Start the dev server**

Run: `npm run dev` (port 3334). Wait for startup log / HTTP 200 on `http://localhost:3334/viewer`.

- [ ] **Step 3: Drive the viewer (Playwright MCP)**

- Navigate to `http://localhost:3334/viewer`.
- Open the project switcher; confirm registry-known projects list (e.g. `Users-rka-Development-activator-rosalind`, `Users-rka-Development-anthill-cloud`).
- Switch to a non-bound project; confirm frames render with current labels (`infrastructure`, `events`, `settings`, `devbox`, `drizzle`, …) and **no `cluster:N`**.
- Check the browser console for errors.
- Screenshot to `.tmp/` (e.g. `browser_take_screenshot` with `filename: ".tmp/p2-viewer.png"`).

- [ ] **Step 4: Report findings**

Runtime errors / stale labels / broken render → fix before completion. Aesthetic issues → document, don't block. If Playwright is unavailable, state so and flag the task as needing user hand-verify before merge.

- [ ] **Step 5: Gate 1 — code review**

Run `/review` on `git diff main --name-only`. Fix Critical findings; document Warnings.

- [ ] **Step 6: Capture a decision**

```
create_decision({
  repo_path: "/Users/rka/Development/cortex",
  title: "Canonical .cortex/db + decoupled repo registry",
  description: "...", rationale: "...",
  governs: ["src/db/registry.ts", "src/graph/code-queries.ts", "src/db/resolve-path.ts"],
})
```
(Reference this plan + the design spec.)

---

## Self-review notes

- **Spec coverage:** §1 canonical store (Tasks 3,4 write `.cortex/db`); §2 registry (Task 1); §3 write path + WAL (Tasks 3,4); §4 read path (Tasks 5,6); §5 migration (Tasks 2,6); §6 boundaries (file structure); §7 error handling (best-effort try/catch in every wiring step, `openProjectStore` returns null); §8 testing (Tasks 1,2,5 unit; Task 7 integration/Gate-0). All covered.
- **Single-chokepoint invariant:** path→DB mapping stays in `resolve-path.ts`; no task hardcodes `.cortex/db` outside it except the two writers, which use `resolveCortexDbPath(repoPath)`. Future branch-keying remains a one-file change.
- **Type consistency:** `Registry.register/list/findByName/remove/close`, `RegistryRepo {name, root_path, indexed_at}`, `migrateCacheToRegistry(registry, cacheDir?)`, `openProjectStore(..., { registry })` used identically across tasks.
- **Phasing:** every task leaves the build green and the system working (registry is additive until Task 5/6 switch readers over; the cache fallback in `openProjectStore` and `resolveGraphDbForRead` keeps un-migrated repos readable throughout).
