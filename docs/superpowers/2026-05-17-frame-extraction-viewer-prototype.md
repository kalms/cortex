# Frame Extraction — Viewer Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the TF-IDF + HDBSCAN + co-change clustering output (γ = 0.3 winner from the prior chunk) into the 2D graph viewer so a human can eyeball-check whether the frames look semantically right. Ship in one branch with a project switcher in the viewer so the same prototype can show frames from multiple indexed repos (essential for cross-repo testing).

**Architecture:** Frames are injected into the existing `nodes.data` JSON column as `{frame_id, frame_label, frame_confidence}` — no schema migration. The viewer learns a new grouping derivation (`deriveFrameGroups` mirroring `derivePathGroups`), a Frames-mode toggle, a frame palette + hull rendering. A new `?project=<name>` query param on `/api/graph` + a new `/api/projects` endpoint + a toolbar project selector unlock cross-repo switching. Cluster output stays in `.tmp/frame-extraction/clusters/`; the inject script reads from there and writes into the central cortex.db.

**Tech Stack:** TypeScript (inject script + API extension), vanilla JS (viewer), SQLite (existing). No new dependencies.

**Out of scope:** Frame ranking (budgeting which frames are ambient), frame classification (`FrameKind.layer`) for layout gravity, re-running clustering on graph mutations, frame-aware layout, persisting frames into the durable sidecar, MCP tool exposure of frames. All explicitly deferred until the eyeball check passes.

---

## File Structure

- Create: [scripts/frame-extraction/inject-frames.ts](../../scripts/frame-extraction/inject-frames.ts) — one-shot script that reads a ClusterResult JSON + writes `data.frame_id`/`data.frame_label`/`data.frame_confidence` into nodes
- Create: [tests/frame-extraction/inject-frames.test.ts](../../tests/frame-extraction/inject-frames.test.ts) — covers idempotence, noise-clearing, label selection
- Modify: [src/mcp-server/api.ts](../../src/mcp-server/api.ts) — add `?project=<name>` to `/api/graph`, add new `/api/projects` endpoint
- Modify: [src/viewer/index.html](../../src/viewer/index.html) — add `<select id="project-select">` in the toolbar, add Frames-mode toggle
- Modify: [src/viewer/graph-viewer-2d.js](../../src/viewer/graph-viewer-2d.js) — fetch `/api/projects`, wire selector to reload graph with `?project=`, wire frames-mode toggle
- Modify: [src/viewer/shared/groups.js](../../src/viewer/shared/groups.js) — add `deriveFrameGroups` mirroring `derivePathGroups`
- Modify: [src/viewer/shared/colors.js](../../src/viewer/shared/colors.js) — add deterministic frame palette `frameHullColor(frameId)`
- Modify: [src/viewer/shared/projection.js](../../src/viewer/shared/projection.js) — emit frame groups when frames mode is on
- Modify: [src/viewer/style.css](../../src/viewer/style.css) — minor styling for selector + toggle (whatever the JS hooks up)

---

## Design notes (read once before starting)

**Persistence shape.** `nodes.data` is `TEXT NOT NULL DEFAULT '{}'`. Frames ride along as three JSON keys: `frame_id` (integer cluster id from HDBSCAN, never -1), `frame_label` (string, derived from top tokens), `frame_confidence` (float in [0, 1] — for now, `1.0` for all non-noise, `null` for noise). Noise files have no `frame_id` (or explicit `null`) so the viewer treats them as un-grouped. Re-running the inject script overwrites existing values for nodes in the cluster set; nodes not in the cluster set get `frame_id` cleared (handles the case where a re-clustering moves a file from clustered → noise).

**Label selection.** The Python script already emits `parameters.top_tokens_per_cluster` as `{cluster_id_str: [token, ...]}`. The inject script picks the first non-generic token from that list, falling back to `cluster:<id>` if the list is empty. We do not implement the full spec's 4-step labeling cascade in this prototype — that's a follow-up. Generic tokens to filter: a small built-in stop list (e.g. `["src", "index", "test", "util", "utils", "helper", "helpers"]`).

**Frame coloring.** Deterministic hash: `frame_id → HSL hue` so palette is stable across reloads. Saturation/lightness fixed. Noise files render with the existing neutral palette unchanged.

**Project switching.** The API gains `?project=<name>` (URL-decoded). Missing or empty → server falls back to the existing `indexerProject` (current behavior). The viewer's selector defaults to whatever `indexerProject` resolved to at server boot (we read it from `/api/projects` and mark the active one). Switching projects re-fetches `/api/graph?project=<name>`.

**Frames mode.** A new checkbox in the toolbar `<input type="checkbox" id="frames-mode">`. When off: viewer behaves exactly as today (path-based grouping). When on: viewer renders frame hulls instead of (or in addition to) directory hulls. Decision is: in addition to, with a slightly different visual treatment — so reviewers can see both. Path hulls go thin/grey; frame hulls go colored.

**Why no MCP tool for frames in this PR.** The whole point is fast eyeball-check; MCP would require schema + tool plumbing the spec is still working out. Inject script + viewer flag is the minimal demonstrable path. If frames look good, a follow-up PR adds proper MCP exposure.

---

### Task 1: Inject script + tests

**Files:**
- Create: `scripts/frame-extraction/inject-frames.ts`
- Create: `tests/frame-extraction/inject-frames.test.ts`

**Goal:** Read a `ClusterResult` JSON and mutate `data.frame_id`/`data.frame_label`/`data.frame_confidence` on matching file nodes in the central cortex.db. Idempotent (re-run replaces all assignments). Noise files have any prior `frame_id` cleared.

The script can be invoked as:

```bash
npx tsx scripts/frame-extraction/inject-frames.ts \
  --cluster .tmp/frame-extraction/clusters/Users-rka-Development-cortex.json \
  --project Users-rka-Development-cortex
```

It opens the cortex.db at `<git-root>/.cortex/db/cortex.db` (use `src/db/resolve-path.ts`'s helper if it has one — read the file first; if no helper, hardcode the path resolution to `join(execSync("git rev-parse --show-toplevel").toString().trim(), ".cortex", "db", "cortex.db")`).

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `tests/frame-extraction/inject-frames.test.ts` with these tests targeting two pure functions we'll implement next:

```typescript
// tests/frame-extraction/inject-frames.test.ts
import { describe, it, expect } from "vitest";
import {
  pickFrameLabel,
  buildFrameAssignments,
} from "../../scripts/frame-extraction/inject-frames.js";
import type { ClusterResult } from "../../scripts/frame-extraction/types.js";

describe("pickFrameLabel", () => {
  it("returns the first non-generic top token", () => {
    expect(pickFrameLabel(["src", "auth", "token"])).toBe("auth");
  });

  it("falls back to cluster:<id> when all tokens are generic", () => {
    expect(pickFrameLabel(["src", "index", "util"], 7)).toBe("cluster:7");
  });

  it("falls back to cluster:<id> when no top tokens at all", () => {
    expect(pickFrameLabel([], 3)).toBe("cluster:3");
  });

  it("is case-insensitive in the stop list", () => {
    expect(pickFrameLabel(["SRC", "UTIL", "billing"])).toBe("billing");
  });
});

describe("buildFrameAssignments", () => {
  const cluster: ClusterResult = {
    algorithm: "tfidf+hdbscan",
    parameters: {
      top_tokens_per_cluster: {
        "0": ["auth", "token"],
        "1": ["billing", "invoice"],
      },
    },
    clusters: [
      { cluster_id: 0, member_paths: ["src/auth/a.ts", "src/auth/b.ts"] },
      { cluster_id: 1, member_paths: ["src/billing/c.ts"] },
      { cluster_id: -1, member_paths: ["src/noise.ts"] },
    ],
    total_files: 4,
    noise_count: 1,
  };

  it("emits one assignment per file in non-noise clusters", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments).toEqual([
      { file_path: "src/auth/a.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0 },
      { file_path: "src/auth/b.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0 },
      { file_path: "src/billing/c.ts", frame_id: 1, frame_label: "billing", frame_confidence: 1.0 },
    ]);
  });

  it("does not emit assignments for noise (cluster_id = -1)", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments.some((a) => a.file_path === "src/noise.ts")).toBe(false);
  });

  it("uses cluster:<id> fallback when top_tokens_per_cluster is missing", () => {
    const minimalCluster: ClusterResult = {
      ...cluster,
      parameters: {},
      clusters: [{ cluster_id: 5, member_paths: ["src/x.ts"] }],
    };
    const assignments = buildFrameAssignments(minimalCluster);
    expect(assignments[0]?.frame_label).toBe("cluster:5");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/frame-extraction/inject-frames.test.ts
```

Expected: module-not-found / type error for the import. That confirms we haven't started yet.

- [ ] **Step 3: Implement the pure helpers + a thin CLI**

Create `scripts/frame-extraction/inject-frames.ts`:

```typescript
// scripts/frame-extraction/inject-frames.ts
/**
 * Inject frame_id + frame_label into nodes.data for the named project.
 *
 * Reads a ClusterResult JSON, picks a label per non-noise cluster, and
 * UPDATEs the nodes table for every file-kind node whose file_path
 * matches a clustered file. Files in the noise cluster (or not present
 * in the cluster at all) get their frame_* keys cleared. Idempotent.
 *
 * CLI:
 *   tsx scripts/frame-extraction/inject-frames.ts \
 *     --cluster <path-to-cluster.json> --project <name> [--db <path>]
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import type { ClusterResult } from "./types.js";

/** Stop-list of generic tokens we skip when picking a label. Lowercase. */
const GENERIC_TOKENS = new Set([
  "src", "index", "test", "tests", "util", "utils", "helper", "helpers",
  "lib", "common", "core", "main", "app", "components",
]);

export function pickFrameLabel(topTokens: string[], clusterId?: number): string {
  for (const token of topTokens) {
    if (!GENERIC_TOKENS.has(token.toLowerCase())) {
      return token;
    }
  }
  return `cluster:${clusterId ?? "?"}`;
}

export interface FrameAssignment {
  file_path: string;
  frame_id: number;
  frame_label: string;
  frame_confidence: number;
}

export function buildFrameAssignments(cluster: ClusterResult): FrameAssignment[] {
  const topTokens = (cluster.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>;
  const out: FrameAssignment[] = [];
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokens[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.cluster_id);
    for (const path of c.member_paths) {
      out.push({
        file_path: path,
        frame_id: c.cluster_id,
        frame_label: label,
        frame_confidence: 1.0,
      });
    }
  }
  return out;
}

/** Resolves the central cortex.db path: <git-root>/.cortex/db/cortex.db. */
function defaultDbPath(): string {
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  return join(root, ".cortex", "db", "cortex.db");
}

function parseArgs(argv: string[]): { cluster: string; project: string; db?: string } {
  const out: Partial<{ cluster: string; project: string; db: string }> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cluster") out.cluster = argv[++i];
    else if (argv[i] === "--project") out.project = argv[++i];
    else if (argv[i] === "--db") out.db = argv[++i];
  }
  if (!out.cluster || !out.project) {
    console.error("usage: tsx inject-frames.ts --cluster <path> --project <name> [--db <path>]");
    process.exit(2);
  }
  return out as { cluster: string; project: string; db?: string };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const clusterPath = resolve(args.cluster);
  if (!existsSync(clusterPath)) {
    console.error(`Cluster JSON not found: ${clusterPath}`);
    process.exit(2);
  }
  const dbPath = args.db ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Cortex DB not found: ${dbPath}`);
    process.exit(2);
  }

  const cluster = JSON.parse(readFileSync(clusterPath, "utf-8")) as ClusterResult;
  const assignments = buildFrameAssignments(cluster);
  const clusteredPaths = new Set(assignments.map((a) => a.file_path));

  const db = new Database(dbPath);
  try {
    // 1. Apply assignments (UPDATE the data JSON for matching file nodes).
    const applyOne = db.prepare(`
      UPDATE nodes
      SET data = json_set(
        json_set(
          json_set(COALESCE(data, '{}'), '$.frame_id', @frame_id),
          '$.frame_label', @frame_label
        ),
        '$.frame_confidence', @frame_confidence
      )
      WHERE project = @project
        AND kind = 'file'
        AND file_path = @file_path
    `);

    // 2. Clear frame_* keys on any file node in this project that is NOT in
    //    the cluster set (handles re-clustering moving files to noise).
    const clearStmt = db.prepare(`
      UPDATE nodes
      SET data = json_remove(
        json_remove(
          json_remove(COALESCE(data, '{}'), '$.frame_id'),
          '$.frame_label'
        ),
        '$.frame_confidence'
      )
      WHERE project = @project
        AND kind = 'file'
        AND file_path NOT IN (${assignments.map(() => "?").join(",") || "NULL"})
    `);

    const tx = db.transaction(() => {
      for (const a of assignments) {
        applyOne.run({ ...a, project: args.project });
      }
      // Run clear statement only when there are files to clear against;
      // otherwise the NOT IN (NULL) collapses to nothing matching.
      if (assignments.length > 0) {
        clearStmt.run(args.project, ...assignments.map((a) => a.file_path));
      }
    });
    tx();

    console.log(`[inject-frames] project=${args.project} assigned=${assignments.length} clustered_files=${clusteredPaths.size}`);
  } finally {
    db.close();
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("inject-frames.ts");
if (isDirect) main();
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/frame-extraction/inject-frames.test.ts
```

Expected: 7 passing tests.

- [ ] **Step 5: Smoke-test against the actual cortex.db**

```bash
# Recluster cortex at γ=0.3 to make sure we have an up-to-date cluster JSON.
npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts "$(pwd)" --gamma 0.3
# Inject.
npx tsx scripts/frame-extraction/inject-frames.ts \
  --cluster .tmp/frame-extraction/clusters/Users-rka-Development-cortex.json \
  --project Users-rka-Development-cortex
```

Expected output ends in `assigned=257 clustered_files=257` (approximately — depends on noise count). Verify the DB write landed:

```bash
sqlite3 "$(git rev-parse --show-toplevel)/.cortex/db/cortex.db" \
  "SELECT name, json_extract(data, '\$.frame_id'), json_extract(data, '\$.frame_label')
   FROM nodes WHERE kind = 'file' AND json_extract(data, '\$.frame_id') IS NOT NULL LIMIT 5;"
```

Expected: 5 rows showing file names + cluster ids + labels like "auth", "billing", "viewer", etc.

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "$(cat <<'EOF'
feat(frame-extraction): inject-frames script — write frame_id into nodes.data

One-shot script that reads a ClusterResult JSON and updates the
nodes.data JSON with frame_id, frame_label, frame_confidence per
matching file node in the named project. Idempotent — re-runs
overwrite prior assignments; files not in the cluster set get
frame_* keys cleared (handles the case where re-clustering moves
a file from clustered to noise).

Label is the first non-generic top token from the Python script's
top_tokens_per_cluster, fallback to "cluster:<id>". The prototype
deliberately skips the spec's full 4-step labeling cascade —
that's a follow-up if the viewer prototype warrants it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: API project param + /api/projects endpoint

**Files:**
- Modify: `src/mcp-server/api.ts`

Two additions:
1. `/api/graph` honors `?project=<name>` query param. Missing → falls back to `indexerProject` (current behavior).
2. New endpoint `/api/projects` returns `{ projects: [{name, root_path, indexed_at}], active: <name | null> }`.

- [ ] **Step 1: Read the current api.ts**

The file is short (~100 lines). Read it end-to-end to understand the routing structure before editing.

- [ ] **Step 2: Implement both endpoints**

In `src/mcp-server/api.ts`, find the import block at top and add:

```typescript
import { listProjects } from "../graph/code-queries.js";
import { URL as NodeURL } from "node:url";
```

Then find the `/api/graph` handler block (lines 43-57). Replace it with:

```typescript
      if (url.startsWith("/api/graph")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const nodes = store.getAllNodesUnified(project ?? undefined);
        const rawEdges = store.getAllEdgesUnified(project ?? undefined);
        const edges = rawEdges.map((e) => ({
          ...e,
          source: e.source_id,
          target: e.target_id,
        }));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ nodes, edges, project: project ?? null }));
        return;
      }

      if (url === "/api/projects") {
        let projects: ReturnType<typeof listProjects> = [];
        try {
          projects = listProjects(store);
        } catch {
          // No ctx_projects table yet — return empty.
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({
          projects,
          active: indexerProject ?? null,
        }));
        return;
      }
```

The change from `url === "/api/graph"` to `url.startsWith("/api/graph")` is what lets the query param ride along.

- [ ] **Step 3: Add a tiny test for the API**

We won't unit-test by starting an actual server; that's heavy. Instead, write a smoke check we can run by hand.

Actually we already have `tests/api/` patterns — search for one to follow:

```bash
ls tests/ 2>&1 | grep -i api
```

If there's no fitting test file, skip programmatic API tests for this prototype — Task 5 hand-verification in the browser is the real test. If there IS one, add a test that starts the server and hits `/api/projects`. Use existing patterns; do not invent new test infrastructure.

- [ ] **Step 4: Manual API smoke**

In one terminal:

```bash
npm run dev
```

Wait for the line `Viewer running on http://localhost:3334/viewer`. In another terminal:

```bash
curl -s 'http://localhost:3334/api/projects' | jq
curl -s 'http://localhost:3334/api/graph' | jq '.nodes | length'
curl -s 'http://localhost:3334/api/graph?project=Users-rka-Development-cortex' | jq '.nodes | length'
```

Expected: `/api/projects` returns at least one project with `active` set; both `/api/graph` calls return the same node count (since cortex is the active project anyway, the param-vs-default is equivalent).

Stop the dev server (`Ctrl-C`) before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/api.ts
git commit -m "$(cat <<'EOF'
feat(viewer): /api/projects + project filter on /api/graph

Backend prerequisites for the viewer's project switcher.

- /api/graph now honors ?project=<name>; missing falls back to the
  server's indexerProject (current behavior). Response now includes
  the active project name alongside nodes + edges.
- New /api/projects endpoint returns the ctx_projects table plus the
  active project so the viewer can populate a dropdown with the
  default already selected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Viewer project selector UI

**Files:**
- Modify: `src/viewer/index.html` (add `<select>` in toolbar)
- Modify: `src/viewer/graph-viewer-2d.js` (fetch `/api/projects`, wire selector to `/api/graph?project=`)
- Modify: `src/viewer/style.css` (only if needed for layout)

**Behavior:** On viewer load, fetch `/api/projects`, populate `<select>` options, default the active project. On change, re-fetch `/api/graph?project=<name>` and re-hydrate the viewer's state from scratch.

- [ ] **Step 1: Add `<select>` to the toolbar**

In `src/viewer/index.html`, find the `<div id="toolbar">` block (starts ~line 18). Insert this after the `<span id="logo">cortex</span>` line and before `<div id="search-group">`:

```html
    <select id="project-select" title="Switch project">
      <option value="">(loading)</option>
    </select>
```

- [ ] **Step 2: Wire the selector in JS**

Open `src/viewer/graph-viewer-2d.js`. Find where the initial graph fetch happens — search for `/api/graph` in the file. The current code fetches it once on load. We need:

a) Wrap the existing graph-fetch + hydrate logic in a function `loadGraph(projectName?)`
b) On viewer init, fetch `/api/projects` first, populate the selector, then call `loadGraph(active)`
c) On selector `change` event, call `loadGraph(selected)`

Concrete edit pattern (the implementer must locate the exact insertion points):

```javascript
async function fetchProjects() {
  const r = await fetch('/api/projects');
  if (!r.ok) return { projects: [], active: null };
  return r.json();
}

async function loadGraph(projectName) {
  const url = projectName
    ? `/api/graph?project=${encodeURIComponent(projectName)}`
    : '/api/graph';
  const r = await fetch(url);
  const graph = await r.json();
  // Replace existing state with fresh data:
  state.nodes = new Map();
  state.edges = new Map();
  hydrate(state, graph);
  // Re-run layout, redraw, recenter — match whatever the existing
  // bootstrap does after the initial graph fetch.
}

async function initProjectSelector() {
  const select = document.getElementById('project-select');
  const { projects, active } = await fetchProjects();
  select.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === active) opt.selected = true;
    select.appendChild(opt);
  }
  if (projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no projects)';
    opt.disabled = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    loadGraph(select.value || null);
  });
}
```

Replace the original initial-fetch-on-load with `await initProjectSelector(); await loadGraph(initialActive)`. The implementer must read the file end-to-end before doing this — there's existing code that runs once on load that needs to be re-organized so it can be re-run when the project changes.

- [ ] **Step 3: Style the selector**

In `src/viewer/style.css`, find the existing toolbar styles for `#search` or `#search-group`. Add a parallel `#project-select` rule using the same font-family / colors so it doesn't look out of place. Brief — maybe 6-10 lines.

- [ ] **Step 4: Hand-verify project switcher (visual QA)**

Per `.claude/rules/workflow.md` Gate 0:

```bash
npm run dev
```

Wait for "Viewer running" log. Use Playwright (browser_navigate from playwright-local MCP) to open `http://localhost:3334/viewer`. Capture screenshot to `.playwright-mcp/project-switcher-initial.png`. Verify:
- Project dropdown visible in toolbar
- It has at least one option
- Selecting an option re-loads the graph (capture screenshot `.playwright-mcp/project-switcher-after-select.png`)
- No browser console errors

If only one project is indexed (cortex), the dropdown will have one option — selecting it should be a no-op visual-wise but should re-fetch the graph (visible in network panel). That's acceptable for the gate.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/index.html src/viewer/graph-viewer-2d.js src/viewer/style.css
git commit -m "$(cat <<'EOF'
feat(viewer): project switcher in toolbar

Adds a <select> in the toolbar populated from /api/projects. On
change, the viewer re-fetches /api/graph?project=<name> and
re-hydrates state from scratch. Default selection is the active
project from server boot.

Enables side-by-side eyeball comparison of frame extraction across
multiple indexed repos (the immediate driver) and is a clean
prerequisite for any future multi-project viewer feature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Frame grouping + hull rendering + Frames-mode toggle

**Files:**
- Modify: `src/viewer/shared/groups.js` (add `deriveFrameGroups`)
- Modify: `src/viewer/shared/colors.js` (add `frameHullColor(frameId)`)
- Modify: `src/viewer/shared/projection.js` (emit frame groups when mode is on)
- Modify: `src/viewer/graph-viewer-2d.js` (toggle wiring + render frame hulls)
- Modify: `src/viewer/index.html` (Frames-mode checkbox)

**Behavior:** New checkbox in the toolbar `<input id="frames-mode" type="checkbox">`. When checked, the viewer derives frame groups from `node.data.frame_id` and renders a colored translucent hull per frame with the `frame_label` floated at the centroid. When unchecked, viewer behaves exactly as today.

- [ ] **Step 1: Write failing tests for `deriveFrameGroups`**

Add to `tests/frame-extraction/` (or a new test file under tests/viewer-groups/ if there's an existing pattern — check `ls tests/` first). Below is the test content; the implementer should drop it into whatever path matches existing conventions:

```javascript
// tests/viewer/derive-frame-groups.test.js
// (NOTE: if the project's vitest config doesn't pick up .js files under tests/,
//  use .test.ts with TypeScript imports; either way the test logic is identical.)
import { describe, it, expect } from "vitest";
import { deriveFrameGroups } from "../../src/viewer/shared/groups.js";

describe("deriveFrameGroups", () => {
  const nodes = [
    { id: "n1", kind: "file", file_path: "a.ts", data: { frame_id: 0, frame_label: "auth" } },
    { id: "n2", kind: "file", file_path: "b.ts", data: { frame_id: 0, frame_label: "auth" } },
    { id: "n3", kind: "file", file_path: "c.ts", data: { frame_id: 1, frame_label: "billing" } },
    { id: "n4", kind: "file", file_path: "d.ts", data: {} },                  // no frame
    { id: "n5", kind: "file", file_path: "e.ts" /* no data field */ },        // no frame
    { id: "n6", kind: "function", file_path: "a.ts", data: { frame_id: 0 } }, // non-file kind, skipped
  ];

  it("buckets file nodes by data.frame_id", () => {
    const groups = deriveFrameGroups(nodes);
    expect(groups).toHaveLength(2);
    const auth = groups.find((g) => g.frameId === 0);
    const billing = groups.find((g) => g.frameId === 1);
    expect(auth?.members).toEqual(["n1", "n2"]);
    expect(billing?.members).toEqual(["n3"]);
  });

  it("uses frame_label from the first member that has one", () => {
    const groups = deriveFrameGroups(nodes);
    expect(groups.find((g) => g.frameId === 0)?.label).toBe("auth");
  });

  it("ignores nodes without frame_id (un-grouped)", () => {
    const groups = deriveFrameGroups(nodes);
    const memberCount = groups.reduce((s, g) => s + g.members.length, 0);
    expect(memberCount).toBe(3); // n1, n2, n3 only
  });

  it("ignores non-file-kind nodes even if they carry frame_id", () => {
    const groups = deriveFrameGroups(nodes);
    const allMembers = groups.flatMap((g) => g.members);
    expect(allMembers).not.toContain("n6");
  });

  it("handles data as a JSON string (from raw SQLite)", () => {
    const groups = deriveFrameGroups([
      { id: "s1", kind: "file", file_path: "x.ts", data: '{"frame_id": 9, "frame_label": "x"}' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.frameId).toBe(9);
    expect(groups[0]?.label).toBe("x");
  });

  it("sorts groups by frameId ascending", () => {
    const groups = deriveFrameGroups([
      { id: "a", kind: "file", file_path: "a", data: { frame_id: 3, frame_label: "c" } },
      { id: "b", kind: "file", file_path: "b", data: { frame_id: 1, frame_label: "a" } },
      { id: "c", kind: "file", file_path: "c", data: { frame_id: 2, frame_label: "b" } },
    ]);
    expect(groups.map((g) => g.frameId)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/viewer/derive-frame-groups.test.js
```

Expected: `deriveFrameGroups is not a function` (or module-not-found if your test path doesn't match).

- [ ] **Step 3: Implement `deriveFrameGroups`**

In `src/viewer/shared/groups.js`, after the existing `derivePathGroups` definition, add:

```javascript
/**
 * deriveFrameGroups(nodes) → Array<FrameGroupSpec>
 *
 *   { id, kind: 'frame', frameId, label, members: [nodeIds], memberCount }
 *
 * Buckets file nodes by `data.frame_id`. Nodes whose `data` is a JSON
 * string (raw SQLite payload) are parsed lazily. Non-file kinds are
 * ignored even if they carry a frame_id (entity-granular frames are a
 * later spec step). Returns groups sorted by frameId asc.
 */
export function deriveFrameGroups(nodes) {
  const byFrame = new Map();           // frameId → { members: Set, label: string|null }
  for (const n of nodes) {
    if (n.kind !== 'file') continue;
    const raw = n.data;
    if (raw === undefined || raw === null) continue;
    const data = typeof raw === 'string' ? safeParseJson(raw) : raw;
    if (!data || typeof data.frame_id !== 'number') continue;
    const fid = data.frame_id;
    if (!byFrame.has(fid)) byFrame.set(fid, { members: new Set(), label: null });
    const bucket = byFrame.get(fid);
    bucket.members.add(n.id);
    if (bucket.label === null && typeof data.frame_label === 'string') {
      bucket.label = data.frame_label;
    }
  }

  const out = [];
  for (const [fid, bucket] of byFrame) {
    out.push({
      id: `group:frame:${fid}`,
      kind: 'frame',
      frameId: fid,
      label: bucket.label ?? `frame:${fid}`,
      members: [...bucket.members].sort(),
      memberCount: bucket.members.size,
    });
  }
  out.sort((a, b) => a.frameId - b.frameId);
  return out;
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/viewer/derive-frame-groups.test.js
```

Expected: 6 passing tests.

- [ ] **Step 5: Add a deterministic frame palette**

In `src/viewer/shared/colors.js`, add at the end of the file:

```javascript
/**
 * Deterministic color for a frame hull. Same frame_id always gets the
 * same color across reloads. Hue is derived from a small hash; saturation
 * and lightness are fixed at values that read well on both light and
 * dark canvases. Alpha is meant to be applied at fill time.
 */
export function frameHullColor(frameId) {
  // FNV-1a-ish small hash on the integer.
  let h = (frameId >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 55%, 50%)`;
}
```

- [ ] **Step 6: Add the Frames-mode checkbox**

In `src/viewer/index.html`, find the `<div id="filters">` block. Add this as the LAST checkbox inside it:

```html
      <label class="filter-divider"><input type="checkbox" id="frames-mode"> Frames</label>
```

- [ ] **Step 7: Wire the checkbox + render the hulls**

In `src/viewer/graph-viewer-2d.js`:

a) Import `deriveFrameGroups` and `frameHullColor`. Find the existing import of `derivePathGroups` / `deriveTerritories` and add alongside:

```javascript
import { derivePathGroups, deriveTerritories, deriveFrameGroups } from './shared/groups.js';
import { frameHullColor } from './shared/colors.js';
```

(Adjust the colors.js import line to add `frameHullColor` if both already-imported names live there.)

b) Add state for the mode and the derived groups:

```javascript
let framesMode = false;
let frameGroups = [];

const framesModeEl = document.getElementById('frames-mode');
framesModeEl?.addEventListener('change', () => {
  framesMode = framesModeEl.checked;
  recomputeFrames();
  requestRender();   // or whatever the existing render trigger is named
});

function recomputeFrames() {
  frameGroups = framesMode
    ? deriveFrameGroups([...state.nodes.values()])
    : [];
}
```

Call `recomputeFrames()` once at the end of the existing `loadGraph(...)` function (from Task 3) so that switching projects keeps frame groups in sync.

c) Find the render loop's territory-hull drawing code (the implementer locates it; it's the pattern to copy). Add a parallel block that draws frame hulls when `framesMode` is on. The hull is the convex hull of the screen-space positions of the group's members; reuse the existing `convexHull(points)` helper (search for `convexHull` in the codebase).

Pseudo-shape (the implementer fills in the actual canvas calls based on what the territory code uses):

```javascript
if (framesMode) {
  for (const fg of frameGroups) {
    const points = fg.members
      .map((id) => state.nodes.get(id))
      .filter((n) => n && Number.isFinite(n.x) && Number.isFinite(n.y))
      .map((n) => ({ x: n.x, y: n.y }));
    if (points.length < 2) continue;
    const hull = convexHull(points);   // existing helper
    if (hull.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
    ctx.closePath();
    ctx.fillStyle = frameHullColor(fg.frameId);
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = frameHullColor(fg.frameId);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label at centroid.
    const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
    const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
    ctx.fillStyle = '#222';
    ctx.font = '12px Geist Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fg.label, cx, cy);
  }
}
```

If the existing canvas code is heavily abstracted (a draw-loop with phases), match the phase structure rather than dropping a raw block in.

- [ ] **Step 8: Hand-verify in browser (Gate 0)**

```bash
npm run dev
```

Open the viewer. Toggle the Frames checkbox. Capture screenshots:
- `.playwright-mcp/frames-mode-off.png` — baseline path-grouped view
- `.playwright-mcp/frames-mode-on.png` — frame hulls + labels visible
- Browser console must have ZERO errors

If frame hulls don't appear, check:
1. Are nodes' `data` strings actually being parsed in the viewer? (graph-viewer-2d.js line ~1056 shows the JSON.parse pattern for the detail panel — same logic needed for `deriveFrameGroups`. Tests in step 1 cover this.)
2. Is the inject script's data actually in the DB? Re-run the SQL from Task 1 Step 5.
3. Is the render order right? Frame hulls should draw BEFORE nodes, so nodes appear on top.

- [ ] **Step 9: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: no regressions. Should be +7 tests relative to PR #10 (4 inject-frames + 6 deriveFrameGroups; minus any pre-existing test removals — none expected).

- [ ] **Step 10: Commit**

```bash
git add src/viewer/index.html src/viewer/graph-viewer-2d.js src/viewer/shared/groups.js src/viewer/shared/colors.js tests/
git commit -m "$(cat <<'EOF'
feat(viewer): frame hulls + Frames-mode toggle

When the Frames checkbox is on, the viewer derives groups from
data.frame_id on file nodes (injected by the inject-frames script)
and renders one colored translucent hull per frame with the
frame_label at the centroid. Deterministic frame palette
(hash(frame_id) → hue) keeps colors stable across reloads.

Path-based grouping is unchanged; Frames mode is opt-in. Noise
files (no frame_id) render outside any frame hull. This is the
eyeball-check end state: the prototype now visually shows whether
TF-IDF + co-change (γ=0.3) frames make semantic sense.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Hand-verify on cortex + write a brief eyeball-check note

**Files:**
- Create: `docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md` — short prose note + screenshots

**Goal:** Capture what the prototype actually looks like so the human can decide whether to invest in proper persistence + ranking + classification + MCP exposure, or pivot.

- [ ] **Step 1: Re-run the full pipeline end-to-end**

```bash
# Cluster at γ=0.3.
npx tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts "$(pwd)" --gamma 0.3
# Inject into the DB.
npx tsx scripts/frame-extraction/inject-frames.ts \
  --cluster .tmp/frame-extraction/clusters/Users-rka-Development-cortex.json \
  --project Users-rka-Development-cortex
# Start dev server.
npm run dev
```

- [ ] **Step 2: Drive the UI via Playwright**

Per `.claude/rules/workflow.md` Gate 0:

```javascript
browser_navigate('http://localhost:3334/viewer')
browser_take_screenshot('.playwright-mcp/eyeball-cortex-path-mode.png')   // baseline
// Click Frames checkbox.
browser_click({ ref: 'input#frames-mode' })
browser_take_screenshot('.playwright-mcp/eyeball-cortex-frames-mode.png')
// Hover or click a frame to inspect its members.
browser_take_screenshot('.playwright-mcp/eyeball-cortex-frame-detail.png')
```

Note any browser console errors with `browser_console_messages`.

- [ ] **Step 3: Write the eyeball-check note**

Create `docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md`:

```markdown
# Viewer Eyeball Check — cortex frames @ γ=0.3

Generated: <ISO date>

Cluster source: `.tmp/frame-extraction/clusters/Users-rka-Development-cortex.json`
(TF-IDF + HDBSCAN + co-change distance combination, γ = 0.3, see
[cochange comparison report](./Users-rka-Development-cortex-cochange.md))

## Screenshots

- Path mode (baseline): `.playwright-mcp/eyeball-cortex-path-mode.png`
- Frames mode: `.playwright-mcp/eyeball-cortex-frames-mode.png`
- Frame detail: `.playwright-mcp/eyeball-cortex-frame-detail.png`

## Observations

<FIXME 4–8 bullets. Examples of what to cover:
- How many frames are visible
- Do the labels make sense given the directory structure (e.g. "auth"
  frame contains src/auth/* — concentrated, or sprawling)
- Are there obvious mis-clusterings (e.g. an indexer file in the
  "viewer" frame)
- How does ~50% noise look visually — distracting, or interpretable
- Does the layout cluster files spatially before frames mode is on, or
  do they need re-layout
- Recommendation: keep going with this algorithm or pivot to Leiden /
  pinned-embedding>

## Decision: keep going / pivot

<FIXME one paragraph>
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md
git commit -m "$(cat <<'EOF'
docs(frame-extraction): viewer eyeball-check note on cortex frames

Captures the prototype's visual end state and the human judgment
call on whether TF-IDF + co-change frames are good enough to invest
in proper persistence / ranking / classification, or whether we
need to revisit algorithm choice (Leiden / pinned-embedding) first.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- The spec calls for frame persistence, labeling, membership, ranking, and an API surface. This plan covers persistence (lightweight `data.frame_id`), labeling (1-of-4 fallback step), and membership (entity-granular skipped → file-granular only). Ranking, classification, and MCP tool are explicitly deferred and called out in the chunk's "Out of scope".
- The project switcher is the user's added testing-affordance requirement, addressed in Task 2 + 3.

**Placeholder scan:** Task 5's `<FIXME>` bullets are the only ones; Step 3 of that task explicitly resolves them. No other "TODO" / "implement later" markers.

**Type consistency:**
- `FrameAssignment` type defined in Task 1, used internally only — no cross-task references.
- `deriveFrameGroups` returns `{ id, kind: 'frame', frameId, label, members, memberCount }`. Task 4's render code reads `frameId`, `label`, `members`. Names match.
- API response shape: `/api/projects` returns `{ projects: [...], active: ... }`. Task 3's viewer JS reads `projects` and `active`. Names match.

**Risk check:** The biggest unknown is the viewer's existing render loop structure — the plan defers to the implementer to find the right phase to insert frame-hull drawing. If the loop is heavily abstracted, this task might balloon. Mitigation: Task 4 Step 7 is the only step that touches the render loop; if it's surprisingly hard, the implementer flags BLOCKED and we figure it out together rather than letting the subagent thrash.

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

The user has consistently chosen Subagent-Driven for prior chunks; default to it unless the user changes their mind.
