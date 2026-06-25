# TODO Viewer Slice + Unified Layers Menu — Design

> **Arc:** the v0.3 single-player line. The TODO entity *foundation*
> (storage + tools + HTTP contract) shipped in 1.0.0; the `/api/todos`
> contract already serves data. This slice renders that data on the canvas
> and reworks the layers menu so frames, decisions, and TODOs are all
> toggleable "layers". Companion to
> [`docs/specs/cortex-v0.3/todo-entity.md`](../../specs/cortex-v0.3/todo-entity.md)
> (the entity's visual spec) and
> [`2026-06-23-todo-entity-consolidated-tools-design.md`](2026-06-23-todo-entity-consolidated-tools-design.md).

## Problem

TODOs are durable and queryable (`todo` MCP tool, `/api/todos`) but
**invisible on the canvas**. The viewer (`src/viewer/`) never fetches
`/api/todos` — there is no `fetchTodos`, no yellow dots, no drawer, no
marginalia. Planned work has no shape, which breaks the "watch work as a
shape" product claim for the period before code moves.

Separately, the layers menu (`index.html` + `viewer.js::initToolbar`) only
offers one `show layers` tint toggle plus a 6-row architectural legend.
There is no way to hide entity types (frames / decisions / todos) to declutter
the canvas. The product framing is that **frames, decisions, and TODOs are
all just layers of the same map** — the menu should reflect that.

## Goals

1. Render TODOs on the canvas mirroring the decision dot/pill/ring grammar:
   ambient yellow dots, hover pill, marginalia pills, leader lines, a record
   drawer, and a "Tasks" section on the decision drawer.
2. Rework the layers menu into one flat list of toggleable layers
   (frames / decisions / todos / layer-tint), each persisted.
3. Fold in the pre-existing GOVERNS qualified-name classification fix
   (cross-primitive) so TODO `governs` refs resolve correctly.

## Non-goals

- TODO hooks / external bridge (`PostMergeHook`, Linear/JIRA mirroring) —
  a separate deferred slice.
- A `/api/todos/:id` detail route. The list endpoint returns full
  `AdaptedTodo` records, so the viewer keys off a loaded `TODOS` map exactly
  as it does for `DECISIONS` (no per-record fetch).
- Any change to frame ranking, layout, or the layer classifier.

---

## Section 1 — Unified "layers" menu

### Current state

`src/viewer/index.html` renders one `layers-menu` with a single `show layers`
switch (`#layers-switch`, toggling `layersOn`, persisted to
`cortex.viewer.layers`) and a fixed 6-row architectural legend
(interface / orchestration / domain / data / infrastructure / ceremony, swatch
colors injected from `LAYER_RGB` at init).

### Target

One flat list of layer toggles. The architectural tint is just one more layer,
with its legend nested under it:

```
┌─ layers ──────────────────┐
│  ◉ frames                 │   structural substrate chrome
│  ◉ decisions              │   green dots / marginalia / leaders
│  ◉ todos                  │   yellow dots / marginalia / leaders
│  ──────────────────────   │
│  ○ layer tint             │   the former "show layers" lens
│      ▪ interface          │
│      ▪ orchestration      │     (legend meaningful only when
│      ▪ domain             │      layer tint is on)
│      ▪ data               │
│      ▪ infrastructure     │
│      ▪ ceremony           │
└───────────────────────────┘
```

### Toggle semantics

| Layer | Default | Off behavior |
|---|---|---|
| `frames` | **on** | Suppress frame **chrome only** — box border, fill, label, and tint — inside `drawFrames`. **`drawNodes` and `drawEdges` still run; layout positions are untouched.** File dots stay exactly where they are, so decisions/TODOs remain anchorable. Marginalia still position off the (now-invisible) frame geometry. |
| `decisions` | **on** | Skip decision dots, decision marginalia pills, decision leader lines, and floating decision nodes. |
| `todos` | **on** | Skip all TODO rendering (dots, marginalia, leader lines, floating dots). |
| `layer tint` | **off** | Existing `layersOn` behavior. Inert when `frames` is off (tint lives on the box chrome). |

Defaults keep the canvas **pixel-identical to today plus visible TODOs**:
entity layers on, tint off.

### Persistence

- `frames` → `cortex.viewer.show.frames`
- `decisions` → `cortex.viewer.show.decisions`
- `todos` → `cortex.viewer.show.todos`
- `layer tint` → `cortex.viewer.layers` (unchanged)

Each reads on init (default to "on", except tint "off") and writes on toggle,
inside the same sandboxed `try/catch` the current code uses.

### Module boundaries

- `index.html` — restructure `#layers-menu` markup into the flat list. The
  legend rows stay (`.lm-row i[data-layer]`), nested under a `layer tint`
  switch.
- `viewer.js::initToolbar` — wire each switch (click + keydown a11y, mirroring
  the existing `layers-switch` handlers); read/write localStorage; flip a
  module-level boolean per layer (`showFrames`, `showDecisions`, `showTodos`,
  `layersOn`).
- Render passes read those booleans to gate drawing.

---

## Section 2 — Data layer (mirror decisions)

- `data-fetch.js` gains `fetchTodos(project)` — project-scoped, same shape as
  `fetchDecisions` (returns `{ todos: [] }` on non-OK).
- `loadGraph` adds the todos fetch to its parallel load, then builds:
  - `TODOS = {}` — id → `AdaptedTodo`, mirroring the `DECISIONS` map.
  - `TODO_GOVERNANCE` — frameId → todo ids, built by the same rollup as
    `FRAME_GOVERNANCE` (reuse / generalize `buildFrameGovernance` in
    `adapters.js` to take a generic governed-entity list).
  - `todo._nodeIdxs` — governed-entity anchor dots, computed with the **same
    seeded picker** decisions use (`viewer.js:354-371`), generalized to run
    over `TODO_GOVERNANCE` as well. Seed string namespaced (`'todo:'+id+':'+frameId`)
    so todo anchors are deterministic and independent of decision anchors.
  - `SPAWNS_FROM` — decision id → child todo ids, from each todo's
    `spawnsFrom` field. Drives §5 leader lines and the §6 decision-drawer
    Tasks section.
- **Ambient filter:** done/cancelled TODOs are excluded from the canvas data
  set at load (still present in the raw response for potential drawer/search
  use, but not added to ambient `TODOS`/governance/floating sets). Spec:
  done/cancelled are "hidden from ambient … queryable via search / drawer".

## Section 3 — Ambient rendering

TODO dots reuse the decision dot/pill/ring grammar. Palette: yellow
`#facc15` → `[250, 204, 21]`, added as a `todoDotRGB()` / `todoTextRGB()`
theme helper pair alongside the existing `decisionDotRGB()` etc.

| State | Visual |
|---|---|
| `open` | Solid yellow ~95% opacity |
| `in_progress` | Assignee identity color (fall back to yellow if no assignee color) |
| `blocked` | Yellow dot + amber ring (`amberRGB()`) at ~80% alpha |
| `done` / `cancelled` | Not rendered (filtered in §2) |

- Hover pill `T-042 · <summary>` via the existing hover machinery
  (the same path that yields decision hover pills).
- TODOs not mapped to any frame → floating yellow dots, mirroring
  `drawFloatingDecisionNodes` (generalize or add a sibling
  `drawFloatingTodoNodes`).
- All TODO drawing is gated by `showTodos`.

## Section 4 — Marginalia

`drawMarginaliaForFrame` is extended (or paired with a todo variant) so that,
on a focused frame, **yellow TODO pills stack below the decision pills** in the
same right-edge column, with the same leader lines to their `_nodeIdxs` anchor
dots. Decision pills gate on `showDecisions`, TODO pills on `showTodos`; the
column packs whichever are visible.

## Section 5 — Leader lines

Two kinds:

1. **TODO → governed entity** — yellow dashed leaders from a TODO marginalia
   pill to its `_nodeIdxs` anchor dots (mirror of the decision leader lines).
2. **Decision → TODO (`spawnsFrom`)** — when a decision is selected and has
   child TODOs (`SPAWNS_FROM[decisionId]`), render a leader from the decision
   dot to each child-TODO dot, same grammar as decision→governed-entity
   leaders. Gated by `showDecisions && showTodos` (both endpoints must be
   visible).

## Section 6 — Drawers

- **TODO drawer** reusing the decision-card chrome (`renderDecisionCard` is the
  template; factor shared structure or add `renderTodoCard`):
  - Header: yellow monospace ID (`T-<seq>`), state pill, summary, provenance
    (`proposed by @agent on YYYY-MM-DD`), close button.
  - Sections: description (markdown), governs (ref pills), spawned-from (link to
    parent decision), resolved-by (PR pills), dependencies (blockedBy / blocks),
    related, external refs (empty if none).
  - In-place pivot decision ↔ TODO, same mechanism as the existing
    decision ↔ PR/ref pivot (`refPillHtml` + the card click handler).
- **Decision drawer — Tasks section:** a new section listing
  `SPAWNS_FROM[thisDecision]` child TODOs as pills (ID · summary · state).
  Clicking a pill swaps the drawer content to that TODO (in-place navigation).

## Section 7 — GOVERNS qualified-name fix (fold-in)

`classifyTarget` in **both** `src/decisions/service.ts` and
`src/todos/service.ts` currently uses `includes("/") ? "path" : "qn"`. A real
qualified name (`dir/file.ts::sym`) always contains `/`, so it is misclassified
`"path"` and then silently dropped by `resolveGovernsRef` (it looks the whole
string up in `nodesByPath` and finds nothing). Fix both:

```ts
target.includes("::") ? "qn" : target.includes("/") ? "path" : "qn"
```

— check `::` first. This is the documented pre-existing low-severity bug
(HANDOFF "Known latent issue"; `progress.md` Known issues), not a 1.0.0
regression. Cross-primitive fix so TODO `governs` qn refs render in §3–§6.

## Section 8 — Testing

- **TDD on pure logic:**
  - `classifyTarget` fix — regression test in both decision and todo service
    suites proving a `dir/file.ts::sym` qn classifies `"qn"` and resolves
    through `resolveGovernsRef` to a node ref (not dropped).
  - `SPAWNS_FROM` index + done/cancelled ambient filter — unit tests on the
    adapter/builder helpers (kept pure in `adapters.js`).
  - Generalized governance rollup / anchor picker — assert decisions still
    produce byte-identical `_nodeIdxs` (no regression) and todos produce
    deterministic anchors.
- **Gate 0 — Visual QA** (rendering is not unit-testable): drive `npm run dev`
  (:3334) with Playwright. Capture: TODOs visible (open/blocked/in_progress
  states), each layer toggle on→off→on, frames-off keeps dots+anchors, TODO
  drawer open, decision-drawer Tasks section, decision→TODO leader lines.
  Screenshots to `.playwright-mcp/` or `.tmp/`. Check console for errors.
- **Gate 1** `/review` on the diff; **Gate 2** `qa` agent before merge.
- Full suite green (`npm test`) before merge.

> ⚠ The MCP plugin server (:3333) loads `src/` once at startup and does not
> hot-reload. Use `npm run dev` (:3334) for Gate-0 QA; the live plugin server
> needs a restart to serve new viewer code.

---

## Risks & mitigations

- **Regression in decision rendering** from generalizing the governance rollup
  / anchor picker → guarded by a byte-identical `_nodeIdxs` test for decisions.
- **`viewer.js` is already ~1760 lines.** This slice adds a parallel TODO
  pipeline. Mitigation: keep new pure helpers (governance rollup, spawns-from
  index, ambient filter, state→color) in `adapters.js` (testable), and
  parameterize the shared draw helpers by entity rather than copy-pasting two
  near-identical 80-line functions where practical. If a draw helper can't be
  cleanly parameterized, a focused sibling function is acceptable over a tangled
  conditional.
- **Done/cancelled leakage** into ambient → single filter chokepoint at load,
  unit-tested.

## Version / release

Code change touching `src/` → patch bump (`1.0.3` → `1.0.4`) across
`package.json`, `plugin.json`, `.claude-plugin/marketplace.json` + a
`CHANGELOG.md` entry, merged via PR with the CI gate passing (per
`.claude/rules/workflow.md`).
