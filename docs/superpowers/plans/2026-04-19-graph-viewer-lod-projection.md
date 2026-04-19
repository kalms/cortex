# Graph Viewer: LOD Projection Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the client-side projection layer that drives zoom-based LOD, supernode aggregation, territory hulls, aggregate edges, and pleasant transitions in the 2D graph viewer — with no server-side changes.

**Architecture:** Four new pure modules (`shared/sizing.js`, `shared/groups.js`, `shared/projection.js`, `shared/transitions.js`) feed into the existing `graph-viewer-2d.js`. The entry file is refactored to run its sim + render against projection output rather than raw state. Server, protocol, mutations, and `shared/state.js` stay untouched. All tunables (band table, size ranges, transition durations) live in one file each so UX iteration is cheap.

**Tech Stack:** Vanilla ES modules (no build), d3-force v3, Canvas 2D, vitest for unit tests.

**Spec:** [../specs/2026-04-18-graph-viewer-lod-projection-design.md](../specs/2026-04-18-graph-viewer-lod-projection-design.md)

---

## File inventory

**New files:**
- `src/viewer/shared/sizing.js` — per-kind `{ world, min_px, max_px }` ranges + `sizeAt(kind, zoom)` + edge stroke helper
- `src/viewer/shared/groups.js` — path-hierarchy + decision-governance group derivation
- `src/viewer/shared/projection.js` — the `project()` pure function
- `src/viewer/shared/transitions.js` — `diffProjection()` + transition state advance/render helpers
- `tests/viewer/sizing.test.ts`
- `tests/viewer/groups.test.ts`
- `tests/viewer/projection.test.ts`
- `tests/viewer/transitions.test.ts`

**Modified files:**
- `src/viewer/shared/layout.js` — force config reads from `sizing.js`
- `src/viewer/shared/shapes.js` — adds `drawRoundedRect` (supernode) + `drawHull` (territory)
- `src/viewer/graph-viewer-2d.js` — sim + render use projection output; selection ring; aggregate edges; transition rendering; supernode dblclick drill
- `tests/viewer/layout.test.ts` — adapts to the new sizing source
- `tests/viewer/shapes.test.ts` — covers new shape primitives
- `docs/architecture/graph-ui.md` — documents the new modules + render pipeline

---

## Task 1: Fix selection render bug (standalone quick win)

**Context:** `selectedId` is tracked in `graph-viewer-2d.js:506` but never consumed by the render path — the spec's §1 addition and §5 selection visuals both depend on this being fixed.

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js` — adds persistent selection ring + neighbor highlight in the render loop; ensures click-on-empty clears selection

- [ ] **Step 1: Establish baseline — run existing viewer tests**

Run: `npm test -- tests/viewer/`
Expected: all pass.

- [ ] **Step 2: Add selection effect to node render**

In `src/viewer/graph-viewer-2d.js`, inside the node-rendering loop (currently at lines ~363-385), add selection brightness and persistent ring. Locate:

```js
  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const hover = PALETTE_HOVER[node.kind] || PALETTE_HOVER.file;
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };
```

Add, right after the `nAnim` line:

```js
    const isSelected = node.id === selectedId;
    const isSelectionNeighbor = selectedId !== null && (neighborsOf.get(selectedId) || new Set()).has(node.id);
    const selectionLevel = isSelected ? 1.0 : (isSelectionNeighbor ? 0.6 : 0);
    const combinedHighlight = Math.max(nAnim.highlight, selectionLevel);
```

Replace the existing `const rgb = lerpRGB(...)` with:

```js
    const rgb = lerpRGB(base, hover, Math.max(nAnim.colorMix, selectionLevel));
```

Replace the existing `alpha` computation with:

```js
    const alpha = hoveredId === null && !isSelected && !isSelectionNeighbor
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * combinedHighlight;
```

Replace the existing `const r = nodeSize(...)` with:

```js
    const r = nodeSize(node.kind) * (1 + combinedHighlight * 0.15);
```

After the `shape(...)` call but before the superseded strike block, add the ring:

```js
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, r + 2, 0, Math.PI * 2);
      ctx.strokeStyle = rgbString(hover, 0.9);
      ctx.lineWidth = 1 / camera.zoom;
      ctx.stroke();
    }
```

- [ ] **Step 3: Add selection effect to edge render**

In the edge-rendering loop (currently at lines ~340-361), replace the `edgeBright` computation with one that considers selection:

```js
    const isSelectedEdge =
      selectedId !== null && (edge.source_id === selectedId || edge.target_id === selectedId);
    const edgeBright = !searchQuery
      || (searchMatch(a, searchQuery) && searchMatch(b, searchQuery))
      || a.id === hoveredId || b.id === hoveredId
      || isSelectedEdge;
```

For edges incident to the selected node, nudge the alpha up:

```js
    const selectionBoost = isSelectedEdge ? 1.0 : 0;
    const effectiveHighlight = Math.max(h, selectionBoost);
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * effectiveHighlight;
```

(Replaces the existing `const alpha = alphaSpec.rest + ...` line.)

- [ ] **Step 4: Ensure click-empty clears selection**

The existing `canvas.addEventListener('click', ...)` handler already calls `closeDetail()` on empty click (line ~564). Verify by inspecting: `closeDetail()` sets `selectedId = null`. No change required.

- [ ] **Step 5: Hand-verify**

Run: `npm run dev` (opens on http://localhost:3334/viewer).

Click a node. Verify: ring appears around it, ring persists when mouse leaves, its 1-hop edges stay bright, its 1-hop neighbor nodes stay slightly brightened. Click another node: ring moves to the new node. Click empty canvas: ring disappears, detail panel closes. Hover during selection: hover halo composes on top of the ring. Type in search: selected node should not be dimmed even if it doesn't match.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "fix(viewer): persistent selection ring + neighbor highlight

selectedId was tracked but never consumed by the render path.
Now a clicked node shows a persistent ring, its 1-hop edges stay
bright, and its neighbors brighten subtly. Click-empty clears.
Hover composes on top of selection."
```

---

## Task 2: Sizing module — range-based per-kind sizes

**Files:**
- Create: `src/viewer/shared/sizing.js`
- Create: `tests/viewer/sizing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/viewer/sizing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SIZE,
  worldSize,
  sizeAt,
  groupWorldSize,
  edgeStrokeAt,
} from '../../src/viewer/shared/sizing.js';

describe('sizing', () => {
  describe('SIZE table', () => {
    it('has {world, min_px, max_px} for every known kind', () => {
      const kinds = ['decision', 'file', 'function', 'component', 'reference', 'path'];
      for (const k of kinds) {
        expect(SIZE[k]).toMatchObject({
          world: expect.any(Number),
          min_px: expect.any(Number),
          max_px: expect.any(Number),
        });
        expect(SIZE[k].min_px).toBeLessThan(SIZE[k].max_px);
      }
    });

    it('decisions have largest range, functions smallest', () => {
      expect(SIZE.decision.max_px).toBeGreaterThan(SIZE.file.max_px);
      expect(SIZE.file.max_px).toBeGreaterThan(SIZE.function.max_px);
    });
  });

  describe('worldSize', () => {
    it('returns SIZE[kind].world', () => {
      expect(worldSize('decision')).toBe(SIZE.decision.world);
      expect(worldSize('file')).toBe(SIZE.file.world);
    });

    it('falls back for unknown kind', () => {
      expect(worldSize('unknown')).toBeGreaterThan(0);
    });
  });

  describe('sizeAt', () => {
    it('returns world * zoom when within [min_px, max_px]', () => {
      const s = SIZE.file;
      const midZoom = (s.min_px / s.world + s.max_px / s.world) / 2;
      expect(sizeAt('file', midZoom)).toBeCloseTo(s.world * midZoom, 5);
    });

    it('clamps to min_px (in apparent screen space) at far zoom', () => {
      const tinyZoom = 0.01;
      const apparent = sizeAt('file', tinyZoom) * tinyZoom;
      expect(apparent).toBeCloseTo(SIZE.file.min_px, 5);
    });

    it('clamps to max_px (in apparent screen space) at close zoom', () => {
      const hugeZoom = 100;
      const apparent = sizeAt('file', hugeZoom) * hugeZoom;
      expect(apparent).toBeCloseTo(SIZE.file.max_px, 5);
    });

    it('ratios between kinds are stable within unclamped band', () => {
      // Pick a zoom where all three kinds are unclamped.
      const z = 1.5;
      const dec = sizeAt('decision', z);
      const file = sizeAt('file', z);
      const fn = sizeAt('function', z);
      expect(dec / file).toBeCloseTo(SIZE.decision.world / SIZE.file.world, 2);
      expect(file / fn).toBeCloseTo(SIZE.file.world / SIZE.function.world, 2);
    });
  });

  describe('groupWorldSize', () => {
    it('scales sublinearly with member count', () => {
      const s3 = groupWorldSize(3);
      const s30 = groupWorldSize(30);
      const s300 = groupWorldSize(300);
      expect(s30).toBeGreaterThan(s3);
      expect(s300).toBeGreaterThan(s30);
      // sublinear: 10x members < 2x size
      expect(s30 / s3).toBeLessThan(2);
    });

    it('has a minimum for 1-member groups', () => {
      expect(groupWorldSize(1)).toBeGreaterThan(0);
    });
  });

  describe('edgeStrokeAt', () => {
    it('GOVERNS never thins below its floor', () => {
      const tinyZoom = 0.01;
      const apparent = edgeStrokeAt('GOVERNS', tinyZoom) * tinyZoom;
      expect(apparent).toBeGreaterThan(0.4);
    });

    it('CALLS can thin more than GOVERNS at far zoom', () => {
      const z = 0.2;
      expect(edgeStrokeAt('GOVERNS', z)).toBeGreaterThan(edgeStrokeAt('CALLS', z));
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm test -- tests/viewer/sizing.test.ts`
Expected: FAIL with "Cannot find module '../../src/viewer/shared/sizing.js'".

- [ ] **Step 3: Create the module**

Create `src/viewer/shared/sizing.js`:

```js
/**
 * Per-kind sizing model for the 2D viewer.
 *
 * Each kind has a `world` size (used by d3-force collide/link distance —
 * constant across zoom for stable physics), and a screen-space range
 * [min_px, max_px] that bounds the apparent on-screen radius.
 *
 * `sizeAt(kind, zoom)` returns a world-space radius such that
 * `returnedRadius * zoom` falls inside [min_px, max_px]. The render divides
 * by zoom after clamping so the draw call operates in world space.
 */

export const SIZE = {
  decision:  { world: 10,  min_px: 14, max_px: 22 },
  file:      { world: 5,   min_px: 7,  max_px: 12 },
  component: { world: 4.5, min_px: 6,  max_px: 11 },
  reference: { world: 3,   min_px: 5,  max_px: 9  },
  function:  { world: 2.5, min_px: 5,  max_px: 8  },
  path:      { world: 2.5, min_px: 5,  max_px: 8  },
};

const DEFAULT_SIZE = { world: 4, min_px: 5, max_px: 10 };

export function worldSize(kind) {
  return (SIZE[kind] ?? DEFAULT_SIZE).world;
}

export function sizeAt(kind, zoom) {
  const s = SIZE[kind] ?? DEFAULT_SIZE;
  const apparent = clamp(s.world * zoom, s.min_px, s.max_px);
  return apparent / zoom;
}

export function groupWorldSize(memberCount) {
  return 4 + 2 * Math.log2(Math.max(1, memberCount));
}

// Edge stroke ranges by relation. Values are screen-space px.
const EDGE_STROKE = {
  GOVERNS:      { world: 0.8, min_px: 0.6, max_px: 2.4 },
  SUPERSEDES:   { world: 0.8, min_px: 0.5, max_px: 2.0 },
  CALLS:        { world: 0.5, min_px: 0.3, max_px: 1.6 },
  IMPORTS:      { world: 0.5, min_px: 0.3, max_px: 1.6 },
  REFERENCES:   { world: 0.4, min_px: 0.3, max_px: 1.4 },
  'co-changed': { world: 0.3, min_px: 0.2, max_px: 1.0 },
};
const DEFAULT_EDGE = { world: 0.5, min_px: 0.3, max_px: 1.6 };

export function edgeStrokeAt(relation, zoom) {
  const s = EDGE_STROKE[relation] ?? DEFAULT_EDGE;
  const apparent = clamp(s.world * zoom, s.min_px, s.max_px);
  return apparent / zoom;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npm test -- tests/viewer/sizing.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/sizing.js tests/viewer/sizing.test.ts
git commit -m "feat(viewer): add sizing module with per-kind {world, min_px, max_px} ranges

New pure module replacing the constant SIZE table in layout.js.
sizeAt(kind, zoom) returns a world-space radius clamped so the apparent
on-screen size stays in [min_px, max_px]. groupWorldSize(n) scales
supernodes sublinearly with member count. edgeStrokeAt(relation, zoom)
does the same for edges.

Not yet wired — layout.js still uses the old constants. Task 7 switches
layout.js to read from here."
```

---

## Task 3: Groups module — path hierarchy + territory derivation

**Files:**
- Create: `src/viewer/shared/groups.js`
- Create: `tests/viewer/groups.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/viewer/groups.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  derivePathGroups,
  deriveTerritories,
  pathGroupId,
  territoryId,
  parentPathGroupId,
} from '../../src/viewer/shared/groups.js';

function makeNode(id: string, kind: string, file_path?: string, qualified_name?: string) {
  return { id, kind, name: id, file_path, qualified_name };
}

describe('groups', () => {
  describe('pathGroupId / territoryId', () => {
    it('pathGroupId is deterministic from dir path', () => {
      expect(pathGroupId('src/events/worker')).toBe('group:path:src/events/worker');
    });

    it('territoryId is deterministic from decision id', () => {
      expect(territoryId('dec-123')).toBe('group:decision:dec-123');
    });
  });

  describe('derivePathGroups', () => {
    it('groups files by their directory', () => {
      const nodes = [
        makeNode('a', 'file', 'src/events/worker/persister.ts'),
        makeNode('b', 'file', 'src/events/worker/git-watcher.ts'),
        makeNode('c', 'file', 'src/events/bus.ts'),
      ];
      const groups = derivePathGroups(nodes);
      const worker = groups.find((g) => g.id === 'group:path:src/events/worker');
      expect(worker).toBeDefined();
      expect(worker!.members.sort()).toEqual(['a', 'b']);
      expect(worker!.memberCount).toBe(2);
    });

    it('collapses singleton directories up', () => {
      const nodes = [
        makeNode('a', 'file', 'src/foo/only.ts'),
        makeNode('b', 'file', 'src/bar/x.ts'),
        makeNode('c', 'file', 'src/bar/y.ts'),
      ];
      const groups = derivePathGroups(nodes);
      // src/foo has only 1 member — should not exist as a group
      expect(groups.find((g) => g.id === 'group:path:src/foo')).toBeUndefined();
      // src/bar has 2 — should exist
      expect(groups.find((g) => g.id === 'group:path:src/bar')).toBeDefined();
    });

    it('nests functions under their owning file (via qualified_name)', () => {
      const nodes = [
        makeNode('file1', 'file', 'src/a.ts'),
        makeNode('fn1', 'function', 'src/a.ts', 'src/a.ts::doThing'),
        makeNode('fn2', 'function', 'src/a.ts', 'src/a.ts::otherThing'),
      ];
      const groups = derivePathGroups(nodes);
      // The file node serves as the implicit group for its functions — but we still
      // produce an explicit group entry so the projection can treat it uniformly.
      const fileGroup = groups.find((g) => g.id === 'group:path:src/a.ts');
      expect(fileGroup).toBeDefined();
      expect(fileGroup!.members.sort()).toEqual(['fn1', 'fn2']);
      expect(fileGroup!.kind).toBe('file');
    });

    it('skips decisions — they are always top-level', () => {
      const nodes = [
        makeNode('dec', 'decision', undefined),
        makeNode('a', 'file', 'src/x.ts'),
        makeNode('b', 'file', 'src/y.ts'),
      ];
      const groups = derivePathGroups(nodes);
      // No group should list the decision as a member
      for (const g of groups) {
        expect(g.members).not.toContain('dec');
      }
    });

    it('is deterministic across runs', () => {
      const nodes = [
        makeNode('a', 'file', 'src/events/worker/persister.ts'),
        makeNode('b', 'file', 'src/events/worker/git-watcher.ts'),
      ];
      const g1 = derivePathGroups(nodes);
      const g2 = derivePathGroups(nodes);
      expect(g1).toEqual(g2);
    });
  });

  describe('parentPathGroupId', () => {
    it('returns the parent directory group id', () => {
      expect(parentPathGroupId('src/events/worker')).toBe('group:path:src/events');
      expect(parentPathGroupId('src/events')).toBe('group:path:src');
      expect(parentPathGroupId('src')).toBeNull();
    });
  });

  describe('deriveTerritories', () => {
    it('groups governed members by decision', () => {
      const nodes = [
        makeNode('d1', 'decision'),
        makeNode('f1', 'file', 'src/a.ts'),
        makeNode('f2', 'file', 'src/b.ts'),
      ];
      const edges = [
        { source_id: 'd1', target_id: 'f1', relation: 'GOVERNS' },
        { source_id: 'd1', target_id: 'f2', relation: 'GOVERNS' },
      ];
      const territories = deriveTerritories(nodes, edges);
      expect(territories).toHaveLength(1);
      expect(territories[0].id).toBe('group:decision:d1');
      expect(territories[0].members.sort()).toEqual(['f1', 'f2']);
    });

    it('ignores non-GOVERNS edges', () => {
      const nodes = [makeNode('d1', 'decision'), makeNode('f1', 'file', 'src/a.ts')];
      const edges = [{ source_id: 'd1', target_id: 'f1', relation: 'REFERENCES' }];
      const territories = deriveTerritories(nodes, edges);
      expect(territories).toHaveLength(0);
    });

    it('returns no territory for decisions with zero governance', () => {
      const nodes = [makeNode('d1', 'decision')];
      const edges: any[] = [];
      const territories = deriveTerritories(nodes, edges);
      expect(territories).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm test -- tests/viewer/groups.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create the module**

Create `src/viewer/shared/groups.js`:

```js
/**
 * Group derivation for the 2D viewer's projection layer.
 *
 * Two group sources:
 *   a) path hierarchy — derived from `file_path` on each leaf node. A directory
 *      with 2+ members becomes a group; singletons collapse up. Files with
 *      owned functions (via qualified_name prefix match) also get a group so
 *      the projection can treat "contains children" uniformly.
 *   b) decision-governance territories — each decision's outgoing GOVERNS set.
 *      Rendered as a translucent convex hull overlay, cutting across paths.
 *
 * All group IDs are deterministic from source: same graph → same ids → same
 * positions across reloads. Nothing persisted.
 */

export function pathGroupId(dirPath) {
  return `group:path:${dirPath}`;
}

export function territoryId(decisionId) {
  return `group:decision:${decisionId}`;
}

export function parentPathGroupId(dirPath) {
  const idx = dirPath.lastIndexOf('/');
  if (idx <= 0) return null;
  return pathGroupId(dirPath.slice(0, idx));
}

/**
 * derivePathGroups(nodes) → Array<GroupSpec>
 *
 * Groups are of two shapes:
 *   - directory group:  { id, kind: 'dir',  dirPath, members: [nodeIds], memberCount }
 *   - file group:       { id, kind: 'file', dirPath, filePath, members: [fnIds], memberCount }
 *
 * A file node is included in its dir's group (as a member), AND if it has
 * child function/reference nodes, those are grouped under a file-kind group
 * so the projection can fold functions into the file.
 */
export function derivePathGroups(nodes) {
  const groups = new Map();   // id → group spec

  // Bucket leaves by their file_path's dir, and file → children.
  const dirMembers = new Map();   // dirPath → Set<nodeId>
  const fileMembers = new Map();  // filePath → Set<nodeId>
  const fileNodeIds = new Set();  // ids of nodes with kind === 'file'

  for (const n of nodes) {
    if (n.kind === 'decision') continue;  // top-level, never in a path group

    if (n.kind === 'file' && n.file_path) {
      fileNodeIds.add(n.id);
      const dir = dirOf(n.file_path);
      if (dir !== null) {
        if (!dirMembers.has(dir)) dirMembers.set(dir, new Set());
        dirMembers.get(dir).add(n.id);
      }
    } else if (n.qualified_name) {
      // function / reference / component — nest under owning file path.
      const owner = qualifiedNameFile(n.qualified_name);
      if (owner) {
        if (!fileMembers.has(owner)) fileMembers.set(owner, new Set());
        fileMembers.get(owner).add(n.id);
      }
    } else if (n.file_path) {
      // leaf with a path but not a file kind — bucket by dir as a last resort.
      const dir = dirOf(n.file_path);
      if (dir !== null) {
        if (!dirMembers.has(dir)) dirMembers.set(dir, new Set());
        dirMembers.get(dir).add(n.id);
      }
    }
  }

  // Directory groups: keep only those with 2+ members.
  for (const [dir, memberSet] of dirMembers) {
    if (memberSet.size < 2) continue;
    const id = pathGroupId(dir);
    groups.set(id, {
      id,
      kind: 'dir',
      dirPath: dir,
      members: [...memberSet].sort(),
      memberCount: memberSet.size,
    });
  }

  // File groups: files that own functions/references.
  for (const [filePath, memberSet] of fileMembers) {
    if (memberSet.size === 0) continue;
    const id = pathGroupId(filePath);
    groups.set(id, {
      id,
      kind: 'file',
      dirPath: dirOf(filePath) ?? '',
      filePath,
      members: [...memberSet].sort(),
      memberCount: memberSet.size,
    });
  }

  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * deriveTerritories(nodes, edges) → Array<TerritorySpec>
 *   { id, kind: 'territory', decisionId, members: [nodeIds], memberCount }
 *
 * A decision with zero GOVERNS targets produces no territory.
 */
export function deriveTerritories(nodes, edges) {
  const decisions = new Set(nodes.filter((n) => n.kind === 'decision').map((n) => n.id));
  const territories = new Map();   // decisionId → Set<memberId>

  for (const e of edges) {
    if (e.relation !== 'GOVERNS') continue;
    if (!decisions.has(e.source_id)) continue;
    if (!territories.has(e.source_id)) territories.set(e.source_id, new Set());
    territories.get(e.source_id).add(e.target_id);
  }

  const out = [];
  for (const [decisionId, memberSet] of territories) {
    if (memberSet.size === 0) continue;
    out.push({
      id: territoryId(decisionId),
      kind: 'territory',
      decisionId,
      members: [...memberSet].sort(),
      memberCount: memberSet.size,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- helpers ----

function dirOf(path) {
  if (!path) return null;
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return null;
  return path.slice(0, idx);
}

function qualifiedNameFile(qn) {
  const idx = qn.indexOf('::');
  if (idx < 0) return null;
  return qn.slice(0, idx);
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npm test -- tests/viewer/groups.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/groups.js tests/viewer/groups.test.ts
git commit -m "feat(viewer): add groups module — path + territory derivation

derivePathGroups derives dir and file groups from file_path /
qualified_name. Singleton directories collapse up. deriveTerritories
groups a decision's GOVERNS targets into a territory spec (rendered
as a convex hull later).

All group IDs deterministic from source, so same graph → same groups
across reloads. Pure function, no mutation of inputs. Not yet wired
to the viewer."
```

---

## Task 4: Projection module — the `project()` function

**Context:** This is the core of the design. Takes the full state + current UX inputs (zoom, focus, filters, search), returns the visible set + synthesized group representatives + aggregate edges. Reads `shared/groups.js` for derivation.

**Files:**
- Create: `src/viewer/shared/projection.js`
- Create: `tests/viewer/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/viewer/projection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  project,
  BAND_TABLE,
  projectionDeltaIsInteresting,
} from '../../src/viewer/shared/projection.js';

function makeState(nodes: any[], edges: any[]) {
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e, i) => [`ek:${i}`, e])),
  };
}

const defaultInputs = {
  zoom: 1.0,
  focus: null,
  filters: new Set(['decision', 'file', 'function', 'component', 'reference', 'path']),
  search: '',
};

describe('projection', () => {
  describe('BAND_TABLE', () => {
    it('has four bands covering zoom from 0 to Infinity', () => {
      expect(BAND_TABLE.length).toBe(4);
      expect(BAND_TABLE[0].maxZoom).toBeCloseTo(0.4);
      expect(BAND_TABLE[BAND_TABLE.length - 1].maxZoom).toBe(Infinity);
    });
  });

  describe('far zoom (< 0.4×) — decisions + top-level groups only', () => {
    it('emits decisions and top-level path groups, not leaves', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'a', kind: 'file', name: 'a.ts', file_path: 'src/events/worker/a.ts' },
          { id: 'b', kind: 'file', name: 'b.ts', file_path: 'src/events/worker/b.ts' },
          { id: 'c', kind: 'file', name: 'c.ts', file_path: 'src/graph/c.ts' },
          { id: 'c2', kind: 'file', name: 'c2.ts', file_path: 'src/graph/c2.ts' },
        ],
        [],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3 });
      const ids = [...out.visibleNodes.keys()];
      expect(ids).toContain('d1');
      // Leaves must not appear
      expect(ids).not.toContain('a');
      expect(ids).not.toContain('c');
      // Some top-level path group must appear
      expect(ids.some((id) => id.startsWith('group:path:src'))).toBe(true);
    });
  });

  describe('close zoom (> 2.0×) — all leaves visible', () => {
    it('emits all leaves including functions', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'f1', kind: 'file', name: 'a.ts', file_path: 'src/a.ts' },
          { id: 'fn1', kind: 'function', name: 'doThing',
            file_path: 'src/a.ts', qualified_name: 'src/a.ts::doThing' },
        ],
        [],
      );
      const out = project(state, { ...defaultInputs, zoom: 3.0 });
      const ids = [...out.visibleNodes.keys()];
      expect(ids).toContain('d1');
      expect(ids).toContain('f1');
      expect(ids).toContain('fn1');
    });
  });

  describe('search force-visible', () => {
    it('forces a matching folded leaf visible at far zoom with ancestor path', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'a', kind: 'file', name: 'persister.ts',
            file_path: 'src/events/worker/persister.ts' },
          { id: 'b', kind: 'file', name: 'git-watcher.ts',
            file_path: 'src/events/worker/git-watcher.ts' },
          { id: 'c', kind: 'file', name: 'other.ts', file_path: 'src/other/x.ts' },
          { id: 'c2', kind: 'file', name: 'other2.ts', file_path: 'src/other/y.ts' },
        ],
        [],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3, search: 'persister' });
      const ids = [...out.visibleNodes.keys()];
      expect(ids).toContain('a');   // matched leaf forced visible
    });
  });

  describe('focus restriction', () => {
    it('restricts to root + 1-hop neighborhood', () => {
      const state = makeState(
        [
          { id: 'r', kind: 'file', name: 'root.ts', file_path: 'src/r.ts' },
          { id: 'n1', kind: 'file', name: 'n1.ts', file_path: 'src/n1.ts' },
          { id: 'n2', kind: 'file', name: 'n2.ts', file_path: 'src/n2.ts' },
          { id: 'far', kind: 'file', name: 'far.ts', file_path: 'src/far.ts' },
        ],
        [
          { source_id: 'r', target_id: 'n1', relation: 'CALLS' },
          { source_id: 'r', target_id: 'n2', relation: 'CALLS' },
        ],
      );
      const out = project(state, {
        ...defaultInputs, zoom: 3.0, focus: { root: 'r', depth: 1 },
      });
      const ids = [...out.visibleNodes.keys()];
      expect(ids.sort()).toEqual(['n1', 'n2', 'r']);
    });
  });

  describe('aggregate edges', () => {
    it('rolls edges between folded supernodes into an aggregate edge', () => {
      const state = makeState(
        [
          { id: 'a', kind: 'file', name: 'a', file_path: 'src/events/a.ts' },
          { id: 'b', kind: 'file', name: 'b', file_path: 'src/events/b.ts' },
          { id: 'c', kind: 'file', name: 'c', file_path: 'src/graph/c.ts' },
          { id: 'd', kind: 'file', name: 'd', file_path: 'src/graph/d.ts' },
        ],
        [
          { source_id: 'a', target_id: 'c', relation: 'CALLS' },
          { source_id: 'b', target_id: 'c', relation: 'CALLS' },
          { source_id: 'a', target_id: 'd', relation: 'IMPORTS' },
        ],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3 });
      const aggs = [...out.visibleEdges.values()].filter((e) => e.aggregate);
      expect(aggs.length).toBeGreaterThanOrEqual(1);
      const total = aggs.reduce((sum, e) => sum + e.count, 0);
      expect(total).toBe(3);
    });
  });

  describe('dangling edge — forced-visible node to folded neighbor', () => {
    it('emits an aggregate edge from the forced leaf to the neighbor supernode', () => {
      const state = makeState(
        [
          { id: 'a', kind: 'file', name: 'persister.ts',
            file_path: 'src/events/worker/persister.ts' },
          { id: 'b', kind: 'file', name: 'other.ts', file_path: 'src/graph/other.ts' },
          { id: 'b2', kind: 'file', name: 'other2.ts', file_path: 'src/graph/other2.ts' },
        ],
        [{ source_id: 'a', target_id: 'b', relation: 'CALLS' }],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3, search: 'persister' });
      const visibleIds = new Set(out.visibleNodes.keys());
      expect(visibleIds.has('a')).toBe(true);
      expect(visibleIds.has('b')).toBe(false);
      // There must be an edge whose target is the supernode containing b.
      const hasAggToNeighborGroup = [...out.visibleEdges.values()].some(
        (e) => e.source_id === 'a' && e.target_id.startsWith('group:path:src/graph'),
      );
      expect(hasAggToNeighborGroup).toBe(true);
    });
  });

  describe('idempotence', () => {
    it('same inputs → same output shape (by deep-equal)', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'a', kind: 'file', name: 'a', file_path: 'src/a.ts' },
          { id: 'b', kind: 'file', name: 'b', file_path: 'src/b.ts' },
        ],
        [],
      );
      const a = project(state, { ...defaultInputs, zoom: 0.5 });
      const b = project(state, { ...defaultInputs, zoom: 0.5 });
      expect([...a.visibleNodes.keys()].sort()).toEqual([...b.visibleNodes.keys()].sort());
      expect([...a.visibleEdges.keys()].sort()).toEqual([...b.visibleEdges.keys()].sort());
    });
  });

  describe('projectionDeltaIsInteresting', () => {
    it('false when previous is null and current is any projection', () => {
      const state = makeState([{ id: 'a', kind: 'file', name: 'a' }], []);
      const curr = project(state, defaultInputs);
      expect(projectionDeltaIsInteresting(null, curr)).toBe(true);
    });

    it('true when visible node id set differs', () => {
      const s1 = makeState([{ id: 'a', kind: 'file', name: 'a' }], []);
      const s2 = makeState([{ id: 'b', kind: 'file', name: 'b' }], []);
      const p1 = project(s1, defaultInputs);
      const p2 = project(s2, defaultInputs);
      expect(projectionDeltaIsInteresting(p1, p2)).toBe(true);
    });

    it('false when node ids identical and edges identical', () => {
      const s = makeState([{ id: 'a', kind: 'file', name: 'a' }], []);
      const p1 = project(s, defaultInputs);
      const p2 = project(s, defaultInputs);
      expect(projectionDeltaIsInteresting(p1, p2)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm test -- tests/viewer/projection.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create the module**

Create `src/viewer/shared/projection.js`:

```js
/**
 * Client-side LOD projection for the 2D viewer.
 *
 * Takes the full graph state + UX inputs (zoom, focus, filters, search) and
 * returns the visible set + synthesized groups + (possibly aggregate) edges.
 *
 * The projection is the sole authority for what the simulation and renderer
 * see. Everything is derived from the raw state — server protocol unchanged.
 */

import { derivePathGroups, deriveTerritories, pathGroupId } from './groups.js';
import { edgeKey } from './state.js';

/**
 * Zoom bands, from far to close. A node kind is emitted as a leaf only when
 * the current zoom falls within its visibility range; otherwise it folds into
 * its ancestor group (its path-group or, last resort, stays hidden).
 *
 * Decisions are always visible. Dir groups appear at far/mid zoom; file
 * groups at mid zoom; leaves progressively at closer zoom.
 */
export const BAND_TABLE = [
  { maxZoom: 0.4, visibleKinds: new Set(['decision']),                emitDirGroups: 'top',    emitFileGroups: false, emitLeafFiles: false },
  { maxZoom: 1.0, visibleKinds: new Set(['decision']),                emitDirGroups: 'mid',    emitFileGroups: false, emitLeafFiles: false },
  { maxZoom: 2.0, visibleKinds: new Set(['decision', 'file']),        emitDirGroups: 'none',   emitFileGroups: true,  emitLeafFiles: true  },
  { maxZoom: Infinity,
                  visibleKinds: new Set(['decision', 'file',
                    'function', 'component', 'reference', 'path']),   emitDirGroups: 'none',   emitFileGroups: false, emitLeafFiles: true  },
];

function bandFor(zoom) {
  for (const b of BAND_TABLE) {
    if (zoom < b.maxZoom) return b;
  }
  return BAND_TABLE[BAND_TABLE.length - 1];
}

/**
 * project(state, inputs) → { visibleNodes, visibleEdges, groups }
 *
 * inputs: { zoom, focus, filters, search }
 *   focus:    null | { root, depth }
 *   filters:  Set<kind> — kind filter from the UI checkboxes
 *   search:   lowercase string; empty = no search
 *
 * Output:
 *   visibleNodes: Map<id, node | groupRepresentative>
 *   visibleEdges: Map<key, edge | aggregateEdge>
 *   groups:       Array<groupSpec>   (for hull / territory rendering)
 */
export function project(state, inputs) {
  const { zoom, focus, filters, search } = inputs;
  const band = bandFor(zoom);

  const allNodes = [...state.nodes.values()];
  const allEdges = [...state.edges.values()];

  // Derive groups once per call.
  const pathGroups = derivePathGroups(allNodes);
  const territories = deriveTerritories(allNodes, allEdges);

  // Build lookup: leaf id → ancestor group id (its file group, or dir group).
  const leafAncestor = new Map();
  for (const g of pathGroups) {
    for (const m of g.members) leafAncestor.set(m, g.id);
  }

  // Determine which dir groups to emit as visible supernodes.
  const emittedGroupIds = new Set();
  if (band.emitDirGroups !== 'none') {
    for (const g of pathGroups) {
      if (g.kind !== 'dir') continue;
      const depth = g.dirPath.split('/').length;
      if (band.emitDirGroups === 'top' && depth > 1) continue;
      if (band.emitDirGroups === 'mid' && depth > 2) continue;
      emittedGroupIds.add(g.id);
    }
  }
  if (band.emitFileGroups) {
    for (const g of pathGroups) {
      if (g.kind === 'file') emittedGroupIds.add(g.id);
    }
  }

  const groupById = new Map(pathGroups.map((g) => [g.id, g]));

  // ---- Decide which leaf nodes are visible ----
  const visibleLeafIds = new Set();

  for (const n of allNodes) {
    if (!filters.has(n.kind) && n.kind !== 'decision') continue;
    if (focus && !inFocus(n.id, focus, allEdges)) continue;

    // Decisions are always visible (when not filtered out).
    if (n.kind === 'decision') {
      visibleLeafIds.add(n.id);
      continue;
    }

    // Leaf is visible if its kind is in the band's visible set, AND its
    // ancestor group is not emitted (or no ancestor group exists).
    const ancestor = leafAncestor.get(n.id);
    if (ancestor && emittedGroupIds.has(ancestor)) continue;
    if (!band.visibleKinds.has(n.kind)) continue;
    if (n.kind === 'file' && !band.emitLeafFiles) continue;
    visibleLeafIds.add(n.id);
  }

  // Search force-visible: any node whose name matches, plus its ancestor path.
  if (search) {
    for (const n of allNodes) {
      if (!filters.has(n.kind) && n.kind !== 'decision') continue;
      if (focus && !inFocus(n.id, focus, allEdges)) continue;
      if (!nameMatches(n, search)) continue;
      visibleLeafIds.add(n.id);
      // Un-emit any ancestor groups covering this leaf so the leaf doesn't
      // stay hidden behind them.
      let ancestor = leafAncestor.get(n.id);
      while (ancestor) {
        emittedGroupIds.delete(ancestor);
        const g = groupById.get(ancestor);
        ancestor = g ? parentPathGroupIdFromSpec(g, groupById) : null;
      }
    }
  }

  // ---- Assemble visibleNodes: leaves + emitted group representatives ----
  const visibleNodes = new Map();
  for (const id of visibleLeafIds) visibleNodes.set(id, state.nodes.get(id));

  for (const id of emittedGroupIds) {
    const g = groupById.get(id);
    if (!g) continue;
    // Group representative: synthetic node with id === g.id.
    visibleNodes.set(g.id, {
      id: g.id,
      kind: 'group',
      name: labelFor(g),
      groupKind: g.kind,          // 'dir' or 'file'
      members: g.members,
      memberCount: g.memberCount,
      dirPath: g.dirPath,
      filePath: g.filePath,
      // x/y filled in by syncSimulation's inherit-from-centroid logic later.
    });
  }

  // ---- Edges: emit raw or aggregate ----
  const representative = (leafId) => {
    if (visibleNodes.has(leafId)) return leafId;
    const a = leafAncestor.get(leafId);
    if (a && visibleNodes.has(a)) return a;
    return null;
  };

  const visibleEdges = new Map();
  const aggBuckets = new Map();   // key → { source_id, target_id, count, relations: Map<rel, n> }

  for (const e of allEdges) {
    const srcRep = representative(e.source_id);
    const tgtRep = representative(e.target_id);
    if (!srcRep || !tgtRep) continue;
    if (srcRep === tgtRep) continue;  // edge collapsed onto a single representative; drop

    if (srcRep === e.source_id && tgtRep === e.target_id) {
      // Pass-through raw edge.
      visibleEdges.set(edgeKey(e), e);
    } else {
      // Aggregate.
      const key = `agg:${srcRep}→${tgtRep}`;
      if (!aggBuckets.has(key)) {
        aggBuckets.set(key, {
          aggregate: true,
          source_id: srcRep,
          target_id: tgtRep,
          count: 0,
          relations: new Map(),
        });
      }
      const b = aggBuckets.get(key);
      b.count += 1;
      b.relations.set(e.relation, (b.relations.get(e.relation) ?? 0) + 1);
    }
  }

  for (const [key, b] of aggBuckets) {
    const relationEntries = [...b.relations.entries()].sort((x, y) => y[1] - x[1]);
    const majority = relationEntries[0][0];
    visibleEdges.set(key, {
      aggregate: true,
      source_id: b.source_id,
      target_id: b.target_id,
      count: b.count,
      relation: majority,
      relations: Object.fromEntries(relationEntries),
    });
  }

  // ---- Territories: overlay groups — returned for hull rendering, not
  // emitted as visible nodes. ----
  const visibleTerritories = territories.filter((t) =>
    t.members.some((m) => visibleNodes.has(m) || visibleNodes.has(leafAncestor.get(m) ?? '')),
  );

  return {
    visibleNodes,
    visibleEdges,
    groups: [...pathGroups.filter((g) => emittedGroupIds.has(g.id)), ...visibleTerritories],
  };
}

/**
 * True iff the *visible node id set* or the *visible edge id set* differs
 * between previous and current projections. Purely visual changes (size,
 * stroke weight at a given zoom) do not count.
 */
export function projectionDeltaIsInteresting(previous, current) {
  if (!previous) return true;
  if (previous.visibleNodes.size !== current.visibleNodes.size) return true;
  if (previous.visibleEdges.size !== current.visibleEdges.size) return true;
  for (const k of current.visibleNodes.keys()) {
    if (!previous.visibleNodes.has(k)) return true;
  }
  for (const k of current.visibleEdges.keys()) {
    if (!previous.visibleEdges.has(k)) return true;
  }
  return false;
}

// ---- helpers ----

function inFocus(id, focus, edges) {
  if (id === focus.root) return true;
  if (focus.depth < 1) return false;
  for (const e of edges) {
    if (e.source_id === focus.root && e.target_id === id) return true;
    if (e.target_id === focus.root && e.source_id === id) return true;
  }
  return false;
}

function nameMatches(node, query) {
  return (node.name && node.name.toLowerCase().includes(query))
      || (node.qualified_name && node.qualified_name.toLowerCase().includes(query));
}

function labelFor(group) {
  if (group.kind === 'dir') {
    const parts = group.dirPath.split('/');
    return parts[parts.length - 1] + '/';
  }
  if (group.kind === 'file') {
    const parts = (group.filePath ?? '').split('/');
    return parts[parts.length - 1];
  }
  return group.id;
}

function parentPathGroupIdFromSpec(g, groupById) {
  if (g.kind === 'dir') {
    const parts = g.dirPath.split('/');
    if (parts.length <= 1) return null;
    const parentDir = parts.slice(0, -1).join('/');
    const pid = pathGroupId(parentDir);
    return groupById.has(pid) ? pid : null;
  }
  // file group's parent is its dir group
  if (g.kind === 'file' && g.dirPath) {
    const pid = pathGroupId(g.dirPath);
    return groupById.has(pid) ? pid : null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npm test -- tests/viewer/projection.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/projection.js tests/viewer/projection.test.ts
git commit -m "feat(viewer): add projection module — LOD + group synthesis

project(state, {zoom, focus, filters, search}) returns the visible
node + edge set plus synthesized group representatives. Honors the
BAND_TABLE for zoom-driven folding, composes with search force-visible
(matched leaves surface with their ancestor groups un-emitted), and
rolls dangling / group-to-group edges into aggregate edges.

Pure function with no side effects. projectionDeltaIsInteresting is
the gate for triggering a sim reheat vs. a pure re-render.

Not yet wired into graph-viewer-2d.js."
```

---

## Task 5: Transitions module — projection diff + animation state

**Files:**
- Create: `src/viewer/shared/transitions.js`
- Create: `tests/viewer/transitions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/viewer/transitions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  diffProjection,
  createTransitionState,
  advanceTransitions,
  enterTransition,
  exitTransition,
  interpolated,
} from '../../src/viewer/shared/transitions.js';

function mkProj(ids: string[]) {
  return {
    visibleNodes: new Map(ids.map((id) => [id, { id, kind: 'file', name: id }])),
    visibleEdges: new Map(),
    groups: [],
  };
}

describe('transitions', () => {
  describe('diffProjection', () => {
    it('returns {entering, exiting} node id sets', () => {
      const prev = mkProj(['a', 'b']);
      const curr = mkProj(['b', 'c']);
      const d = diffProjection(prev, curr);
      expect([...d.entering]).toEqual(['c']);
      expect([...d.exiting]).toEqual(['a']);
    });

    it('null previous treats everything as entering', () => {
      const curr = mkProj(['a', 'b']);
      const d = diffProjection(null, curr);
      expect([...d.entering].sort()).toEqual(['a', 'b']);
      expect([...d.exiting]).toEqual([]);
    });
  });

  describe('transition state', () => {
    it('creates empty state', () => {
      const s = createTransitionState();
      expect(s.transitions.size).toBe(0);
    });

    it('enterTransition adds an entering entry', () => {
      const s = createTransitionState();
      enterTransition(s, 'a', { x: 0, y: 0 }, 280);
      expect(s.transitions.get('a')).toMatchObject({ phase: 'entering', age: 0, duration: 280 });
    });

    it('exitTransition adds an exiting entry with provided from/to', () => {
      const s = createTransitionState();
      exitTransition(s, 'a', { x: 10, y: 0, opacity: 1, scale: 1 }, { x: 5, y: 5 }, 220);
      expect(s.transitions.get('a')?.phase).toBe('exiting');
    });

    it('advanceTransitions increments age and removes completed', () => {
      const s = createTransitionState();
      enterTransition(s, 'a', { x: 0, y: 0 }, 100);
      advanceTransitions(s, 50);
      expect(s.transitions.get('a')?.age).toBe(50);
      advanceTransitions(s, 60);
      expect(s.transitions.has('a')).toBe(false);
    });
  });

  describe('interpolated', () => {
    it('at age 0 returns from', () => {
      const t = { phase: 'entering', age: 0, duration: 100,
                  from: { x: 0, y: 0, opacity: 0, scale: 0 },
                  to:   { x: 10, y: 10, opacity: 1, scale: 1 } };
      const v = interpolated(t);
      expect(v).toMatchObject({ x: 0, y: 0, opacity: 0, scale: 0 });
    });

    it('at age = duration returns to', () => {
      const t = { phase: 'entering', age: 100, duration: 100,
                  from: { x: 0, y: 0, opacity: 0, scale: 0 },
                  to:   { x: 10, y: 10, opacity: 1, scale: 1 } };
      const v = interpolated(t);
      expect(v).toMatchObject({ x: 10, y: 10, opacity: 1, scale: 1 });
    });

    it('interpolates smoothly in between', () => {
      const t = { phase: 'entering', age: 50, duration: 100,
                  from: { x: 0, y: 0, opacity: 0, scale: 0 },
                  to:   { x: 10, y: 10, opacity: 1, scale: 1 } };
      const v = interpolated(t);
      expect(v.opacity).toBeGreaterThan(0);
      expect(v.opacity).toBeLessThan(1);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm test -- tests/viewer/transitions.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create the module**

Create `src/viewer/shared/transitions.js`:

```js
/**
 * Transition state for projection deltas: entering / exiting node animations.
 * Pure module; advanceTransitions mutates its own state only.
 *
 * Time units throughout are milliseconds; callers pass dt each frame.
 */

export function diffProjection(previous, current) {
  const entering = new Set();
  const exiting = new Set();
  const prevIds = previous ? new Set(previous.visibleNodes.keys()) : new Set();
  const currIds = new Set(current.visibleNodes.keys());
  for (const id of currIds) if (!prevIds.has(id)) entering.add(id);
  for (const id of prevIds) if (!currIds.has(id)) exiting.add(id);
  return { entering, exiting };
}

export function createTransitionState() {
  return { transitions: new Map() };
}

export function enterTransition(state, id, spawnPos, duration = 280) {
  state.transitions.set(id, {
    phase: 'entering',
    age: 0,
    duration,
    from: { x: spawnPos.x, y: spawnPos.y, opacity: 0, scale: 0 },
    to:   { x: spawnPos.x, y: spawnPos.y, opacity: 1, scale: 1 },
  });
}

export function exitTransition(state, id, currentRender, exitPos, duration = 220) {
  state.transitions.set(id, {
    phase: 'exiting',
    age: 0,
    duration,
    from: { ...currentRender },
    to:   { x: exitPos.x, y: exitPos.y, opacity: 0, scale: 0.6 },
  });
}

export function advanceTransitions(state, dtMs) {
  for (const [id, t] of state.transitions) {
    t.age += dtMs;
    if (t.age >= t.duration) state.transitions.delete(id);
  }
}

export function interpolated(t) {
  const u = Math.max(0, Math.min(1, t.age / t.duration));
  const ease = t.phase === 'entering' ? easeOutBack(u) : easeIn(u);
  return {
    x:       lerp(t.from.x,       t.to.x,       ease),
    y:       lerp(t.from.y,       t.to.y,       ease),
    opacity: lerp(t.from.opacity, t.to.opacity, ease),
    scale:   lerp(t.from.scale,   t.to.scale,   ease),
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function easeIn(u)     { return u * u; }
function easeOutBack(u) {
  const c = 1.70158;
  const x = u - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npm test -- tests/viewer/transitions.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/transitions.js tests/viewer/transitions.test.ts
git commit -m "feat(viewer): add transitions module — projection-diff + animation state

diffProjection computes entering/exiting node id sets. The transition
state tracks each in-flight animation with phase, age, duration, and
from/to render state. interpolated() samples the current value with
ease-out-back for entering (slight bloom overshoot) and ease-in for
exiting. advanceTransitions ages each frame and cleans up completed.

Not yet wired into graph-viewer-2d.js."
```

---

## Task 6: Extend shapes module — rounded rect + hull polygon

**Files:**
- Modify: `src/viewer/shared/shapes.js`
- Modify: `tests/viewer/shapes.test.ts`

- [ ] **Step 1: Read current shape tests**

Run: `cat tests/viewer/shapes.test.ts` — review to understand the existing mock-ctx pattern before extending.

- [ ] **Step 2: Write failing tests for new shapes**

Append to `tests/viewer/shapes.test.ts`:

```ts
import { drawRoundedRect, drawHull, SHAPE_FOR_KIND } from '../../src/viewer/shared/shapes.js';

describe('drawRoundedRect', () => {
  it('draws a filled rect with arcTo corners and fill style', () => {
    const calls: string[] = [];
    const ctx: any = {
      beginPath: () => calls.push('beginPath'),
      moveTo:    () => calls.push('moveTo'),
      lineTo:    () => calls.push('lineTo'),
      arcTo:     () => calls.push('arcTo'),
      closePath: () => calls.push('closePath'),
      fill:      () => calls.push('fill'),
      stroke:    () => calls.push('stroke'),
      set fillStyle(v) { calls.push(`fill=${v}`); },
      set strokeStyle(v) { calls.push(`stroke=${v}`); },
    };
    drawRoundedRect(ctx, 0, 0, 10, '#abc');
    expect(calls).toContain('beginPath');
    expect(calls).toContain('fill=#abc');
    expect(calls).toContain('fill');
    expect(calls.filter((c) => c === 'arcTo').length).toBeGreaterThanOrEqual(4);
  });
});

describe('drawHull', () => {
  it('draws a convex hull polygon for 3+ points', () => {
    const calls: string[] = [];
    const ctx: any = {
      beginPath: () => calls.push('beginPath'),
      moveTo:    () => calls.push('moveTo'),
      lineTo:    () => calls.push('lineTo'),
      closePath: () => calls.push('closePath'),
      fill:      () => calls.push('fill'),
      stroke:    () => calls.push('stroke'),
      set fillStyle(v) { calls.push(`fill=${v}`); },
      set strokeStyle(v) { calls.push(`stroke=${v}`); },
      set lineWidth(v) {},
    };
    const points = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ];
    drawHull(ctx, points, 'rgba(100,100,200,0.1)', 'rgba(100,100,200,0.8)');
    expect(calls).toContain('beginPath');
    expect(calls).toContain('closePath');
    expect(calls).toContain('fill');
    expect(calls).toContain('stroke');
  });

  it('does nothing for fewer than 3 points', () => {
    const calls: string[] = [];
    const ctx: any = {
      beginPath: () => calls.push('beginPath'),
      moveTo:    () => calls.push('moveTo'),
      fill:      () => calls.push('fill'),
      stroke:    () => calls.push('stroke'),
      set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    };
    drawHull(ctx, [{ x: 0, y: 0 }, { x: 1, y: 1 }], '#fff', '#fff');
    expect(calls).toEqual([]);
  });
});

describe('SHAPE_FOR_KIND', () => {
  it('includes group kind pointing to drawRoundedRect', () => {
    expect(SHAPE_FOR_KIND.group).toBe(drawRoundedRect);
  });
});
```

- [ ] **Step 3: Run — verify new tests fail**

Run: `npm test -- tests/viewer/shapes.test.ts`
Expected: FAIL — drawRoundedRect, drawHull, SHAPE_FOR_KIND.group not defined.

- [ ] **Step 4: Implement drawRoundedRect and drawHull**

Edit `src/viewer/shared/shapes.js`. Add, before the existing `drawStrike`:

```js
export function drawRoundedRect(ctx, x, y, r, fill, stroke) {
  // Square-ish rounded rect, centered on (x, y), half-size r.
  const half = r;
  const radius = Math.min(r * 0.35, 4);
  ctx.beginPath();
  ctx.moveTo(x - half + radius, y - half);
  ctx.lineTo(x + half - radius, y - half);
  ctx.arcTo(x + half, y - half, x + half, y - half + radius, radius);
  ctx.lineTo(x + half, y + half - radius);
  ctx.arcTo(x + half, y + half, x + half - radius, y + half, radius);
  ctx.lineTo(x - half + radius, y + half);
  ctx.arcTo(x - half, y + half, x - half, y + half - radius, radius);
  ctx.lineTo(x - half, y - half + radius);
  ctx.arcTo(x - half, y - half, x - half + radius, y - half, radius);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

/**
 * Draw a convex-hull polygon around the given points with a fill + stroke.
 * Uses monotone-chain; no-op for <3 points.
 */
export function drawHull(ctx, points, fill, stroke) {
  if (!points || points.length < 3) return;
  const hull = convexHull(points);
  if (hull.length < 3) return;

  ctx.beginPath();
  ctx.moveTo(hull[0].x, hull[0].y);
  for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function convexHull(pts) {
  const points = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const n = points.length;
  if (n < 3) return points.slice();
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
```

Update the `SHAPE_FOR_KIND` dispatcher at the bottom of the file:

```js
export const SHAPE_FOR_KIND = {
  decision:  drawDiamond,
  file:      drawCircle,
  function:  drawCircle,
  component: drawPill,
  reference: drawHex,
  path:      drawTri,
  group:     drawRoundedRect,
};
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npm test -- tests/viewer/shapes.test.ts`
Expected: all pass (old + new).

- [ ] **Step 6: Commit**

```bash
git add src/viewer/shared/shapes.js tests/viewer/shapes.test.ts
git commit -m "feat(viewer): add drawRoundedRect and drawHull shape primitives

drawRoundedRect renders supernodes (path groups) — soft-cornered
rounded rect that reads visually as 'a collection'. drawHull draws
convex-hull polygons for decision territories using monotone-chain
computation; no-op for <3 points.

SHAPE_FOR_KIND gains 'group' → drawRoundedRect. Not yet called by
the entry file."
```

---

## Task 7: Layout module — read sizes from sizing.js

**Context:** Before the entry file can switch to the new sizing, `layout.js` needs to read `world` sizes from the sizing module so forceCollide / forceLink stay consistent with the render.

**Files:**
- Modify: `src/viewer/shared/layout.js`
- Modify: `tests/viewer/layout.test.ts`

- [ ] **Step 1: Update layout.js to import from sizing**

Replace the entire contents of `src/viewer/shared/layout.js`:

```js
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from 'd3-force';
import { worldSize, groupWorldSize } from './sizing.js';

/**
 * d3-force configuration for the 2D viewer.
 *
 * Charges and link distances/strengths live here (they're force-specific);
 * node sizes come from sizing.js so the render and the physics agree.
 */

const CHARGE = {
  decision: -220,
  file:     -80,
  function: -40,
  component: -40,
  reference: -40,
  path:     -25,
  group:    -180,   // supernodes repel like mid-weight decisions
};

const LINK_DIST = {
  GOVERNS: 45,
  CALLS: 55,
  IMPORTS: 70,
  SUPERSEDES: 40,
  REFERENCES: 70,
  'co-changed': 140,
};

const LINK_STR = {
  GOVERNS: 0.8,
  CALLS: 0.5,
  IMPORTS: 0.4,
  SUPERSEDES: 0.6,
  REFERENCES: 0.4,
  'co-changed': 0.1,
};

export function nodeSize(kindOrNode) {
  // Accept either a kind string (test convention) or a node object.
  if (typeof kindOrNode === 'string') return worldSize(kindOrNode);
  const n = kindOrNode;
  if (n.kind === 'group') return groupWorldSize(n.memberCount ?? 1);
  return worldSize(n.kind);
}

export function nodeCharge(node) {
  return CHARGE[node.kind] ?? -50;
}

export function linkDistance(link) {
  return LINK_DIST[link.relation] ?? 120;
}

export function linkStrength(link) {
  return LINK_STR[link.relation] ?? 0.3;
}

export function createSimulation() {
  return forceSimulation()
    .force('link',   forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge', forceManyBody().strength(nodeCharge))
    .force('center', forceCenter(0, 0).strength(0.12))
    .force('collide', forceCollide().radius(n => nodeSize(n) + 4))
    .alpha(1);
}
```

- [ ] **Step 2: Update layout tests to reflect new behavior**

The existing tests check radius ranges (e.g., `nodeSize('decision') >= 7 && <= 8`). With the new model `worldSize('decision') === 10`. Update the expectations.

Replace the `describe('nodeSize', ...)` block in `tests/viewer/layout.test.ts` with:

```ts
  describe('nodeSize', () => {
    it('returns per-kind world sizes from sizing module', () => {
      expect(nodeSize('decision')).toBe(10);
      expect(nodeSize('file')).toBe(5);
      expect(nodeSize('function')).toBe(2.5);
    });

    it('accepts a node object too', () => {
      expect(nodeSize({ kind: 'file' })).toBe(5);
    });

    it('uses groupWorldSize for group nodes', () => {
      const small = nodeSize({ kind: 'group', memberCount: 2 });
      const big   = nodeSize({ kind: 'group', memberCount: 64 });
      expect(big).toBeGreaterThan(small);
    });

    it('falls back for unknown kinds', () => {
      expect(nodeSize('unknown')).toBeGreaterThan(0);
    });
  });
```

- [ ] **Step 3: Run layout + sizing tests — verify pass**

Run: `npm test -- tests/viewer/layout.test.ts tests/viewer/sizing.test.ts`
Expected: all pass.

- [ ] **Step 4: Hand-verify no viewer regression**

Run: `npm run dev`. Open http://localhost:3334/viewer.
Expected: visual behavior identical to before — node sizes may change slightly (old `SIZE.decision = 7.5`, now `10`) but everything still lays out, pans, zooms, filters, and highlights correctly.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts
git commit -m "refactor(viewer): layout reads world sizes from sizing module

nodeSize() now delegates to sizing.worldSize() or groupWorldSize()
for group kind. Force charges, link distances, and link strengths
stay local to layout.js. Adds 'group' charge for supernode physics.

No render behavior change — world sizes are what the sim sees;
render-side sizeAt() clamping is wired in a later task."
```

---

## Task 8: Wire projection into the viewer — identity pass

**Context:** Refactor `graph-viewer-2d.js` to route its sim + render through `project()`, but keep the projection behavior neutral (visible set = all filter-passing nodes, no LOD yet). This is a pure refactor — should produce no visible change.

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add imports**

Near the top of `src/viewer/graph-viewer-2d.js`, add:

```js
import { project, projectionDeltaIsInteresting } from '/viewer/shared/projection.js';
import { sizeAt, edgeStrokeAt } from '/viewer/shared/sizing.js';
```

- [ ] **Step 2: Add projection state + inputs object**

Just below the existing `const state = createGraphState();` / `const anim = createAnimState();` lines, add:

```js
let projected = null;   // current projection output
let lastProjectionInputs = null;

function projectionInputs() {
  return {
    zoom: camera.zoom,
    focus: focusSet ? { root: focusId, depth: 1 } : null,
    filters: activeKinds,
    search: searchQuery,
  };
}
```

Move the declarations of `activeKinds`, `searchQuery`, `focusId`, `focusSet` *up* in the file so they're defined before `projectionInputs()` is called. Their current definitions are at lines ~272, ~271, ~570, ~588 — hoist them next to the projection state declaration. (Keep initial values the same.)

- [ ] **Step 3: Replace the initial `simulation.nodes(...)` call**

Currently (line ~66-73):

```js
const simulation = createSimulation()
  .nodes([...state.nodes.values()])
  .on('tick', () => {});
simulation.force('link').links([...state.edges.values()].map(e => ({
  source: e.source_id,
  target: e.target_id,
  relation: e.relation,
})));
```

Replace with:

```js
const simulation = createSimulation().on('tick', () => {});

function reproject(reason) {
  const inputs = projectionInputs();
  const next = project(state, inputs);
  applyEntryPositions(next, projected);   // inherit-from-parent (defined below)
  const changed = projectionDeltaIsInteresting(projected, next);
  projected = next;
  if (changed) {
    simulation.nodes([...projected.visibleNodes.values()]);
    simulation.force('link').links([...projected.visibleEdges.values()].map((e) => ({
      source: e.source_id,
      target: e.target_id,
      relation: e.relation,
      aggregate: !!e.aggregate,
      count: e.count,
    })));
    simulation.alpha(alphaFor(reason)).restart();
  }
}

function alphaFor(reason) {
  switch (reason) {
    case 'focus-enter':
    case 'focus-exit': return 0.5;
    case 'band-cross': return 0.4;
    case 'mutation':
    case 'filter':    return 0.3;
    case 'search':    return 0.2;
    default:          return 0.3;
  }
}

function applyEntryPositions(next, prev) {
  // For newly-visible nodes, inherit (x, y) from their parent centroid
  // (or fall back to a connected decision, if any).
  const prevVisible = prev ? prev.visibleNodes : new Map();
  for (const [id, n] of next.visibleNodes) {
    if (prevVisible.has(id)) {
      // Reuse the old position instance if available.
      const old = prevVisible.get(id);
      if (old.x !== undefined) { n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy; }
      continue;
    }
    if (n.kind === 'group' && n.members && n.members.length) {
      // Group appearing: centroid of its (now-leaving) member positions.
      let sx = 0, sy = 0, count = 0;
      for (const m of n.members) {
        const old = prevVisible.get(m);
        if (old && old.x !== undefined) { sx += old.x; sy += old.y; count++; }
      }
      if (count) { n.x = sx / count + jitter(); n.y = sy / count + jitter(); }
    } else {
      // Leaf entering: start from parent group centroid if its ancestor was visible.
      const stateNode = state.nodes.get(id);
      if (stateNode && stateNode.file_path) {
        const parentDirId = `group:path:${dirnameOf(stateNode.file_path)}`;
        const parent = prevVisible.get(parentDirId);
        if (parent && parent.x !== undefined) {
          n.x = parent.x + jitter(); n.y = parent.y + jitter();
        }
      }
    }
  }
}

function jitter() { return (Math.random() - 0.5) * 8; }
function dirnameOf(p) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

// Initial projection.
reproject('mutation');
```

- [ ] **Step 4: Replace syncSimulation with reproject**

Find `function syncSimulation()` (line ~89). Delete it. Replace all call sites of `syncSimulation()` with `reproject('mutation')`. Search for `syncSimulation` in the file — there's one call inside the onMutation handler. Replace:

```js
  onMutation: (m) => {
    applyMutation(state, m);
    rebuildNeighbors();
    syncSimulation();
    ...
```

with:

```js
  onMutation: (m) => {
    applyMutation(state, m);
    rebuildNeighbors();
    reproject('mutation');
    ...
```

- [ ] **Step 5: Make render + hit-test iterate over projected nodes/edges instead of state**

In `pickNodeAt` (line ~167), replace `for (const node of state.nodes.values())` with:

```js
  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
```

(State fallback covers the brief window before the first projection runs.)

In the edge render loop (line ~340), replace `for (const edge of state.edges.values())` with:

```js
  for (const edge of (projected?.visibleEdges.values() ?? state.edges.values())) {
```

In the node render loop (line ~363), replace `for (const node of state.nodes.values())` with:

```js
  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
```

In `drawLabels` (line ~399), do the same substitution.

Remove the `isVisible(node)` call inside each loop (projection already handles visibility). Delete the `function isVisible(node)` definition (line ~323) and its calls in the loops.

- [ ] **Step 6: Hand-verify no visual regression**

Run: `npm run dev`. Open http://localhost:3334/viewer.

Expected: viewer looks and behaves exactly as before. All ~453 nodes visible at default zoom (BAND_TABLE emits them because the default zoom, after initial fit, is typically around 1× which is in the leaf-file band). If you see fewer nodes, the band table is already folding — that's the design, but this task is supposed to be neutral. If the default zoom lands in a band that folds, note it; the LOD behavior is the subject of Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "refactor(viewer): route sim + render through project()

The simulation and the render/hit-test now read from projected output
rather than raw state. reproject(reason) is the single choke point:
runs project(), applies entry-position inheritance, feeds the sim,
and reheats with reason-aware alpha.

No new LOD behavior yet — the BAND_TABLE still emits leaves at the
default zoom. Task 9 tunes the bands to actually fold.

Deletes the unused isVisible() helper now that projection owns visibility."
```

---

## Task 9: Enable LOD — reheat triggers on filter/search/zoom-band changes

**Context:** Wire the `reproject()` call into the UI events (filter toggles, search, zoom-band crossings). Debounce zoom.

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Trigger reproject on filter toggle**

Find the filter checkbox handler (line ~315):

```js
document.querySelectorAll('#filters input').forEach((cb) => {
  cb.addEventListener('change', () => {
    const k = cb.dataset.kind;
    if (cb.checked) activeKinds.add(k); else activeKinds.delete(k);
    updateSearchCount();
  });
});
```

Change to:

```js
document.querySelectorAll('#filters input').forEach((cb) => {
  cb.addEventListener('change', () => {
    const k = cb.dataset.kind;
    if (cb.checked) activeKinds.add(k); else activeKinds.delete(k);
    updateSearchCount();
    reproject('filter');
  });
});
```

- [ ] **Step 2: Trigger reproject on search input (debounced)**

Find the search input handler (line ~294). Extract the debounce:

```js
let searchDebounce = null;
searchInput.addEventListener('input', (ev) => {
  searchQuery = ev.target.value.toLowerCase();
  updateSearchCount();
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { reproject('search'); }, 200);
});
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = '';
    searchQuery = '';
    updateSearchCount();
    searchInput.blur();
    if (searchDebounce) clearTimeout(searchDebounce);
    reproject('search');
  }
});
```

- [ ] **Step 3: Trigger reproject on zoom band crossing**

Find the wheel handler (line ~252). Before the end of the handler, after `camera = zoomAtPoint(...)`, check for a band crossing:

```js
canvas.addEventListener('wheel', (ev) => {
  if (ev.deltaY === 0) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const factor = Math.exp(-ev.deltaY * 0.001);
  const prevBand = bandIndexFor(camera.zoom);
  camera = zoomAtPoint(camera, factor, sx, sy, rect.width, rect.height);
  targetCamera = null;
  const nextBand = bandIndexFor(camera.zoom);
  if (prevBand !== nextBand) reproject('band-cross');
}, { passive: false });
```

Add the `bandIndexFor` helper near the top-level of the file:

```js
import { BAND_TABLE } from '/viewer/shared/projection.js';

function bandIndexFor(zoom) {
  for (let i = 0; i < BAND_TABLE.length; i++) {
    if (zoom < BAND_TABLE[i].maxZoom) return i;
  }
  return BAND_TABLE.length - 1;
}
```

(Extend the existing `projection.js` import rather than duplicating.)

- [ ] **Step 4: Trigger reproject on focus mode enter / exit**

Find the dblclick handler (line ~590). Replace:

```js
canvas.addEventListener('dblclick', (ev) => {
  const best = pickNodeAt(ev);
  if (best) {
    focusId = best.id;
    focusSet = bfsNeighborhood(best.id, 1);
    const focusedNodes = [...state.nodes.values()].filter((n) => focusSet.has(n.id));
    targetCamera = fitToBounds(focusedNodes, canvas.clientWidth, canvas.clientHeight, 80);
  }
});
```

with:

```js
canvas.addEventListener('dblclick', (ev) => {
  const best = pickNodeAt(ev);
  if (!best) return;
  focusId = best.id;
  focusSet = bfsNeighborhood(best.id, 1);
  const focusedNodes = [...state.nodes.values()].filter((n) => focusSet.has(n.id));
  targetCamera = fitToBounds(focusedNodes, canvas.clientWidth, canvas.clientHeight, 80);
  reproject('focus-enter');
});
```

Find the Esc handler (line ~606). Add `reproject('focus-exit')` after clearing focus:

```js
window.addEventListener('keydown', (ev) => {
  if (document.activeElement === searchInput) return;
  if (ev.key !== 'Escape') return;
  if (!focusSet) return;
  focusId = null;
  focusSet = null;
  targetCamera = fitToBounds(state.nodes.values(), canvas.clientWidth, canvas.clientHeight, 40);
  reproject('focus-exit');
});
```

- [ ] **Step 5: Hand-verify LOD behavior**

Run: `npm run dev`. Open http://localhost:3334/viewer.

Verify:
- Zoom out with wheel: at some point the number of visible nodes drops (a band crossing). Briefly see the graph re-layout.
- Zoom in: more nodes appear; re-layout again.
- Toggle off "function" filter: functions fade out (they're in the exiting transition set once Task 12 lands; for now they just disappear). Graph re-breathes.
- Type "persister" in search at far zoom: the matching file appears in the graph (forced-visible). Clear search → it disappears again.
- Double-click a node: focus mode engages, camera fits to neighborhood. Esc: exit focus; camera refits.

Note: transitions are not yet rendered (that's Task 13) — entries/exits snap. Still verify the visibility changes are correct.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): wire LOD reheat triggers (filter, search, zoom-band, focus)

reproject() now fires on:
  - kind filter toggle (reason=filter, alpha 0.3)
  - search input, debounced 200ms (reason=search, alpha 0.2)
  - wheel zoom crossing a BAND_TABLE threshold (reason=band-cross, alpha 0.4)
  - dblclick focus enter / Esc focus exit (alpha 0.5)

Pure intra-band zoom does not reheat — render scale suffices.
Transitions still snap; Task 13 adds the animation pass."
```

---

## Task 10: Render supernodes with labels and member count

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Render group nodes in the node pass**

Inside the existing node loop (currently at lines ~363-385), add a branch for `node.kind === 'group'`. Locate:

```js
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
```

Expand the whole loop body to handle the group kind:

```js
  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = node.kind === 'group'
      ? [108, 116, 132]
      : (PALETTE_REST[node.kind] || PALETTE_REST.file);
    const hover = node.kind === 'group'
      ? [168, 176, 192]
      : (PALETTE_HOVER[node.kind] || PALETTE_HOVER.file);
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };
    const isSelected = node.id === selectedId;
    const isSelectionNeighbor = selectedId !== null && (neighborsOf.get(selectedId) || new Set()).has(node.id);
    const selectionLevel = isSelected ? 1.0 : (isSelectionNeighbor ? 0.6 : 0);
    const combinedHighlight = Math.max(nAnim.highlight, selectionLevel);
    const rgb = lerpRGB(base, hover, Math.max(nAnim.colorMix, selectionLevel));
    const statusAlpha = node.status === 'proposed' || node.status === 'superseded' ? 0.4 : 1.0;
    const restAlpha  = statusAlpha * 0.5;
    const hoverAlpha = Math.min(1, statusAlpha + 0.25);
    const alpha = hoveredId === null && !isSelected && !isSelectionNeighbor
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * combinedHighlight;
    const matches = searchMatch(node, searchQuery);
    const isHovered = node.id === hoveredId;
    const searchDim = searchQuery && !matches && !isHovered && !isSelected ? 0.15 : 1.0;

    // Use sizeAt for the *rendered* radius (clamped screen-space), nodeSize
    // for the underlying world size used by physics.
    const screenR = sizeAt(node.kind === 'group' ? 'group' : node.kind, camera.zoom) * (1 + combinedHighlight * 0.15);
    const r = node.kind === 'group'
      ? (nodeSize(node) + combinedHighlight * 1.5)
      : screenR;

    shape(ctx, node.x ?? 0, node.y ?? 0, r, rgbString(rgb, alpha * searchDim));

    if (isSelected) {
      ctx.beginPath();
      if (node.kind === 'group') ctx.rect(node.x - r - 2, node.y - r - 2, (r + 2) * 2, (r + 2) * 2);
      else ctx.arc(node.x ?? 0, node.y ?? 0, r + 2, 0, Math.PI * 2);
      ctx.strokeStyle = rgbString(hover, 0.9);
      ctx.lineWidth = 1 / camera.zoom;
      ctx.stroke();
    }
    if (node.status === 'superseded') {
      drawStrike(ctx, node.x ?? 0, node.y ?? 0, r, 'rgba(255,255,255,' + (alpha * searchDim * 0.8) + ')');
    }
  }
```

Note: `sizeAt` gets a `'group'` argument. Add a sizing entry for `'group'` in `src/viewer/shared/sizing.js`:

```js
  group:     { world: 8,   min_px: 12, max_px: 26 },
```

Rerun `npm test -- tests/viewer/sizing.test.ts` — expected still passing (the new row isn't tested in detail; it uses the existing infrastructure).

- [ ] **Step 2: Add group labels + member count pill**

In `drawLabels` (line ~394), add a branch for group kind. Inside the loop, after the existing kind-specific alpha computation, add before `if (alpha <= 0)`:

```js
    if (node.kind === 'group') alpha = 1;   // groups are always labeled
```

After `ctx.fillText(String(node.name || ''), sx + offset, sy + 3);`, add the member count pill for groups:

```js
    if (node.kind === 'group' && node.memberCount) {
      const countText = ' · ' + node.memberCount;
      ctx.fillStyle = 'rgba(120,120,120,' + alpha + ')';
      const nameW = ctx.measureText(String(node.name || '')).width;
      ctx.fillText(countText, sx + offset + nameW, sy + 3);
    }
```

- [ ] **Step 3: Hand-verify**

Run: `npm run dev`.

Zoom out until supernodes appear (below ~1.0×). Verify:
- Rounded-rect supernodes appear where directory groups were folded.
- Each has its directory basename label (e.g., `worker/`) and a member count (`· 8`).
- Click one: selection ring appears (square, around the rect).
- Click empty: ring disappears.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js src/viewer/shared/sizing.js
git commit -m "feat(viewer): render supernode representatives from projection

Path groups emitted by the projection render as rounded-rect
supernodes. Labels show dir basename + member count pill (e.g.
'worker/ · 8'). Selection ring shapes to match the kind (square
for groups)."
```

---

## Task 11: Render territory hulls behind the edges

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Draw hulls before edges**

In `draw()` (line ~330), after the `ctx.translate(-camera.x, -camera.y)` line and before the edge loop, insert the hull pass:

```js
  // --- Territory hulls (drawn behind edges + nodes) ---
  if (projected && projected.groups) {
    for (const g of projected.groups) {
      if (g.kind !== 'territory') continue;
      const decisionNode = projected.visibleNodes.get(g.decisionId);
      if (!decisionNode) continue;
      const points = [];
      for (const m of g.members) {
        const vis = projected.visibleNodes.get(m);
        if (vis && vis.x !== undefined) { points.push({ x: vis.x, y: vis.y }); continue; }
        // Member folded into a supernode — include the supernode's position instead.
        const anc = findAncestorRep(m);
        if (anc && anc.x !== undefined) points.push({ x: anc.x, y: anc.y });
      }
      // Always include the decision itself in the hull.
      if (decisionNode.x !== undefined) points.push({ x: decisionNode.x, y: decisionNode.y });
      if (points.length < 3) continue;
      const basePalette = PALETTE_REST[decisionNode.kind] || PALETTE_REST.decision || [160, 140, 200];
      const hoverPalette = PALETTE_HOVER[decisionNode.kind] || PALETTE_HOVER.decision || [200, 180, 240];
      drawHull(ctx, points,
        rgbString(basePalette, 0.08),
        rgbString(hoverPalette, 0.35));
    }
  }
```

Add a helper near the other helpers:

```js
function findAncestorRep(memberId) {
  if (!projected) return null;
  const stateNode = state.nodes.get(memberId);
  if (!stateNode || !stateNode.file_path) return null;
  const dirId = `group:path:${dirnameOf(stateNode.file_path)}`;
  return projected.visibleNodes.get(dirId) ?? null;
}
```

Add to imports at the top:

```js
import { drawHull } from '/viewer/shared/shapes.js';
```

- [ ] **Step 2: Hand-verify**

Run: `npm run dev`. Zoom to a level where a decision's governed files or supernodes are visible. Verify:
- A translucent tinted region appears around the decision's territory.
- The hull inflates/deflates as the sim settles (expected).
- Hovering or clicking inside the hull doesn't interfere (hulls are draw-only, no hit-test change).
- Decisions with no currently-visible members don't draw a hull (nothing to draw).

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): render territory hulls for decision governance

Territories emitted by the projection render as translucent convex
hulls behind edges + nodes. Fallback to supernode position when a
governed member is folded — so the hull still conveys 'this decision's
territory extends into worker/'. Empty territories don't draw."
```

---

## Task 12: Render aggregate edges with count-aware stroke

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Update edge render loop**

In the edge loop (line ~340-361, now iterating `projected.visibleEdges.values()`), handle aggregate edges. Replace the entire edge-drawing block:

```js
  ctx.lineWidth = 0.5 / camera.zoom;
  for (const edge of (projected?.visibleEdges.values() ?? state.edges.values())) {
    const a = projected ? projected.visibleNodes.get(edge.source_id) : state.nodes.get(edge.source_id);
    const b = projected ? projected.visibleNodes.get(edge.target_id) : state.nodes.get(edge.target_id);
    if (!a || !b) continue;

    const eKey = edgeKey({ source_id: edge.source_id, target_id: edge.target_id, relation: edge.relation });
    const alphaSpec = EDGE_ALPHA[edge.relation] || EDGE_ALPHA.CALLS;
    const eAnim = anim.edges.get(eKey);
    const h = eAnim ? eAnim.highlight : 0;
    const isSelectedEdge =
      selectedId !== null && (edge.source_id === selectedId || edge.target_id === selectedId);
    const effectiveHighlight = Math.max(h, isSelectedEdge ? 1.0 : 0);
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * effectiveHighlight;

    const edgeBright = !searchQuery
      || (searchMatch(a, searchQuery) && searchMatch(b, searchQuery))
      || a.id === hoveredId || b.id === hoveredId
      || isSelectedEdge;
    const edgeSearchDim = edgeBright ? 1.0 : 0.15;

    // Aggregate edges: thicker stroke, weight ∝ log2(count).
    const aggregateBoost = edge.aggregate ? (1 + Math.log2(Math.max(1, edge.count))) : 1;
    ctx.lineWidth = edgeStrokeAt(edge.relation, camera.zoom) * aggregateBoost;

    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * edgeSearchDim) + ')';
    ctx.beginPath();
    ctx.moveTo(a.x ?? 0, a.y ?? 0);
    ctx.lineTo(b.x ?? 0, b.y ?? 0);
    ctx.stroke();
  }
```

- [ ] **Step 2: Aggregate edge tooltip on hover**

Update the pointermove handler to show aggregate info when hovering near an aggregate edge. For v1 keep it minimal: at the end of the pointermove handler (before the tooltip position updates at the end), add:

```js
  if (!best && projected) {
    // Check proximity to an aggregate edge.
    const rect = canvas.getBoundingClientRect();
    const [wx, wy] = camScreenToWorld(
      camera, ev.clientX - rect.left, ev.clientY - rect.top,
      rect.width, rect.height,
    );
    const found = findAggregateEdgeNear(wx, wy, 5 / camera.zoom);
    if (found) {
      const relations = Object.entries(found.relations || { [found.relation]: found.count })
        .map(([r, n]) => `${n} ${r}`).join(', ');
      tooltip.textContent = relations;
      tooltip.classList.add('show');
    } else if (!hoveredId) {
      tooltip.classList.remove('show');
    }
  }
```

Add the helper:

```js
function findAggregateEdgeNear(wx, wy, threshold) {
  if (!projected) return null;
  for (const edge of projected.visibleEdges.values()) {
    if (!edge.aggregate) continue;
    const a = projected.visibleNodes.get(edge.source_id);
    const b = projected.visibleNodes.get(edge.target_id);
    if (!a || !b) continue;
    if (distToSegment(wx, wy, a.x, a.y, b.x, b.y) <= threshold) return edge;
  }
  return null;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
```

- [ ] **Step 3: Hand-verify**

Run: `npm run dev`. Zoom out so leaves collapse into supernodes.
Verify:
- Edges between two supernodes, or from a decision into a supernode, appear thicker than single leaf-to-leaf edges.
- Hover on an aggregate edge: tooltip shows "3 CALLS, 1 IMPORTS" or similar.
- Selection of a node adjacent to a supernode brightens the aggregate edge.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): render aggregate edges with count-aware stroke + tooltip

Aggregate edges get stroke width 1 + log2(count) (on top of the
per-relation base). Tooltip on hover shows the relation breakdown
('3 CALLS, 1 IMPORTS'). Proximity picking uses point-to-segment
distance with a 5px (apparent) threshold."
```

---

## Task 13: Transition rendering — entering + exiting animations

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add transition state + wire it to projection deltas**

At the top of `graph-viewer-2d.js`, add imports:

```js
import {
  createTransitionState,
  diffProjection,
  enterTransition,
  exitTransition,
  advanceTransitions,
  interpolated,
} from '/viewer/shared/transitions.js';
```

Near the anim state declaration, add:

```js
const transitionState = createTransitionState();
```

Inside `reproject()` (after the `const next = project(...)` line, before `applyEntryPositions(next, projected)`), compute the diff and register transitions:

```js
  const diff = diffProjection(projected, next);
  for (const id of diff.entering) {
    const n = next.visibleNodes.get(id);
    if (!n) continue;
    // Use the already-assigned (inherit-from-parent) position as spawn point.
    // applyEntryPositions hasn't run yet — do a lightweight spawn pos here.
    let spawn = { x: n.x ?? 0, y: n.y ?? 0 };
    enterTransition(transitionState, id, spawn, 280);
  }
  for (const id of diff.exiting) {
    const n = projected?.visibleNodes.get(id);
    if (!n) continue;
    // Condense toward parent centroid.
    const stateNode = state.nodes.get(id) || n;
    let exitPos = { x: n.x ?? 0, y: n.y ?? 0 };
    if (stateNode && stateNode.file_path) {
      const parentId = `group:path:${dirnameOf(stateNode.file_path)}`;
      const parent = next.visibleNodes.get(parentId);
      if (parent && parent.x !== undefined) exitPos = { x: parent.x, y: parent.y };
    }
    exitTransition(transitionState, id,
      { x: n.x ?? 0, y: n.y ?? 0, opacity: 1, scale: 1 }, exitPos, 220);
  }
```

- [ ] **Step 2: Advance transitions each frame**

In the `frame(t)` function (line ~472), add:

```js
  // Advance transitions using real wall-time since last frame.
  const dt = lastFrameT ? t - lastFrameT : 16;
  lastFrameT = t;
  advanceTransitions(transitionState, dt);
```

Add `let lastFrameT = 0;` near the top of the file (alongside the other mutable viewer state).

- [ ] **Step 3: Apply entering opacity/scale in node render**

In the node render loop, after `const searchDim = ...`, add:

```js
    // Transition opacity/scale override.
    const trans = transitionState.transitions.get(node.id);
    let tOpacity = 1, tScale = 1;
    if (trans) {
      const v = interpolated(trans);
      tOpacity = v.opacity;
      tScale = v.scale;
      // For entering/exiting, force their interpolated position (overrides sim).
      node.x = v.x;
      node.y = v.y;
    }
```

Include `tOpacity` and `tScale` in the final draw call:

```js
    const finalAlpha = alpha * searchDim * tOpacity;
    const finalR = r * tScale;
    shape(ctx, node.x ?? 0, node.y ?? 0, finalR, rgbString(rgb, finalAlpha));
```

Update the `isSelected` ring to use `finalR`:

```js
    if (isSelected) {
      ctx.beginPath();
      if (node.kind === 'group') ctx.rect(node.x - finalR - 2, node.y - finalR - 2, (finalR + 2) * 2, (finalR + 2) * 2);
      else ctx.arc(node.x ?? 0, node.y ?? 0, finalR + 2, 0, Math.PI * 2);
      ctx.strokeStyle = rgbString(hover, 0.9);
      ctx.lineWidth = 1 / camera.zoom;
      ctx.stroke();
    }
```

- [ ] **Step 4: Include exiting nodes in render iteration**

Exiting transitions need to be drawn even though they're not in `projected.visibleNodes` anymore. Near the top of the node render loop, expand the iteration:

```js
  // Iterate over both currently-visible nodes and those still exiting.
  const visible = projected?.visibleNodes ?? new Map();
  const exitingIds = new Set(
    [...transitionState.transitions.entries()]
      .filter(([, t]) => t.phase === 'exiting')
      .map(([id]) => id),
  );
  const idsToRender = new Set([...visible.keys(), ...exitingIds]);
  for (const id of idsToRender) {
    const node = visible.get(id) || state.nodes.get(id);
    if (!node) continue;
    /* ...existing per-node body... */
  }
```

Wrap the existing body in this loop.

- [ ] **Step 5: Hand-verify**

Run: `npm run dev`.

Zoom out to cross a band threshold. Observe:
- Functions fade + shrink as they condense toward their file's or dir's supernode.
- Supernodes appear by blooming from a centroid with a slight overshoot.
Filter off a kind (e.g., function): same fade-and-condense.
Clear search that forced a leaf visible: the leaf fades and condenses back into its supernode.

Transitions should feel smooth — no snaps, no teleports.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): entering + exiting node transitions (fade + scale + position)

reproject() computes the projection diff and registers enter/exit
transitions for affected nodes. The frame loop advances them by
real dt; node render interpolates opacity + scale + position for
each active transition. Exiting nodes keep rendering until their
transition completes, condensing toward their parent's centroid."
```

---

## Task 14: Supernode drill + search force-visible polish

**Context:** Double-click a supernode to animate the camera into the zoom level that unfolds it. Confirm search force-visible works end-to-end with the transitions.

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Drill into a supernode on dblclick**

Expand the dblclick handler (from Task 9) to special-case group nodes:

```js
canvas.addEventListener('dblclick', (ev) => {
  const best = pickNodeAt(ev);
  if (!best) return;

  if (best.kind === 'group') {
    // Compute a zoom level that places this group inside the next band up
    // (so its children become visible), centered on the group's position.
    const targetZoom = zoomLevelForBandBelow(bandIndexFor(camera.zoom));
    targetCamera = {
      x: best.x ?? camera.x,
      y: best.y ?? camera.y,
      zoom: targetZoom,
    };
    return;   // Band crossing from the camera lerp fires reproject via wheel; supply it explicitly.
  }

  focusId = best.id;
  focusSet = bfsNeighborhood(best.id, 1);
  const focusedNodes = [...state.nodes.values()].filter((n) => focusSet.has(n.id));
  targetCamera = fitToBounds(focusedNodes, canvas.clientWidth, canvas.clientHeight, 80);
  reproject('focus-enter');
});
```

Add the helper:

```js
function zoomLevelForBandBelow(bandIndex) {
  // Return a zoom that lands inside the next closer band.
  // BAND_TABLE[bandIndex].maxZoom is the upper bound of the current band.
  // Pick the midpoint of the next band.
  const i = Math.min(BAND_TABLE.length - 1, bandIndex + 1);
  const prevMax = i > 0 ? BAND_TABLE[i - 1].maxZoom : 0;
  const currMax = BAND_TABLE[i].maxZoom === Infinity ? 4 : BAND_TABLE[i].maxZoom;
  return (prevMax + currMax) / 2;
}
```

- [ ] **Step 2: Trigger band-cross reproject during camera lerp**

The camera's `frame()` loop lerps toward `targetCamera` without triggering wheel events, so band-cross reproject wouldn't fire. Add a check inside the lerp in `frame(t)`:

```js
  if (targetCamera) {
    const prevBand = bandIndexFor(camera.zoom);
    camera = lerpCamera(camera, targetCamera, 0.15);
    const dx = targetCamera.x - camera.x;
    const dy = targetCamera.y - camera.y;
    const dz = targetCamera.zoom - camera.zoom;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.005) {
      camera = targetCamera;
      targetCamera = null;
    }
    if (bandIndexFor(camera.zoom) !== prevBand) reproject('band-cross');
  }
```

- [ ] **Step 3: Hand-verify**

Run: `npm run dev`.
- Zoom out so supernodes appear.
- Double-click a supernode. The camera should animate inward, centered on that supernode. During the animation, the band threshold is crossed and the supernode unfolds into its children — you see the bloom.
- Double-click a leaf node (non-group): focus mode engages as before.
- Search for a function name at far zoom: it appears with the bloom transition, connected via aggregate edges. Clear search: it condenses back.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): supernode drill via dblclick + camera-lerp band-cross reproject

Double-clicking a supernode now animates the camera into the next
closer band, centered on the supernode. The lerp-driven zoom crossing
triggers reproject('band-cross'), so the supernode's children bloom
in place as the camera arrives. Leaf nodes' dblclick still engages
focus mode as before."
```

---

## Task 15: Documentation + final hand-verify

**Files:**
- Modify: `docs/architecture/graph-ui.md` — document the new modules + projection pipeline

- [ ] **Step 1: Update the architecture doc's module layout table**

Open `docs/architecture/graph-ui.md`. Find the "Module layout" section under "2D viewer". Replace the module table with:

```markdown
| Module | Owns | Pure? |
|---|---|---|
| `shared/state.js` | graph state + `applyMutation` | yes |
| `shared/colors.js` | palette + `lerpRGB` + `rgbString` | yes |
| `shared/shapes.js` | Canvas 2D shape primitives incl. rounded-rect + hull | yes (over a ctx) |
| `shared/sizing.js` | per-kind `{ world, min_px, max_px }` + `sizeAt(kind, zoom)` + edge stroke | yes |
| `shared/groups.js` | path + territory group derivation | yes |
| `shared/projection.js` | `project(state, inputs)` — LOD, aggregation, force-visible | yes |
| `shared/transitions.js` | projection-diff → enter/exit transition state | yes |
| `shared/layout.js` | d3-force config (reads sizing) | yes |
| `shared/animation.js` | hover + synapse state machine | yes |
| `shared/websocket.js` | reconnecting WS client | yes (over `WebSocket`) |
| `graph-viewer-2d.js` | DOM wiring + render loop + interaction | no (side-effectful entry) |
```

- [ ] **Step 2: Add a "Projection pipeline" section**

Append after the existing "Render loop" section in the 2D viewer docs:

```markdown
### Projection pipeline

The render loop does not read from `shared/state.js` directly. It reads from
the output of `project(state, { zoom, focus, filters, search })`, which
returns:

- `visibleNodes` — the leaves and synthesized group representatives to render + simulate
- `visibleEdges` — raw edges + aggregate edges for folded endpoints
- `groups` — emitted path groups + visible territory specs (for hull rendering)

`reproject(reason)` is the single choke point. It runs the projection,
checks whether the visible set changed (`projectionDeltaIsInteresting`),
and if so: feeds the sim, reheats alpha, and registers enter/exit
transitions for the deltas.

**Reheat triggers:**

| Event | `reason` | Alpha |
|---|---|---|
| Graph mutation | `mutation` | 0.3 |
| Kind filter toggle | `filter` | 0.3 |
| Search input (debounced 200ms) | `search` | 0.2 |
| Zoom crossing BAND_TABLE threshold | `band-cross` | 0.4 |
| Focus enter/exit | `focus-*` | 0.5 |

Pan, hover, selection, and intra-band zoom do *not* reheat.

**New-node positioning** inherits from parent: an entering leaf starts at
its path-group's centroid, an entering supernode starts at the centroid of
its (now-leaving) children. This turns what would be "positions re-rolled
by d3-force" into "emerging from where they belong."
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: everything passes.

- [ ] **Step 4: Hand-verify checklist (from spec §8)**

Run: `npm run dev`. Walk through each:

- [ ] Bloom on unfold (dblclick a supernode) + condense on fold (zoom out past threshold) look pleasant, not janky.
- [ ] Territory hull inflates smoothly as members move during reheat.
- [ ] Aggregate edge tooltip shows relation breakdown; stroke width reflects count.
- [ ] Selection ring persists through hover, search dim, focus changes.
- [ ] Search forces matches visible with aggregate edges to folded neighbors.
- [ ] Ambient breathing + decision-superseded synapses continue playing during all the above.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/graph-ui.md
git commit -m "docs: document projection pipeline and new viewer modules

Updates the 2D viewer module table with the four new pure modules
(sizing, groups, projection, transitions). Adds a Projection pipeline
section covering reheat triggers, new-node positioning, and the
single reproject() choke point."
```

---

## Self-review notes

**Spec coverage:**
- §1 Core architecture → Tasks 4, 8, 9 (projection + wire)
- §1 Selection as first-class state → Task 1
- §2 Grouping derivation → Task 3
- §2 Band table → Task 4 (BAND_TABLE constant)
- §3 Sizing + legibility floors → Task 2, Task 7, Task 10
- §4 Reheat model → Task 8 (`reproject` / `alphaFor`), Task 9 (trigger wiring)
- §4 New-node parent-centroid positioning → Task 8 (`applyEntryPositions`)
- §5 Supernode rendering → Task 10
- §5 Territory hulls → Task 11
- §5 Aggregate edges → Task 12
- §5 Selection visuals → Task 1 (base) + Task 10 (group variant)
- §5 Transitions → Task 5 (module) + Task 13 (render)
- §6 Navigation → Task 14 (supernode drill) + Task 9 (focus triggers)
- §7 Ambient undercurrent → preserved (no code changes needed; breathing + synapses continue)
- §8 Testing → Tasks 2-5 include unit tests; Tasks 7-15 include hand-verify steps

**Type consistency:** `project(state, inputs)` signature, `GroupSpec { id, kind, members, memberCount, ... }`, `TransitionState { transitions: Map }` used consistently across tasks.

**No placeholders:** every step has actual code/commands. No TODO/TBD.

**Commit cadence:** every task ends with a commit. 15 commits for the full plan.
