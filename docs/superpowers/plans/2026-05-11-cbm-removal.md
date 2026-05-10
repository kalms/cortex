# CBM Removal — Phases 6 through 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the CBM absorption track. End state: no references to "CBM" / "codebase-memory" anywhere in `src/`, `tests/`, or `docs/` (except historical handoff/spec docs); `internal/cbm/` renamed to `internal/indexer/`; all C symbols on `ctx_*` / `CTX_*`; cortex.db at repo root with a content-addressed build cache; CBM's standalone-product files (README, install scripts, server.json, etc.) replaced by a single attribution doc at repo root.

**Architecture:** Four sequential phases, each shipping independently with its own branch + merge + phase tag (per `.claude/rules/workflow.md`). Phase 6 = restructure the MCP shell, keep handlers, delete transport. Phase 7 = relocate DB + add cache. Phase 8 = TS rename. Phase 9 = C rename + dir rename + attribution consolidation. The earlier discovery that `cli` mode in `main.c` shares handlers with MCP mode (`cbm_mcp_handle_tool` is called from both paths) means Phase 6's "delete `src/mcp/`" is actually "delete JSON-RPC transport, keep handlers, rename the directory."

**Tech Stack:** C (CBM indexer), TypeScript (Cortex MCP server + tests), SQLite, Vitest, Node child_process for CLI bridging.

**Branch strategy:** Each phase is its own sub-branch off `main`, merged with `--no-ff` and tagged `phase-N-<short-name>`. The current branch `feature/db/cbm-removal` is for the plan doc only; once the plan is merged, branch off main per phase.

---

## Phase 6 — Strip MCP shell + bridge 3 missing tools

**Branch:** `feature/db/cbm-phase-6-mcp-strip`
**Tag at merge:** `phase-6-mcp-strip`
**Validation gate:** `npm test` passes; `bin/cortex-indexer cli query_graph '{"cypher":"MATCH (n) RETURN count(n)"}'` returns valid JSON; `bin/cortex-indexer --help` shows only CLI subcommands (no MCP-server mode); 13 bridged tools all visible via Cortex MCP (`index_repository`, `detect_changes`, `delete_project`, `search_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `list_projects`, `index_status`, `search_code`, `query_graph`, `get_architecture`, `ingest_traces`). `manage_adr` deliberately not bridged.

### Task 6.1 — Inventory MCP-only vs shared code in mcp.c

**Files:**
- Read: `internal/cbm/src/mcp/mcp.c` (3886 lines), `internal/cbm/src/mcp/mcp.h`, `internal/cbm/src/main.c:120-180` (run_cli)

- [ ] **Step 1: Identify the JSON-RPC transport boundary**

`mcp.c` mixes two concerns. The JSON-RPC transport is the MCP-only part. The handlers + dispatcher are shared with CLI mode (`run_cli` in `main.c` calls `cbm_mcp_handle_tool`). Classify every top-level function in `mcp.c` into one of:

- **DELETE** — JSON-RPC transport (parsing, framing, stdio read-loop). Known members: `cbm_jsonrpc_parse`, `cbm_jsonrpc_format_response`, `cbm_jsonrpc_format_error`, `cbm_jsonrpc_request_free`, the main stdio read-loop near line 3635+, the `fgets` loop near line 1918 if MCP-only.
- **KEEP** — Tool handlers (all 14 `handle_*` functions), the dispatcher `cbm_mcp_handle_tool` (lines 3342-3383), the server context (`cbm_mcp_server_t`, `cbm_mcp_server_new`, `cbm_mcp_server_free`, `cbm_mcp_text_result`).

Produce a hand-written audit comment at the top of the resulting `handlers.c` (after rename below) listing what was removed and what was kept. Commit this audit as the first commit of the phase so reviewers can verify the boundary.

- [ ] **Step 2: Commit the audit**

```bash
git add internal/cbm/src/mcp/MCP_RESTRUCTURE_AUDIT.md
git commit -m "docs(cbm): audit MCP vs shared code in mcp.c for phase 6"
```

(The audit file can be a temporary markdown sibling — delete it at end of phase 6 once the restructure is verified.)

### Task 6.2 — Rename directory and headers (file moves only, no logic changes)

**Files:**
- Rename: `internal/cbm/src/mcp/mcp.c` → `internal/cbm/src/handlers/handlers.c`
- Rename: `internal/cbm/src/mcp/mcp.h` → `internal/cbm/src/handlers/handlers.h`
- Modify: every `#include "mcp/mcp.h"` reference in the tree
- Modify: `internal/cbm/Makefile.cbm` source paths

- [ ] **Step 1: Move files with git mv**

```bash
git mv internal/cbm/src/mcp internal/cbm/src/handlers
git mv internal/cbm/src/handlers/mcp.c internal/cbm/src/handlers/handlers.c
git mv internal/cbm/src/handlers/mcp.h internal/cbm/src/handlers/handlers.h
```

- [ ] **Step 2: Update includes**

```bash
grep -rln '"mcp/mcp.h"' internal/cbm/src internal/cbm/tests | xargs sed -i '' 's|"mcp/mcp.h"|"handlers/handlers.h"|g'
```

(macOS `sed -i ''` syntax; on Linux use `sed -i`.)

- [ ] **Step 3: Update Makefile**

In `internal/cbm/Makefile.cbm`, replace `src/mcp/mcp.c` with `src/handlers/handlers.c` (search and replace; there's likely also a `src/mcp/*.o` pattern).

- [ ] **Step 4: Build to verify rename only**

```bash
bash scripts/build-indexer.sh
```

Expected: clean build. If any include path was missed, the compiler tells you exactly which file.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cbm): rename src/mcp/ to src/handlers/ (no logic change)"
```

### Task 6.3 — Delete the JSON-RPC transport from handlers.c

**Files:**
- Modify: `internal/cbm/src/handlers/handlers.c` — delete transport functions per Task 6.1 audit
- Modify: `internal/cbm/src/handlers/handlers.h` — remove transport-only declarations
- Test: `bash scripts/build-indexer.sh` then `bin/cortex-indexer cli list_projects '{}'`

- [ ] **Step 1: Delete the functions classified as DELETE**

Remove from `handlers.c`:
- `cbm_jsonrpc_parse`
- `cbm_jsonrpc_format_response`
- `cbm_jsonrpc_format_error`
- `cbm_jsonrpc_request_free`
- Any stdio read-loop (the one near line 3635 that calls `cbm_jsonrpc_parse`)
- The MCP request-dispatch function that wraps `cbm_mcp_handle_tool` with JSON-RPC framing

Remove from `handlers.h`:
- Matching declarations for the above
- The `cbm_jsonrpc_request_t` and `cbm_jsonrpc_response_t` struct definitions

KEEP everything classified as KEEP in Task 6.1 (handlers, dispatcher, server context, `cbm_mcp_text_result`).

- [ ] **Step 2: Build**

```bash
bash scripts/build-indexer.sh
```

Expected: clean build. If a JSON-RPC symbol is referenced from main.c or elsewhere, fix that reference in Task 6.4 — but the build should reveal it now.

- [ ] **Step 3: Smoke-test CLI mode (still works without transport)**

```bash
bin/cortex-indexer cli list_projects '{}'
bin/cortex-indexer cli search_graph '{"name_pattern":"main"}'
```

Expected: valid JSON output from each. If either fails, the boundary in Task 6.1 misclassified something.

- [ ] **Step 4: Commit**

```bash
git add internal/cbm/src/handlers/
git commit -m "feat(cbm): remove JSON-RPC transport from handlers.c"
```

### Task 6.4 — Strip default MCP-server mode from main.c

**Files:**
- Modify: `internal/cbm/src/main.c` — drop the no-args MCP-server default; require a subcommand
- Modify: `internal/cbm/src/main.c:179-185` (print_help) — drop the "Run MCP server on stdio" line

- [ ] **Step 1: Strip MCP-server default in main()**

In `main.c`, the default code path (when no subcommand matches) currently runs the MCP server on stdio. After Phase 6 there is no MCP server. Replace the default with: print usage to stderr, return non-zero. The `cli`, `install`, `uninstall`, `update`, `config`, `--version`, `--help` subcommands continue to work via `handle_subcommand`.

Also remove `parse_ui_flags`, `--ui=`, `--port=` flag handling — those were for the HTTP UI server (deleted in Task 6.5).

- [ ] **Step 2: Strip MCP-related includes**

Remove from main.c:
- `#include "ui/config.h"`, `#include "ui/http_server.h"`, `#include "ui/embedded_assets.h"` (UI deleted in Task 6.5)
- Signal handling for MCP server graceful shutdown if it's MCP-only

Keep:
- `#include "handlers/handlers.h"` (for `cbm_mcp_handle_tool` used by `run_cli`)

- [ ] **Step 3: Update help text**

In `print_help`, drop "Run MCP server on stdio" and the `--ui=`/`--port=` flag docs.

- [ ] **Step 4: Build + smoke-test**

```bash
bash scripts/build-indexer.sh
bin/cortex-indexer --help
bin/cortex-indexer            # no args — should print usage and exit nonzero
bin/cortex-indexer cli list_projects '{}'
```

Expected: `--help` lists only CLI subcommands; bare invocation prints usage and exits ≠ 0; `cli` subcommand still works.

- [ ] **Step 5: Commit**

```bash
git add internal/cbm/src/main.c
git commit -m "feat(cbm): drop default MCP-server mode from main.c"
```

### Task 6.5 — Delete UI directories and vendored mongoose

**Files:**
- Delete: `internal/cbm/src/ui/` (C HTTP server)
- Delete: `internal/cbm/graph-ui/` (Vite frontend)
- Delete: `internal/cbm/vendored/mongoose/` (HTTP library)
- Modify: `internal/cbm/Makefile.cbm` — remove ui/, mongoose from source list and include paths

- [ ] **Step 1: Delete directories**

```bash
git rm -r internal/cbm/src/ui
git rm -r internal/cbm/graph-ui
git rm -r internal/cbm/vendored/mongoose
```

- [ ] **Step 2: Remove from Makefile.cbm**

Open `internal/cbm/Makefile.cbm` and remove all references to `src/ui/`, `graph-ui`, `vendored/mongoose`, `-Ivendored/mongoose`, mongoose `.o` files. Also remove any `embedded_assets.c` generation step (graph-ui builds bake into a C array).

- [ ] **Step 3: Build**

```bash
bash scripts/build-indexer.sh
```

Expected: clean build. Binary size should drop noticeably (mongoose + embedded UI assets gone).

- [ ] **Step 4: Smoke-test**

```bash
bin/cortex-indexer cli list_projects '{}'
```

Expected: valid JSON.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cbm): delete graph-ui, src/ui/, vendored/mongoose"
```

### Task 6.6 — Delete CBM's standalone MCP tests

**Files:**
- Delete: `internal/cbm/tests/` MCP-related files (any test that exercises JSON-RPC over stdio or the MCP server context)

- [ ] **Step 1: Identify MCP-only tests**

```bash
grep -l "jsonrpc\|JSONRPC\|mcp_server\|stdio" internal/cbm/tests/*.c | head -20
```

Manually review. Any test that calls `cbm_jsonrpc_*` or starts an MCP server on stdio is MCP-only and must be deleted. Tests that call `cbm_mcp_handle_tool` directly (as a CLI handler) can be kept *if* they otherwise still build — but HANDOFF tech-debt says the whole `internal/cbm/tests/` suite is already broken post-Phase-4, so simplest path: delete the MCP-only tests and leave the rest as a known-broken suite (the npm test path doesn't run them).

- [ ] **Step 2: Delete identified files**

```bash
git rm internal/cbm/tests/<files identified in step 1>
```

- [ ] **Step 3: Commit**

```bash
git add internal/cbm/tests
git commit -m "test(cbm): delete MCP-only tests after JSON-RPC removal"
```

### Task 6.7 — Add three new CLI dispatch cases for the bridged tools

**Files:**
- Verify: `internal/cbm/src/handlers/handlers.c` already has `handle_query_graph`, `handle_get_architecture`, `handle_ingest_traces` and dispatches them in `cbm_mcp_handle_tool` — they were already CLI-reachable in pre-Phase-6 code. Confirm via:

```bash
grep -n "query_graph\|get_architecture\|ingest_traces" internal/cbm/src/handlers/handlers.c | head -10
bin/cortex-indexer cli query_graph '{"cypher":"MATCH (n) RETURN count(n) LIMIT 1"}'
bin/cortex-indexer cli get_architecture '{"aspects":["all"]}'
bin/cortex-indexer cli ingest_traces '{"traces":[]}'
```

Expected: each command returns valid JSON (not an error). If any returns an error like "tool not found", the dispatcher in `cbm_mcp_handle_tool` lost a case — restore it.

- [ ] **Step 1: Verify all three tools dispatch successfully**

Run the three commands above. Capture output.

- [ ] **Step 2: If a case was lost, restore it**

The dispatcher pattern in `cbm_mcp_handle_tool` is:

```c
if (strcmp(tool_name, "query_graph") == 0) {
    return handle_query_graph(srv, args_json);
}
```

If a case is missing, re-add it next to the others. Build and re-smoke.

- [ ] **Step 3: Commit (if changes were needed; skip if already working)**

```bash
git add internal/cbm/src/handlers/handlers.c
git commit -m "fix(cbm): restore CLI dispatch for query_graph/get_architecture/ingest_traces"
```

### Task 6.8 — Bridge the three tools in Cortex's MCP server

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` — add 3 new `server.tool(...)` registrations following the existing pattern (lines 68-90 show the template)

- [ ] **Step 1: Write failing contract tests**

Create `tests/mcp-contract/code-tools-bridged.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mcpCall } from "./helpers/mcp-call";

describe("Phase 6 bridged tools", () => {
  it("query_graph dispatches via indexer CLI", async () => {
    const res = await mcpCall("query_graph", {
      cypher: "MATCH (n) RETURN count(n) AS c LIMIT 1",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/"c"\s*:/);
  });

  it("get_architecture returns aspects payload", async () => {
    const res = await mcpCall("get_architecture", { aspects: ["all"] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.length).toBeGreaterThan(0);
  });

  it("ingest_traces accepts empty trace list", async () => {
    const res = await mcpCall("ingest_traces", { traces: [] });
    expect(res.isError).toBeFalsy();
  });
});
```

(`mcpCall` helper: follow whatever pattern existing files in `tests/mcp-contract/` use. If there's no such helper, copy the inline pattern from an existing test in that directory.)

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/mcp-contract/code-tools-bridged.test.ts
```

Expected: 3 failures, each "tool not registered" or similar.

- [ ] **Step 3: Add three registrations to code-tools.ts**

In `src/mcp-server/tools/code-tools.ts`, after the existing `search_code` registration, add:

```typescript
server.tool(
  "query_graph",
  "Execute a Cypher-style query against the code graph",
  { cypher: z.string().describe("Cypher query string") },
  async ({ cypher }) => callCbm("query_graph", { cypher }),
);

server.tool(
  "get_architecture",
  "Get architectural overview by aspect (entry_points, public_api, hot_paths, all)",
  {
    aspects: z
      .array(z.string())
      .optional()
      .describe('Aspects to include, e.g. ["all"]'),
  },
  async ({ aspects }) => callCbm("get_architecture", { aspects: aspects ?? ["all"] }),
);

server.tool(
  "ingest_traces",
  "Ingest runtime traces to enrich the graph",
  {
    traces: z.array(z.unknown()).describe("Array of trace records"),
  },
  async ({ traces }) => callCbm("ingest_traces", { traces }),
);
```

(Verify the exact schema fields each handler reads by checking `handle_query_graph` / `handle_get_architecture` / `handle_ingest_traces` in `handlers.c`. The above is a best-guess; correct any field names that don't match.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/mcp-contract/code-tools-bridged.test.ts
```

Expected: 3 passes.

- [ ] **Step 5: Run full test suite to verify nothing else broke**

```bash
npm test
```

Expected: 48+ files, all passing (1 pre-existing skip in `decision-tools.test.ts` is fine).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/mcp-contract/code-tools-bridged.test.ts
git commit -m "feat(api): bridge query_graph, get_architecture, ingest_traces"
```

### Task 6.9 — Delete the audit doc, run Gate 1 review, merge, tag

- [ ] **Step 1: Delete the audit doc from Task 6.1**

```bash
git rm internal/cbm/src/mcp/MCP_RESTRUCTURE_AUDIT.md  # or wherever it ended up
git commit -m "chore: remove phase 6 audit doc after restructure verified"
```

(If the audit doc ended up in `internal/cbm/src/handlers/` after the rename, adjust the path.)

- [ ] **Step 2: Run /review on the branch diff**

```bash
git diff main --name-only
# Then /review
```

Address Critical findings. Document Warnings.

- [ ] **Step 3: Run qa agent (Gate 2)**

Invoke `qa` per workflow.md.

- [ ] **Step 4: Merge to main with --no-ff and tag**

```bash
git checkout main
git merge --no-ff feature/db/cbm-phase-6-mcp-strip
git tag phase-6-mcp-strip
git branch -d feature/db/cbm-phase-6-mcp-strip
```

(Push only when user explicitly asks.)

---

## Phase 7 — Repo-root cortex.db + content-hash cache

**Branch:** `feature/db/cbm-phase-7-db-relocate`
**Tag at merge:** `phase-7-db-relocate`
**Validation gate:** Running `index_repository` in two fresh clones of the same repo produces a cache hit on the second; first index in repo A and first index in repo B produce two distinct DB files at `<repoA>/.cortex/db` and `<repoB>/.cortex/db`; `.cortex/.gitignore` is auto-created.

### Task 7.1 — Define DB path resolution

**Files:**
- Modify: `src/index.ts:13` — replace `process.env.CORTEX_DB_PATH || ".cortex/graph.db"` with repo-root resolution
- Modify: `src/mcp-server/tools/code-tools.ts:33` — same change
- Create: `src/db/resolve-path.ts` — single resolver used by both call sites

- [ ] **Step 1: Write failing test for resolve-path**

Create `tests/db/resolve-path.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCortexDbPath } from "../../src/db/resolve-path.js";

describe("resolveCortexDbPath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cortex-resolve-"));
    mkdirSync(join(tmp, ".git"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds .git from repo root", () => {
    expect(resolveCortexDbPath(tmp)).toBe(join(tmp, ".cortex", "db"));
  });

  it("walks up from a subdirectory", () => {
    const sub = join(tmp, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveCortexDbPath(sub)).toBe(join(tmp, ".cortex", "db"));
  });

  it("honors CORTEX_DB_PATH override", () => {
    process.env.CORTEX_DB_PATH = "/tmp/override.db";
    try {
      expect(resolveCortexDbPath(tmp)).toBe("/tmp/override.db");
    } finally {
      delete process.env.CORTEX_DB_PATH;
    }
  });

  it("falls back to cwd-relative when no .git found", () => {
    const noGit = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(resolveCortexDbPath(noGit)).toBe(join(noGit, ".cortex", "db"));
    rmSync(noGit, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/db/resolve-path.test.ts
```

Expected: import error or all failing.

- [ ] **Step 3: Implement resolveCortexDbPath**

Create `src/db/resolve-path.ts`:

```typescript
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveCortexDbPath(startDir: string = process.cwd()): string {
  const override = process.env.CORTEX_DB_PATH;
  if (override) return override;

  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return join(dir, ".cortex", "db");
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // No .git found — fall back to startDir-relative .cortex/db
      return join(startDir, ".cortex", "db");
    }
    dir = parent;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
npm test -- tests/db/resolve-path.test.ts
```

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add src/db/resolve-path.ts tests/db/resolve-path.test.ts
git commit -m "feat(db): add repo-root cortex.db path resolver"
```

### Task 7.2 — Switch call sites to the resolver

**Files:**
- Modify: `src/index.ts:13`
- Modify: `src/mcp-server/tools/code-tools.ts:33`

- [ ] **Step 1: Replace inline path resolution**

In `src/index.ts`, replace:

```typescript
const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
```

with:

```typescript
import { resolveCortexDbPath } from "./db/resolve-path.js";
const dbPath = resolveCortexDbPath();
```

In `src/mcp-server/tools/code-tools.ts`, replace:

```typescript
const cortexDb = pathResolve(process.env.CORTEX_DB_PATH || ".cortex/graph.db");
```

with:

```typescript
import { resolveCortexDbPath } from "../../db/resolve-path.js";
const cortexDb = resolveCortexDbPath();
```

Note the filename change: `graph.db` → `db`. This is intentional per spec §3 Step 7 ("`<repo>/.cortex/db`"). Existing local DBs at `.cortex/graph.db` will no longer be picked up; users re-index. Acceptable under break-away policy.

- [ ] **Step 2: Create .cortex/.gitignore auto-creator**

In `src/index.ts` startup path, after resolving `dbPath`, ensure the `.cortex/` parent dir exists and write a `.gitignore` if missing:

```typescript
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const cortexDir = dirname(dbPath);
mkdirSync(cortexDir, { recursive: true });
const gitignorePath = join(cortexDir, ".gitignore");
if (!existsSync(gitignorePath)) {
  writeFileSync(gitignorePath, "db\ndb-wal\ndb-shm\nlocal/\n");
}
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: all pass. Some tests may need fixture updates if they hard-coded `.cortex/graph.db`. Grep for that path and fix.

- [ ] **Step 4: Smoke test in a real repo**

```bash
cd /tmp && rm -rf cortex-smoke && git init cortex-smoke && cd cortex-smoke
echo "function hello() { return 42; }" > a.js
git add . && git commit -m "init"
node /Users/rka/Development/cortex/dist/index.js  # or however cortex starts
ls -la .cortex/
```

Expected: `.cortex/db`, `.cortex/.gitignore` (with `db`, `db-wal`, `db-shm`, `local/`), no `graph.db`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/mcp-server/tools/code-tools.ts
git commit -m "feat(db): switch to repo-root .cortex/db path + auto-gitignore"
```

### Task 7.3 — Implement content-hash cache layer

**Files:**
- Create: `src/db/cache.ts` — cache-key derivation and read/write helpers
- Create: `tests/db/cache.test.ts`
- Modify: `src/mcp-server/tools/code-tools.ts` — wrap `index_repository` to check cache before / write cache after

**Cache key derivation:** `sha256(indexerVersion || "\n" || grammarPackHash || "\n" || gitTreeHash)`
- `indexerVersion` — `bin/cortex-indexer --version` output (one line)
- `grammarPackHash` — hash of `internal/cbm/vendored/grammars/` tree (or whatever directory holds the .scm files); falls back to a fixed string if dir doesn't exist post-Phase-9 reorg
- `gitTreeHash` — `git rev-parse HEAD^{tree}` in the repo being indexed (uses tree, not commit — invalidates on uncommitted-staged content via index, but not on truly-unstaged edits; acceptable trade)

**Cache location:** `~/.cache/cortex/<cache-key>.db`

- [ ] **Step 1: Write failing test**

Create `tests/db/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { computeCacheKey, cachePath, hasCacheEntry, writeCacheEntry } from "../../src/db/cache.js";

describe("content-hash cache", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-cache-"));
    execSync("git init && git commit --allow-empty -m init", { cwd: repo, stdio: "ignore" });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("derives a stable cache key from repo state", () => {
    const k1 = computeCacheKey(repo);
    const k2 = computeCacheKey(repo);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("key changes when repo tree changes", () => {
    const k1 = computeCacheKey(repo);
    writeFileSync(join(repo, "a.txt"), "hello");
    execSync("git add . && git commit -m a", { cwd: repo, stdio: "ignore" });
    const k2 = computeCacheKey(repo);
    expect(k1).not.toBe(k2);
  });

  it("writes and detects a cache entry", () => {
    const key = computeCacheKey(repo);
    const fakeDb = mkdtempSync(join(tmpdir(), "fake-db-"));
    writeFileSync(join(fakeDb, "db"), "fake sqlite bytes");
    writeCacheEntry(key, join(fakeDb, "db"));
    expect(hasCacheEntry(key)).toBe(true);
    expect(existsSync(cachePath(key))).toBe(true);
    rmSync(fakeDb, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/db/cache.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement cache module**

Create `src/db/cache.ts`:

```typescript
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(homedir(), ".cache", "cortex");

function indexerVersion(): string {
  try {
    return execSync(`${process.env.CORTEX_INDEXER_PATH || "bin/cortex-indexer"} --version`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function grammarPackHash(): string {
  // Hash of the grammars directory. Phase 9 may relocate this.
  const grammarRoot = join(process.cwd(), "internal", "cbm", "vendored", "grammars");
  if (!existsSync(grammarRoot)) return "no-grammars";
  const h = createHash("sha256");
  function walk(dir: string) {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else {
        h.update(entry);
        h.update(readFileSync(p));
      }
    }
  }
  walk(grammarRoot);
  return h.digest("hex");
}

function gitTreeHash(repo: string): string {
  return execSync("git rev-parse HEAD^{tree}", { cwd: repo, encoding: "utf8" }).trim();
}

export function computeCacheKey(repo: string): string {
  const parts = [indexerVersion(), grammarPackHash(), gitTreeHash(repo)];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.db`);
}

export function hasCacheEntry(key: string): boolean {
  return existsSync(cachePath(key));
}

export function writeCacheEntry(key: string, sourceDbPath: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  copyFileSync(sourceDbPath, cachePath(key));
}

export function readCacheEntry(key: string, destDbPath: string): boolean {
  if (!hasCacheEntry(key)) return false;
  copyFileSync(cachePath(key), destDbPath);
  return true;
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
npm test -- tests/db/cache.test.ts
```

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add src/db/cache.ts tests/db/cache.test.ts
git commit -m "feat(db): content-hash build cache at ~/.cache/cortex/"
```

### Task 7.4 — Wire cache into index_repository

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts` — wrap `index_repository` registration to consult cache

- [ ] **Step 1: Wrap the tool**

In `code-tools.ts`, replace the existing `index_repository` registration with:

```typescript
import { computeCacheKey, readCacheEntry, writeCacheEntry, hasCacheEntry } from "../../db/cache.js";

server.tool(
  "index_repository",
  "Index a repository into the knowledge graph (uses content-hash build cache)",
  { path: z.string().optional().describe("Repository path (default: current directory)") },
  async ({ path }) => {
    const repoPath = path || process.cwd();
    const dbPath = resolveCortexDbPath(repoPath);

    let cacheKey: string;
    try {
      cacheKey = computeCacheKey(repoPath);
    } catch (e) {
      // Repo has no commits / not a git repo. Skip cache.
      return callCbm("index_repository", { repo_path: repoPath });
    }

    if (hasCacheEntry(cacheKey)) {
      readCacheEntry(cacheKey, dbPath);
      return ok(`imported from cache key ${cacheKey.slice(0, 12)}…`);
    }

    const result = await callCbm("index_repository", { repo_path: repoPath });
    if (!result.isError) {
      try {
        writeCacheEntry(cacheKey, dbPath);
      } catch {
        // Cache write failure is non-fatal.
      }
    }
    return result;
  },
);
```

- [ ] **Step 2: Add contract test**

Append to `tests/mcp-contract/code-tools-bridged.test.ts` (or create a new file `tests/mcp-contract/index-cache.test.ts`):

```typescript
it("index_repository hits cache on second call with unchanged repo", async () => {
  // Setup: index a temp repo once
  const repo = createTempRepo();
  const r1 = await mcpCall("index_repository", { path: repo });
  expect(r1.isError).toBeFalsy();

  // Re-index: should report cache hit
  const r2 = await mcpCall("index_repository", { path: repo });
  expect(r2.isError).toBeFalsy();
  expect(r2.content[0].text).toMatch(/imported from cache key/);
});
```

(`createTempRepo` helper: `git init` a tmpdir with one tiny file + commit, return path. Implement inline if needed.)

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all pass including the new cache-hit test.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/mcp-contract/
git commit -m "feat(api): index_repository consults content-hash cache"
```

### Task 7.5 — Review, merge, tag Phase 7

- [ ] **Step 1: `/review`** the branch diff. Fix Criticals.
- [ ] **Step 2: Run `qa` agent.**
- [ ] **Step 3: Merge + tag**

```bash
git checkout main
git merge --no-ff feature/db/cbm-phase-7-db-relocate
git tag phase-7-db-relocate
git branch -d feature/db/cbm-phase-7-db-relocate
```

---

## Phase 8 — TS rename pass

**Branch:** `feature/db/cbm-phase-8-ts-rename`
**Tag at merge:** `phase-8-ts-rename`
**Validation gate:** `grep -rn "Cbm\|cbm" src/ tests/ --include="*.ts"` returns nothing (or only `bin/cortex-indexer` references); `npm test` passes; README's "CBM Integration" section is now "Native Indexer".

### Task 8.1 — Rename TS interfaces / variables

**Files:**
- Modify (via project-wide rename): every `.ts` file under `src/` and `tests/`

- [ ] **Step 1: Catalog the renames**

| Old | New |
|---|---|
| `CbmNode` | `IndexerNode` |
| `CbmEdge` | `IndexerEdge` |
| `CbmProject` | `IndexerProject` |
| `cbmProject` (variable) | `indexerProject` |
| `cbmDb` (variable) | `indexerDb` |
| `callCbm` (function) | `callIndexer` |
| `CBM_BINARY_PATH` (env var) | keep as deprecated alias; primary becomes `CORTEX_INDEXER_PATH` (already exists) |
| `INDEXER_BINARY` (already named correctly) | unchanged |

- [ ] **Step 2: Execute renames**

```bash
grep -rln 'CbmNode' src tests --include="*.ts" | xargs sed -i '' 's/CbmNode/IndexerNode/g'
grep -rln 'CbmEdge' src tests --include="*.ts" | xargs sed -i '' 's/CbmEdge/IndexerEdge/g'
grep -rln 'CbmProject' src tests --include="*.ts" | xargs sed -i '' 's/CbmProject/IndexerProject/g'
grep -rln 'cbmProject' src tests --include="*.ts" | xargs sed -i '' 's/cbmProject/indexerProject/g'
grep -rln 'cbmDb' src tests --include="*.ts" | xargs sed -i '' 's/cbmDb/indexerDb/g'
grep -rln 'callCbm' src tests --include="*.ts" | xargs sed -i '' 's/callCbm/callIndexer/g'
```

- [ ] **Step 3: Verify clean**

```bash
grep -rn 'Cbm\|callCbm\|cbmProject\|cbmDb' src tests --include="*.ts"
```

Expected: zero matches (or only inside comments referencing historical context — review case-by-case).

- [ ] **Step 4: Type-check and test**

```bash
npm run build  # if there's a tsc step
npm test
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): rename Cbm* TS symbols to Indexer*"
```

### Task 8.2 — Update README + CLAUDE.md

**Files:**
- Modify: `README.md` — "CBM Integration" section → "Native Indexer"
- Modify: `CLAUDE.md` — remove any "CBM" mentions; replace with "indexer"
- Delete: `tests/graph/cbm-attach.test.ts` if still present

- [ ] **Step 1: Check for the legacy test**

```bash
ls tests/graph/cbm-attach.test.ts 2>/dev/null
```

If present, delete:

```bash
git rm tests/graph/cbm-attach.test.ts
```

- [ ] **Step 2: Rewrite README's CBM section**

Find the section in `README.md` titled "CBM Integration" (or similar). Rewrite the heading to "Native Indexer" and update language: "Cortex bundles a native C indexer (built from `internal/cbm/`, soon to be `internal/indexer/`). It writes directly to `<repo>/.cortex/db`. There is no longer a separate codebase-memory-mcp process." Update any storage-layout paragraph to reflect single-file `<repo>/.cortex/db`.

- [ ] **Step 3: Scan CLAUDE.md**

```bash
grep -n "CBM\|cbm\|codebase-memory" CLAUDE.md
```

Replace "CBM" with "indexer" where it appears, except where the historical context matters. Keep references to the binary path `bin/cortex-indexer`.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md tests/graph/
git commit -m "docs: replace 'CBM' with 'indexer' in user-facing docs"
```

### Task 8.3 — Review, merge, tag Phase 8

- [ ] **Step 1:** `/review` → fix Criticals
- [ ] **Step 2:** `qa` agent
- [ ] **Step 3:** Merge + tag

```bash
git checkout main
git merge --no-ff feature/db/cbm-phase-8-ts-rename
git tag phase-8-ts-rename
git branch -d feature/db/cbm-phase-8-ts-rename
```

---

## Phase 9 — C-side rename, dir rename, attribution consolidation

**Branch:** `feature/db/cbm-phase-9-c-rename`
**Tag at merge:** `phase-9-c-rename`
**Validation gate:** `internal/cbm/` no longer exists (replaced by `internal/indexer/`); `grep -rn "cbm\|CBM" internal/indexer/` returns nothing (or only attribution / changelog mentions); `bash scripts/build-indexer.sh` produces `bin/cortex-indexer`; `npm test` passes; `THIRD_PARTY.md` exists at repo root and attributes CBM upstream + vendored deps.

**Important:** This phase has the largest mechanical surface area. Subagent timeouts in Phase 4 showed that giant C rewrites can fail. Split aggressively. Each task below is one directory or one concern.

### Task 9.1 — Rename `internal/cbm/` → `internal/indexer/`

**Files:**
- Rename: `internal/cbm/` → `internal/indexer/`
- Modify: every script / config that references `internal/cbm/`

- [ ] **Step 1: Find all references first (before moving)**

```bash
grep -rln "internal/cbm" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist > /tmp/cbm-refs.txt
cat /tmp/cbm-refs.txt
```

Save the list. Expect: `scripts/build-indexer.sh`, `package.json` (`postinstall`?), `.gitignore`, `tsconfig.json` (maybe), `src/db/cache.ts` (Task 7.3 referenced this path), CLAUDE.md, README, etc.

- [ ] **Step 2: Move the directory**

```bash
git mv internal/cbm internal/indexer
```

- [ ] **Step 3: Update every reference from the list**

For each file in `/tmp/cbm-refs.txt`, replace `internal/cbm` with `internal/indexer`. Use sed:

```bash
xargs -I{} sed -i '' 's|internal/cbm|internal/indexer|g' < /tmp/cbm-refs.txt
```

- [ ] **Step 4: Build**

```bash
bash scripts/build-indexer.sh
```

Expected: clean build. The build script itself was updated in step 3.

- [ ] **Step 5: Smoke test**

```bash
bin/cortex-indexer --help
bin/cortex-indexer cli list_projects '{}'
```

- [ ] **Step 6: Run tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(indexer): rename internal/cbm to internal/indexer"
```

### Task 9.2 — Rename `Makefile.cbm` → `Makefile.indexer`

**Files:**
- Rename: `internal/indexer/Makefile.cbm` → `internal/indexer/Makefile.indexer`
- Modify: `scripts/build-indexer.sh` and anything else that references the makefile name

- [ ] **Step 1: Rename**

```bash
git mv internal/indexer/Makefile.cbm internal/indexer/Makefile.indexer
```

- [ ] **Step 2: Update references**

```bash
grep -rln "Makefile.cbm" . --exclude-dir=node_modules --exclude-dir=.git | xargs sed -i '' 's|Makefile.cbm|Makefile.indexer|g'
```

- [ ] **Step 3: Update target name inside the makefile if "cbm" appears as a phony target**

```bash
grep -n "cbm" internal/indexer/Makefile.indexer | head -30
```

If there's `cbm:` as a target, rename to `indexer:`. Same for variables like `CBM_VERSION`, `CBM_BUILD_DIR`, etc.

- [ ] **Step 4: Build + commit**

```bash
bash scripts/build-indexer.sh
git add -A
git commit -m "refactor(indexer): rename Makefile.cbm to Makefile.indexer + targets"
```

### Task 9.3 — Rename C symbols: foundation/ + store/

**Files:**
- Modify: every `.c` and `.h` in `internal/indexer/src/foundation/` and `internal/indexer/src/store/`
- Modify: every other source file that includes these headers

**Rename rules:**
- `cbm_<word>` → `ctx_<word>` (lowercase function/struct names)
- `CBM_<WORD>` → `CTX_<WORD>` (macros, enum members)
- `cbm.h` (if any) → `ctx.h`
- Function pointer typedefs follow the same pattern
- `CbmNode` etc. as C struct typedefs (if they exist; usually only TS had these) → `CtxNode` (matching SQL/TS convention)

The SQL bookkeeping tables were already renamed `cbm_*` → `ctx_*` in Phase 4 — that's where the `ctx_` choice comes from. Keep consistency.

- [ ] **Step 1: Foundation directory**

```bash
cd internal/indexer/src/foundation
grep -l 'cbm_\|CBM_' *.c *.h 2>/dev/null
```

For each file, replace symbols. Use sed for the common cases:

```bash
for f in *.c *.h; do
  [ -f "$f" ] || continue
  sed -i '' \
    -e 's/\bcbm_/ctx_/g' \
    -e 's/\bCBM_/CTX_/g' \
    "$f"
done
```

(`\b` word boundary prevents `cbm_foo_bar` from being half-replaced. macOS BSD sed supports `\b` via the `-E` flag in some versions — if it doesn't work, use grep+sed per match.)

- [ ] **Step 2: Build**

```bash
cd -
bash scripts/build-indexer.sh
```

Expected: linker errors for symbols defined in foundation/ that are referenced from elsewhere with the old name. That's expected — Step 3 handles propagation.

- [ ] **Step 3: Propagate to call sites in the rest of the tree**

```bash
grep -rln 'cbm_\|CBM_' internal/indexer/src --include='*.c' --include='*.h' | grep -v foundation | grep -v store
```

For each file, apply the same sed substitution. But be careful: not every `cbm_` should be renamed (file names in include directives, string literals like log prefixes, etc.). Review the diff before committing.

Strategy: do the substitution mechanically, then `git diff` and revert any false positives (string literals, paths). This is faster than hand-editing.

- [ ] **Step 4: Store directory**

```bash
cd internal/indexer/src/store
for f in *.c *.h; do
  sed -i '' -e 's/\bcbm_/ctx_/g' -e 's/\bCBM_/CTX_/g' "$f"
done
cd -
```

- [ ] **Step 5: Build until clean**

```bash
bash scripts/build-indexer.sh
```

Iterate on remaining linker errors by renaming additional call sites. Once clean:

- [ ] **Step 6: Smoke + test**

```bash
bin/cortex-indexer cli list_projects '{}'
npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(indexer): rename cbm_/CBM_ symbols in foundation/ + store/"
```

### Task 9.4 — Rename C symbols: handlers/ + cli/ + main.c

**Files:**
- Modify: `internal/indexer/src/handlers/handlers.c` + `.h` (was mcp.c)
- Modify: `internal/indexer/src/cli/cli.c` + `cli.h` + `progress_sink.c` + `progress_sink.h`
- Modify: `internal/indexer/src/main.c`

- [ ] **Step 1: Apply same sed pattern as Task 9.3**

```bash
for d in handlers cli; do
  cd internal/indexer/src/$d
  for f in *.c *.h; do
    [ -f "$f" ] || continue
    sed -i '' -e 's/\bcbm_/ctx_/g' -e 's/\bCBM_/CTX_/g' "$f"
  done
  cd -
done
sed -i '' -e 's/\bcbm_/ctx_/g' -e 's/\bCBM_/CTX_/g' internal/indexer/src/main.c
```

- [ ] **Step 2: Build + iterate**

```bash
bash scripts/build-indexer.sh
```

- [ ] **Step 3: The dispatcher name**

`cbm_mcp_handle_tool` is misleading post-Phase-6. Rename to `ctx_handle_tool` (drops the `mcp` since there's no MCP anymore). Update all call sites (only `main.c:run_cli` calls it).

- [ ] **Step 4: Test**

```bash
bin/cortex-indexer cli search_graph '{"name_pattern":"main"}'
npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(indexer): rename cbm_ symbols in handlers/, cli/, main.c"
```

### Task 9.5 — Rename C symbols: remaining dirs

**Files:**
- Modify: `internal/indexer/src/pipeline/`, `discover/`, `cypher/`, `semantic/`, `simhash/`, `graph_buffer/`, `traces/`, `watcher/`

- [ ] **Step 1: Loop over remaining dirs**

```bash
for d in pipeline discover cypher semantic simhash graph_buffer traces watcher; do
  cd internal/indexer/src/$d
  for f in *.c *.h; do
    [ -f "$f" ] || continue
    sed -i '' -e 's/\bcbm_/ctx_/g' -e 's/\bCBM_/CTX_/g' "$f"
  done
  cd -
done
```

- [ ] **Step 2: Build + smoke + test + commit per dir if any single dir's diff is large**

```bash
bash scripts/build-indexer.sh
bin/cortex-indexer cli list_projects '{}'
npm test
```

- [ ] **Step 3: Final symbol audit**

```bash
grep -rn "\bcbm_\|\bCBM_" internal/indexer/src/ | grep -v vendored
```

Expected: zero matches (or only string literals reviewed and kept intentionally).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(indexer): rename cbm_ symbols in remaining source dirs"
```

### Task 9.6 — Delete CBM standalone-product files

**Files (delete):**
- `internal/indexer/README.md` — was for CBM as a standalone MCP server
- `internal/indexer/CONTRIBUTING.md` — CBM project contributor guide
- `internal/indexer/SECURITY.md` — CBM-specific
- `internal/indexer/server.json` — CBM's MCP registry manifest
- `internal/indexer/install.ps1` and `install.sh` — installer scripts
- `internal/indexer/.github/` — CBM CI
- `internal/indexer/.gitattributes`, `.cppcheck`, `.clang-format`, `.clang-tidy` — keep if you want; they're build-tool config. Keep `.clang-format` and `.clang-tidy` (still useful for the C code), drop the rest.
- `internal/indexer/LICENSE` — DO NOT delete; needed for attribution. Phase 9.7 consolidates.

- [ ] **Step 1: Delete the standalone-product files**

```bash
cd internal/indexer
git rm README.md CONTRIBUTING.md SECURITY.md server.json install.ps1 install.sh .gitattributes
git rm -r .github 2>/dev/null || true
cd -
```

- [ ] **Step 2: Verify build still works (no script referenced any of these)**

```bash
bash scripts/build-indexer.sh
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(indexer): drop CBM standalone-product files"
```

### Task 9.7 — Consolidate attribution at repo root

**Files:**
- Create / modify: `THIRD_PARTY.md` at repo root
- Move: license content from `internal/indexer/LICENSE`, `internal/indexer/THIRD_PARTY.md` into the new root doc; then delete those.

- [ ] **Step 1: Inspect existing attribution files**

```bash
cat internal/indexer/LICENSE
cat internal/indexer/THIRD_PARTY.md
ls internal/indexer/vendored/
```

The vendored deps are: `mimalloc`, `nomic`, `sqlite3`, `tre`, `xxhash`, `yyjson`. Each has its own license inside `vendored/<name>/`.

- [ ] **Step 2: Write the consolidated doc**

Create `THIRD_PARTY.md` at repo root with structure:

```markdown
# Third-Party Attribution

Cortex incorporates code from the following projects.

## codebase-memory-mcp (CBM)

The native indexer in `internal/indexer/` originated as a fork of
[codebase-memory-mcp](https://github.com/<upstream>) by <upstream authors>.
Significant portions of the C source — tree-sitter parsing pipeline, SQLite
storage layer, graph traversal — were lifted from that project. The fork
diverged in 2026 and now lives entirely in this repository; upstream is no
longer tracked.

Original CBM license (MIT / Apache / etc. — copy verbatim from the existing
`internal/indexer/LICENSE`):

<paste LICENSE content here>

## Vendored libraries

| Library | Used for | License | Source |
|---|---|---|---|
| mimalloc | Memory allocator | MIT | `internal/indexer/vendored/mimalloc/LICENSE` |
| nomic | Embeddings | TBD | `internal/indexer/vendored/nomic/...` |
| sqlite3 | Storage | Public domain | `internal/indexer/vendored/sqlite3/...` |
| tre | Regex | BSD-2 | `internal/indexer/vendored/tre/...` |
| xxhash | Hashing | BSD-2 | `internal/indexer/vendored/xxhash/...` |
| yyjson | JSON | MIT | `internal/indexer/vendored/yyjson/...` |
```

Verify each license type by reading the actual LICENSE file inside each vendored dir. Update the table accordingly.

- [ ] **Step 3: Delete the old in-indexer attribution files**

```bash
git rm internal/indexer/LICENSE internal/indexer/THIRD_PARTY.md
```

(The vendored libraries keep their own LICENSE files inside `vendored/<lib>/` — those don't move.)

- [ ] **Step 4: Reference the new doc from README**

In `README.md`, add a "License & Attribution" section pointing to `THIRD_PARTY.md`.

- [ ] **Step 5: Capture the lineage decision via `create_decision`**

```
create_decision({
  name: "CBM lineage and attribution",
  description: "internal/indexer/ originated as a fork of codebase-memory-mcp (CBM). After absorption phases 1-9, the fork is fully integrated into Cortex; upstream is no longer tracked. CBM authors and vendored-library licenses are attributed in THIRD_PARTY.md at the repo root.",
  rationale: "Documents the lineage so future maintainers know where the C indexer came from, why certain C-idioms differ from typical Cortex TS conventions, and that we have an attribution obligation.",
  alternatives: ["Keep CBM as a tracked subtree (rejected: upstream diverged too far and we've taken full ownership)", "Drop attribution silently (rejected: not how OSS works)"]
})
```

- [ ] **Step 6: Commit**

```bash
git add THIRD_PARTY.md README.md internal/indexer/
git commit -m "docs: consolidate CBM + vendored attribution at repo root"
```

### Task 9.8 — Cache module path correction

**Files:**
- Modify: `src/db/cache.ts` — the `grammarPackHash` function hardcoded `internal/cbm/vendored/grammars`; update to `internal/indexer/vendored/grammars`

- [ ] **Step 1: Update the path**

In `src/db/cache.ts`, change:

```typescript
const grammarRoot = join(process.cwd(), "internal", "cbm", "vendored", "grammars");
```

to:

```typescript
const grammarRoot = join(process.cwd(), "internal", "indexer", "vendored", "grammars");
```

- [ ] **Step 2: Re-run cache test**

```bash
npm test -- tests/db/cache.test.ts
```

Expected: 3 passes. (Path no longer existing returns `"no-grammars"`; that path now exists.)

- [ ] **Step 3: Commit**

```bash
git add src/db/cache.ts
git commit -m "fix(db): point cache grammarPackHash at internal/indexer/"
```

### Task 9.9 — Final scan for stragglers

- [ ] **Step 1: Grep for any remaining CBM references**

```bash
grep -rn "CBM\|cbm\|codebase-memory" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=internal/indexer/vendored \
  --exclude=THIRD_PARTY.md \
  --exclude=HANDOFF.md \
  --exclude-dir=docs/superpowers \
  --exclude-dir=docs/specs
```

Expected output set:
- Historical handoff / spec docs (allowed)
- Vendored deps (excluded)
- Attribution doc (excluded)
- Anything else: review and remove or justify.

- [ ] **Step 2: Fix any remaining**

For each unexpected hit, decide: rename, delete, or document as intentional.

- [ ] **Step 3: Commit if changes**

```bash
git add -A
git commit -m "chore: final CBM reference cleanup"
```

### Task 9.10 — Review, merge, tag Phase 9

- [ ] **Step 1:** `/review` → fix Criticals
- [ ] **Step 2:** `qa` agent
- [ ] **Step 3:** Update `HANDOFF.md` with the new state (all phases shipped, what to pick up next).
- [ ] **Step 4:** Merge + tag

```bash
git checkout main
git merge --no-ff feature/db/cbm-phase-9-c-rename
git tag phase-9-c-rename
git branch -d feature/db/cbm-phase-9-c-rename
```

---

## Cross-cutting: decision capture

The handoff flags decision-capture as a process gap (0 decisions in the live DB despite multiple sessions of architectural work). This plan introduces several decisions worth capturing during execution:

- **Phase 6:** "MCP shell vs handler split — handlers stay (shared with CLI), JSON-RPC transport deleted."
- **Phase 7:** "Cache key = sha256(indexerVersion + grammarPackHash + gitTreeHash); tree hash not commit hash (sensitive to staged changes, insensitive to commit metadata)."
- **Phase 7:** "DB lives at `<repo>/.cortex/db` with auto-gitignore — abandons `<install>/.cortex/graph.db`."
- **Phase 9:** "CBM lineage and attribution" (this one is explicitly listed as Task 9.7 Step 5).

Call `create_decision` for each at the right phase boundary. Link to the file(s) the decision governs via `link_decision`.

---

## Risks & subagent strategy

1. **Subagent timeouts on Phase 9 C rename.** History: Phase 4 had subagent timeouts on the `sqlite_writer.c` rewrite. Mitigation: tasks 9.3, 9.4, 9.5 are split by directory specifically so each subagent has a bounded scope. If a single dir's rename still times out, split further.

2. **Hidden `cbm_` references in string literals.** `sed -e 's/\bcbm_/ctx_/g'` will rename inside string literals too. Review the diff after each rename batch; revert any that affect log prefixes, error messages, or SQL fragments that aren't part of the schema rename.

3. **CLI tool dispatcher consistency.** After Phase 6, CLI dispatcher lives in `handlers.c`. After Phase 9, function names shift (`cbm_mcp_handle_tool` → `ctx_handle_tool`). The TS side calls these via subprocess (`callIndexer("tool_name", args)`) — the name on the wire is the tool name, not the C function. So TS doesn't need to change beyond Phase 8.

4. **`feat/phase1-implementation` dead branch** (HANDOFF tech-debt). Not in scope. Delete separately when desired.
