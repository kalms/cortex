# 2D Graph Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 2D graph viewer as the new default at `/viewer`, consuming `/api/graph` for hydration and `/ws` for live mutations. The existing 3D viewer moves to `/viewer/3d`. Nine-step ladder from static render to focus mode; each step independently shippable.

**Architecture:** Single-file ES-module entry (`src/viewer/graph-viewer-2d.js`) plus a `shared/` directory of focused modules. Canvas 2D rendering, d3-force for layout, reconnecting WebSocket client. No build step — d3-force loaded via ESM import map in the HTML. Pure modules (state, colors, shapes, layout, animation, websocket) are TDD'd in Vitest; rendering/interaction steps are hand-verified against the running dev server.

**Tech Stack:** Vanilla ES modules, Canvas 2D API, `d3-force` (CDN in browser + npm dev-dep for tests), Vitest.

**Related plans:**
- Plan A (shipped): [2026-04-17-graph-ui-backend.md](2026-04-17-graph-ui-backend.md)
- Plan C (future, not this plan): Activity stream + graph↔stream sync

**Spec:** [2026-04-17-graph-ui-and-activity-stream-design.md](../specs/2026-04-17-graph-ui-and-activity-stream-design.md), section "2D viewer (browser)".

---

## File Structure

**New source files:**

```
src/viewer/
  index.html                 NEW — 2D viewer page (replaces current; imports map + entry)
  graph-viewer-2d.js         NEW — entry: wires state, render loop, interaction
  shared/
    state.js                 NEW — pure graph state + applyMutation + hydrate
    colors.js                NEW — palette constants + lerpRGB + rgbString
    shapes.js                NEW — drawDiamond/Circle/Pill/Hex/Tri (canvas primitives)
    layout.js                NEW — d3-force config factory + per-kind sizing/charge/link tables
    animation.js             NEW — per-node/edge lerp state + synapse queue
    websocket.js             NEW — reconnecting client with heartbeat + backfill
  3d/
    index.html               MOVED from src/viewer/index.html
    graph-viewer.js          MOVED from src/viewer/graph-viewer.js
  style.css                  MODIFIED — shared base; adds 2D-specific classes
```

**New tests:**

```
tests/viewer/
  state.test.ts              applyMutation semantics, hydrate, edgeKey
  colors.test.ts             lerpRGB rounding + endpoints, rgbString formatting
  shapes.test.ts             each shape emits expected canvas calls (mock ctx)
  layout.test.ts             linkDistance / linkStrength / charge / nodeSize tables
  animation.test.ts          advance() lerps, setHover targets, synapse queue lifecycle
  websocket.test.ts          connect/hello, backfill dispatch, reconnect backoff, heartbeat, dedupe
```

**Modified source files:**

- `src/mcp-server/api.ts` — add `/viewer/3d/*` route; update default `/viewer` to serve new `index.html`
- `package.json` — add `d3-force` as devDependency (for Vitest imports; browser loads via CDN import map)
- `CLAUDE.md` — update "Viewer" pointer (`/viewer` = 2D, `/viewer/3d` = 3D)
- `docs/architecture/graph-ui.md` — append "2D viewer" section with module boundaries + render loop + extension recipes

---

### Task 1: Scaffolding — move 3D viewer and set up 2D route

**Files:**
- Move: `src/viewer/index.html` → `src/viewer/3d/index.html`
- Move: `src/viewer/graph-viewer.js` → `src/viewer/3d/graph-viewer.js`
- Create: `src/viewer/index.html` (new 2D page, placeholder entry)
- Create: `src/viewer/graph-viewer-2d.js` (placeholder entry)
- Modify: `src/mcp-server/api.ts`
- Test: manual (curl routes + open in browser)

- [ ] **Step 1: Move 3D files into subdirectory**

```bash
mkdir -p src/viewer/3d
git mv src/viewer/index.html src/viewer/3d/index.html
git mv src/viewer/graph-viewer.js src/viewer/3d/graph-viewer.js
```

- [ ] **Step 2: Fix the 3D page's own asset import for its new location**

Edit `src/viewer/3d/index.html` — change the inline script's `import("/viewer/graph-viewer.js")` to `import("/viewer/3d/graph-viewer.js")`. Also change `<link rel="stylesheet" href="/viewer/style.css">` — leave unchanged (style.css stays at `src/viewer/style.css`, served at `/viewer/style.css`).

- [ ] **Step 3: Create the new 2D index.html (placeholder)**

Write `src/viewer/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cortex — Graph</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/viewer/style.css">
  <script type="importmap">
    {
      "imports": {
        "d3-force": "https://esm.sh/d3-force@3.0.0"
      }
    }
  </script>
</head>
<body>
  <canvas id="graph"></canvas>
  <script type="module" src="/viewer/graph-viewer-2d.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create the new 2D entry placeholder**

Write `src/viewer/graph-viewer-2d.js`:

```js
// Entry for the 2D graph viewer. Built up across tasks in the plan.
console.log('cortex 2D viewer: hello');
```

- [ ] **Step 5: Update api.ts routing**

In `src/mcp-server/api.ts`, replace the current `/viewer` branch with:

```ts
      if (url === "/" || url.startsWith("/viewer")) {
        // Map URL → disk file under VIEWER_DIR.
        // /            → index.html (2D viewer, the new default)
        // /viewer      → index.html
        // /viewer/     → index.html
        // /viewer/3d   → 3d/index.html
        // /viewer/3d/  → 3d/index.html
        // /viewer/<p>  → <p>  (e.g., /viewer/graph-viewer-2d.js, /viewer/shared/state.js, /viewer/style.css, /viewer/3d/graph-viewer.js)
        let rel: string;
        if (url === "/" || url === "/viewer" || url === "/viewer/") {
          rel = "index.html";
        } else if (url === "/viewer/3d" || url === "/viewer/3d/") {
          rel = "3d/index.html";
        } else {
          rel = url.replace(/^\/viewer\//, "");
        }
        const filePath = join(VIEWER_DIR, rel);

        try {
          const content = await readFile(filePath);
          const ext = extname(filePath);
          res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Verify routing manually**

Run: `npm run dev` (background). Then in another shell:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3334/viewer
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3334/viewer/3d
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | head -2
curl -s http://localhost:3334/viewer/3d/graph-viewer.js | head -2
```

Expected: two `200`s, then the placeholder `console.log` line, then the first lines of the 3D viewer.

Kill the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/viewer/ src/mcp-server/api.ts
git commit -m "feat(viewer): scaffold 2D viewer route; move 3D viewer to /viewer/3d"
```

---

### Task 2: `shared/state.js` — pure graph state + mutation application

**Files:**
- Create: `src/viewer/shared/state.js`
- Test: `tests/viewer/state.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/viewer/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createGraphState,
  applyMutation,
  hydrate,
  edgeKey,
} from '../../src/viewer/shared/state.js';

describe('graph state', () => {
  it('creates empty state', () => {
    const s = createGraphState();
    expect(s.nodes.size).toBe(0);
    expect(s.edges.size).toBe(0);
    expect(s.version).toBe(0);
  });

  it('edgeKey is deterministic and relation-aware', () => {
    const a = edgeKey({ source_id: 'x', target_id: 'y', relation: 'CALLS' });
    const b = edgeKey({ source_id: 'x', target_id: 'y', relation: 'CALLS' });
    const c = edgeKey({ source_id: 'x', target_id: 'y', relation: 'IMPORTS' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('hydrate loads from /api/graph shape', () => {
    const s = createGraphState();
    hydrate(s, {
      nodes: [{ id: 'n1', kind: 'file', name: 'a.ts' }],
      edges: [{ source_id: 'n1', target_id: 'n2', relation: 'CALLS' }],
    });
    expect(s.nodes.get('n1').name).toBe('a.ts');
    expect(s.edges.size).toBe(1);
  });

  it('add_node inserts and bumps version', () => {
    const s = createGraphState();
    applyMutation(s, { op: 'add_node', node: { id: 'n1', kind: 'file', name: 'a.ts' } });
    expect(s.nodes.get('n1').name).toBe('a.ts');
    expect(s.version).toBe(1);
  });

  it('update_node merges fields on existing node, no-op on missing', () => {
    const s = createGraphState();
    s.nodes.set('n1', { id: 'n1', kind: 'file', name: 'a.ts' });
    applyMutation(s, { op: 'update_node', id: 'n1', fields: { name: 'a2.ts' } });
    expect(s.nodes.get('n1').name).toBe('a2.ts');
    expect(s.nodes.get('n1').kind).toBe('file');

    applyMutation(s, { op: 'update_node', id: 'missing', fields: { name: 'x' } });
    expect(s.nodes.has('missing')).toBe(false);
  });

  it('remove_node cascades to attached edges', () => {
    const s = createGraphState();
    s.nodes.set('n1', { id: 'n1', kind: 'file', name: 'a' });
    s.nodes.set('n2', { id: 'n2', kind: 'file', name: 'b' });
    s.edges.set(
      edgeKey({ source_id: 'n1', target_id: 'n2', relation: 'CALLS' }),
      { source_id: 'n1', target_id: 'n2', relation: 'CALLS' },
    );
    applyMutation(s, { op: 'remove_node', id: 'n1' });
    expect(s.nodes.has('n1')).toBe(false);
    expect(s.edges.size).toBe(0);
  });

  it('add_edge / remove_edge by (source,target,relation)', () => {
    const s = createGraphState();
    applyMutation(s, {
      op: 'add_edge',
      edge: { source_id: 'a', target_id: 'b', relation: 'CALLS' },
    });
    expect(s.edges.size).toBe(1);
    applyMutation(s, {
      op: 'remove_edge',
      source: 'a',
      target: 'b',
      relation: 'CALLS',
    });
    expect(s.edges.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/viewer/state.test.ts`
Expected: FAIL — `Cannot find module '.../state.js'`.

- [ ] **Step 3: Implement `src/viewer/shared/state.js`**

```js
/**
 * Pure graph state for the 2D viewer.
 *
 * State is a plain object with two Maps: `nodes` (id → WireNode) and `edges`
 * (edgeKey → WireEdge). `version` is incremented on every applyMutation call;
 * render-loop code can compare versions to decide whether a redraw is needed.
 *
 * This module has no DOM dependency; it is the unit-testable core of the viewer.
 */

export function createGraphState() {
  return {
    nodes: new Map(),
    edges: new Map(),
    version: 0,
  };
}

/**
 * Canonical key for an edge: source→target:relation. A node pair can have
 * multiple edges of different relations; the relation must be part of the key.
 */
export function edgeKey(edge) {
  return edge.source_id + '→' + edge.target_id + ':' + edge.relation;
}

/**
 * Seed state from a /api/graph response. Call once on boot, before the first
 * WS mutation is applied.
 */
export function hydrate(state, graph) {
  for (const node of graph.nodes) state.nodes.set(node.id, node);
  for (const edge of graph.edges) state.edges.set(edgeKey(edge), edge);
}

/**
 * Apply a single GraphMutation to state. Bumps `version` by one on every call,
 * including no-op updates (keeps downstream change-detection simple).
 */
export function applyMutation(state, m) {
  state.version++;
  switch (m.op) {
    case 'add_node':
      state.nodes.set(m.node.id, m.node);
      return;
    case 'update_node': {
      const existing = state.nodes.get(m.id);
      if (existing) state.nodes.set(m.id, { ...existing, ...m.fields });
      return;
    }
    case 'remove_node':
      state.nodes.delete(m.id);
      for (const [k, e] of state.edges) {
        if (e.source_id === m.id || e.target_id === m.id) state.edges.delete(k);
      }
      return;
    case 'add_edge':
      state.edges.set(edgeKey(m.edge), m.edge);
      return;
    case 'remove_edge':
      state.edges.delete(
        edgeKey({ source_id: m.source, target_id: m.target, relation: m.relation }),
      );
      return;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/state.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/state.js tests/viewer/state.test.ts
git commit -m "feat(viewer): pure graph state + applyMutation"
```

---

### Task 3: `shared/colors.js` — palette + lerpRGB

**Files:**
- Create: `src/viewer/shared/colors.js`
- Test: `tests/viewer/colors.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/viewer/colors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PALETTE_REST,
  PALETTE_HOVER,
  BACKGROUND,
  lerpRGB,
  rgbString,
} from '../../src/viewer/shared/colors.js';

describe('colors', () => {
  it('palettes define every known kind', () => {
    const kinds = ['decision', 'file', 'function', 'component', 'reference', 'path'];
    for (const k of kinds) {
      expect(PALETTE_REST[k]).toHaveLength(3);
      expect(PALETTE_HOVER[k]).toHaveLength(3);
    }
  });

  it('decision lavender at rest matches spec', () => {
    expect(PALETTE_REST.decision).toEqual([180, 160, 224]);
  });

  it('lerpRGB endpoints return endpoint colors', () => {
    expect(lerpRGB([0, 0, 0], [100, 200, 50], 0)).toEqual([0, 0, 0]);
    expect(lerpRGB([0, 0, 0], [100, 200, 50], 1)).toEqual([100, 200, 50]);
  });

  it('lerpRGB midpoint rounds componentwise', () => {
    expect(lerpRGB([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
  });

  it('rgbString defaults to alpha 1 and emits rgba()', () => {
    expect(rgbString([10, 20, 30])).toBe('rgba(10,20,30,1)');
    expect(rgbString([10, 20, 30], 0.5)).toBe('rgba(10,20,30,0.5)');
  });

  it('background constant is defined', () => {
    expect(BACKGROUND).toBe('#09090b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/colors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/viewer/shared/colors.js`**

```js
/**
 * Palette + color math for the 2D viewer.
 *
 * Rest palette is greyscale-except-decision (decision = lavender); hover palette
 * introduces per-kind accent colors. The renderer lerps between the two based
 * on each node's `colorMix` animation state.
 */

export const BACKGROUND = '#09090b';
export const SURFACE = '#0d0d0d';

export const PALETTE_REST = {
  decision:  [180, 160, 224],
  file:      [102, 102, 102],
  function:  [ 85,  85,  85],
  component: [ 85,  85,  85],
  reference: [ 68,  68,  68],
  path:      [ 51,  51,  51],
};

export const PALETTE_HOVER = {
  decision:  [190, 170, 235],
  file:      [140, 200, 210],
  function:  [130, 170, 140],
  component: [160, 140, 180],
  reference: [140, 130, 160],
  path:      [100, 100, 100],
};

/** Edge base alpha at rest and when endpoint is highlighted. */
export const EDGE_ALPHA = {
  GOVERNS:     { rest: 0.05,  hover: 0.35 },
  CALLS:       { rest: 0.05,  hover: 0.35 },
  IMPORTS:     { rest: 0.035, hover: 0.35 },
  SUPERSEDES:  { rest: 0.05,  hover: 0.35 },
  REFERENCES:  { rest: 0.05,  hover: 0.35 },
  'co-changed':{ rest: 0.02,  hover: 0.25 },
};

/** Component-wise integer linear interpolation between two RGB triples. */
export function lerpRGB(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Format a color for canvas fillStyle/strokeStyle. */
export function rgbString(rgb, alpha = 1) {
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/colors.test.ts`
Expected: 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/colors.js tests/viewer/colors.test.ts
git commit -m "feat(viewer): palette constants + lerpRGB"
```

---

### Task 4: `shared/shapes.js` — canvas drawing primitives

**Files:**
- Create: `src/viewer/shared/shapes.js`
- Test: `tests/viewer/shapes.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/viewer/shapes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  drawDiamond,
  drawCircle,
  drawPill,
  drawHex,
  drawTri,
  drawStrike,
} from '../../src/viewer/shared/shapes.js';

function mockCtx() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (n: string) => (...args: unknown[]) => { calls.push([n, ...args]); };
  const ctx = {
    calls,
    beginPath: rec('beginPath'),
    moveTo:    rec('moveTo'),
    lineTo:    rec('lineTo'),
    closePath: rec('closePath'),
    arc:       rec('arc'),
    fill:      rec('fill'),
    stroke:    rec('stroke'),
    save:      rec('save'),
    restore:   rec('restore'),
    translate: rec('translate'),
    rotate:    rec('rotate'),
    _fill: '', _stroke: '', _lw: 0,
    set fillStyle(v: string)   { this._fill   = v; calls.push(['fillStyle=', v]); },
    set strokeStyle(v: string) { this._stroke = v; calls.push(['strokeStyle=', v]); },
    set lineWidth(v: number)   { this._lw     = v; calls.push(['lineWidth=', v]); },
  };
  return ctx;
}

describe('shapes', () => {
  it('drawCircle: arc + fill', () => {
    const ctx = mockCtx();
    drawCircle(ctx as any, 10, 20, 5, 'rgba(1,1,1,1)');
    const names = ctx.calls.map(c => c[0]);
    expect(names).toContain('arc');
    expect(names).toContain('fill');
    expect(ctx._fill).toBe('rgba(1,1,1,1)');
  });

  it('drawDiamond: 4 lineTo calls + closePath', () => {
    const ctx = mockCtx();
    drawDiamond(ctx as any, 0, 0, 8, 'rgba(180,160,224,1)');
    const lineTos = ctx.calls.filter(c => c[0] === 'lineTo');
    expect(lineTos.length).toBe(3); // moveTo + 3 lineTo + closePath = 4 vertices
    expect(ctx.calls.some(c => c[0] === 'closePath')).toBe(true);
  });

  it('drawHex: 5 lineTo calls + closePath (6 vertices)', () => {
    const ctx = mockCtx();
    drawHex(ctx as any, 0, 0, 5, 'rgba(68,68,68,1)');
    const lineTos = ctx.calls.filter(c => c[0] === 'lineTo');
    expect(lineTos.length).toBe(5);
  });

  it('drawTri: 2 lineTo calls + closePath (3 vertices)', () => {
    const ctx = mockCtx();
    drawTri(ctx as any, 0, 0, 4, 'rgba(51,51,51,1)');
    const lineTos = ctx.calls.filter(c => c[0] === 'lineTo');
    expect(lineTos.length).toBe(2);
  });

  it('drawPill: two arcs (caps) + lineTos (sides)', () => {
    const ctx = mockCtx();
    drawPill(ctx as any, 0, 0, 4, 'rgba(85,85,85,1)');
    const arcs = ctx.calls.filter(c => c[0] === 'arc');
    expect(arcs.length).toBe(2);
    expect(ctx.calls.some(c => c[0] === 'fill')).toBe(true);
  });

  it('drawStrike: diagonal line across node', () => {
    const ctx = mockCtx();
    drawStrike(ctx as any, 0, 0, 8, 'rgba(255,255,255,0.6)');
    expect(ctx.calls.some(c => c[0] === 'moveTo')).toBe(true);
    expect(ctx.calls.some(c => c[0] === 'lineTo')).toBe(true);
    expect(ctx.calls.some(c => c[0] === 'stroke')).toBe(true);
  });

  it('fillStyle is set before fill()', () => {
    const ctx = mockCtx();
    drawCircle(ctx as any, 0, 0, 3, 'rgba(1,2,3,0.4)');
    const fillIdx = ctx.calls.findIndex(c => c[0] === 'fill');
    const fillStyleIdx = ctx.calls.findIndex(c => c[0] === 'fillStyle=');
    expect(fillStyleIdx).toBeGreaterThanOrEqual(0);
    expect(fillStyleIdx).toBeLessThan(fillIdx);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/shapes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/viewer/shared/shapes.js`**

```js
/**
 * Canvas 2D drawing primitives for the six node kinds + strike-through overlay.
 *
 * All functions accept (ctx, x, y, r, fillStyle) with an optional `strokeStyle`;
 * they do not set lineWidth (caller decides) except drawStrike which sets 1px.
 * r is the bounding radius; each shape interprets it in a way that gives
 * visually comparable areas.
 */

export function drawCircle(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawDiamond(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x,     y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x,     y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawHex(ctx, x, y, r, fill, stroke) {
  // Flat-top hexagon, 6 vertices.
  ctx.beginPath();
  const angleOffset = Math.PI / 6;
  for (let i = 0; i < 6; i++) {
    const a = angleOffset + i * (Math.PI / 3);
    const vx = x + r * Math.cos(a);
    const vy = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawTri(ctx, x, y, r, fill, stroke) {
  // Equilateral, pointing up. 3 vertices.
  ctx.beginPath();
  ctx.moveTo(x,           y - r);
  ctx.lineTo(x + r * 0.866, y + r * 0.5);
  ctx.lineTo(x - r * 0.866, y + r * 0.5);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawPill(ctx, x, y, r, fill, stroke) {
  // Horizontal pill, width 1.8r, height r.
  const halfW = r * 0.9;  // 1.8r / 2
  const halfH = r * 0.5;
  ctx.beginPath();
  ctx.arc(x - halfW + halfH, y, halfH, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.lineTo(x + halfW - halfH, y - halfH);
  ctx.arc(x + halfW - halfH, y, halfH, (3 * Math.PI) / 2, Math.PI / 2);
  ctx.lineTo(x - halfW + halfH, y + halfH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

/**
 * Diagonal strike line across a node (used for superseded decisions).
 */
export function drawStrike(ctx, x, y, r, stroke) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

/** Dispatcher. kind → draw function. */
export const SHAPE_FOR_KIND = {
  decision:  drawDiamond,
  file:      drawCircle,
  function:  drawCircle,
  component: drawPill,
  reference: drawHex,
  path:      drawTri,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/shapes.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/shapes.js tests/viewer/shapes.test.ts
git commit -m "feat(viewer): canvas drawing primitives for node shapes"
```

---

### Task 5: `shared/layout.js` — d3-force config factory

**Files:**
- Create: `src/viewer/shared/layout.js`
- Modify: `package.json`
- Test: `tests/viewer/layout.test.ts`

- [ ] **Step 1: Install d3-force as a dev dependency**

`d3-force` is loaded via ESM import map in the browser (no bundling). Tests run in Node and need the installed package. Add it as a devDependency so it does not ship to the built dist but is available to Vitest.

Run: `npm install --save-dev d3-force@^3.0.0`

- [ ] **Step 2: Write the failing tests**

Write `tests/viewer/layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  nodeSize,
  nodeCharge,
  linkDistance,
  linkStrength,
  createSimulation,
} from '../../src/viewer/shared/layout.js';

describe('layout', () => {
  describe('nodeSize', () => {
    it('returns per-kind radii', () => {
      expect(nodeSize('decision')).toBeGreaterThanOrEqual(7);
      expect(nodeSize('decision')).toBeLessThanOrEqual(8);
      expect(nodeSize('file')).toBeGreaterThanOrEqual(4);
      expect(nodeSize('file')).toBeLessThanOrEqual(6);
      expect(nodeSize('function')).toBeGreaterThanOrEqual(2);
      expect(nodeSize('function')).toBeLessThanOrEqual(3);
    });

    it('falls back for unknown kinds', () => {
      expect(nodeSize('unknown')).toBeGreaterThan(0);
    });
  });

  describe('nodeCharge', () => {
    it('decisions repel more than files, files more than functions', () => {
      expect(Math.abs(nodeCharge({ kind: 'decision' })))
        .toBeGreaterThan(Math.abs(nodeCharge({ kind: 'file' })));
      expect(Math.abs(nodeCharge({ kind: 'file' })))
        .toBeGreaterThan(Math.abs(nodeCharge({ kind: 'function' })));
    });

    it('returns negative (repulsive) values per spec', () => {
      expect(nodeCharge({ kind: 'decision' })).toBeLessThan(0);
      expect(nodeCharge({ kind: 'file' })).toBeLessThan(0);
    });
  });

  describe('linkDistance', () => {
    it('GOVERNS shorter than CALLS, CALLS shorter than IMPORTS, IMPORTS shorter than co-changed', () => {
      const g = linkDistance({ relation: 'GOVERNS' });
      const c = linkDistance({ relation: 'CALLS' });
      const i = linkDistance({ relation: 'IMPORTS' });
      const cc = linkDistance({ relation: 'co-changed' });
      expect(g).toBeLessThanOrEqual(c);
      expect(c).toBeLessThan(i);
      expect(i).toBeLessThan(cc);
    });

    it('has a fallback for unknown relations', () => {
      expect(linkDistance({ relation: 'UNKNOWN' })).toBeGreaterThan(0);
    });
  });

  describe('linkStrength', () => {
    it('GOVERNS strongest, co-changed weakest', () => {
      expect(linkStrength({ relation: 'GOVERNS' }))
        .toBeGreaterThan(linkStrength({ relation: 'CALLS' }));
      expect(linkStrength({ relation: 'co-changed' }))
        .toBeLessThan(linkStrength({ relation: 'IMPORTS' }));
    });
  });

  describe('createSimulation', () => {
    it('returns a running d3 simulation with configured forces', () => {
      const sim = createSimulation();
      expect(sim.force('link')).toBeTruthy();
      expect(sim.force('charge')).toBeTruthy();
      expect(sim.force('center')).toBeTruthy();
      expect(sim.force('collide')).toBeTruthy();
      sim.stop();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/viewer/shared/layout.js`**

```js
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from 'd3-force';

/**
 * d3-force configuration for the 2D graph viewer.
 *
 * Pure tables for kind → size / charge and relation → distance / strength are
 * exported so the render loop can use them directly and tests can assert
 * their contents. `createSimulation()` wires them into a running simulation.
 */

const SIZE = {
  decision: 7.5,
  file: 5,
  function: 2.5,
  component: 4.5,
  reference: 4.5,
  path: 3.5,
};

const CHARGE = {
  decision: -300,
  file: -100,
  function: -50,
  component: -50,
  reference: -50,
  path: -30,
};

const LINK_DIST = {
  GOVERNS: 70,
  CALLS: 80,
  IMPORTS: 100,
  SUPERSEDES: 60,
  REFERENCES: 100,
  'co-changed': 200,
};

const LINK_STR = {
  GOVERNS: 0.8,
  CALLS: 0.5,
  IMPORTS: 0.4,
  SUPERSEDES: 0.6,
  REFERENCES: 0.4,
  'co-changed': 0.1,
};

export function nodeSize(kind) {
  return SIZE[kind] ?? 4;
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

/**
 * Build a running d3 simulation, forces pre-configured.
 * Call `.nodes(...)` and `.force('link').links(...)` on the returned sim
 * after hydrating graph state.
 */
export function createSimulation() {
  return forceSimulation()
    .force('link',   forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge', forceManyBody().strength(nodeCharge))
    .force('center', forceCenter(0, 0).strength(0.03))
    .force('collide', forceCollide().radius(n => nodeSize(n.kind) + 4))
    .alpha(1);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/layout.test.ts`
Expected: 8 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts package.json package-lock.json
git commit -m "feat(viewer): d3-force config factory + per-kind/relation tables"
```

---

### Task 6: Ladder step 1 — static render

**Files:**
- Modify: `src/viewer/index.html` (add import map for d3-force already in place; no change needed)
- Modify: `src/viewer/graph-viewer-2d.js` (first real implementation)
- Modify: `src/viewer/style.css`
- Test: manual via `npm run dev` + browser

- [ ] **Step 1: Add canvas styling**

Append to `src/viewer/style.css`:

```css
/* -- 2D viewer canvas -- */
#graph {
  display: block;
  background: #09090b;
  width: 100vw;
  height: 100vh;
  touch-action: none;
}
```

- [ ] **Step 2: Implement static render in `graph-viewer-2d.js`**

Replace the placeholder with:

```js
import { createGraphState, hydrate } from '/viewer/shared/state.js';
import { SHAPE_FOR_KIND } from '/viewer/shared/shapes.js';
import { PALETTE_REST, rgbString, BACKGROUND } from '/viewer/shared/colors.js';
import { nodeSize } from '/viewer/shared/layout.js';

const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
const DPR = window.devicePixelRatio || 1;

function resize() {
  canvas.width = canvas.clientWidth * DPR;
  canvas.height = canvas.clientHeight * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const state = createGraphState();
window.__cortex_viewer_state = state;  // hook for tests / debugging

const graph = await fetch('/api/graph').then(r => r.json());
hydrate(state, graph);

// Deterministic pseudo-random layout for static step 1 — replaced by d3-force next task.
let i = 0;
for (const node of state.nodes.values()) {
  const angle = (i * 137.5) * (Math.PI / 180);      // golden-angle spread
  const radius = 30 + Math.sqrt(i) * 30;
  node.x = Math.cos(angle) * radius;
  node.y = Math.sin(angle) * radius;
  i++;
}

function worldToScreen(x, y) {
  return [x + canvas.clientWidth / 2, y + canvas.clientHeight / 2];
}

function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  // Edges: 0.5px white lines at low alpha.
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (const edge of state.edges.values()) {
    const a = state.nodes.get(edge.source_id);
    const b = state.nodes.get(edge.target_id);
    if (!a || !b) continue;
    const [ax, ay] = worldToScreen(a.x, a.y);
    const [bx, by] = worldToScreen(b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // Nodes: filled shape per kind.
  for (const node of state.nodes.values()) {
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const color = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const [sx, sy] = worldToScreen(node.x, node.y);
    shape(ctx, sx, sy, nodeSize(node.kind), rgbString(color, 1));
  }
}

draw();
```

- [ ] **Step 3: Verify manually in the browser**

Run: `npm run dev` (background).
Open: `http://localhost:3334/viewer` in the browser.
Expected: dark canvas fills the window; nodes are drawn as their correct shapes (decisions as lavender diamonds, files as circles, etc.) in a spiral-ish pattern; thin faint edges connect them.

Also verify: `http://localhost:3334/viewer/3d` — the old 3D viewer still loads.

Check browser DevTools Console — no errors.

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js src/viewer/style.css
git commit -m "feat(viewer): static render — shapes + edges from /api/graph"
```

---

### Task 7: Ladder step 2 — force sim + ambient breathing

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual

- [ ] **Step 1: Wire d3-force simulation and render loop**

Replace the body of `graph-viewer-2d.js` after the `hydrate(state, graph)` call (delete the deterministic seeding loop + the one-off `draw()` call) with:

```js
import { createSimulation } from '/viewer/shared/layout.js';

const simulation = createSimulation()
  .nodes([...state.nodes.values()])
  .on('tick', () => {}); // render loop drives redraw, not d3
simulation.force('link').links([...state.edges.values()].map(e => ({
  source: e.source_id,
  target: e.target_id,
  relation: e.relation,
})));

// Ambient breathing: tiny sinusoidal velocity injection so the graph never
// fully stills. Damping 0.92 keeps it from accelerating.
function applyBreathing(t) {
  for (const node of state.nodes.values()) {
    node.vx = (node.vx || 0) * 0.92 + Math.sin(t * 0.008 + node.x * 0.01) * 0.0015;
    node.vy = (node.vy || 0) * 0.92 + Math.cos(t * 0.006 + node.y * 0.01) * 0.0015;
  }
}

let rafHandle = 0;
function frame(t) {
  simulation.tick();
  applyBreathing(t);
  draw();
  rafHandle = requestAnimationFrame(frame);
}
rafHandle = requestAnimationFrame(frame);
```

Remove the `let i = 0; for (...) { node.x = ... }` seeding block above it (the simulation will place nodes itself).

- [ ] **Step 2: Verify manually**

Run: `npm run dev`.
Expected: nodes animate from origin outward as forces stabilize; edges visibly settle into distances-by-relation. After ~2s the layout is roughly equilibrium. Micro-motion (breathing) continues indefinitely — nothing ever fully freezes.

Watch DevTools Performance tab briefly (or just "feels" test): should hit 60fps at current graph size.

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): force simulation + ambient breathing"
```

---

### Task 8: `shared/animation.js` — hover + synapse state machine

**Files:**
- Create: `src/viewer/shared/animation.js`
- Test: `tests/viewer/animation.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/viewer/animation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createAnimState,
  advance,
  setHover,
  clearHover,
  triggerSynapse,
  LERP_FACTOR,
} from '../../src/viewer/shared/animation.js';

describe('animation', () => {
  it('createAnimState returns empty maps', () => {
    const a = createAnimState();
    expect(a.nodes.size).toBe(0);
    expect(a.edges.size).toBe(0);
    expect(a.synapses.length).toBe(0);
  });

  it('setHover marks hovered node highlight=1, neighbors 0.6, others 0', () => {
    const a = createAnimState();
    setHover(a, 'n1', new Set(['n2', 'n3']));
    expect(a.nodes.get('n1').targetHighlight).toBe(1);
    expect(a.nodes.get('n2').targetHighlight).toBe(0.6);
    expect(a.nodes.get('n3').targetHighlight).toBe(0.6);
  });

  it('clearHover zeros all targets', () => {
    const a = createAnimState();
    setHover(a, 'n1', new Set(['n2']));
    clearHover(a);
    expect(a.nodes.get('n1').targetHighlight).toBe(0);
    expect(a.nodes.get('n2').targetHighlight).toBe(0);
  });

  it('advance lerps highlight toward target', () => {
    const a = createAnimState();
    setHover(a, 'n1', new Set());
    const before = a.nodes.get('n1').highlight;
    advance(a, 1);
    const after = a.nodes.get('n1').highlight;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1);
    // After many frames, highlight approaches 1.
    for (let i = 0; i < 60; i++) advance(a, 1);
    expect(a.nodes.get('n1').highlight).toBeGreaterThan(0.95);
  });

  it('LERP_FACTOR is a small positive fraction', () => {
    expect(LERP_FACTOR).toBeGreaterThan(0);
    expect(LERP_FACTOR).toBeLessThan(1);
  });

  it('triggerSynapse appends an entry with expected shape', () => {
    const a = createAnimState();
    triggerSynapse(a, { kind: 'ring', nodeId: 'n1', duration: 60 });
    expect(a.synapses.length).toBe(1);
    expect(a.synapses[0].age).toBe(0);
    expect(a.synapses[0].kind).toBe('ring');
    expect(a.synapses[0].nodeId).toBe('n1');
  });

  it('advance increments synapse age and prunes expired entries', () => {
    const a = createAnimState();
    triggerSynapse(a, { kind: 'ring', nodeId: 'n1', duration: 3 });
    advance(a, 1);
    expect(a.synapses[0].age).toBe(1);
    advance(a, 1);
    advance(a, 1);
    advance(a, 1);
    expect(a.synapses.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/animation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/viewer/shared/animation.js`**

```js
/**
 * Hover + synapse animation state machine for the 2D viewer.
 *
 * Per-node state:    { highlight, colorMix, targetHighlight, targetColorMix }
 * Per-edge state:    { highlight, targetHighlight }
 * Synapses:          [{ kind, nodeId?, edgeKey?, age, duration, ...data }]
 *
 * `advance(state, dtFrames)` is called every render frame. It lerps current
 * values toward targets and ages synapses; expired synapses are pruned.
 * Rendering reads highlight / colorMix / age-based values directly.
 */

export const LERP_FACTOR = 0.12; // per frame; ~7 frames to 50%, ~20 to 95%.

export function createAnimState() {
  return {
    nodes: new Map(),
    edges: new Map(),
    synapses: [],
  };
}

function getOrInitNode(state, id) {
  let n = state.nodes.get(id);
  if (!n) {
    n = { highlight: 0, colorMix: 0, targetHighlight: 0, targetColorMix: 0 };
    state.nodes.set(id, n);
  }
  return n;
}

function getOrInitEdge(state, key) {
  let e = state.edges.get(key);
  if (!e) {
    e = { highlight: 0, targetHighlight: 0 };
    state.edges.set(key, e);
  }
  return e;
}

/**
 * On hover: hovered node full intensity, neighbors partial, everything else
 * relaxed. Call from pointermove.
 */
export function setHover(state, hoveredId, neighborIds) {
  // First, reset every existing entry to 0.
  for (const n of state.nodes.values()) {
    n.targetHighlight = 0;
    n.targetColorMix = 0;
  }
  const h = getOrInitNode(state, hoveredId);
  h.targetHighlight = 1;
  h.targetColorMix = 1;
  for (const id of neighborIds) {
    const n = getOrInitNode(state, id);
    n.targetHighlight = 0.6;
    n.targetColorMix = 1;
  }
}

export function setEdgeHover(state, edgeKeys) {
  for (const e of state.edges.values()) e.targetHighlight = 0;
  for (const k of edgeKeys) {
    const e = getOrInitEdge(state, k);
    e.targetHighlight = 1;
  }
}

export function clearHover(state) {
  for (const n of state.nodes.values()) {
    n.targetHighlight = 0;
    n.targetColorMix = 0;
  }
  for (const e of state.edges.values()) {
    e.targetHighlight = 0;
  }
}

/**
 * Trigger a synapse. kind ∈ 'ring' | 'pulse' | 'fade' | 'strike'.
 * `duration` in frames. Extra fields (e.g., edgeKey for pulse) are preserved.
 */
export function triggerSynapse(state, synapse) {
  state.synapses.push({ ...synapse, age: 0 });
}

/**
 * Lerp highlight/colorMix toward target, advance synapse ages, prune expired.
 * `dtFrames` is always 1 in practice (frame-paced); the parameter exists for
 * dt-independent pacing if we later switch to variable-step.
 */
export function advance(state, dtFrames) {
  const f = LERP_FACTOR * dtFrames;
  for (const n of state.nodes.values()) {
    n.highlight += (n.targetHighlight - n.highlight) * f;
    n.colorMix  += (n.targetColorMix  - n.colorMix)  * f;
  }
  for (const e of state.edges.values()) {
    e.highlight += (e.targetHighlight - e.highlight) * f;
  }
  for (const s of state.synapses) s.age += dtFrames;
  // Prune.
  let w = 0;
  for (let r = 0; r < state.synapses.length; r++) {
    const s = state.synapses[r];
    if (s.age < s.duration) state.synapses[w++] = s;
  }
  state.synapses.length = w;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/animation.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/animation.js tests/viewer/animation.test.ts
git commit -m "feat(viewer): hover + synapse animation state machine"
```

---

### Task 9: Ladder step 3 — hover lerp + tooltip

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Modify: `src/viewer/index.html` (add tooltip element)
- Modify: `src/viewer/style.css`
- Test: manual

- [ ] **Step 1: Add tooltip DOM + styling**

Edit `src/viewer/index.html`, add inside `<body>` before the `<script>` tag:

```html
<div id="tooltip"></div>
```

Append to `src/viewer/style.css`:

```css
/* -- Tooltip -- */
#tooltip {
  position: fixed;
  pointer-events: none;
  background: rgba(13, 13, 13, 0.92);
  border: 1px solid #222;
  color: #ccc;
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 3px;
  z-index: 30;
  opacity: 0;
  transition: opacity 0.12s ease;
  white-space: nowrap;
}
#tooltip.show { opacity: 1; }
```

- [ ] **Step 2: Rewrite render loop with hover + lerp**

Replace `graph-viewer-2d.js` render logic with:

```js
import { createGraphState, hydrate, edgeKey } from '/viewer/shared/state.js';
import { SHAPE_FOR_KIND, drawStrike } from '/viewer/shared/shapes.js';
import {
  PALETTE_REST,
  PALETTE_HOVER,
  EDGE_ALPHA,
  lerpRGB,
  rgbString,
  BACKGROUND,
} from '/viewer/shared/colors.js';
import { nodeSize, createSimulation } from '/viewer/shared/layout.js';
import {
  createAnimState,
  advance,
  setHover,
  setEdgeHover,
  clearHover,
} from '/viewer/shared/animation.js';

const canvas = document.getElementById('graph');
const tooltip = document.getElementById('tooltip');
const ctx = canvas.getContext('2d');
const DPR = window.devicePixelRatio || 1;

function resize() {
  canvas.width = canvas.clientWidth * DPR;
  canvas.height = canvas.clientHeight * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const state = createGraphState();
const anim = createAnimState();
window.__cortex_viewer_state = state;
window.__cortex_viewer_anim = anim;

const graph = await fetch('/api/graph').then(r => r.json());
hydrate(state, graph);

const simulation = createSimulation()
  .nodes([...state.nodes.values()])
  .on('tick', () => {});
simulation.force('link').links([...state.edges.values()].map(e => ({
  source: e.source_id,
  target: e.target_id,
  relation: e.relation,
})));

// --- Neighbor index --- rebuild whenever edges change.
let neighborsOf = new Map();
function rebuildNeighbors() {
  neighborsOf = new Map();
  for (const edge of state.edges.values()) {
    if (!neighborsOf.has(edge.source_id)) neighborsOf.set(edge.source_id, new Set());
    if (!neighborsOf.has(edge.target_id)) neighborsOf.set(edge.target_id, new Set());
    neighborsOf.get(edge.source_id).add(edge.target_id);
    neighborsOf.get(edge.target_id).add(edge.source_id);
  }
}
rebuildNeighbors();

// --- Hover detection ---
let hoveredId = null;
canvas.addEventListener('pointermove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left - rect.width / 2;
  const my = ev.clientY - rect.top  - rect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - mx;
    const dy = (node.y ?? 0) - my;
    const d = dx * dx + dy * dy;
    const r = nodeSize(node.kind) + 3;
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  if (best && best.id !== hoveredId) {
    hoveredId = best.id;
    const ns = neighborsOf.get(best.id) || new Set();
    setHover(anim, best.id, ns);
    const keys = new Set();
    for (const edge of state.edges.values()) {
      if (edge.source_id === best.id || edge.target_id === best.id) {
        keys.add(edgeKey(edge));
      }
    }
    setEdgeHover(anim, keys);
    tooltip.textContent = best.name;
    tooltip.classList.add('show');
  } else if (!best && hoveredId) {
    hoveredId = null;
    clearHover(anim);
    tooltip.classList.remove('show');
  }
  tooltip.style.left = (ev.clientX + 14) + 'px';
  tooltip.style.top  = (ev.clientY + 14) + 'px';
});

canvas.addEventListener('pointerleave', () => {
  hoveredId = null;
  clearHover(anim);
  tooltip.classList.remove('show');
});

// --- Render ---
function worldToScreen(x, y) {
  return [x + canvas.clientWidth / 2, y + canvas.clientHeight / 2];
}

function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.lineWidth = 0.5;
  for (const edge of state.edges.values()) {
    const a = state.nodes.get(edge.source_id);
    const b = state.nodes.get(edge.target_id);
    if (!a || !b) continue;
    const eKey = edgeKey(edge);
    const alphaSpec = EDGE_ALPHA[edge.relation] || EDGE_ALPHA.CALLS;
    const eAnim = anim.edges.get(eKey);
    const h = eAnim ? eAnim.highlight : 0;
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * h;
    ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
    const [ax, ay] = worldToScreen(a.x ?? 0, a.y ?? 0);
    const [bx, by] = worldToScreen(b.x ?? 0, b.y ?? 0);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  for (const node of state.nodes.values()) {
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const hover = PALETTE_HOVER[node.kind] || PALETTE_HOVER.file;
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };

    const rgb = lerpRGB(base, hover, nAnim.colorMix);

    // Status: 'proposed' / 'superseded' → 40% base opacity.
    const statusAlpha = node.status === 'proposed' || node.status === 'superseded' ? 0.4 : 1.0;
    // Hover dims non-highlighted to 50% of base, highlighted nodes to base+0.25.
    const restAlpha  = statusAlpha * 0.5;
    const hoverAlpha = Math.min(1, statusAlpha + 0.25);
    // If nothing is hovered (noone highlighted), use statusAlpha directly.
    const alpha = hoveredId === null
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * nAnim.highlight;

    const r = nodeSize(node.kind) * (1 + nAnim.highlight * 0.15);
    const [sx, sy] = worldToScreen(node.x ?? 0, node.y ?? 0);
    shape(ctx, sx, sy, r, rgbString(rgb, alpha));
    if (node.status === 'superseded') {
      drawStrike(ctx, sx, sy, r, 'rgba(255,255,255,' + (alpha * 0.8) + ')');
    }
  }
}

function applyBreathing(t) {
  for (const node of state.nodes.values()) {
    node.vx = (node.vx || 0) * 0.92 + Math.sin(t * 0.008 + (node.x || 0) * 0.01) * 0.0015;
    node.vy = (node.vy || 0) * 0.92 + Math.cos(t * 0.006 + (node.y || 0) * 0.01) * 0.0015;
  }
}

function frame(t) {
  simulation.tick();
  applyBreathing(t);
  advance(anim, 1);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

- [ ] **Step 2: Verify manually**

Run: `npm run dev`.
Open: `http://localhost:3334/viewer`.
Expected:
- Hovering a node brightens it, colorizes it to its hover palette, subtly grows it
- Its neighbors brighten to 60%, everything else dims to 50%
- Connected edges brighten to 35% alpha
- A tooltip with the node's `name` follows the cursor
- Transitions are smooth (~200ms ease, not instant)
- Leaving the canvas or hovering empty space restores everything to rest state

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js src/viewer/index.html src/viewer/style.css
git commit -m "feat(viewer): hover lerp + neighbor highlight + tooltip"
```

---

### Task 10: `shared/websocket.js` — reconnecting WebSocket client

**Files:**
- Create: `src/viewer/shared/websocket.js`
- Test: `tests/viewer/websocket.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/viewer/websocket.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWsClient, BACKOFF_MS, HEARTBEAT_MS } from '../../src/viewer/shared/websocket.js';

class MockWS {
  static instances: MockWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

beforeEach(() => {
  MockWS.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('websocket client', () => {
  it('exposes BACKOFF_MS 1s/2s/4s/... capped at 30s', () => {
    expect(BACKOFF_MS[0]).toBe(1000);
    expect(BACKOFF_MS[1]).toBe(2000);
    expect(BACKOFF_MS[2]).toBe(4000);
    expect(BACKOFF_MS[BACKOFF_MS.length - 1]).toBe(30000);
  });

  it('HEARTBEAT_MS is 30 seconds', () => {
    expect(HEARTBEAT_MS).toBe(30000);
  });

  it('dispatches hello, event, mutation, backfill_page to callbacks', () => {
    const onHello = vi.fn();
    const onEvent = vi.fn();
    const onMutation = vi.fn();
    const onBackfill = vi.fn();
    createWsClient({ url: 'ws://x/ws', onHello, onEvent, onMutation, onBackfill });
    const ws = MockWS.instances[0]!;
    ws.open();
    ws.receive({ type: 'hello', project_id: 'p', server_version: '1' });
    ws.receive({ type: 'event', event: { id: 'e1' } });
    ws.receive({ type: 'mutation', mutation: { op: 'add_node', node: { id: 'n' } } });
    ws.receive({ type: 'backfill_page', events: [{ id: 'e0' }], mutations: [], has_more: false });
    expect(onHello).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({ id: 'e1' });
    expect(onMutation).toHaveBeenCalled();
    expect(onBackfill).toHaveBeenCalled();
  });

  it('dedupes events by id', () => {
    const onEvent = vi.fn();
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent, onMutation: () => {}, onBackfill: () => {} });
    const ws = MockWS.instances[0]!;
    ws.open();
    ws.receive({ type: 'event', event: { id: 'same' } });
    ws.receive({ type: 'event', event: { id: 'same' } });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('sends ping every HEARTBEAT_MS', () => {
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent: () => {}, onMutation: () => {}, onBackfill: () => {} });
    const ws = MockWS.instances[0]!;
    ws.open();
    expect(ws.sent.length).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(JSON.parse(ws.sent[0]!).type).toBe('ping');
  });

  it('reconnects with backoff after close', () => {
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent: () => {}, onMutation: () => {}, onBackfill: () => {} });
    const ws1 = MockWS.instances[0]!;
    ws1.open();
    ws1.close();
    expect(MockWS.instances.length).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(MockWS.instances.length).toBe(2);
  });

  it('sends backfill with before_id = last seen on reconnect', () => {
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent: () => {}, onMutation: () => {}, onBackfill: () => {} });
    const ws1 = MockWS.instances[0]!;
    ws1.open();
    ws1.receive({ type: 'event', event: { id: 'latest-id' } });
    ws1.close();
    vi.advanceTimersByTime(1000);
    const ws2 = MockWS.instances[1]!;
    ws2.open();
    const backfillMsg = ws2.sent.map(s => JSON.parse(s)).find(m => m.type === 'backfill');
    expect(backfillMsg).toBeTruthy();
    expect(backfillMsg.before_id).toBe('latest-id');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/websocket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/viewer/shared/websocket.js`**

```js
/**
 * Reconnecting WebSocket client for the 2D viewer.
 *
 * Responsibilities:
 *  - Open a WS connection; re-open with exponential backoff on close.
 *  - Dispatch incoming server messages to per-type callbacks.
 *  - Heartbeat: ping every 30s. Server replies with pong; if we miss responses
 *    (closes), backoff-reconnect.
 *  - On reconnect, send a `backfill` with `before_id = lastSeenEventId` so the
 *    client catches up on events missed during the outage.
 *  - Dedupe events by `id` (server may re-send during backfill).
 */

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const HEARTBEAT_MS = 30000;

export function createWsClient({ url, onHello, onEvent, onMutation, onBackfill }) {
  let ws = null;
  let attempt = 0;
  let heartbeatTimer = 0;
  let reconnectTimer = 0;
  let lastSeenId = null;
  const seen = new Set();

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      if (lastSeenId) {
        ws.send(JSON.stringify({ type: 'backfill', before_id: lastSeenId, limit: 50 }));
      }
      scheduleHeartbeat();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'hello': onHello(msg); return;
        case 'event': {
          if (msg.event && !seen.has(msg.event.id)) {
            seen.add(msg.event.id);
            lastSeenId = msg.event.id;
            onEvent(msg.event);
          }
          return;
        }
        case 'mutation': onMutation(msg.mutation); return;
        case 'backfill_page': {
          for (const e of msg.events) {
            if (!seen.has(e.id)) {
              seen.add(e.id);
              if (!lastSeenId || e.id > lastSeenId) lastSeenId = e.id;
              onEvent(e);
            }
          }
          onBackfill(msg);
          return;
        }
        case 'pong': return;
      }
    };
    ws.onclose = () => {
      clearTimeout(heartbeatTimer);
      scheduleReconnect();
    };
    ws.onerror = () => { /* close will follow */ };
  }

  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      try { ws && ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  open();

  return {
    close() {
      clearTimeout(heartbeatTimer);
      clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch { /* ignore */ }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/websocket.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/websocket.js tests/viewer/websocket.test.ts
git commit -m "feat(viewer): reconnecting WebSocket client with heartbeat + backfill"
```

---

### Task 11: Ladder step 4 — WebSocket wire-up + live mutations (no synapse yet)

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual (create decision, watch graph update)

- [ ] **Step 1: Wire WebSocket client into entry**

At the top of `src/viewer/graph-viewer-2d.js`, add to the imports:

```js
import { createWsClient } from '/viewer/shared/websocket.js';
import { applyMutation } from '/viewer/shared/state.js';
```

(`applyMutation` may already be imported via the state.js re-export — if so, consolidate into the existing `import { createGraphState, hydrate, edgeKey } from '/viewer/shared/state.js';` line.)

After the simulation setup and `rebuildNeighbors()` call, and before the hover section, append:

```js
// --- WebSocket live updates ---
function syncSimulation() {
  simulation.nodes([...state.nodes.values()]);
  simulation.force('link').links([...state.edges.values()].map(e => ({
    source: e.source_id,
    target: e.target_id,
    relation: e.relation,
  })));
  simulation.alpha(0.3).restart();  // gentle reheat, not 1.0
}

createWsClient({
  url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
  onHello: (msg) => console.log('cortex ws hello', msg.project_id, msg.server_version),
  onEvent: () => { /* stream component (Plan C) consumes these */ },
  onMutation: (m) => {
    applyMutation(state, m);
    rebuildNeighbors();
    syncSimulation();
  },
  onBackfill: () => { /* events only (server sends mutations:[]) — for stream */ },
});
```

- [ ] **Step 2: Verify manually — create a decision, watch the graph update**

Run: `npm run dev`. Open `http://localhost:3334/viewer` in one window.

In another terminal, add a decision via the MCP tools or a one-off script. Simplest: use the `mcp__cortex__create_decision` tool from a sibling Claude session, or shell-call the CLI. The spec expects a new lavender diamond to appear in the viewer within ~1s, force sim reheats to 0.3 and the node settles.

Close DevTools Console — verify:
- `cortex ws hello <project_id> <version>` log fires on page load
- Creating a decision emits at least one `add_node` mutation and you can see the graph state update via `window.__cortex_viewer_state.nodes.size`.

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): wire WebSocket — live mutations update graph"
```

---

### Task 12: Ladder step 5 — synapse animations

**Files:**
- Modify: `src/viewer/shared/animation.js` — no change (synapse queue already supports)
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual

- [ ] **Step 1: Trigger synapse on every mutation**

In the `onMutation` callback in `graph-viewer-2d.js`, update to dispatch per op:

```js
  onMutation: (m) => {
    applyMutation(state, m);
    rebuildNeighbors();
    syncSimulation();
    switch (m.op) {
      case 'add_node':
        triggerSynapse(anim, { kind: 'ring', nodeId: m.node.id, duration: 60 });
        break;
      case 'add_edge':
        triggerSynapse(anim, {
          kind: 'pulse',
          edgeKey: edgeKey(m.edge),
          source: m.edge.source_id,
          target: m.edge.target_id,
          duration: 45,
        });
        break;
      // 'remove_node' is instant in v1. A true fade would require deferring
      // state.nodes.delete() until the synapse expires — acceptable follow-up.
    }
  },
```

(Add `triggerSynapse` to the animation.js import.)

- [ ] **Step 2: Render synapses as an overlay pass**

Add a `drawSynapses()` function, called after `drawNodes()` in `draw()`:

```js
function drawSynapses() {
  for (const s of anim.synapses) {
    const progress = s.age / s.duration;  // 0→1
    if (s.kind === 'ring') {
      const node = state.nodes.get(s.nodeId);
      if (!node) continue;
      const [sx, sy] = worldToScreen(node.x || 0, node.y || 0);
      const r = nodeSize(node.kind) + progress * 22;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(180,160,224,' + (1 - progress) + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (s.kind === 'pulse') {
      const a = state.nodes.get(s.source);
      const b = state.nodes.get(s.target);
      if (!a || !b) continue;
      const [ax, ay] = worldToScreen(a.x || 0, a.y || 0);
      const [bx, by] = worldToScreen(b.x || 0, b.y || 0);
      const px = ax + (bx - ax) * progress;
      const py = ay + (by - ay) * progress;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (1 - progress) + ')';
      ctx.fill();
    }
  }
}
```

Call `drawSynapses()` at the end of the render `draw()` function, after the nodes loop.

- [ ] **Step 3: Verify manually**

Run: `npm run dev`. Open `http://localhost:3334/viewer`. Trigger mutations from another terminal (create decision, link decision, delete decision).

Expected:
- `add_node` — expanding lavender ring emanates from the new node and fades out over ~1s
- `add_edge` — small white particle travels from source → target
- `remove_node` — node disappears instantly (explicit fade is deferred; see comment in handler)

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): synapse animations for add_node / add_edge"
```

---

### Task 13: Ladder step 6 — supersession choreography

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual

- [ ] **Step 1: Listen for `decision.superseded` events and sequence a choreography**

In the `onEvent` callback, replace the placeholder with:

```js
  onEvent: (e) => {
    if (e.kind === 'decision.superseded') {
      // 3s sequence: pulse each GOVERNS edge of old (staggered), then flip to strike,
      // then draw SUPERSEDES edge, then new node ring ripple, then new GOVERNS pulses.
      const oldId = e.payload.old_id;
      const newId = e.payload.new_id;

      // Pulse governing edges of old, staggered.
      const oldGoverns = [...state.edges.values()].filter(
        (edge) => edge.source_id === oldId && edge.relation === 'GOVERNS',
      );
      oldGoverns.forEach((edge, i) => {
        setTimeout(() => {
          triggerSynapse(anim, {
            kind: 'pulse',
            source: edge.source_id,
            target: edge.target_id,
            duration: 30,
          });
        }, i * 80);
      });

      // After pulses, the actual `update_node` mutation will flip old.status = 'superseded'
      // (emitted by the backend) — no extra work here.

      // Ring the new node 1.2s in.
      setTimeout(() => {
        if (state.nodes.has(newId)) {
          triggerSynapse(anim, { kind: 'ring', nodeId: newId, duration: 60 });
        }
      }, 1200);
    }
  },
```

- [ ] **Step 2: Verify manually**

Run: `npm run dev`. Open `http://localhost:3334/viewer`. Create two decisions A and B, then call the `supersede` path so that B supersedes A.

Expected:
- A's GOVERNS edges pulse one-by-one (staggered 80ms)
- A visually transitions to ghost-fill + diagonal strike (via `update_node` from the backend)
- SUPERSEDES edge appears (via `add_edge` from the backend — already handled by Task 12)
- B gets a ring ripple
- Total duration ~3s

(If the backend doesn't emit the full mutation sequence for supersession, the choreography degrades gracefully — only the observable mutations animate. This matches the spec's "the superseded sequence is the only animation kicked off by an event rather than a mutation, because it's a choreography across multiple mutations.")

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): supersession choreography event-driven overlay"
```

---

### Task 14: Ladder step 7 — search + filter

**Files:**
- Modify: `src/viewer/index.html` — add toolbar
- Modify: `src/viewer/style.css`
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual

- [ ] **Step 1: Add toolbar DOM**

In `src/viewer/index.html`, insert before the `<canvas>`:

```html
<div id="toolbar">
  <span id="logo">cortex</span>
  <input type="text" id="search" placeholder="Search nodes...">
  <div id="filters">
    <label><input type="checkbox" data-kind="decision" checked> decisions</label>
    <label><input type="checkbox" data-kind="file" checked> files</label>
    <label><input type="checkbox" data-kind="function" checked> functions</label>
    <label><input type="checkbox" data-kind="component" checked> components</label>
    <label><input type="checkbox" data-kind="reference" checked> references</label>
    <label><input type="checkbox" data-kind="path" checked> paths</label>
  </div>
</div>
```

The existing `style.css` already has `#toolbar`, `#search`, `#filters` rules from the 3D viewer — reuse as-is.

- [ ] **Step 2: Wire search + filter into state**

In `graph-viewer-2d.js`, add after the hover setup:

```js
// --- Search + filter ---
let searchQuery = '';
const activeKinds = new Set(['decision', 'file', 'function', 'component', 'reference', 'path']);

const searchInput = document.getElementById('search');
searchInput.addEventListener('input', (ev) => {
  searchQuery = ev.target.value.toLowerCase();
});

document.querySelectorAll('#filters input').forEach((cb) => {
  cb.addEventListener('change', () => {
    const k = cb.dataset.kind;
    if (cb.checked) activeKinds.add(k); else activeKinds.delete(k);
  });
});

function isVisible(node) {
  if (!activeKinds.has(node.kind)) return false;
  if (searchQuery && !node.name.toLowerCase().includes(searchQuery)) return false;
  return true;
}
```

In the `draw()` function, wrap node and edge rendering with `isVisible` checks:

```js
  // Edges loop — inside the loop:
  if (!isVisible(a) || !isVisible(b)) continue;

  // Nodes loop — inside the loop:
  if (!isVisible(node)) continue;
```

- [ ] **Step 3: Verify manually**

Run: `npm run dev`. Expected:
- Typing in search hides nodes whose name does not contain the query (live as you type)
- Unchecking a kind checkbox hides all nodes of that kind
- Edges vanish when either endpoint is hidden
- Rest-state still looks correct

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/index.html src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): search + per-kind filter"
```

---

### Task 15: Ladder step 8 — detail panel on click

**Files:**
- Modify: `src/viewer/index.html` — add panel DOM
- Modify: `src/viewer/style.css` — panel already styled in 3D viewer CSS; reuse
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual

- [ ] **Step 1: Add panel DOM**

In `src/viewer/index.html`, append inside `<body>`:

```html
<div id="detail-panel" class="hidden">
  <button id="close-panel">&times;</button>
  <div id="detail-content"></div>
</div>
```

The 3D viewer's CSS already defines `#detail-panel`, `#close-panel`, `#detail-content`, `.field`, `.field-label`, `.field-value`, `.connection-link` — reuse.

- [ ] **Step 2: Wire click → detail panel**

Append to `graph-viewer-2d.js`:

```js
// --- Detail panel ---
const detailPanel = document.getElementById('detail-panel');
const detailContent = document.getElementById('detail-content');
const closePanel = document.getElementById('close-panel');
let selectedId = null;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function field(label, value) {
  return '<div class="field"><div class="field-label">' + escapeHtml(label) +
    '</div><div class="field-value">' + value + '</div></div>';
}

function showDetail(node) {
  selectedId = node.id;
  const data = typeof node.data === 'string' ? JSON.parse(node.data) : (node.data || {});
  let html = '<h2>' + escapeHtml(node.name) + '</h2>';
  html += field('Kind', escapeHtml(node.kind));
  if (node.tier)           html += field('Tier', escapeHtml(node.tier));
  if (node.status)         html += field('Status', escapeHtml(node.status));
  if (node.qualified_name) html += field('Qualified name', escapeHtml(node.qualified_name));
  if (node.file_path)      html += field('File', escapeHtml(node.file_path));
  if (data.rationale)      html += field('Rationale', escapeHtml(data.rationale));
  if (data.description)    html += field('Description', escapeHtml(data.description));

  const connected = [...state.edges.values()]
    .filter(e => e.source_id === node.id || e.target_id === node.id)
    .map(e => {
      const otherId = e.source_id === node.id ? e.target_id : e.source_id;
      const dir = e.source_id === node.id ? '→' : '←';
      const other = state.nodes.get(otherId);
      const name = other ? other.name : otherId;
      return '<a href="#" class="connection-link" data-node-id="' + escapeHtml(otherId) +
        '">' + escapeHtml(dir + ' ' + e.relation + ' ' + name) + '</a>';
    });
  if (connected.length) html += field('Connections', connected.join('<br>'));

  html += field('ID', escapeHtml(node.id));
  detailContent.innerHTML = html;
  detailPanel.classList.remove('hidden');

  detailContent.querySelectorAll('.connection-link').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      const target = state.nodes.get(link.dataset.nodeId);
      if (target) showDetail(target);
    });
  });
}

function closeDetail() {
  selectedId = null;
  detailPanel.classList.add('hidden');
}

closePanel.addEventListener('click', closeDetail);

canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left - rect.width / 2;
  const my = ev.clientY - rect.top  - rect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - mx;
    const dy = (node.y ?? 0) - my;
    const d = dx * dx + dy * dy;
    const r = nodeSize(node.kind) + 3;
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  if (best) showDetail(best);
  else closeDetail();
});
```

- [ ] **Step 3: Verify manually**

Run: `npm run dev`. Open the viewer, click a node. Expected: right-side panel slides in showing name, kind, connections; clicking a connection link switches the panel to that node; clicking the `×` or the empty canvas closes the panel.

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/index.html src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): detail panel on click"
```

---

### Task 16: Ladder step 9 — focus mode (local graph)

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Test: manual

- [ ] **Step 1: Add focus-on-double-click that restricts visible graph to N-hop neighborhood**

Append:

```js
// --- Focus mode ---
// Double-click a node → restrict visible graph to its 1-hop neighborhood + edges.
// Esc → clear focus.
let focusId = null;

function bfsNeighborhood(rootId, depth) {
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) {
      const neighbors = neighborsOf.get(id) || new Set();
      for (const n of neighbors) {
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
  }
  return seen;
}

let focusSet = null; // Set<id> of visible nodes when in focus mode.

canvas.addEventListener('dblclick', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left - rect.width / 2;
  const my = ev.clientY - rect.top  - rect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - mx;
    const dy = (node.y ?? 0) - my;
    const d = dx * dx + dy * dy;
    const r = nodeSize(node.kind) + 3;
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  if (best) {
    focusId = best.id;
    focusSet = bfsNeighborhood(best.id, 1);
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    focusId = null;
    focusSet = null;
  }
});
```

Extend `isVisible`:

```js
function isVisible(node) {
  if (focusSet && !focusSet.has(node.id)) return false;
  if (!activeKinds.has(node.kind)) return false;
  if (searchQuery && !node.name.toLowerCase().includes(searchQuery)) return false;
  return true;
}
```

- [ ] **Step 2: Verify manually**

Run: `npm run dev`. Double-click a decision node. Expected: all non-neighbors vanish; only the decision and its 1-hop neighbors are visible. Press Esc → full graph returns.

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): focus mode — dblclick restricts to 1-hop neighborhood, Esc clears"
```

---

### Task 17: Architecture doc update + CLAUDE.md pointer

**Files:**
- Modify: `docs/architecture/graph-ui.md` — append a "2D viewer" section
- Modify: `CLAUDE.md` — update viewer pointer

- [ ] **Step 1: Append to docs/architecture/graph-ui.md**

At the end of the file, append:

```markdown
## 2D viewer

### Entry point

[src/viewer/graph-viewer-2d.js](../../src/viewer/graph-viewer-2d.js) — the single
entry module served at `/viewer/graph-viewer-2d.js`. It wires all `shared/`
modules together, opens the WebSocket, and runs the render loop.

### Module layout

| Module | Owns | Pure? |
|---|---|---|
| `shared/state.js` | graph state + `applyMutation` | yes |
| `shared/colors.js` | palette + `lerpRGB` + `rgbString` | yes |
| `shared/shapes.js` | Canvas 2D shape primitives | yes (over a ctx) |
| `shared/layout.js` | d3-force config + per-kind/relation tables | yes |
| `shared/animation.js` | hover + synapse state machine | yes |
| `shared/websocket.js` | reconnecting WS client | yes (over `WebSocket`) |
| `graph-viewer-2d.js` | DOM wiring + render loop | no (side-effectful entry) |

Every `shared/` module is unit-tested in Vitest. The entry file is
hand-verified against the running dev server (canvas rendering and animation
timing are not testable headlessly in v1).

### Render loop

Per frame (requestAnimationFrame):

1. `simulation.tick()` — d3-force integrates positions
2. `applyBreathing(t)` — sinusoidal velocity nudge per node
3. `advance(anim, 1)` — lerp hover + colorMix, age synapses, prune expired
4. `draw()` — clear, edges, nodes, synapse overlay (ordered for z-behavior)

### Extending the viewer

**Adding a new node kind** — extend `PALETTE_REST`, `PALETTE_HOVER`,
`SIZE`, `CHARGE`, `SHAPE_FOR_KIND`. Reuse an existing shape or add one to
`shapes.js`.

**Adding a new mutation op** — extend `state.js::applyMutation`, extend the
`onMutation` dispatcher in `graph-viewer-2d.js` to trigger any associated
synapse.

**Adding a new event-driven animation** — handle in `onEvent` callback,
sequence `triggerSynapse` calls with `setTimeout` for staggered choreography.

### Routes

- `/viewer` — 2D viewer (default).
- `/viewer/3d` — the original 3D viewer.
- `/viewer/<asset>` — static asset serving from `src/viewer/`; supports
  nested paths like `/viewer/shared/state.js` and `/viewer/3d/graph-viewer.js`.
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, under the "Viewer" heading, replace the existing sentence with:

```markdown
## Viewer

The 2D graph viewer (default) runs at http://localhost:3334/viewer during development (`npm run dev`), or http://localhost:3333/viewer when running as an MCP plugin. The legacy 3D viewer is at `/viewer/3d`. See [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md#2d-viewer) for module layout and extension recipes.
```

- [ ] **Step 3: Verify tests still pass end-to-end**

Run: `npm test`
Expected: all existing 119 backend tests + the 6 new viewer-module test files pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/graph-ui.md CLAUDE.md
git commit -m "docs: architecture and CLAUDE.md pointers for 2D viewer"
```

---

## Self-Review Notes

Completed against the spec section "2D viewer (browser)":

- **Tech stack (d3-force + Canvas 2D, no build step, ESM import map):** Task 1 (import map), Task 5 (d3-force), Task 6 (Canvas).
- **Module layout (6 shared modules + single entry):** Tasks 2, 3, 4, 5, 8, 10 build the shared modules; Tasks 6–9, 11–16 extend the entry file.
- **Render loop (tick → breathing → advanceLerps → clear → edges → nodes → synapse):** Tasks 6, 7, 9, 12.
- **Visual system (palette, shapes, status modifiers, edge styles):** Task 3 (palette + edge alpha), Task 4 (shapes + strike), Task 9 (status alpha + hover lerp).
- **Force simulation (link distances, charges, collide, center, breathing):** Task 5 (tables), Task 7 (sim + breathing).
- **Lerp hover (factor, highlight targets, size/alpha/color lerps):** Task 8 (state machine), Task 9 (wiring).
- **Synapse animations (add_node ring, add_edge pulse, remove_node fade, supersession choreography):** Tasks 12 (mutations), 13 (choreography).
- **Mutation application (`applyMutation` switch):** Task 2 (pure), Task 11 (wiring + sim reheat 0.3).
- **Viewer shipping order (nine-step ladder):** Tasks 6 (static), 7 (sim), 9 (hover), 11 (WS), 12 (synapse), 13 (supersession), 14 (search+filter), 15 (detail panel), 16 (focus mode).

Not addressed in this plan (out of scope):
- Activity stream (Plan C)
- Graph↔stream click sync (Plan C)
- Playwright smoke suite (deferred to overall shipping step 9, after Plan C)
