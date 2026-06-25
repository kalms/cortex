# TODO Viewer Slice + Unified Layers Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render durable TODO data on the frames viewer (yellow dots, hover, marginalia, leader lines, drawer, decision "Tasks" section) and rework the layers menu so frames / decisions / todos / layer-tint are all toggleable layers.

**Architecture:** The `/api/todos` HTTP contract already serves full `AdaptedTodo` records (project-scoped, list-only — no `:id` route). The viewer mirrors its existing **decision** rendering pipeline for TODOs: a `TODOS` map (like `DECISIONS`), a governance rollup + seeded anchor picker (generalized from the decision path), `drawFloatingTodoNodes` (mirror of `drawFloatingDecisionNodes`), TODO marginalia pills, a `renderTodoCard` reusing the decision-card chrome, and the already-multi-type-aware `openRecord(type,id)` / `marginaliaRects[].type` selection machinery. New **pure** helpers live in `src/viewer/adapters.js` (unit-tested); rendering is verified by Gate-0 Playwright QA since canvas drawing is not unit-testable.

**Tech Stack:** TypeScript (services + HTTP), vanilla ES-module JS + Canvas 2D (viewer), Vitest (`npm test`), Playwright MCP (Gate-0), `npm run dev` dev server on :3334.

## Global Constraints

- **Worktree:** all work happens in `/Users/rka/Development/cortex-wt-todo-viewer` (branch `feature/component/todo-viewer-layers`). `node_modules` + `bin/cortex-indexer` are symlinked from the main checkout.
- **Default canvas unchanged + TODOs:** entity layers (`frames`/`decisions`/`todos`) default **on**, `layer tint` defaults **off**. With todos absent the canvas is pixel-identical to today.
- **No layout change ever:** server-computed frame/dot positions are never recomputed by this slice. Hiding `frames` suppresses box **chrome only**; `drawNodes`/`drawEdges` still run.
- **Determinism:** no `Math.random` in any render data path. TODO anchors use the existing `mulberry32(fnv1a(seed))` picker, seed-namespaced `'todo:'+id+':'+frameId`.
- **Done/cancelled TODOs are never ambient** (filtered at load); only `open` / `in_progress` / `blocked` render on canvas.
- **TODO palette:** yellow `#facc15` → `[250, 204, 21]`; blocked adds the existing `amberRGB()` ring `[245, 158, 11]`; `in_progress` uses the assignee identity color, falling back to yellow.
- **HTTP contract is frozen for this slice:** do **not** edit `src/mcp-server/api-schemas.ts` or `docs/api/*.schema.json`. `/api/todos` already returns what the viewer needs.
- **Server reload caveat:** the plugin MCP server (:3333) loads `src/` once at startup. Use `npm run dev` (:3334) for all Gate-0 QA.
- **Gates per `.claude/rules/workflow.md`:** Gate-0 visual QA on every UI-visible task, Gate-1 `/review` before marking a task done, Gate-2 `qa` agent + version bump + PR before merge.

---

### Task 1: GOVERNS qualified-name classification fix (both primitives)

Pre-existing latent bug: `classifyTarget` classifies any string containing `/` as a `"path"`, so a real qualified name (`dir/file.ts::sym`, always contains `/`) is misclassified and silently dropped by `resolveGovernsRef`. Fix decisions + todos to check `::` first. Pure logic, independently mergeable, and a prerequisite for TODO `governs` qn refs rendering later.

**Files:**
- Modify: `src/decisions/service.ts:349-351` (`classifyTarget`)
- Modify: `src/todos/service.ts:49` (the `GOVERNS` branch of `addLink`)
- Test: `tests/decisions/service.test.ts` (add case; create if absent — check first)
- Test: `tests/todos/service.test.ts` (add case; create if absent — check first)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `classifyTarget(target)` and the todo GOVERNS branch now return `"qn"` for any string containing `::`. No signature change.

- [ ] **Step 1: Locate the existing service test files and their setup**

Run: `ls tests/decisions/ tests/todos/ 2>/dev/null`
Read whichever `service.test.ts` exists to copy its DB/service construction boilerplate (in-memory DB open + repo wiring). If neither exists, model the new test on `tests/decisions/links-repository.test.ts` or the nearest existing decisions/todos test.

- [ ] **Step 2: Write the failing test (decisions)**

Add to `tests/decisions/service.test.ts` a test that creates a decision governing a qualified name and asserts the stored link is classified `qn`, not `path`. Use the same service/DB construction the file already uses. The assertion that matters:

```ts
it("classifies a qualified-name governs target as qn, not path", () => {
  // ...construct service + create a decision with governs: ["src/foo/bar.ts::doThing"]...
  const links = linksRepo.findByDecision(decisionId);
  const governs = links.find((l) => l.relation === "GOVERNS");
  expect(governs?.target_kind).toBe("qn"); // currently "path" — bug
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- tests/decisions/service.test.ts`
Expected: FAIL — `expected 'path' to be 'qn'`.

- [ ] **Step 4: Fix `classifyTarget` (decisions)**

In `src/decisions/service.ts`, replace:

```ts
function classifyTarget(target: string): TargetKind {
  return target.includes("/") ? "path" : "qn";
}
```

with:

```ts
function classifyTarget(target: string): TargetKind {
  // A qualified name (`dir/file.ts::sym`) also contains "/", so check the
  // "::" qn marker FIRST — otherwise real qns were misclassified "path" and
  // silently dropped by resolveGovernsRef (it only looks paths up in nodesByPath).
  return target.includes("::") ? "qn" : target.includes("/") ? "path" : "qn";
}
```

- [ ] **Step 5: Run the decisions test to confirm it passes**

Run: `npm test -- tests/decisions/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test (todos)**

Add to `tests/todos/service.test.ts` the analogous test: a TODO with `governs: ["src/foo/bar.ts::doThing"]` stores a GOVERNS link with `target_kind === "qn"`. Use the file's existing `TodoService` construction.

- [ ] **Step 7: Run it to confirm it fails**

Run: `npm test -- tests/todos/service.test.ts`
Expected: FAIL — `expected 'path' to be 'qn'`.

- [ ] **Step 8: Fix the todo GOVERNS branch**

In `src/todos/service.ts`, in `addLink`'s switch, replace the `GOVERNS` case body:

```ts
      case "GOVERNS":
        kind = ref.includes("/") ? "path" : "qn";
        break;
```

with:

```ts
      case "GOVERNS":
        // Check the "::" qn marker before "/": a qualified name always
        // contains "/" too, so the old order misclassified qns as "path".
        kind = ref.includes("::") ? "qn" : ref.includes("/") ? "path" : "qn";
        break;
```

- [ ] **Step 9: Run the todos test to confirm it passes**

Run: `npm test -- tests/todos/service.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all green (no regressions). If a snapshot/contract test references the old classification, investigate before adjusting.

- [ ] **Step 11: Gate-1 review, then commit**

Run `/review` on the diff (`git diff main --name-only`). Address Critical findings. Then:

```bash
git add src/decisions/service.ts src/todos/service.ts tests/decisions/service.test.ts tests/todos/service.test.ts
git commit -m "fix(decisions,todos): classify dir/file.ts::sym governs targets as qn not path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure viewer adapters (governance, spawns-from, ambient filter, state→color)

All new pure transforms live in `src/viewer/adapters.js` so they're unit-testable in isolation, before any canvas code consumes them.

**Files:**
- Modify: `src/viewer/adapters.js` (add 4 exports; keep `buildFrameGovernance` intact)
- Test: `tests/viewer/adapters.test.ts` (add cases; the file already exists — confirm with `ls tests/viewer/`)

**Interfaces:**
- Consumes: the `AdaptedTodo` wire shape — `{ id, seq, summary, state, governs: {kind,id?,path?}[], spawnsFrom: string|null, ... }`.
- Produces:
  - `buildGovernance(entities)` → `{ [frameIdStr]: entityId[] }` — generalization of `buildFrameGovernance` over any list whose items have `.id` + `.governs[]` with `kind==='frame'`. `buildFrameGovernance` stays as a thin wrapper (no caller churn).
  - `buildSpawnsFromIndex(todos)` → `{ [decisionId]: todoId[] }` from each todo's `spawnsFrom`.
  - `filterAmbientTodos(todos)` → `Todo[]` excluding `state==='done'||'cancelled'`.
  - `todoDotColor(state)` → `{ rgb:[r,g,b], ring:[r,g,b]|null }` — pure state→color (no assignee handling; identity color is resolved at draw time).

- [ ] **Step 1: Write failing tests**

Add to `tests/viewer/adapters.test.ts` (import from `../../src/viewer/adapters.js`):

```ts
import { buildGovernance, buildFrameGovernance, buildSpawnsFromIndex, filterAmbientTodos, todoDotColor } from "../../src/viewer/adapters.js";

describe("buildGovernance / buildFrameGovernance", () => {
  const items = [
    { id: "T-1", governs: [{ kind: "frame", id: "3" }, { kind: "file", path: "a.ts" }] },
    { id: "T-2", governs: [{ kind: "frame", id: "3" }] },
  ];
  it("rolls frame-governed entities up by frame id, deduped", () => {
    expect(buildGovernance(items)).toEqual({ "3": ["T-1", "T-2"] });
  });
  it("buildFrameGovernance stays a wrapper over buildGovernance", () => {
    const decs = [{ id: "D-1", governs: [{ kind: "frame", id: "5" }] }];
    expect(buildFrameGovernance(decs)).toEqual({ "5": ["D-1"] });
  });
});

describe("buildSpawnsFromIndex", () => {
  it("maps decision id -> child todo ids, ignoring null", () => {
    const todos = [
      { id: "T-1", spawnsFrom: "D-9" },
      { id: "T-2", spawnsFrom: "D-9" },
      { id: "T-3", spawnsFrom: null },
    ];
    expect(buildSpawnsFromIndex(todos)).toEqual({ "D-9": ["T-1", "T-2"] });
  });
});

describe("filterAmbientTodos", () => {
  it("drops done and cancelled, keeps open/in_progress/blocked", () => {
    const todos = [
      { id: "T-1", state: "open" }, { id: "T-2", state: "in_progress" },
      { id: "T-3", state: "blocked" }, { id: "T-4", state: "done" },
      { id: "T-5", state: "cancelled" },
    ];
    expect(filterAmbientTodos(todos).map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
  });
});

describe("todoDotColor", () => {
  it("open -> solid yellow, no ring", () => {
    expect(todoDotColor("open")).toEqual({ rgb: [250, 204, 21], ring: null });
  });
  it("blocked -> yellow + amber ring", () => {
    expect(todoDotColor("blocked")).toEqual({ rgb: [250, 204, 21], ring: [245, 158, 11] });
  });
  it("in_progress -> yellow base (identity color applied at draw time), no ring", () => {
    expect(todoDotColor("in_progress")).toEqual({ rgb: [250, 204, 21], ring: null });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- tests/viewer/adapters.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Implement the helpers in `adapters.js`**

Add (and rewrite `buildFrameGovernance` as a wrapper):

```js
/**
 * Generalized governance rollup: { [frameIdStr]: entityId[] } from any list of
 * items with `.id` and a `.governs[]` carrying `kind: 'frame'` refs. Deduped,
 * insertion order preserved. Used for both decisions and TODOs.
 */
export function buildGovernance(entities) {
  const out = {};
  for (const e of entities || []) {
    for (const g of e.governs || []) {
      if (g.kind !== "frame") continue;
      if (!out[g.id]) out[g.id] = [];
      if (!out[g.id].includes(e.id)) out[g.id].push(e.id);
    }
  }
  return out;
}

/** Decision frame-governance (kept as a named wrapper so callers don't churn). */
export function buildFrameGovernance(decisions) {
  return buildGovernance(decisions);
}

/** { [decisionId]: todoId[] } from each todo's `spawnsFrom` (null ignored). */
export function buildSpawnsFromIndex(todos) {
  const out = {};
  for (const t of todos || []) {
    const parent = t.spawnsFrom;
    if (!parent) continue;
    if (!out[parent]) out[parent] = [];
    if (!out[parent].includes(t.id)) out[parent].push(t.id);
  }
  return out;
}

/** Ambient canvas excludes closed work; done/cancelled are drawer/search-only. */
export function filterAmbientTodos(todos) {
  return (todos || []).filter((t) => t.state !== "done" && t.state !== "cancelled");
}

const TODO_YELLOW = [250, 204, 21];
const TODO_AMBER = [245, 158, 11];

/** Pure state -> dot color. `in_progress` returns the yellow base; the draw
 *  layer substitutes the assignee identity color when one is available. */
export function todoDotColor(state) {
  return { rgb: TODO_YELLOW, ring: state === "blocked" ? TODO_AMBER : null };
}
```

Then DELETE the old `buildFrameGovernance` body (lines ~86-96) that this wrapper replaces.

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- tests/viewer/adapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite (guards the `buildFrameGovernance` refactor)**

Run: `npm test`
Expected: green — existing `buildFrameGovernance` callers/tests unchanged.

- [ ] **Step 6: Commit** (pure modules, no UI → Gate-0 skip; run `/review`)

```bash
git add src/viewer/adapters.js tests/viewer/adapters.test.ts
git commit -m "feat(viewer): pure todo adapters (governance, spawns-from, ambient filter, dot color)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Unified "layers" menu (HTML + toggles + render gating)

Restructure the menu into a flat layer list and add module-level visibility booleans that gate the render passes. `frames`/`decisions`/`layer tint` become functional immediately; `todos` gating is wired but inert until Task 4 draws TODOs.

**Files:**
- Modify: `src/viewer/index.html:20-32` (`#layers-menu` markup)
- Modify: `src/viewer/style.css` (`.lm-toggle` / `.lm-row` reuse; add a nested-legend indent rule)
- Modify: `src/viewer/viewer.js` — `initToolbar` (lines ~212-243), the `layersOn`/`LAYERS_LS_KEY` block (lines 36-38), `drawFrames` (chrome gating), `mainLoop` (1575-1589 decision-pass gating)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: module-level booleans `showFrames`, `showDecisions`, `showTodos` (default `true`) and existing `layersOn` (default `false`), each persisted to `cortex.viewer.show.frames|decisions|todos` / `cortex.viewer.layers`. Later tasks gate TODO drawing on `showTodos`.

- [ ] **Step 1: Restructure the menu markup**

Replace `src/viewer/index.html:20-32` with:

```html
  <div class="layers-wrap">
    <button id="layers-toggle" title="Layers">layers</button>
    <div class="layers-menu" id="layers-menu" hidden>
      <div class="lm-toggle on" id="show-frames" role="switch" aria-checked="true" tabindex="0"><span class="sw"></span>frames</div>
      <div class="lm-toggle on" id="show-decisions" role="switch" aria-checked="true" tabindex="0"><span class="sw"></span>decisions</div>
      <div class="lm-toggle on" id="show-todos" role="switch" aria-checked="true" tabindex="0"><span class="sw"></span>todos</div>
      <div class="lm-sep"></div>
      <div class="lm-toggle" id="layers-switch" role="switch" aria-checked="false" tabindex="0"><span class="sw"></span>layer tint</div>
      <div class="lm-legend">
        <div class="lm-row"><i data-layer="interface"></i>interface</div>
        <div class="lm-row"><i data-layer="orchestration"></i>orchestration</div>
        <div class="lm-row"><i data-layer="domain"></i>domain</div>
        <div class="lm-row"><i data-layer="data"></i>data</div>
        <div class="lm-row"><i data-layer="infrastructure"></i>infrastructure</div>
        <div class="lm-row"><i data-layer="ceremony"></i>ceremony</div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add the nested-legend CSS**

In `src/viewer/style.css`, near the existing `.layers-menu` block (~line 498), add:

```css
.lm-legend { padding-left: 14px; margin-top: 2px; }
```

(The `.lm-toggle`, `.lm-row`, `.lm-sep`, swatch styles already exist and are reused as-is.)

- [ ] **Step 3: Add the visibility-state booleans**

In `src/viewer/viewer.js`, just after the `layersOn` block (lines 36-38), add:

```js
  const SHOW_LS = {
    frames: 'cortex.viewer.show.frames',
    decisions: 'cortex.viewer.show.decisions',
    todos: 'cortex.viewer.show.todos',
  };
  function readShow(key) {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; } // default ON
  }
  let showFrames = readShow(SHOW_LS.frames);
  let showDecisions = readShow(SHOW_LS.decisions);
  let showTodos = readShow(SHOW_LS.todos);
```

- [ ] **Step 4: Wire the three entity switches in `initToolbar`**

In `src/viewer/viewer.js::initToolbar`, after the existing `layersSwitch` keydown handler (line ~243), add a generic switch binder and bind the three entity toggles:

```js
    const bindSwitch = (el, lsKey, get, set) => {
      el.classList.toggle('on', get());
      el.setAttribute('aria-checked', String(get()));
      const toggle = () => {
        set(!get());
        el.classList.toggle('on', get());
        el.setAttribute('aria-checked', String(get()));
        try { localStorage.setItem(lsKey, get() ? '1' : '0'); } catch { /* sandboxed */ }
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    };
    bindSwitch(document.getElementById('show-frames'), SHOW_LS.frames,
      () => showFrames, (v) => { showFrames = v; });
    bindSwitch(document.getElementById('show-decisions'), SHOW_LS.decisions,
      () => showDecisions, (v) => { showDecisions = v; });
    bindSwitch(document.getElementById('show-todos'), SHOW_LS.todos,
      () => showTodos, (v) => { showTodos = v; });
```

Leave the existing `layersSwitch` (layer tint) handler untouched — it keeps writing `LAYERS_LS_KEY`.

- [ ] **Step 5: Gate frame chrome on `showFrames` (chrome only — layout untouched)**

In `drawFrames`, wrap only the box fill, border, and label drawing so they're skipped when `showFrames` is false, while the per-frame loop, `framePx`, `marginaliaRects` reset, and the marginalia call at the end still run. Concretely, guard the chrome block: at the top of the `FRAMES.forEach` body after `ctx.save(); ctx.translate(...)` (line ~1040), wrap the fill/border/label section (lines ~1042-1107) in `if (showFrames) { ... }`. The `ctx.save/translate/restore` and `drawMarginaliaForFrame` calls stay outside the guard so decision/todo marginalia still anchor.

Verify by reading: `drawNodes(now)` and `drawEdges()` are separate passes in `mainLoop` and are NOT touched here — dots and edges keep rendering when frames are hidden.

- [ ] **Step 6: Gate the decision pass on `showDecisions`**

In `mainLoop` (line 1583), change:

```js
    drawFloatingDecisionNodes(now);
```

to:

```js
    if (showDecisions) drawFloatingDecisionNodes(now);
```

And in `drawMarginaliaForFrame` (Task adds the todo half later), guard the decision-pill loop on `showDecisions` — at the top of `drawMarginaliaForFrame`, after fetching `decs`, wrap the decision `forEach` so it only runs `if (showDecisions)`. (Marginalia rects for decisions must not be pushed when hidden, or hidden pills stay clickable.)

- [ ] **Step 7: Gate-0 visual QA**

Start dev server (background): `npm run dev` (wait for `:3334`). Drive with Playwright MCP:
- Navigate `http://localhost:3334/viewer`; screenshot to `.playwright-mcp/menu-default.png`; check console — no errors.
- Open the `layers` menu; confirm the flat list (frames/decisions/todos/layer tint + legend). Screenshot.
- Toggle `frames` off → boxes/labels vanish, **dots + edges remain in place** (no relayout). Screenshot `.playwright-mcp/frames-off.png`.
- Toggle `decisions` off → green dots/pills/leaders vanish. Screenshot.
- Toggle `layer tint` on → per-layer frame tint appears + legend meaningful. Screenshot.
- Reload → toggles persist (localStorage). Confirm console clean.

Block on any console error, missing dots when frames off (regression), or relayout. Document aesthetic-only issues.

- [ ] **Step 8: Gate-1 review + commit**

`/review` the diff; fix Critical. Then:

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/viewer.js
git commit -m "feat(viewer): unified layers menu with frames/decisions/todos visibility toggles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: TODO data wiring + ambient dot rendering

Fetch `/api/todos`, build the TODO maps + generalized anchor picker, and draw ambient yellow TODO dots with hover pills — mirroring `drawFloatingDecisionNodes`. Selection/drawer come in Task 7; this task makes TODOs *visible*.

**Files:**
- Modify: `src/viewer/data-fetch.js` (add `fetchTodos`)
- Modify: `src/viewer/viewer.js` — imports (line 1-2), globals (~63-86), `loadGraph` (114-188), the `_nodeIdxs` builder in `buildGraph` (354-371), add `drawFloatingTodoNodes` + `todoNodeRects` + `todoNodeAtPoint`, hover wiring, `mainLoop`
- Test: `tests/viewer/adapters.test.ts` already covers the pure helpers; add a determinism note test only if a pure picker is extracted (see Step 4).

**Interfaces:**
- Consumes: `buildGovernance`, `buildSpawnsFromIndex`, `filterAmbientTodos`, `todoDotColor` (Task 2); `showTodos` (Task 3).
- Produces: globals `TODOS` (`{[id]: AdaptedTodo}`), `TODO_GOVERNANCE` (`{[frameIdStr]: todoId[]}`), `SPAWNS_FROM` (`{[decisionId]: todoId[]}`); each ambient todo carries `todo._nodeIdxs` (anchor dot indices); `drawFloatingTodoNodes(now)` + `todoNodeAtPoint(px,py)`; `hoveredTodoId`.

- [ ] **Step 1: Add `fetchTodos`**

In `src/viewer/data-fetch.js`, append:

```js
export async function fetchTodos(project) {
  const url = project
    ? `/api/todos?project=${encodeURIComponent(project)}`
    : "/api/todos";
  const r = await fetch(url);
  if (!r.ok) return { todos: [] };
  return r.json();
}
```

- [ ] **Step 2: Import the new fetch + adapters**

In `src/viewer/viewer.js` line 1-2, add `fetchTodos` to the data-fetch import and `buildGovernance, buildSpawnsFromIndex, filterAmbientTodos, todoDotColor` to the adapters import.

- [ ] **Step 3: Add TODO globals**

Near the `DECISIONS`/`FRAME_GOVERNANCE` declarations (~80-81), add:

```js
  let TODOS = {};
  let TODO_GOVERNANCE = {};
  let SPAWNS_FROM = {};
```

- [ ] **Step 4: Fetch + build TODO maps in `loadGraph`**

Add `fetchTodos(projectName)` to the `Promise.all` (line 116-122), destructuring a `todosResp`. After the decisions block (line 170), add:

```js
    // 5c. TODOs → TODOS map (ambient-filtered) + governance + spawns-from index.
    const ambientTodos = filterAmbientTodos(todosResp.todos || []);
    TODOS = {};
    for (const t of ambientTodos) TODOS[t.id] = t;
    TODO_GOVERNANCE = buildGovernance(ambientTodos);
    SPAWNS_FROM = buildSpawnsFromIndex(todosResp.todos || []);
```

(`SPAWNS_FROM` uses the unfiltered list so a decision's Tasks section in Task 8 can still list a done child — the *ambient dots* use the filtered set.)

- [ ] **Step 5: Generalize the anchor-index builder to also seed TODO anchors**

The decision anchor builder at `buildGraph` lines 354-371 picks `dec._nodeIdxs`. Extract the per-frame seeded picker into a local helper and run it for both maps. Replace lines 354-371 with:

```js
    const assignAnchors = (governance, store, prefix) => {
      for (const frameId in governance) {
        const frameNodes = nodes.map((n, i) => ({ n, i })).filter(o => o.n.frameId === frameId);
        governance[frameId].forEach((entId) => {
          const ent = store[entId];
          if (!ent) return;
          const rng = mulberry32(fnv1a(prefix + entId + ':' + frameId));
          const targetCount = Math.min(2 + Math.floor(rng() * 2), frameNodes.length);
          const pool = [...frameNodes];
          const picked = [];
          for (let k = 0; k < targetCount; k++) {
            picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          }
          ent._nodeIdxs = picked.map(o => o.i);
        });
      }
    };
    assignAnchors(FRAME_GOVERNANCE, DECISIONS, '');           // unchanged seed → identical decision anchors
    assignAnchors(TODO_GOVERNANCE, TODOS, 'todo:');           // namespaced seed → independent todo anchors
```

The empty `''` prefix reproduces the prior decision seed string (`decId + ':' + frameId`) **byte-for-byte**, so decision anchors do not move.

- [ ] **Step 6: Add `drawFloatingTodoNodes` + hit-test (mirror of decisions)**

Add a `hoveredTodoId` global (near `hoveredDecisionId`, line 485) and `const todoNodeRects = [];` (near `decisionNodeRects`). Add a `drawFloatingTodoNodes(now)` modeled on `drawFloatingDecisionNodes` (lines 822-990) with these differences:
- Source list: `Object.values(TODOS)` (already ambient-filtered).
- Dot color: `const { rgb, ring } = todoDotColor(todo.state);` — for `in_progress` with an assignee identity color available, substitute it (fall back to `rgb`). Identity-color lookup: reuse the same helper decisions/agents use if present; otherwise yellow.
- Ring: if `ring` non-null (blocked), stroke an amber ring at `DOT_R + 2`, `0.8` alpha (same shape as the deprecated-decision ring at lines 917-923).
- Pill text/border: yellow palette — add `todoDotRGB()` `[250,204,21]` and `todoTextRGB()` helpers near the decision color helpers (lines 46-47); pill bg can reuse `pillBgRGB()` (neutral) to avoid a green tint.
- Selection: `const selectedTodoId = (focusedRecord && focusedRecord.type === 'todo') ? focusedRecord.id : null;`
- Push to `todoNodeRects` (same rect shape as `decisionNodeRects`, with `id` = todo id).
- Standalone TODOs with no governed frame have no `_nodeIdxs` → `governedPositions` empty → `return` (same as decisions). **Known limitation:** standalone/unanchored TODOs are not drawn as ambient dots this slice (they remain in search/drawer). Flag at handoff.

Add `todoNodeAtPoint(px, py)` mirroring `decisionNodeAtPoint` (992-1001) over `todoNodeRects`.

- [ ] **Step 7: Render + hover wiring**

In `mainLoop` (after the gated decision pass), add:

```js
    if (showTodos) drawFloatingTodoNodes(now);
```

In the `mousemove` handler (near line 653 where `hoveredDecisionId` is set), add a parallel `todoNodeAtPoint` check setting `hoveredTodoId`, and clear it in `mouseleave` (line 688). Ensure the hover pill machinery shows `T-<seq> · summary` for a hovered todo (reuse the decision hover-pill path, keyed by `hoveredTodoId`).

- [ ] **Step 8: Gate-0 visual QA**

`npm run dev`; Playwright:
- Need TODO data: if the current project has none, create a few via the `todo` MCP tool (`todo propose` with `governs` pointing at a file in a visible frame; one `open`, one `blocked`, one `in_progress`) against `repo_path` for the dev project, OR point the viewer at a project that has todos. Document which.
- Navigate `/viewer`; screenshot `.playwright-mcp/todos-visible.png`. Confirm: open=solid yellow, blocked=yellow+amber ring, in_progress=identity/yellow. Console clean.
- Hover a todo dot → `T-NNN · summary` pill. Screenshot.
- Toggle `todos` off → yellow dots vanish; decisions unaffected. Toggle back on. Screenshot.

Block on console errors or decision-anchor shift (compare a decision-heavy frame screenshot to Task 3's `menu-default.png` — anchors must be identical).

- [ ] **Step 9: Gate-1 review + commit**

```bash
git add src/viewer/data-fetch.js src/viewer/viewer.js
git commit -m "feat(viewer): render ambient TODO dots from /api/todos with hover pills

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: TODO marginalia pills

On a focused frame, stack yellow TODO pills below the decision pills in the right-edge column, with leader lines to their anchor dots.

**Files:**
- Modify: `src/viewer/viewer.js` — `drawMarginaliaForFrame` (1118-1238), add a `getFrameTodos` helper

**Interfaces:**
- Consumes: `TODO_GOVERNANCE`, `TODOS`, `showTodos`, `todoDotColor`, `marginaliaRects`, the `pillY` cursor.
- Produces: `marginaliaRects` entries with `type: 'todo'`; TODO pills rendered after decision pills.

- [ ] **Step 1: Add `getFrameTodos`**

Near `getFrameDecisions` (line 86), add:

```js
  function getFrameTodos(frameId) {
    return (TODO_GOVERNANCE[frameId] || []).map((id) => TODOS[id]).filter(Boolean);
  }
```

- [ ] **Step 2: Append TODO pills in `drawMarginaliaForFrame`**

`drawMarginaliaForFrame` currently draws decision pills and advances `pillY` (the decision loop ends ~line 1235). After the decision `forEach` (and inside the same `ctx.save()/restore()` scope, before `ctx.restore()`), add a TODO loop gated on `showTodos` that reuses the same pill geometry (`pillX`, advancing `pillY`), but:
- Skips entirely if `!showTodos`.
- `const decs` stays decisions; add `const todos = getFrameTodos(frameId);` and iterate it.
- Mark/dot color from `todoDotColor(todo.state)`; label `${todoDisplayId(todo)} · ${todo.summary}` (add `todoDisplayId(t)` → `t.seq != null ? 'T-'+t.seq : t.id` near `decisionDisplayId`, line 54).
- Leader lines: same dashed-leader code as decisions (lines 1158-1168), color yellow `[250,204,21]`, to `todo._nodeIdxs`.
- Pill bg neutral (`pillBgRGB()`), border yellow; blocked adds the amber left-tick (mirror lines 1184-1187) and/or amber ring on the mark.
- Push `marginaliaRects.push({ type: 'todo', id: todo.id, x: pillX, y: pillY, w: pillW, h: pillH, frameId });` then `pillY += pillH + 8;`

The decision-pill loop must already be gated on `showDecisions` from Task 3 Step 6 — confirm decisions and todos pack independently (if decisions hidden, todos start at the top of the column).

- [ ] **Step 3: Gate-0 visual QA**

`npm run dev`; Playwright: focus a frame that has both a governing decision and a governing todo (use the Task-4 seeded todo's frame). Confirm green decision pill(s) then yellow todo pill(s) stacked below, each with leader lines to dots. Screenshot `.playwright-mcp/marginalia-todo.png`. Toggle decisions off → todo pills reflow to top. Toggle todos off → only decisions. Console clean.

- [ ] **Step 4: Gate-1 review + commit**

```bash
git add src/viewer/viewer.js
git commit -m "feat(viewer): TODO marginalia pills stacked beside decision pills

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Decision → TODO leader lines (`spawnsFrom`)

When a decision is selected and has child TODOs, draw leaders from the decision dot to each child-TODO dot.

**Files:**
- Modify: `src/viewer/viewer.js` — `drawFloatingDecisionNodes` (the selected-decision branch, ~877-909)

**Interfaces:**
- Consumes: `SPAWNS_FROM`, `TODOS` (with `_nodeIdxs`), the decision dot center `(dotX, dotY)`, `showDecisions`, `showTodos`.
- Produces: extra leader strokes from a selected decision's dot to its child-TODO anchor dots.

- [ ] **Step 1: Draw spawns-from leaders for the selected decision**

Inside `drawFloatingDecisionNodes`, within the `if (showLeaders)` / `isSelected` block (~886-897), after the existing governed-position leaders, add:

```js
        // Decision → child-TODO leaders (spawnsFrom). Only when both layers visible.
        if (showTodos) {
          for (const todoId of (SPAWNS_FROM[dec.id] || [])) {
            const childTodo = TODOS[todoId];
            for (const idx of (childTodo?._nodeIdxs || [])) {
              const p = nodePx(nodes[idx]);
              ctx.strokeStyle = `rgba(250, 204, 21, 0.30)`; // yellow, distinct from green governed leaders
              ctx.lineWidth = 0.6;
              ctx.setLineDash([2, 2]);
              ctx.beginPath();
              ctx.moveTo(dotX, dotY);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }
        }
```

(`drawFloatingDecisionNodes` is already gated on `showDecisions` in `mainLoop`, so no extra decision guard needed.)

- [ ] **Step 2: Gate-0 visual QA**

`npm run dev`; need a decision with a `spawnsFrom` child todo — create via `todo propose ... spawns_from:<decisionId>` if absent (document the id). Select that decision (click its dot); confirm yellow dashed leaders reach the child-todo dot(s), visually distinct from the green governed leaders. Screenshot `.playwright-mcp/spawns-from-leaders.png`. Toggle todos off → yellow leaders vanish, green remain. Console clean.

- [ ] **Step 3: Gate-1 review + commit**

```bash
git add src/viewer/viewer.js
git commit -m "feat(viewer): decision->TODO leader lines for spawnsFrom children

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: TODO drawer (record card) + selection wiring

A click on a TODO dot/pill opens a record drawer reusing the decision-card chrome.

**Files:**
- Modify: `src/viewer/viewer.js` — add `renderTodoCard`, extend `updateDecisionCardVisibility` (1728-1742), extend the canvas `click` handler (711-746) to hit-test `todoNodeAtPoint`

**Interfaces:**
- Consumes: `TODOS`, `openRecord('todo', id)` (already generic, lines 507-522), `todoNodeAtPoint` (Task 4), `marginaliaRects[].type==='todo'` (Task 5), `refPillHtml`, `escapeHtml`, `decisionCardEl`.
- Produces: `renderTodoCard(todoId)`; TODO selection opens the drawer; decision↔todo ref pivot.

- [ ] **Step 1: Hit-test TODO dots on click**

In the canvas `click` handler (711-746), alongside the `decisionNodeAtPoint` checks, add `todoNodeAtPoint` checks that call `openRecord('todo', hit.id)`. Both the "already focused" branch (716-733) and the default branch (736-746) need the todo case. The marginalia branch already dispatches by `marginaliaHit.type`, so `type: 'todo'` pills route through `openRecord('todo', id)` with no change.

- [ ] **Step 2: Implement `renderTodoCard`**

Add near `renderDecisionCard` (1631). Reuse the `dc-*` classes; yellow ID via a `dc-id--todo` modifier (add a CSS rule `.dc-id.todo { color: #facc15; }` and pass the class). Sections, all guarded by presence:

```js
  function renderTodoCard(todoId) {
    const t = TODOS[todoId];
    if (!t) { decisionCardEl.innerHTML = ''; return; }
    const provParts = [];
    if (t.proposedBy) provParts.push(`proposed by <span class="agent">@${escapeHtml(t.proposedBy)}</span>`);
    if (t.proposedAt) provParts.push(`on ${escapeHtml(t.proposedAt)}`);

    let html = `<div class="dc-header"><div class="dc-id-block">
      <div class="dc-id-row">
        <span class="dc-id todo">${escapeHtml(todoDisplayId(t))}</span>
        <span class="dc-state-pill ${escapeHtml(t.state)}"><span class="sw"></span>${escapeHtml(t.state)}</span>
      </div>
      <div class="dc-summary">${escapeHtml(t.summary)}</div>
      ${provParts.length ? `<div class="dc-provenance">${provParts.join(' · ')}</div>` : ''}
    </div><button class="dc-close" id="dc-close" aria-label="close">×</button></div>`;

    html += '<div class="dc-body">';
    if (t.description) html += `<div class="dc-section"><div class="dc-section-label">description</div><div class="dc-prose">${escapeHtml(t.description)}</div></div>`;
    if (t.governs?.length) html += `<div class="dc-section"><div class="dc-section-label">governs</div><div class="dc-ref-row">${t.governs.map(refPillHtml).join('')}</div></div>`;
    if (t.spawnsFrom) html += `<div class="dc-section"><div class="dc-section-label">spawned from</div><div class="dc-ref-row">${refPillHtml({ kind: 'decision', id: t.spawnsFrom })}</div></div>`;
    if (t.resolvedBy?.length) html += `<div class="dc-section"><div class="dc-section-label">resolved by</div><div class="dc-ref-row">${t.resolvedBy.map(id => refPillHtml({ kind: 'pr', id })).join('')}</div></div>`;
    if (t.blockedBy?.length || t.blocks?.length) {
      html += `<div class="dc-section"><div class="dc-section-label">dependencies</div><div class="dc-ref-row">`;
      html += t.blockedBy.map(r => refPillHtml({ kind: 'todo', id: r.id })).join('');
      html += t.blocks.map(r => refPillHtml({ kind: 'todo', id: r.id })).join('');
      html += `</div></div>`;
    }
    if (t.relatedTo?.length) html += `<div class="dc-section"><div class="dc-section-label">related</div><div class="dc-ref-row">${t.relatedTo.map(r => refPillHtml({ kind: 'todo', id: r.id })).join('')}</div></div>`;
    html += '</div>';
    decisionCardEl.innerHTML = html;

    const closeBtn = document.getElementById('dc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeRecord());
    wireCardRefPills(); // see Step 3
  }
```

- [ ] **Step 3: Extract ref-pill click wiring so both cards share it**

The decision card's ref-pill click handler (1695-1718) handles `decision` pivot + frame focus. Extend it to also pivot to TODOs and pull it into a shared `wireCardRefPills()` that both `renderDecisionCard` and `renderTodoCard` call. Add a `todo` branch: `if (ref.kind === 'todo') { if (TODOS[ref.id]) openRecord('todo', ref.id); return; }`. Update `renderDecisionCard` to call `wireCardRefPills()` instead of its inline block.

- [ ] **Step 4: Branch `updateDecisionCardVisibility` on type**

At lines 1729-1733, add the todo case:

```js
    if (focusedRecord && !sameRecord(focusedRecord, currentRenderedRecord)) {
      if (focusedRecord.type === 'decision') renderDecisionCard(focusedRecord.id);
      else if (focusedRecord.type === 'todo') renderTodoCard(focusedRecord.id);
      currentRenderedRecord = { ...focusedRecord };
    }
```

- [ ] **Step 5: Add `dc-id.todo` + any missing `dc-state-pill` state colors**

In `style.css`, add `.dc-id.todo { color: #facc15; }`. Confirm `.dc-state-pill` has rules for `open`/`in_progress`/`blocked`/`done`/`cancelled`; add yellow/amber/neutral variants for any missing states (mirror the decision state-pill rules).

- [ ] **Step 6: Gate-0 visual QA**

`npm run dev`; Playwright: click a TODO dot → drawer opens with yellow ID, state pill, summary, provenance, governs/spawned-from/etc. sections. Screenshot `.playwright-mcp/todo-drawer.png`. Click the "spawned from" decision pill → drawer pivots to that decision. From a decision drawer, no regression. Esc closes. Console clean.

- [ ] **Step 7: Gate-1 review + commit**

```bash
git add src/viewer/viewer.js src/viewer/style.css
git commit -m "feat(viewer): TODO record drawer + decision<->todo ref pivot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Decision drawer "Tasks" section

The decision drawer gains a Tasks section listing `spawnsFrom` child TODOs; clicking a pill pivots to that TODO.

**Files:**
- Modify: `src/viewer/viewer.js` — `renderDecisionCard` (add a Tasks section before `</div>` at line 1689)

**Interfaces:**
- Consumes: `SPAWNS_FROM`, `TODOS`, `wireCardRefPills` (Task 7), `todoDisplayId`.
- Produces: a Tasks section of todo ref pills in the decision drawer.

- [ ] **Step 1: Render the Tasks section**

In `renderDecisionCard`, just before `html += '</div>';` (line 1689), add:

```js
    const childTodoIds = SPAWNS_FROM[dec.id] || [];
    if (childTodoIds.length) {
      html += `<div class="dc-section"><div class="dc-section-label">tasks</div><div class="dc-ref-row">`;
      html += childTodoIds.map((id) => {
        const t = TODOS[id];
        const label = t ? `${todoDisplayId(t)} · ${t.summary}` : id;
        // refPillHtml renders a clickable todo pill; wireCardRefPills handles the pivot.
        return refPillHtml({ kind: 'todo', id, name: label });
      }).join('');
      html += `</div></div>`;
    }
```

Note: `SPAWNS_FROM` (Task 4) is built from the **unfiltered** todo list, but `TODOS[id]` only holds ambient (open/in_progress/blocked) todos, so a done child resolves `t` to undefined and falls back to the bare id label. That's acceptable; the pill still pivots (`TODOS[ref.id]` guard in `wireCardRefPills` simply no-ops for a done todo not in the ambient map). If listing done children's summaries matters, hold a separate `ALL_TODOS` map — **out of scope; note at handoff.**

- [ ] **Step 2: Gate-0 visual QA**

`npm run dev`; open a decision that has child todos (the Task-6 spawnsFrom decision). Confirm a Tasks section with todo pills (ID · summary · implied state via pill). Click a task pill → drawer pivots to that TODO. Screenshot `.playwright-mcp/decision-tasks.png`. Console clean.

- [ ] **Step 3: Gate-1 review + commit**

```bash
git add src/viewer/viewer.js
git commit -m "feat(viewer): decision drawer Tasks section for spawnsFrom children

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Gate-2 QA + release (1.0.4) via PR

**Files:**
- Modify: `package.json`, `plugin.json`, `.claude-plugin/marketplace.json` (version `1.0.3` → `1.0.4`)
- Modify: `CHANGELOG.md` (new `## [1.0.4]` entry + link reference)
- Modify: `HANDOFF.md`, `docs/specs/progress.md` (mark TODO viewer slice shipped)

**Interfaces:** none.

- [ ] **Step 1: Full suite + clean dev startup**

Run: `npm test` → all green. Start `npm run dev`, confirm `/api/health` + `/api/todos` 200, viewer loads clean.

- [ ] **Step 2: Gate-2 — invoke the `qa` agent**

Run the project QA pass (build health = `npm test` pass + clean dev startup; full feature walkthrough in light + dark mode; confirm no hardcoded-color regressions in the new CSS). Address FAIL items; document PASS-WITH-WARNINGS.

- [ ] **Step 3: Capture a decision**

```
decision({ action: "search", query: "todo viewer rendering layers menu" })
decision({ action: "create", title: "TODO viewer slice mirrors the decision render pipeline; layers menu unified as entity toggles",
  description: "...", rationale: "Reuse over reinvention: TODOS map + generalized governance/anchor picker + drawFloatingTodoNodes mirror decisions; menu unifies frames/decisions/todos/tint as 'layers' per product framing.",
  alternatives: "Separate 'Show' group vs lens (rejected — user: it's all layers); standalone-todo floating placement (deferred — no graph anchor).",
  governs: ["src/viewer/viewer.js", "src/viewer/adapters.js"] })
```

- [ ] **Step 4: Version bump + CHANGELOG**

Set `1.0.4` in `package.json`, `plugin.json`, `.claude-plugin/marketplace.json`. Add a `## [1.0.4] — 2026-06-25` CHANGELOG entry (Added: TODO viewer rendering — dots/hover/marginalia/leaders/drawer/Tasks; unified layers menu with frames/decisions/todos toggles. Fixed: GOVERNS qn-classification in decisions + todos services) + bottom link reference. Update `HANDOFF.md` / `progress.md` to mark the slice shipped.

- [ ] **Step 5: Commit, push, PR**

```bash
git add -A
git commit -m "chore(release): 1.0.4 — TODO viewer slice + unified layers menu

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin feature/component/todo-viewer-layers
gh pr create --base main --title "TODO viewer slice + unified layers menu (1.0.4)" --body "$(cat <<'EOF'
## What
Renders durable TODO data on the frames viewer (yellow dots, hover, marginalia pills, decision→TODO leader lines, record drawer, decision-drawer Tasks section) and reworks the layers menu into a unified frames/decisions/todos/layer-tint toggle list. Folds in the GOVERNS qualified-name classification fix across decisions + todos services.

## Why
The TODO entity foundation shipped in 1.0.0 (storage + tools + /api/todos contract) but TODOs were invisible on the canvas. This renders them, mirroring the decision pipeline. Spec: docs/superpowers/specs/2026-06-25-todo-viewer-slice-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Merge after CI gate passes**

Wait for the **CI gate** check to pass on the PR, then:

```bash
gh pr merge feature/component/todo-viewer-layers --merge
git worktree remove ../cortex-wt-todo-viewer && git worktree prune
```

---

## Self-Review

**Spec coverage:**
- §1 unified menu → Task 3. §2 data layer → Tasks 2 + 4. §3 ambient rendering → Task 4. §4 marginalia → Task 5. §5 leader lines → Task 6 (decision→todo) + Task 5 (todo→governed). §6 drawers → Tasks 7 (todo drawer) + 8 (decision Tasks section). §7 GOVERNS fix → Task 1. §8 testing → unit tests in Tasks 1-2, Gate-0 in 3-8, Gate-2 in 9. ✓ All covered.
- **Discovered limitation (documented, flagged at handoff):** standalone TODOs with no governed entity have no graph anchor and aren't drawn as ambient dots (mirrors existing decision behavior). The spec's "floating dots" line is satisfied only for governed/anchored TODOs this slice.

**Placeholder scan:** No TBD/TODO-in-plan; every code step shows full code. ✓

**Type consistency:** `buildGovernance`/`buildFrameGovernance`/`buildSpawnsFromIndex`/`filterAmbientTodos`/`todoDotColor` (Task 2) match their Task-4/5 consumers; `TODOS`/`TODO_GOVERNANCE`/`SPAWNS_FROM`/`_nodeIdxs`/`drawFloatingTodoNodes`/`todoNodeAtPoint`/`hoveredTodoId`/`todoDisplayId`/`renderTodoCard`/`wireCardRefPills` are defined once and referenced consistently. `openRecord('todo', id)` matches the existing generic signature. ✓
