# Frames Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old `src/viewer/` with the prototype at [docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html](../../specs/cortex-v0.3/cortex-frames-prototype-v5.html) as the production viewer at `http://localhost:3334/viewer`, wired to live Cortex data (frames from `data.frame_id`, decisions from `.cortex/decisions.db`, project switcher already in place).

**Architecture:** Single-step replacement: the prototype HTML becomes `src/viewer/index.html`; its inline `<style>` and `<script>` are extracted into siblings; simulation features (agents, synapses, PRs, auto-loop, 3D viewer) are cut entirely; hardcoded data structures (`FRAMES`, `DECISIONS`, `PRS`, `FRAME_GOVERNANCE`) are replaced with live fetches; a small pure `layout.js` derives frame positions deterministically from cluster membership.

**Tech Stack:** Vanilla JS (canvas-rendered viewer), TypeScript server (api.ts + new api-decisions.ts), better-sqlite3 (decisions DB), vitest (unit tests on pure modules), Playwright MCP (browser hand-verify).

**Reference spec:** [docs/superpowers/specs/2026-05-17-frames-viewer-design.md](../specs/2026-05-17-frames-viewer-design.md)

---

## File Structure

### Created

| File | Responsibility |
|---|---|
| `src/mcp-server/api-decisions.ts` | Pure server-side adapter: `Decision[] + DecisionLink[] + Map<path, NodeRow> + Map<path, frame info>` → `AdaptedDecision[]`. Used by `/api/decisions` handler. |
| `tests/api/decisions-adapter.test.ts` | Unit tests for adapter (status mapping, alternatives mapping, governs ref resolution, supersedes chain). |
| `src/viewer/index.html` | Extracted from prototype's HTML body; loads `style.css` + `viewer.js`. |
| `src/viewer/style.css` | Extracted from prototype's `<style>` block. Cuts simulation-only styles. |
| `src/viewer/viewer.js` | Extracted from prototype's `<script>` block. Cuts simulation/PR/agents code. Replaces hardcoded data with imports from `data-fetch.js`. |
| `src/viewer/data-fetch.js` | `fetchProjects()`, `fetchGraph(project)`, `fetchDecisions(project)`. ~30 lines. |
| `src/viewer/layout.js` | Pure: `gridLayout(frames, stageW, stageH) → Frame[]` (deterministic grid). |
| `src/viewer/adapters.js` | Pure: `groupNodesIntoFrames(nodes) → {frames, framesById}`, `nodesByFrame(nodes) → Map`, `pickFileNames(members, limit)`. |
| `tests/viewer/layout.test.js` | Grid layout fixtures. |
| `tests/viewer/adapters.test.js` | Adapter fixtures. |
| `docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md` | Hand-verify screenshots + observations + keep/pivot decision. |

### Modified

| File | Change |
|---|---|
| `src/index.ts` | Pass `decisionsRepo` + `decisionLinksRepo` to `startViewerServer(...)` so `/api/decisions` has data access. |
| `src/mcp-server/api.ts` | Accept decisions repos in signature; add `/api/decisions?project=`, `/api/decisions/:id` routes; drop `/viewer/3d` mapping (no longer exists). |

### Deleted

- `src/viewer/graph-viewer-2d.js`
- `src/viewer/shared/animation.js`
- `src/viewer/shared/camera.js`
- `src/viewer/shared/colors.js`
- `src/viewer/shared/groups.js`
- `src/viewer/shared/layout.js`
- `src/viewer/shared/projection.js`
- `src/viewer/shared/search.js`
- `src/viewer/shared/shapes.js`
- `src/viewer/shared/sizing.js`
- `src/viewer/shared/state.js`
- `src/viewer/shared/transitions.js`
- `src/viewer/shared/websocket.js`
- `src/viewer/3d/index.html`
- `src/viewer/3d/graph-viewer.js`
- old `src/viewer/index.html`
- old `src/viewer/style.css`
- any test file under `tests/` that imports from any of the above (search at task time)

---

## Tasks

### Task 1: Server-side `/api/decisions` adapter + endpoint

**Files:**
- Create: `src/mcp-server/api-decisions.ts`
- Create: `tests/api/decisions-adapter.test.ts`
- Modify: `src/mcp-server/api.ts`
- Modify: `src/index.ts`

**Goal:** Two new HTTP endpoints `/api/decisions?project=<name>` and `/api/decisions/:id` that return decisions in a shape matching the prototype's `DECISIONS[id]` consumers (renderDecisionCard, marginalia). Old viewer remains functional throughout this task.

**Background read:** Subagent must read these files before writing code (full read, not skim): [src/decisions/repository.ts](../../src/decisions/repository.ts), [src/decisions/links-repository.ts](../../src/decisions/links-repository.ts), [src/decisions/types.ts](../../src/decisions/types.ts), [src/mcp-server/api.ts](../../src/mcp-server/api.ts), [src/mcp-server/server.ts:25-65](../../src/mcp-server/server.ts) (where decisions repos are constructed).

- [ ] **Step 1: Write failing tests for adapter pure function**

Create `tests/api/decisions-adapter.test.ts`:

```typescript
// tests/api/decisions-adapter.test.ts
import { describe, it, expect } from "vitest";
import {
  buildAdaptedDecisions,
  buildAdaptedDecision,
} from "../../src/mcp-server/api-decisions.js";
import type { DecisionRecord } from "../../src/decisions/repository.js";
import type { DecisionLink } from "../../src/decisions/links-repository.js";
import type { NodeRow } from "../../src/graph/store.js";

const baseDecision: DecisionRecord = {
  id: "dec-1",
  title: "Use SQLite for the graph store",
  description: null,
  rationale: "Cross-platform, file-based, fast for read-heavy workloads.",
  problem: "Need a persistent graph store accessible from multiple agents.",
  resolution: "SQLite via better-sqlite3, attached read-only from CBM.",
  alternatives: JSON.stringify([
    { name: "Neo4j", reason_rejected: "Operationally heavy" },
    { name: "Postgres", reason_rejected: "Server process required" },
  ]),
  tier: "team",
  status: "active",
  superseded_by: null,
  author: "rasmus",
  created_at: "2026-03-05T10:00:00Z",
  updated_at: "2026-03-05T10:00:00Z",
};

const fileNode = (path: string, frameId?: number, frameLabel?: string): NodeRow => ({
  id: `n:${path}`,
  kind: "file",
  name: path.split("/").pop()!,
  qualified_name: null,
  file_path: path,
  project: "test",
  tier: null,
  status: null,
  data: JSON.stringify({
    ...(frameId !== undefined ? { frame_id: frameId, frame_label: frameLabel } : {}),
  }),
  created_at: "",
  updated_at: "",
});

describe("buildAdaptedDecision", () => {
  it("maps repository fields to prototype shape", () => {
    const result = buildAdaptedDecision(baseDecision, [], new Map(), new Map());
    expect(result.id).toBe("dec-1");
    expect(result.summary).toBe("Use SQLite for the graph store");
    expect(result.state).toBe("active");
    expect(result.problem).toContain("persistent graph store");
    expect(result.resolution).toContain("SQLite via better-sqlite3");
    expect(result.rationale).toContain("Cross-platform");
    expect(result.proposedBy).toBe("rasmus");
    expect(result.proposedAt).toBe("2026-03-05T10:00:00Z");
  });

  it("maps alternatives {name, reason_rejected} → {title, reason}", () => {
    const result = buildAdaptedDecision(baseDecision, [], new Map(), new Map());
    expect(result.alternatives).toEqual([
      { title: "Neo4j", reason: "Operationally heavy" },
      { title: "Postgres", reason: "Server process required" },
    ]);
  });

  it("handles null alternatives (no rows)", () => {
    const result = buildAdaptedDecision(
      { ...baseDecision, alternatives: null },
      [], new Map(), new Map(),
    );
    expect(result.alternatives).toEqual([]);
  });

  it("preserves superseded_by", () => {
    const result = buildAdaptedDecision(
      { ...baseDecision, superseded_by: "dec-old" },
      [], new Map(), new Map(),
    );
    expect(result.supersededBy).toBe("dec-old");
  });
});

describe("buildAdaptedDecisions — governs ref resolution", () => {
  it("resolves a file-path governs link to {kind:'file', path}", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/graph/store.ts",
        relation: "GOVERNS", created_at: "" },
    ];
    const nodes = new Map([
      ["src/graph/store.ts", fileNode("src/graph/store.ts", 3, "graph")],
    ]);
    const frames = new Map([
      ["src/graph/store.ts", { frame_id: 3, frame_label: "graph" }],
    ]);
    const [result] = buildAdaptedDecisions([baseDecision], links, nodes, frames);
    expect(result?.governs).toEqual([
      { kind: "frame", id: "3", label: "graph" },
      { kind: "file", path: "src/graph/store.ts" },
    ]);
  });

  it("resolves a qn-prefix governs link to a frame ref when the file is in a frame", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "qn", target_ref: "src/graph/store.ts::insertNode",
        relation: "GOVERNS", created_at: "" },
    ];
    const nodes = new Map([
      ["src/graph/store.ts", fileNode("src/graph/store.ts", 3, "graph")],
    ]);
    const frames = new Map([
      ["src/graph/store.ts", { frame_id: 3, frame_label: "graph" }],
    ]);
    const [result] = buildAdaptedDecisions([baseDecision], links, nodes, frames);
    expect(result?.governs).toEqual([
      { kind: "frame", id: "3", label: "graph" },
      { kind: "function", path: "src/graph/store.ts", name: "insertNode" },
    ]);
  });

  it("drops links whose target is not in the project (silent)", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/missing.ts",
        relation: "GOVERNS", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.governs).toEqual([]);
  });

  it("ignores non-GOVERNS links when building the governs array", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "decision", target_ref: "dec-other",
        relation: "DECISION_RELATED_TO", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.governs).toEqual([]);
    expect(result?.relatedTo).toEqual(["dec-other"]);
  });

  it("dedupes the frame ref when multiple files in the same frame are governed", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/graph/a.ts",
        relation: "GOVERNS", created_at: "" },
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/graph/b.ts",
        relation: "GOVERNS", created_at: "" },
    ];
    const nodes = new Map([
      ["src/graph/a.ts", fileNode("src/graph/a.ts", 3, "graph")],
      ["src/graph/b.ts", fileNode("src/graph/b.ts", 3, "graph")],
    ]);
    const frames = new Map([
      ["src/graph/a.ts", { frame_id: 3, frame_label: "graph" }],
      ["src/graph/b.ts", { frame_id: 3, frame_label: "graph" }],
    ]);
    const [result] = buildAdaptedDecisions([baseDecision], links, nodes, frames);
    const frameRefs = result?.governs.filter((g) => g.kind === "frame") ?? [];
    expect(frameRefs).toHaveLength(1);
    expect(frameRefs[0]).toEqual({ kind: "frame", id: "3", label: "graph" });
  });
});

describe("buildAdaptedDecisions — related/dependsOn links", () => {
  it("captures DECISION_RELATED_TO targets into relatedTo[]", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "decision", target_ref: "dec-x",
        relation: "DECISION_RELATED_TO", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.relatedTo).toEqual(["dec-x"]);
  });

  it("captures DECISION_DEPENDS_ON targets into dependsOn[]", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "decision", target_ref: "dec-y",
        relation: "DECISION_DEPENDS_ON", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.dependsOn).toEqual(["dec-y"]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/api/decisions-adapter.test.ts
```

Expected: module-not-found error (the module doesn't exist yet).

- [ ] **Step 3: Implement the adapter**

Create `src/mcp-server/api-decisions.ts`:

```typescript
// src/mcp-server/api-decisions.ts
/**
 * Adapter: DecisionRecord + DecisionLink rows from the sidecar decisions DB
 * into the shape the prototype-derived viewer consumes (renderDecisionCard,
 * marginalia pills). Pure functions — fully unit-testable.
 *
 * Output shape matches the prototype's hardcoded DECISIONS[id] consumers in
 * docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html.
 */
import type { DecisionRecord } from "../decisions/repository.js";
import type { DecisionLink } from "../decisions/links-repository.js";
import type { NodeRow } from "../graph/store.js";

export type GovernsRef =
  | { kind: "frame"; id: string; label: string }
  | { kind: "file"; path: string }
  | { kind: "function"; path: string; name: string }
  | { kind: "symbol"; path: string; name: string };

export interface AdaptedAlternative {
  title: string;
  reason: string;
}

export interface AdaptedDecision {
  id: string;
  summary: string;
  state: string;
  problem: string | null;
  resolution: string | null;
  rationale: string;
  alternatives: AdaptedAlternative[];
  proposedBy: string | null;
  proposedAt: string;
  governs: GovernsRef[];
  supersedes: string | null;
  supersededBy: string | null;
  relatedTo: string[];
  dependsOn: string[];
}

export interface FrameInfo {
  frame_id: number;
  frame_label: string;
}

export function buildAdaptedDecision(
  rec: DecisionRecord,
  links: DecisionLink[],
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedDecision {
  const alternatives: AdaptedAlternative[] = parseAlternatives(rec.alternatives);

  const governs: GovernsRef[] = [];
  const seenFrames = new Set<string>();
  let supersedes: string | null = null;
  const relatedTo: string[] = [];
  const dependsOn: string[] = [];

  for (const link of links) {
    if (link.decision_id !== rec.id) continue;

    if (link.relation === "GOVERNS") {
      const refs = resolveGovernsRef(link, nodesByPath, framesByPath);
      for (const r of refs) {
        if (r.kind === "frame") {
          if (seenFrames.has(r.id)) continue;
          seenFrames.add(r.id);
        }
        governs.push(r);
      }
    } else if (link.relation === "SUPERSEDES" && link.target_kind === "decision") {
      supersedes = link.target_ref;
    } else if (link.relation === "DECISION_RELATED_TO" && link.target_kind === "decision") {
      relatedTo.push(link.target_ref);
    } else if (link.relation === "DECISION_DEPENDS_ON" && link.target_kind === "decision") {
      dependsOn.push(link.target_ref);
    }
  }

  return {
    id: rec.id,
    summary: rec.title,
    state: rec.status,
    problem: rec.problem,
    resolution: rec.resolution,
    rationale: rec.rationale ?? "",
    alternatives,
    proposedBy: rec.author,
    proposedAt: rec.created_at,
    governs,
    supersedes,
    supersededBy: rec.superseded_by,
    relatedTo,
    dependsOn,
  };
}

export function buildAdaptedDecisions(
  records: DecisionRecord[],
  links: DecisionLink[],
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedDecision[] {
  return records.map((rec) =>
    buildAdaptedDecision(rec, links, nodesByPath, framesByPath),
  );
}

function parseAlternatives(raw: string | null): AdaptedAlternative[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ name: string; reason_rejected: string }>;
    return parsed.map((a) => ({ title: a.name, reason: a.reason_rejected }));
  } catch {
    return [];
  }
}

function resolveGovernsRef(
  link: DecisionLink,
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): GovernsRef[] {
  if (link.target_kind === "path") {
    if (!nodesByPath.has(link.target_ref)) return [];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(link.target_ref);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "file", path: link.target_ref });
    return out;
  }

  if (link.target_kind === "qn") {
    const sepIdx = link.target_ref.indexOf("::");
    if (sepIdx === -1) return [];
    const path = link.target_ref.slice(0, sepIdx);
    const name = link.target_ref.slice(sepIdx + 2);
    if (!nodesByPath.has(path)) return [];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(path);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "function", path, name });
    return out;
  }

  return [];
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/api/decisions-adapter.test.ts
```

Expected: all 12 tests pass.

- [ ] **Step 5: Plumb decisions repos into the viewer server**

Modify `src/index.ts`. Find the existing line (around line 154):

```typescript
const { port, httpServer } = await startViewerServer(store, indexerProject);
```

We need to construct the decisions repos here too. Above that line, add (importing what's needed at the top of the file):

```typescript
// At the top of the file, in the import block, add:
import { openDb as openDecisionsDb } from "./decisions/db.js";
import { DecisionsRepository } from "./decisions/repository.js";
import { DecisionLinksRepository } from "./decisions/links-repository.js";
import { resolveDecisionsDbPath } from "./db/resolve-path.js";

// Above the startViewerServer call, add:
const decisionsDbPath = resolveDecisionsDbPath(cwd);
const decisionsDb = openDecisionsDb(decisionsDbPath);
const decisionsRepo = new DecisionsRepository(decisionsDb);
const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);
```

Then update the call:

```typescript
const { port, httpServer } = await startViewerServer(
  store,
  indexerProject,
  decisionsRepo,
  decisionLinksRepo,
);
```

(If `openDb` isn't named that — read `src/decisions/db.ts` first to confirm the export name. Use whatever the actual exported function is.)

- [ ] **Step 6: Add `/api/decisions` routes to api.ts**

Modify `src/mcp-server/api.ts`. Update imports at the top:

```typescript
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { buildAdaptedDecision, buildAdaptedDecisions, type FrameInfo } from "./api-decisions.js";
```

Update the `startViewerServer` signature:

```typescript
export function startViewerServer(
  store: GraphStore,
  indexerProject?: string | null,
  decisionsRepo?: DecisionsRepository,
  decisionLinksRepo?: DecisionLinksRepository,
): Promise<ViewerServerHandle> {
```

Inside the request handler, just before the `if (url === "/" || url.startsWith("/viewer"))` block, add:

```typescript
      if (url.startsWith("/api/decisions/") && !url.includes("?")) {
        if (!decisionsRepo || !decisionLinksRepo) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "decisions repos unavailable" }));
          return;
        }
        const id = decodeURIComponent(url.slice("/api/decisions/".length));
        const rec = decisionsRepo.get(id);
        if (!rec) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "decision not found" }));
          return;
        }
        const links = decisionLinksRepo.findByDecision(id);
        const { nodesByPath, framesByPath } = buildPathIndices(
          store.getAllNodesUnified(indexerProject ?? undefined),
        );
        const adapted = buildAdaptedDecision(rec, links, nodesByPath, framesByPath);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(adapted));
        return;
      }

      if (url.startsWith("/api/decisions")) {
        if (!decisionsRepo || !decisionLinksRepo) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "decisions repos unavailable" }));
          return;
        }
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const records = decisionsRepo.list();
        const allLinks = records.flatMap((r) => decisionLinksRepo.findByDecision(r.id));
        const { nodesByPath, framesByPath } = buildPathIndices(
          store.getAllNodesUnified(project ?? undefined),
        );
        const decisions = buildAdaptedDecisions(records, allLinks, nodesByPath, framesByPath);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ decisions }));
        return;
      }
```

At the bottom of `api.ts` (after `startViewerServer`), add:

```typescript
function buildPathIndices(nodes: ReturnType<GraphStore["getAllNodesUnified"]>): {
  nodesByPath: Map<string, ReturnType<GraphStore["getAllNodesUnified"]>[number]>;
  framesByPath: Map<string, FrameInfo>;
} {
  const nodesByPath = new Map<string, ReturnType<GraphStore["getAllNodesUnified"]>[number]>();
  const framesByPath = new Map<string, FrameInfo>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    nodesByPath.set(n.file_path, n);
    if (!n.data) continue;
    try {
      const data = JSON.parse(n.data) as { frame_id?: number; frame_label?: string };
      if (typeof data.frame_id === "number" && typeof data.frame_label === "string") {
        framesByPath.set(n.file_path, { frame_id: data.frame_id, frame_label: data.frame_label });
      }
    } catch {
      /* ignore parse failures */
    }
  }
  return { nodesByPath, framesByPath };
}
```

- [ ] **Step 7: Hand-smoke the endpoint**

```bash
npm run dev 2>&1 | head -5 &
sleep 5
curl -s http://localhost:3334/api/decisions | jq '.decisions | length, .decisions[0]'
curl -s http://localhost:3334/api/decisions/$(curl -s http://localhost:3334/api/decisions | jq -r '.decisions[0].id') | jq '.summary, .state, (.governs | length)'
# Stop dev server:
kill %1 2>/dev/null || true
```

Expected: count > 0 (the repo has 2 decisions), and the single-decision fetch returns the expected shape.

- [ ] **Step 8: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: no regressions. +12 tests from this task.

- [ ] **Step 9: Commit**

```bash
git add src/mcp-server/api-decisions.ts tests/api/decisions-adapter.test.ts \
        src/mcp-server/api.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): /api/decisions endpoints + adapter for viewer

Two new HTTP endpoints serve decisions in the shape the prototype-
derived viewer expects:

- GET /api/decisions?project=<name> — list all decisions, governs
  refs resolved to {frame, file, function, symbol} variants based on
  the project's nodes + frame assignments
- GET /api/decisions/:id — single decision, same shape

Pure adapter in api-decisions.ts; api.ts is the I/O shell. Old
viewer is untouched — endpoints are additive for the new viewer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Replace src/viewer/ with prototype as index.html

**Files:**
- Create: `src/viewer/index.html` (from the prototype, with old `<script>` block still inline + old data intact)
- Delete: `src/viewer/graph-viewer-2d.js`
- Delete: `src/viewer/shared/*` (entire directory)
- Delete: `src/viewer/3d/*` (entire directory)
- Delete: old `src/viewer/index.html`, `src/viewer/style.css` (the previous files)
- Modify: `src/mcp-server/api.ts` (drop `/viewer/3d` route mapping)

**Goal:** After this task, `http://localhost:3334/viewer` shows the prototype's hardcoded canvas (frames at their hardcoded positions, with `viewer/graph/events/mcp/ws/temporal` frames). No data wiring yet. The old viewer is gone.

- [ ] **Step 1: Delete old viewer + any tests that import from it**

```bash
# Delete old viewer source files
rm -f src/viewer/graph-viewer-2d.js
rm -rf src/viewer/shared
rm -rf src/viewer/3d

# Find and delete any test file that imports from a deleted module
git grep -l "viewer/shared\|graph-viewer-2d\|viewer/3d" tests/ 2>/dev/null | xargs -I {} rm -f {}

# Also delete the old index.html + style.css (we'll replace them)
rm -f src/viewer/index.html src/viewer/style.css
```

- [ ] **Step 2: Copy the prototype into src/viewer/index.html**

```bash
cp docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html src/viewer/index.html
```

- [ ] **Step 3: Drop the /viewer/3d route mapping from api.ts**

Edit `src/mcp-server/api.ts`. In the `if (url === "/" || url.startsWith("/viewer"))` block, the current mapping is:

```typescript
        if (url === "/" || url === "/viewer" || url === "/viewer/") {
          rel = "index.html";
        } else if (url === "/viewer/3d" || url === "/viewer/3d/") {
          rel = "3d/index.html";
        } else {
          rel = url.replace(/^\/viewer\//, "");
        }
```

Replace with:

```typescript
        if (url === "/" || url === "/viewer" || url === "/viewer/") {
          rel = "index.html";
        } else {
          rel = url.replace(/^\/viewer\//, "");
        }
```

Also update the comment block above to remove the `/viewer/3d` lines.

- [ ] **Step 4: Hand-verify the page loads**

```bash
npm run dev 2>&1 | head -3 &
sleep 5
# Confirm 200 OK + non-zero body:
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:3334/viewer
# Stop dev server:
kill %1 2>/dev/null || true
```

Expected: `200` and a download size matching the prototype's file size (~131 KB).

Then drive the UI:

```bash
# Use Playwright MCP tools (or equivalent) to:
# - browser_navigate http://localhost:3334/viewer
# - browser_take_screenshot --filename .playwright-mcp/task2-prototype-as-viewer.png
# - browser_console_messages — must be empty/no errors
```

If you cannot run Playwright, document the inability in the report and proceed (Gate 0 hand-verify can run in Task 7 instead).

- [ ] **Step 5: Commit**

```bash
git add src/viewer/index.html src/mcp-server/api.ts
git rm -r --ignore-unmatch src/viewer/shared src/viewer/3d src/viewer/graph-viewer-2d.js
git commit -m "$(cat <<'EOF'
feat(viewer): replace src/viewer with prototype HTML

Drops the old 2D + 3D viewers wholesale and lands the prototype at
docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html as the new
src/viewer/index.html.

The page still runs on the prototype's hardcoded FRAMES/DECISIONS
data — data wiring happens in the next tasks. /viewer/3d route is
removed. Old shared/* modules and tests that referenced them are
deleted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract `<style>` and `<script>` into siblings

**Files:**
- Modify: `src/viewer/index.html` (extract `<style>` and `<script>` blocks)
- Create: `src/viewer/style.css` (contents of the original `<style>` block)
- Create: `src/viewer/viewer.js` (contents of the original `<script>` block)

**Goal:** Same visible behavior as Task 2 — but now the CSS and JS live in separate files instead of inline. No behavior change. Setup for Task 4 (subtractive simulation cut) and Task 6 (data wiring).

- [ ] **Step 1: Extract `<style>` block to style.css**

Open `src/viewer/index.html`. Locate the `<style>` block (starts around line 10, ends with `</style>`). Cut its contents into `src/viewer/style.css`. In the HTML, replace the entire `<style>...</style>` element with:

```html
<link rel="stylesheet" href="/viewer/style.css">
```

- [ ] **Step 2: Extract `<script>` block to viewer.js**

In `src/viewer/index.html`, locate the main `<script>` block (the one starting `(() => {` — that's the prototype's whole IIFE). Cut its contents into `src/viewer/viewer.js`. In the HTML, replace the `<script>...</script>` element with:

```html
<script type="module" src="/viewer/viewer.js"></script>
```

(Use `type="module"` because Task 6 will use `import`.)

- [ ] **Step 3: Hand-verify the page still loads identically**

```bash
npm run dev 2>&1 | head -3 &
sleep 5
# Same canvas should render. Take screenshot via Playwright if available:
# browser_navigate http://localhost:3334/viewer
# browser_take_screenshot --filename .playwright-mcp/task3-extracted.png
# Compare visually to task2 screenshot — should be identical.
kill %1 2>/dev/null || true
```

If browser console has any errors, you've broken something in the extraction — likely the IIFE boundary or a stray HTML comment that closed the script block. Fix before committing.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/viewer.js
git commit -m "$(cat <<'EOF'
refactor(viewer): split prototype into index.html + style.css + viewer.js

Pure file split. No behavior change. Sets up clean module boundaries
for the upcoming subtractive cut of simulation features and the
data-wiring task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cut simulation / PR / agent features from viewer.js

**Files:**
- Modify: `src/viewer/viewer.js` (delete simulation code)
- Modify: `src/viewer/style.css` (delete styles for deleted UI)
- Modify: `src/viewer/index.html` (delete HTML for deleted UI)

**Goal:** Code base shrinks substantially. After this task, the viewer still renders frames + nodes + edges + decisions from the prototype's hardcoded data, but the agent control panel, multi-agent simulation, PR features, synapse animations, auto-loop, and cursors are entirely removed. Theme toggle stays. Frame focus + decision card stay.

**Cut these JS top-level symbols + their callers in `viewer.js`:**
- All variables and functions referencing agents: `agents`, `agentRGBFor(...)`, `agentRGB(...)`, `AGENT`, `initAgent`, `stepAgent`, `advanceAgents`, `chooseNextTarget`, `beginTraversal`, `bfsPath`, `findEdge`, `frameHeat`, `updateFrameHeat`
- All synapse code: `synapses`, `drawSynapses`
- All PR functions + state: `PRS`, `getPr`, `prByNumber`, `activePrs`, `getActivePRs`, `framesIntroducedByActivePRs`, `isFrameUncommitted`, `getFrameActiveBranch`, `getFrameAdditions`, `isNodeTouchedByActivePR`, `prsTouchingFrame`, `prsTouchingNode`, `drawFloatingPRNodes`, `prNodeAtPoint`, `prExpandLevel`, `startMerge`, `tickMerges`, `mergeBeatProgress`, `activeMergeForNode`, `renderPrCard`, `prPillHtml`
- Auto-loop: `autoLoop`, the auto-loop toggle UI in HTML/CSS
- Cursor traversal: `drawCursors`, `drawProviderGlyph`
- Presence: `presence` div + `commitAvatar` + `dismissAvatar` + `showPresenceTipFor`

**Keep:**
- Frame rendering: `framePxBase`, `framePxFocused`, `framePx`, `nodePx`, `drawFrames`, `drawNodes`, `drawEdges`, `setFocus`, `marginaliaAtPoint`, `nodeAtPoint`, `frameAtPoint`, `frameLabelAtPoint`, `decisionExpandLevel`, `drawFloatingDecisionNodes`, `decisionNodeAtPoint`, `drawMarginaliaForFrame`
- Decision card: `openRecord`, `closeRecord`, `openDecisionCard`, `closeDecisionCard`, `currentDecisionId`, `renderDecisionCard`, `updateDecisionCardVisibility`, `refPillHtml`, `findGoverningDecision`
- Helpers: `ease`, `rand`, `roundedRect`, `truncateMiddle`, `escapeHtml`, `isLight`, all color RGB helpers, `resize`, `mainLoop`
- Hover affordances: `drawHoverPill`, `drawCompactHoverBadge`, `findRecentToucher` (or replace the latter with a stub returning null — it depends on PRs)
- Frame builder: `buildGraph` — KEEP but make it work without the simulation-dependent fields (`adjacency` is still useful; `dec._nodeIdxs` random assignment can stay for now until Task 6 replaces it)

- [ ] **Step 1: Read viewer.js end-to-end first**

Use the Read tool with no line limit. This is the biggest single file in the project (~3,000+ lines after the extraction). You MUST hold the whole call graph in mind before deleting things.

- [ ] **Step 2: Delete agent + simulation code from viewer.js**

Delete the functions and variables listed in the "Cut" list above. After each deletion, search the rest of the file for references and delete those too. Specifically:

- Delete the `AGENT = { a: { ... }, b: { ... }, c: { ... } }` constant and all `agentRGBFor`/`agentRGB` helpers.
- Delete the `agents` object and `initAgent`/`stepAgent`/`advanceAgents`/`chooseNextTarget`/`beginTraversal`/`bfsPath`/`findEdge` block.
- Delete `frameHeat` references in `buildGraph` and `updateFrameHeat`.
- Delete `synapses` array and `drawSynapses` function.
- Delete all of `PRS`, the PR-related accessor functions, `drawFloatingPRNodes`, `prNodeAtPoint`, `prExpandLevel`, `startMerge`, `tickMerges`, `mergeBeatProgress`, `activeMergeForNode`, `renderPrCard`, `prPillHtml`.
- Delete `autoLoop` + the auto-toggle event listener.
- Delete `drawCursors`, `drawProviderGlyph`.
- Delete `commitAvatar`, `dismissAvatar`, `showPresenceTipFor`.
- In the `mainLoop`, remove calls to `advanceAgents(...)`, `drawSynapses(...)`, `drawFloatingPRNodes(...)`, `drawCursors(...)`, `updateFrameHeat(...)`, `tickMerges(...)` — keep calls to `drawFrames(...)`, `drawEdges(...)`, `drawNodes(...)`, `drawMarginaliaForFrame(...)` (when focused), `drawFloatingDecisionNodes(...)`, `drawHoverPill(...)`, `drawCompactHoverBadge(...)`.
- Replace `findRecentToucher(nodeIdx)` body with `return null` (it depended on PRs).
- In `buildGraph`, remove the loop that randomly fires synapses; leave the node + edge generation + decision._nodeIdxs assignment.

- [ ] **Step 3: Delete simulation chrome from index.html**

Delete:
- `<div class="controls">` (the bottom-left control panel — agent buttons + merge button + auto-toggle)
- `<div class="presence">` (top-right avatars)
- `<div class="presence-tip">`

Keep:
- `<div class="logo-mark">` (top-left)
- `<canvas id="stage">`
- `<div class="decision-card">` (sidepanel; we'll populate from real data later)
- `<div class="card-scrim">` (display:none but referenced)

- [ ] **Step 4: Delete simulation styles from style.css**

Delete CSS rules for: `.controls`, `.ctrl-label`, `.agent-buttons`, `.agent-btn`, `.agent-btn.a`, `.agent-btn.b`, `.agent-btn.c`, `.merge-btn`, `.auto-toggle`, `.switch`, `.switch.on`, `.presence`, `.avatar`, `.avatar + .avatar`, `.avatar.lifted`, `.avatar.user`, `.avatar.kai`, `.avatar.mira`, `.avatar.idle`, `.avatar svg`, `.avatar .dot`, `.avatar .glyph-line`, `body.light .avatar.user`, `body.light .avatar.user .dot`, `body.light .avatar .glyph-line`, `.presence-tip`, `.presence-tip.visible`, `.presence-tip .handle`, `.presence-tip .provider`.

- [ ] **Step 5: Hand-verify**

```bash
npm run dev 2>&1 | head -3 &
sleep 5
# Browser:
# - Canvas should still show the 6 prototype frames
# - Decision card should still open on clicking a floating decision
# - No agent buttons, no merge button, no avatars
# - No errors in console (no ReferenceErrors for deleted functions)
kill %1 2>/dev/null || true
```

If console has `ReferenceError: <name> is not defined`, you missed a caller for the deleted function. Find it, delete the call site, and re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/viewer.js
git commit -m "$(cat <<'EOF'
refactor(viewer): cut simulation/PR/agent features

Removes everything tied to the prototype's multi-agent demo: agent
buttons, agent heat, synapses, cursor traversal, auto-loop, PR
floating nodes, PR cards, merge animation, presence avatars.

What remains: the canvas, frames, nodes, edges, frame focus,
decision marginalia, decision card sidepanel, theme toggle (light/
dark via body.light). These are the pieces that have real data
sources for the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Layout module + tests

**Files:**
- Create: `src/viewer/layout.js`
- Create: `tests/viewer/layout.test.js`

**Goal:** Pure module that takes `[{frame_id, frame_label, member_count}]` and stage dimensions, returns `[{id, name, x, y, w, h, count}]` with positions deterministic from input. Replaces the prototype's hardcoded FRAMES x/y/w/h.

Layout algorithm: grid of `ceil(sqrt(N))` columns × `ceil(N/cols)` rows. Frames are placed in member-count-desc order (largest first, top-left-to-bottom-right). Each frame fills 80% of its cell (10% inner padding); width and height scale by `sqrt(member_count / max_member_count)` clamped to [0.55, 1.0] of the cell dimension.

- [ ] **Step 1: Write failing tests for layout**

Create `tests/viewer/layout.test.js`:

```javascript
// tests/viewer/layout.test.js
import { describe, it, expect } from "vitest";
import { gridLayout } from "../../src/viewer/layout.js";

describe("gridLayout", () => {
  it("returns one positioned frame per input", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 5 },
       { frame_id: 1, frame_label: "b", member_count: 3 }],
      1000, 800,
    );
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual([0, 1]);
  });

  it("preserves frame_id and frame_label as id/name", () => {
    const [a] = gridLayout(
      [{ frame_id: 7, frame_label: "viewer", member_count: 10 }],
      1000, 800,
    );
    expect(a.id).toBe(7);
    expect(a.name).toBe("viewer");
    expect(a.count).toBe(10);
  });

  it("sorts by member_count desc, then by frame_id asc", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 2 },
       { frame_id: 1, frame_label: "b", member_count: 8 },
       { frame_id: 2, frame_label: "c", member_count: 5 }],
      1000, 800,
    );
    // After sort: [b(8), c(5), a(2)]
    expect(result.map((f) => f.id)).toEqual([1, 2, 0]);
  });

  it("is deterministic — same input gives same output", () => {
    const input = [
      { frame_id: 0, frame_label: "a", member_count: 5 },
      { frame_id: 1, frame_label: "b", member_count: 3 },
      { frame_id: 2, frame_label: "c", member_count: 7 },
    ];
    const r1 = gridLayout(input, 1000, 800);
    const r2 = gridLayout(input, 1000, 800);
    expect(r1).toEqual(r2);
  });

  it("places frames within stage bounds", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 5 },
       { frame_id: 1, frame_label: "b", member_count: 3 },
       { frame_id: 2, frame_label: "c", member_count: 7 },
       { frame_id: 3, frame_label: "d", member_count: 2 }],
      1000, 800,
    );
    for (const f of result) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(1000);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(800);
    }
  });

  it("returns empty array for empty input", () => {
    expect(gridLayout([], 1000, 800)).toEqual([]);
  });

  it("scales frame size by sqrt(member_count) within [0.55, 1.0] of cell", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 100 },
       { frame_id: 1, frame_label: "b", member_count: 1 }],
      1000, 800,
    );
    // Two frames → grid is 2x1. cellW=500, cellH=800. Inner = 80%.
    // Cell content area = 400×640.
    // largest gets 1.0× = 400, smallest gets 0.55× = 220.
    const [big, small] = result;
    expect(big.count).toBe(100);
    expect(small.count).toBe(1);
    expect(big.w).toBeGreaterThan(small.w);
  });

  it("handles single frame", () => {
    const [only] = gridLayout(
      [{ frame_id: 0, frame_label: "solo", member_count: 5 }],
      1000, 800,
    );
    // 1x1 grid: cell = full stage; inner = 80%
    expect(only.x).toBeCloseTo(500, 0);
    expect(only.y).toBeCloseTo(400, 0);
    expect(only.w).toBeCloseTo(800, 0); // 1000 * 0.8
    expect(only.h).toBeCloseTo(640, 0); // 800 * 0.8
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/viewer/layout.test.js
```

Expected: module-not-found.

- [ ] **Step 3: Implement layout.js**

Create `src/viewer/layout.js`:

```javascript
// src/viewer/layout.js
/**
 * Deterministic grid layout for frames. No physics, no force, no jitter.
 *
 * Input: [{ frame_id, frame_label, member_count }]
 * Output: [{ id, name, count, x, y, w, h }] where x/y are CENTER coordinates.
 *
 * Sort: member_count desc, then frame_id asc. Largest frames fill the
 * top-left, smallest the bottom-right. Each frame sits in a cell sized
 * `stageW/cols × stageH/rows` with 10% inner padding. The frame's size
 * inside the cell scales by sqrt(member_count / max_member_count),
 * clamped to [0.55, 1.0] of the cell content area.
 */
export function gridLayout(frameInputs, stageW, stageH) {
  if (frameInputs.length === 0) return [];

  const sorted = [...frameInputs].sort((a, b) => {
    if (b.member_count !== a.member_count) return b.member_count - a.member_count;
    return a.frame_id - b.frame_id;
  });

  const N = sorted.length;
  const cols = Math.ceil(Math.sqrt(N));
  const rows = Math.ceil(N / cols);
  const cellW = stageW / cols;
  const cellH = stageH / rows;
  const innerW = cellW * 0.8;
  const innerH = cellH * 0.8;
  const maxCount = sorted[0].member_count || 1;

  return sorted.map((f, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = cellW * col + cellW / 2;
    const y = cellH * row + cellH / 2;
    const scale = Math.max(0.55, Math.min(1, Math.sqrt((f.member_count || 1) / maxCount)));
    return {
      id: f.frame_id,
      name: f.frame_label,
      count: f.member_count,
      x,
      y,
      w: innerW * scale,
      h: innerH * scale,
    };
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/viewer/layout.test.js
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/layout.js tests/viewer/layout.test.js
git commit -m "$(cat <<'EOF'
feat(viewer): pure grid layout module for frames

Deterministic grid layout: input is [{frame_id, frame_label,
member_count}], output is positioned frames with center x/y and
w/h sized by sqrt(member_count). No physics, no force, no jitter
— same input always gives same positions. Will replace the
prototype's hardcoded FRAMES x/y coordinates in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire live data — fetches, adapters, frame rendering, project switcher

**Files:**
- Create: `src/viewer/data-fetch.js`
- Create: `src/viewer/adapters.js`
- Create: `tests/viewer/adapters.test.js`
- Modify: `src/viewer/viewer.js` (replace hardcoded FRAMES/DECISIONS/buildGraph with live data + project switcher)
- Modify: `src/viewer/index.html` (add project selector + theme toggle in a small floating toolbar)
- Modify: `src/viewer/style.css` (style the new mini-toolbar)

**Goal:** The viewer fetches `/api/projects`, `/api/graph?project=`, `/api/decisions?project=` on load. Frames are derived from `nodes[].data.frame_id`, positioned by `gridLayout`. Decisions populate `FRAME_GOVERNANCE` and the floating ambient + card. Project switcher in the toolbar; selecting another project re-fetches and re-renders.

- [ ] **Step 1: Write failing tests for adapters**

Create `tests/viewer/adapters.test.js`:

```javascript
// tests/viewer/adapters.test.js
import { describe, it, expect } from "vitest";
import {
  groupNodesIntoFrames,
  basenames,
  buildFrameGovernance,
  edgesInternalIndex,
} from "../../src/viewer/adapters.js";

describe("groupNodesIntoFrames", () => {
  const nodes = [
    { id: "1", kind: "file", file_path: "src/auth/a.ts", data: { frame_id: 0, frame_label: "auth" } },
    { id: "2", kind: "file", file_path: "src/auth/b.ts", data: { frame_id: 0, frame_label: "auth" } },
    { id: "3", kind: "file", file_path: "src/billing/c.ts", data: { frame_id: 1, frame_label: "billing" } },
    { id: "4", kind: "file", file_path: "src/noise.ts", data: {} },
    { id: "5", kind: "file", file_path: "src/x.ts", data: '{"frame_id": 2, "frame_label": "x"}' },
  ];

  it("buckets file nodes by data.frame_id", () => {
    const frames = groupNodesIntoFrames(nodes);
    const auth = frames.find((f) => f.frame_id === 0);
    expect(auth?.members.map((n) => n.id).sort()).toEqual(["1", "2"]);
  });

  it("uses frame_label from first node with one", () => {
    const frames = groupNodesIntoFrames(nodes);
    expect(frames.find((f) => f.frame_id === 0)?.frame_label).toBe("auth");
  });

  it("computes member_count", () => {
    const frames = groupNodesIntoFrames(nodes);
    expect(frames.find((f) => f.frame_id === 0)?.member_count).toBe(2);
  });

  it("ignores nodes without frame_id", () => {
    const frames = groupNodesIntoFrames(nodes);
    // 0, 1, 2 — 3 frames; noise file isn't in any frame.
    expect(frames.map((f) => f.frame_id).sort()).toEqual([0, 1, 2]);
  });

  it("parses string-form data (raw SQLite JSON)", () => {
    const frames = groupNodesIntoFrames(nodes);
    expect(frames.find((f) => f.frame_id === 2)?.members[0].id).toBe("5");
  });
});

describe("basenames", () => {
  it("returns up to limit basenames from file paths", () => {
    const result = basenames(
      [{ file_path: "src/a/foo.ts" }, { file_path: "src/b/bar.ts" }, { file_path: "src/c/baz.ts" }],
      2,
    );
    expect(result).toEqual(["foo.ts", "bar.ts"]);
  });

  it("handles nodes without file_path", () => {
    expect(basenames([{ file_path: undefined }, { file_path: "x.ts" }], 10)).toEqual(["x.ts"]);
  });
});

describe("buildFrameGovernance", () => {
  it("groups decision ids by frame id (from governs[] frame refs)", () => {
    const decisions = [
      { id: "d-1", governs: [{ kind: "frame", id: "0", label: "auth" }] },
      { id: "d-2", governs: [{ kind: "frame", id: "0", label: "auth" }, { kind: "file", path: "x" }] },
      { id: "d-3", governs: [{ kind: "frame", id: "1", label: "billing" }] },
      { id: "d-4", governs: [] },
    ];
    expect(buildFrameGovernance(decisions)).toEqual({
      "0": ["d-1", "d-2"],
      "1": ["d-3"],
    });
  });
});

describe("edgesInternalIndex", () => {
  it("indexes edges by node id pairs for fast lookups", () => {
    const edges = [
      { source_id: "1", target_id: "2", relation: "CALLS" },
      { source_id: "2", target_id: "3", relation: "IMPORTS" },
    ];
    const index = edgesInternalIndex(edges);
    expect(index.has("1::2")).toBe(true);
    expect(index.has("2::3")).toBe(true);
    expect(index.has("3::1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/viewer/adapters.test.js
```

Expected: module-not-found.

- [ ] **Step 3: Implement adapters.js**

Create `src/viewer/adapters.js`:

```javascript
// src/viewer/adapters.js
/**
 * Pure helpers for transforming live API data into shapes the viewer's
 * canvas-drawing code consumes.
 */

/** Parse data into a plain object whether it arrives as JSON string or object. */
function parseData(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Group file nodes by data.frame_id.
 * Returns: [{ frame_id, frame_label, member_count, members: NodeRow[] }]
 *  sorted by frame_id asc.
 */
export function groupNodesIntoFrames(nodes) {
  const byFrame = new Map();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const data = parseData(n.data);
    if (typeof data.frame_id !== "number") continue;
    if (!byFrame.has(data.frame_id)) {
      byFrame.set(data.frame_id, {
        frame_id: data.frame_id,
        frame_label: typeof data.frame_label === "string" ? data.frame_label : `frame:${data.frame_id}`,
        members: [],
      });
    }
    byFrame.get(data.frame_id).members.push(n);
  }
  const out = [];
  for (const f of byFrame.values()) {
    out.push({
      frame_id: f.frame_id,
      frame_label: f.frame_label,
      member_count: f.members.length,
      members: f.members,
    });
  }
  out.sort((a, b) => a.frame_id - b.frame_id);
  return out;
}

/** First N basenames from a list of nodes' file_path values. */
export function basenames(nodes, limit) {
  const out = [];
  for (const n of nodes) {
    if (!n.file_path) continue;
    const i = n.file_path.lastIndexOf("/");
    out.push(i >= 0 ? n.file_path.slice(i + 1) : n.file_path);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the FRAME_GOVERNANCE shape: { [frameIdStr]: decisionId[] }.
 * Sources from decisions[].governs[].kind === 'frame' refs.
 */
export function buildFrameGovernance(decisions) {
  const out = {};
  for (const d of decisions) {
    for (const g of d.governs || []) {
      if (g.kind !== "frame") continue;
      if (!out[g.id]) out[g.id] = [];
      if (!out[g.id].includes(d.id)) out[g.id].push(d.id);
    }
  }
  return out;
}

/** Quick membership check: does an edge between (a,b) exist? */
export function edgesInternalIndex(edges) {
  const set = new Set();
  for (const e of edges) {
    set.add(`${e.source_id}::${e.target_id}`);
  }
  return set;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/viewer/adapters.test.js
```

Expected: all 9 tests pass.

- [ ] **Step 5: Implement data-fetch.js**

Create `src/viewer/data-fetch.js`:

```javascript
// src/viewer/data-fetch.js
/** Network helpers used by viewer.js on load + on project switch. */

export async function fetchProjects() {
  const r = await fetch("/api/projects");
  if (!r.ok) return { projects: [], active: null };
  return r.json();
}

export async function fetchGraph(project) {
  const url = project
    ? `/api/graph?project=${encodeURIComponent(project)}`
    : "/api/graph";
  const r = await fetch(url);
  if (!r.ok) return { nodes: [], edges: [], project: null };
  return r.json();
}

export async function fetchDecisions(project) {
  const url = project
    ? `/api/decisions?project=${encodeURIComponent(project)}`
    : "/api/decisions";
  const r = await fetch(url);
  if (!r.ok) return { decisions: [] };
  return r.json();
}
```

- [ ] **Step 6: Add project selector + theme toggle to index.html**

In `src/viewer/index.html`, just after `<canvas id="stage"></canvas>` (or near the logo-mark — pick a tasteful location), add:

```html
<div class="toolbar">
  <select id="project-select" title="Project">
    <option value="">(loading…)</option>
  </select>
  <button id="theme-toggle" title="Toggle light/dark">◐</button>
</div>
```

- [ ] **Step 7: Style the toolbar in style.css**

Append to `src/viewer/style.css`:

```css
.toolbar {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 30;
  display: flex;
  gap: 6px;
  align-items: center;
}
.toolbar select,
.toolbar button {
  font-family: var(--mono);
  font-size: 11px;
  padding: 5px 8px;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border-2);
  border-radius: 4px;
  cursor: pointer;
}
.toolbar select:hover,
.toolbar button:hover {
  border-color: var(--border-3);
}
```

- [ ] **Step 8: Wire live data into viewer.js**

Open `src/viewer/viewer.js`. At the top of the IIFE, add imports (this works because we set `type="module"` in Task 3):

```javascript
import { fetchProjects, fetchGraph, fetchDecisions } from '/viewer/data-fetch.js';
import { groupNodesIntoFrames, basenames, buildFrameGovernance } from '/viewer/adapters.js';
import { gridLayout } from '/viewer/layout.js';
```

(Move the IIFE wrapper aside if needed — the file can become a top-level module rather than an IIFE.)

Locate the hardcoded data blocks:

```javascript
const FRAMES = [
  { id: 'viewer', name: 'src/viewer', x: 0.16, y: 0.30, w: 190, h: 140, count: 142 },
  // ...
];
const NODE_CFG = { viewer: { count: 8 }, /* ... */ };
const FILE_NAMES = { viewer: [...], /* ... */ };
const DECISIONS = { 'D-142': { /* ... */ }, /* ... */ };
const FRAME_GOVERNANCE = { /* ... */ };
```

Replace with mutable `let` declarations that start empty:

```javascript
let FRAMES = [];
let NODE_CFG = {};
let FILE_NAMES = {};
let DECISIONS = {};
let FRAME_GOVERNANCE = {};
```

(The rest of the file references these as if they're always there; making them `let` keeps the existing draw code happy.)

Add a `loadGraph` function near the top of the IIFE (after the constants, before `buildGraph`):

```javascript
let currentProject = null;

async function loadGraph(projectName) {
  currentProject = projectName;
  const [graph, decs] = await Promise.all([
    fetchGraph(projectName),
    fetchDecisions(projectName),
  ]);

  // 1. Build frame summaries from the graph.
  const summaries = groupNodesIntoFrames(graph.nodes);

  // 2. Position via grid layout.
  const stageW = canvas.clientWidth;
  const stageH = canvas.clientHeight;
  const positioned = gridLayout(
    summaries.map((s) => ({
      frame_id: s.frame_id,
      frame_label: s.frame_label,
      member_count: s.member_count,
    })),
    stageW, stageH,
  );

  // 3. Replace FRAMES with positioned frames (string id matches the rest of
  // the file's expectation that id is a string).
  FRAMES = positioned.map((p) => ({
    id: String(p.id),
    name: p.name,
    x: p.x / stageW,
    y: p.y / stageH,
    w: p.w,
    h: p.h,
    count: p.count,
  }));

  // 4. NODE_CFG.count = how many file basenames to show per frame (cap at 16).
  NODE_CFG = {};
  FILE_NAMES = {};
  for (const s of summaries) {
    const sid = String(s.frame_id);
    NODE_CFG[sid] = { count: Math.min(s.member_count, 16) };
    FILE_NAMES[sid] = basenames(s.members, 16);
  }

  // 5. Decisions → DECISIONS map + FRAME_GOVERNANCE rollup.
  DECISIONS = {};
  for (const d of decs.decisions) {
    DECISIONS[d.id] = d;
  }
  FRAME_GOVERNANCE = buildFrameGovernance(decs.decisions);

  // 6. Rebuild the in-canvas graph (re-uses existing buildGraph; that fn
  // already reads from FRAMES/NODE_CFG/FILE_NAMES/FRAME_GOVERNANCE/DECISIONS).
  buildGraph();
  focusedFrameId = null;
  previousFocusId = null;
}

async function initToolbar() {
  const select = document.getElementById('project-select');
  const themeToggle = document.getElementById('theme-toggle');
  const { projects, active } = await fetchProjects();
  select.innerHTML = '';
  if (projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no projects)';
    opt.disabled = true;
    select.appendChild(opt);
  }
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === active) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => loadGraph(select.value || null));
  themeToggle.addEventListener('click', () => document.body.classList.toggle('light'));

  await loadGraph(active);
}
```

At the very bottom of the IIFE (or top-level module), replace the existing init-on-load block (the one that calls `buildGraph()` synchronously and starts the main loop) with:

```javascript
window.addEventListener('load', async () => {
  resize();
  await initToolbar();
  requestAnimationFrame(mainLoop);
});
window.addEventListener('resize', resize);
```

If the existing file already has an init flow, ADAPT it to the above — don't double-init.

- [ ] **Step 9: Hand-verify in browser**

```bash
npm run dev 2>&1 | head -3 &
sleep 5
# Browser:
# - Toolbar shows project dropdown + theme toggle
# - Canvas shows frames derived from cortex's real cluster output (not 6
#   hardcoded ones)
# - Frame labels reflect real frame_labels ("viewer shared", "events",
#   "tre", etc. — what cortex's clustering produced)
# - Click a frame → it focuses, files become visible
# - Theme toggle flips light/dark
# - No console errors

# Take a screenshot for the record:
# browser_take_screenshot --filename .playwright-mcp/task6-live-data.png
kill %1 2>/dev/null || true
```

Common failures + fixes:
- "FRAMES is empty / canvas is blank" → `data.frame_id` parsing is broken; check `parseData` is being called on `n.data`. Inspect `await fetchGraph()` response in dev tools.
- "Decision card opens with empty fields" → adapter response shape mismatch. Check the `/api/decisions` curl from Task 1 Step 7 vs. what `renderDecisionCard` reads.
- "Project dropdown empty" → `/api/projects` returning `{projects: []}` because `ctx_projects` table is empty. Confirm with `sqlite3 .cortex/db "SELECT * FROM ctx_projects"`.

- [ ] **Step 10: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: no regressions. +17 tests total from this branch's work (12 decisions adapter + 8 layout — adjusted by what's deleted in Task 2 cleanup).

- [ ] **Step 11: Commit**

```bash
git add src/viewer/data-fetch.js src/viewer/adapters.js \
        tests/viewer/adapters.test.js \
        src/viewer/viewer.js src/viewer/index.html src/viewer/style.css
git commit -m "$(cat <<'EOF'
feat(viewer): wire live data — frames, decisions, project switcher

The viewer now derives FRAMES from nodes[].data.frame_id with
deterministic grid layout (sqrt(member_count) sizing). Decisions
come from /api/decisions; FRAME_GOVERNANCE is rolled up from
decisions[].governs frame refs.

A small toolbar lands top-right with the project dropdown +
theme toggle. Selecting a project re-fetches and re-renders.

Old hardcoded FRAMES/DECISIONS/PRS/NODE_CFG/FILE_NAMES blocks are
deleted from viewer.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Hand-verify on cortex + eyeball-check note

**Files:**
- Create: `docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md`

**Goal:** Capture screenshots of the new viewer in action on cortex's own data, and write a one-paragraph honest assessment that informs whether to invest in proper persistence / ranking / classification / MCP exposure for frames, or whether the algorithm needs more work first.

- [ ] **Step 1: Start the dev server in the foreground (or background) and open the viewer**

```bash
npm run dev 2>&1 | tee /tmp/cortex-dev.log &
DEV_PID=$!
# Wait for "Viewer running" line:
until grep -q "Cortex viewer:" /tmp/cortex-dev.log; do sleep 1; done
```

- [ ] **Step 2: Drive the UI via Playwright MCP**

Use the playwright-local MCP browser tools (or equivalent):

```text
browser_navigate http://localhost:3334/viewer
browser_take_screenshot --filename .playwright-mcp/viewer-eyeball-overview.png

# Click the largest frame:
browser_evaluate "const c = document.getElementById('stage'); const r = c.getBoundingClientRect(); /* click center-left */"
# Or use the actual click APIs in the playwright tools to click at coordinates near the first frame's centroid.
browser_take_screenshot --filename .playwright-mcp/viewer-eyeball-frame-focus.png

# Click a floating ambient decision (if any are rendered):
# (only if visible — cortex's decisions DB has 2 rows)
browser_take_screenshot --filename .playwright-mcp/viewer-eyeball-decision-card.png

# Toggle theme:
# (click #theme-toggle)
browser_take_screenshot --filename .playwright-mcp/viewer-eyeball-light-theme.png
```

If a step fails (e.g. no decisions to click), note it in the report and skip that screenshot.

Capture browser console messages too:

```text
browser_console_messages
```

Stop the dev server:

```bash
kill $DEV_PID
```

- [ ] **Step 3: Write the eyeball-check note**

Create `docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md`:

```markdown
# Viewer Eyeball Check — cortex frames in the new viewer

Generated: 2026-05-17

Source data:
- Cluster: `.tmp/frame-extraction/clusters/Users-rka-Development-cortex.json`
  (TF-IDF + HDBSCAN + co-change, γ = 0.3)
- Frames injected: `scripts/frame-extraction/inject-frames.ts`
- Viewer: src/viewer (prototype-derived, this PR)

## Screenshots

- Overview (path mode): `.playwright-mcp/viewer-eyeball-overview.png`
- Frame focus: `.playwright-mcp/viewer-eyeball-frame-focus.png`
- Decision card: `.playwright-mcp/viewer-eyeball-decision-card.png`
- Light theme: `.playwright-mcp/viewer-eyeball-light-theme.png`

## Observations

<!-- FILL IN AFTER SCREENSHOTTING. Cover:
- Frame count and labels — do the labels make sense for what cortex is?
- Spatial layout — does the grid layout look okay or does it need force?
- Decisions integration — do the 2 decisions appear in marginalia
  on the frames they govern?
- ~50% noise rate visualization — files outside hulls visible?
- Performance — does it render smoothly at typical zoom?
- Any obvious bugs / regressions vs. the prototype's visual baseline?
-->

## Decision: keep going / pivot

<!-- ONE PARAGRAPH. Either:
- "The algorithm output is good enough to invest in proper persistence
  (frame_id column, ranking, classification, MCP exposure)."
- "The algorithm output needs more work before it's worth investing in
  more infrastructure. Specifically: <X is wrong>. Next step: <Y>."
-->
```

Edit the `<!-- FILL IN -->` sections after taking the screenshots. Be honest — if the labels look like garbage from vendored C code, say so.

- [ ] **Step 4: Run final test suite + typecheck**

```bash
npm test 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -10
```

Expected: tests pass, no TS errors. (If TS errors come from deleted files referenced elsewhere, fix at root by removing the dangling imports.)

- [ ] **Step 5: Commit**

```bash
git add docs/specs/cortex-v0.3/phase-2-eval/viewer-eyeball-cortex.md \
        .playwright-mcp/viewer-eyeball-*.png
git commit -m "$(cat <<'EOF'
docs(viewer): eyeball-check note on cortex frames in new viewer

End-to-end visual record + honest assessment of whether the
prototype-as-viewer is producing useful output on cortex's own
real data. Informs whether to invest more in frame persistence /
ranking / classification, or whether the clustering algorithm
needs another iteration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- "Render a frame per cluster from data.frame_id/frame_label" → Task 6 (groupNodesIntoFrames + gridLayout)
- "Files inside frames, sized/spaced as in prototype" → Task 6 (basenames feeds FILE_NAMES; existing draw code in viewer.js handles spacing)
- "Edges between nodes" → preserved from prototype's drawEdges; data comes from /api/graph
- "Open focused frame on click" → preserved from prototype's setFocus; works on any FRAMES content
- "Decision marginalia on focused frame" → Task 6 wires DECISIONS + FRAME_GOVERNANCE from /api/decisions
- "Floating ambient decisions" → preserved from prototype's drawFloatingDecisionNodes; works on any DECISIONS content
- "Decision card sidepanel from real decision record" → Task 1 (adapter) + Task 6 (DECISIONS pop from API)
- "Project switcher in toolbar" → Task 6 (initToolbar + loadGraph)
- "Theme toggle" → Task 6 toolbar
- "Cut multi-agent, PRs, synapses, search, 3D viewer" → Task 4
- "Delete old viewer" → Task 2

**Placeholder scan:**
- The eyeball-check note in Task 7 has `<!-- FILL IN -->` markers; that's intentional — the subagent fills them in after screenshotting, not before. Acceptable per the plan's spirit.
- No "TBD" / "later" / "appropriate" / "handle edge cases" elsewhere.

**Type consistency:**
- `AdaptedDecision` defined in Task 1; consumed by Task 6 (via `DECISIONS[d.id] = d`) and by `renderDecisionCard` which expects exactly the prototype's hardcoded shape (id, summary, state, problem, resolution, rationale, alternatives, proposedBy, proposedAt, governs, supersedes, supersededBy, relatedTo, dependsOn). Names match.
- `FrameInfo` defined in Task 1's `api-decisions.ts`; used by `buildPathIndices` in `api.ts`. Same shape.
- `gridLayout` (Task 5) input matches what `groupNodesIntoFrames` (Task 6) returns when mapped. Confirmed: `{frame_id, frame_label, member_count}`.
- `buildFrameGovernance` (Task 6) returns `{[frameIdStr]: decisionId[]}` — the prototype's existing code reads `FRAME_GOVERNANCE[frameId]` where `frameId` is `frame.id` which is a string post-Task-6 (we map `String(p.id)` when building FRAMES). Match.

**Risk + mitigation gaps:** The prototype's `buildGraph` randomly generates edges between nodes within a frame (`Math.random() < 0.45`) — we keep that for now so the canvas isn't visually empty (real edges between file nodes are sparser than the prototype assumes). The eyeball-check note in Task 7 should flag this if it produces a bad visual; a follow-up plan can switch to real edges from the graph.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-frames-viewer-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration. Consistent with prior pattern for this user.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

The user's most recent instruction was "work without stopping for clarifying questions; make the reasonable call and continue." Defaulting to **Subagent-Driven** per the established pattern.
