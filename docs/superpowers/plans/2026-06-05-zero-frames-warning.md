# Zero-Frames Warning Implementation Plan (Plan 1b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a non-fatal banner in the frames viewer when a project has file nodes but **zero** frames, so a graph last indexed via the raw C binary (which skips the TS frame-extraction pass) doesn't silently look frameless.

**Architecture:** Deferred sibling of Phase 1 ([import-aware spec](../specs/2026-06-04-import-aware-frame-extraction-design.md) §8). Two parts: (1) a **pure detection helper** `frameCoverage(nodes)` in `src/viewer/adapters.js`, unit-tested alongside the existing `groupNodesIntoFrames`; (2) a **viewer banner** — DOM element + CSS + a toggle in `viewer.js`'s `loadGraph`. The viewer (`startViewerServer` → `/api/graph`, frontend `src/viewer/*.js`) is the real read-time surface where a user notices missing frames.

**Tech Stack:** Plain ES-module JS (`src/viewer/*.js`), HTML, CSS. Vitest for the helper. Playwright (MCP) for Gate-0 visual QA.

**Scope decision — CLI surface omitted.** The parent spec §8 also suggested a CLI line. Investigation during Plan 1 showed there is no clean TS CLI read surface for this: `index_status` is produced by the C indexer (`internal/indexer/src/handlers/handlers.c`), and `renderFramesLine` only fires inside `cortex index`, which **always** runs frame extraction and assigns frames — so a warning there is unreachable. A CLI warning would require C-indexer changes, which are out of this plan's scope. This plan delivers the viewer surface (where the footgun is actually observed) plus the reusable pure detector. The detector is written so a future C/CLI surface can mirror its logic.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/viewer/adapters.js` | Add pure `frameCoverage(nodes)` → `{ fileNodes, framedNodes, zeroFrames }`. Reuses the existing `parseData`. | **Modify** |
| `tests/viewer/adapters.test.js` | Unit tests for `frameCoverage`. | **Modify** |
| `src/viewer/index.html` | Add the banner element + dismiss button. | **Modify** |
| `src/viewer/style.css` | Style `.frames-warning` (fixed, top-center, amber, dark/light). | **Modify** |
| `src/viewer/viewer.js` | Import `frameCoverage`; toggle the banner in `loadGraph`; wire the dismiss button in init. | **Modify** |

---

## Task 1: Pure `frameCoverage` detector

**Files:**
- Modify: `src/viewer/adapters.js`
- Test: `tests/viewer/adapters.test.js`

The detector mirrors the iteration shape of the existing `groupNodesIntoFrames` (same `kind === "file"` filter, same `parseData(n.data)`), returning counts plus the `zeroFrames` boolean the banner keys on. Kept pure so it is unit-tested without a DOM or server.

- [ ] **Step 1: Write the failing tests**

In `tests/viewer/adapters.test.js`, add `frameCoverage` to the import list at the top:

```js
import {
  groupNodesIntoFrames,
  basenames,
  buildFrameGovernance,
  edgesInternalIndex,
  frameCoverage,
} from "../../src/viewer/adapters.js";
```

Then append this describe block at the end of the file:

```js
describe("frameCoverage", () => {
  it("flags zeroFrames when file nodes exist but none carry a frame_id", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: {} },
      { id: "2", kind: "file", file_path: "src/b.ts", data: {} },
      { id: "3", kind: "function", name: "foo", data: {} },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 2, framedNodes: 0, zeroFrames: true });
  });

  it("does not flag when at least one file node has a frame_id", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: { frame_id: 0, frame_label: "auth" } },
      { id: "2", kind: "file", file_path: "src/b.ts", data: {} },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 2, framedNodes: 1, zeroFrames: false });
  });

  it("does not flag a project with no file nodes (unindexed / empty)", () => {
    const nodes = [{ id: "1", kind: "function", name: "foo", data: {} }];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 0, framedNodes: 0, zeroFrames: false });
  });

  it("parses stringified data JSON like the rest of the adapter", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: '{"frame_id":2,"frame_label":"x"}' },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 1, framedNodes: 1, zeroFrames: false });
  });

  it("ignores frame_id that is not a number", () => {
    const nodes = [
      { id: "1", kind: "file", file_path: "src/a.ts", data: { frame_id: null } },
      { id: "2", kind: "file", file_path: "src/b.ts", data: { frame_id: "0" } },
    ];
    expect(frameCoverage(nodes)).toEqual({ fileNodes: 2, framedNodes: 0, zeroFrames: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/adapters.test.js`
Expected: FAIL — `frameCoverage` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/viewer/adapters.js`, add this exported function (place it directly after `groupNodesIntoFrames`, before `basenames`):

```js
/**
 * Frame-coverage summary for a project's nodes.
 *
 * `zeroFrames` is true when the graph has file nodes but NONE carry a numeric
 * `frame_id` — the signature of a graph built by the raw C indexer (which
 * skips the TS frame-extraction pass) rather than via `cortex index` / the MCP
 * `index_repository` tool. A project with no file nodes at all (unindexed /
 * empty) is NOT flagged. Mirrors `groupNodesIntoFrames`' file-node + parseData
 * handling so the two never disagree about what counts as "framed".
 * Returns: { fileNodes, framedNodes, zeroFrames }.
 */
export function frameCoverage(nodes) {
  let fileNodes = 0;
  let framedNodes = 0;
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    fileNodes++;
    const data = parseData(n.data);
    if (typeof data.frame_id === "number") framedNodes++;
  }
  return { fileNodes, framedNodes, zeroFrames: fileNodes > 0 && framedNodes === 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/adapters.test.js`
Expected: PASS — the new `frameCoverage` block plus the pre-existing `groupNodesIntoFrames` / `basenames` / `buildFrameGovernance` / `edgesInternalIndex` blocks.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/adapters.js tests/viewer/adapters.test.js
git commit -m "feat(viewer): frameCoverage detector for zero-frames warning"
```

---

## Task 2: Viewer banner

**Files:**
- Modify: `src/viewer/index.html`
- Modify: `src/viewer/style.css`
- Modify: `src/viewer/viewer.js`

A fixed, dismissible banner at top-center. Shown only when `frameCoverage(graph.nodes).zeroFrames` is true. Hidden whenever frames are present (the common case) and on project switch re-evaluated each `loadGraph`. **Gate 0 visual QA required** (this changes rendered DOM and the render/load flow).

- [ ] **Step 1: Add the banner element to index.html**

In `src/viewer/index.html`, add this block immediately after the `<div class="toolbar"> … </div>` block (so it sits in the top overlay layer, sibling to the toolbar):

```html
<div class="frames-warning" id="frames-warning" hidden>
  <span class="frames-warning-text" id="frames-warning-text"></span>
  <button class="frames-warning-dismiss" id="frames-warning-dismiss" title="Dismiss" aria-label="Dismiss">×</button>
</div>
```

- [ ] **Step 2: Style the banner in style.css**

In `src/viewer/style.css`, append (z-index 40 sits above the canvas/toolbar at 30 but below the decision card at 50; amber matches `amberRGB()` `[245,158,11]` already used in `viewer.js`):

```css
.frames-warning {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 640px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.5);
  color: #f59e0b;
}
.frames-warning[hidden] { display: none; }
.frames-warning code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(245, 158, 11, 0.18);
  padding: 0 4px;
  border-radius: 4px;
}
.frames-warning-dismiss {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  opacity: 0.8;
}
.frames-warning-dismiss:hover { opacity: 1; }
body.light .frames-warning {
  background: rgba(180, 83, 9, 0.10);
  border-color: rgba(180, 83, 9, 0.5);
  color: #b45309;
}
```

- [ ] **Step 2.5: Read viewer.js around `loadGraph` and `initToolbar` before editing**

Read `src/viewer/viewer.js` lines 1–160 so the edits below land in the right scope (the IIFE/closure that owns `canvas`, `loadGraph`, `initToolbar`). The import is line 2; `loadGraph` starts ~line 61; `initToolbar` ~line 130.

- [ ] **Step 3: Import `frameCoverage` in viewer.js**

Change line 2 of `src/viewer/viewer.js` from:

```js
import { groupNodesIntoFrames, basenames, buildFrameGovernance } from '/viewer/adapters.js';
```

to:

```js
import { groupNodesIntoFrames, basenames, buildFrameGovernance, frameCoverage } from '/viewer/adapters.js';
```

- [ ] **Step 4: Add the banner toggle helper**

In `src/viewer/viewer.js`, inside the same closure that defines `loadGraph` (e.g. directly above `async function loadGraph`), add:

```js
  // Zero-frames warning: shown when a project has file nodes but none are
  // framed (graph built by the raw C indexer, which skips frame extraction).
  // Re-evaluated on every loadGraph; dismiss only hides until next load.
  function updateFramesWarning(nodes) {
    const el = document.getElementById('frames-warning');
    if (!el) return;
    const { zeroFrames, fileNodes } = frameCoverage(nodes);
    if (zeroFrames) {
      const text = document.getElementById('frames-warning-text');
      if (text) {
        text.textContent = '';
        text.append(`${fileNodes} files indexed, 0 frames — reindex via `);
        const code = document.createElement('code');
        code.textContent = 'cortex index';
        text.append(code, ' to generate frames.');
      }
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
```

(Using `textContent` + `append` rather than `innerHTML` avoids any injection concern and matches the no-`innerHTML` style for dynamic text.)

- [ ] **Step 5: Call the toggle from `loadGraph`**

In `src/viewer/viewer.js`, inside `loadGraph`, immediately after the line `const summaries = groupNodesIntoFrames(graph.nodes);` (step "1." in `loadGraph`), add:

```js
    updateFramesWarning(graph.nodes);
```

- [ ] **Step 6: Wire the dismiss button once, in `initToolbar`**

In `src/viewer/viewer.js`, inside `initToolbar` (after it grabs the `project-select` / `theme-toggle` elements), add:

```js
    const framesDismiss = document.getElementById('frames-warning-dismiss');
    if (framesDismiss) {
      framesDismiss.addEventListener('click', () => {
        const el = document.getElementById('frames-warning');
        if (el) el.hidden = true;
      });
    }
```

- [ ] **Step 7: Run the viewer adapter test + full suite**

Run: `npx vitest run tests/viewer/adapters.test.js && npm test`
Expected: PASS (viewer JS has no type check; the suite must stay green — 650+ tests).

- [ ] **Step 8: Gate 0 — Visual QA (REQUIRED; this changes rendered DOM + the load flow)**

Start the dev server and drive the viewer with Playwright. Screenshots MUST go to `.playwright-mcp/` or `.tmp/` (never the repo root).

1. Start the server in the background: `npm run dev` (viewer at `http://localhost:3334/viewer`). Wait until it serves (poll the URL).
2. `browser_navigate` to `http://localhost:3334/viewer`. Capture a screenshot + check `browser_console_messages` for errors.
3. **No-false-positive check (primary):** with a normally-framed project loaded (e.g. `self/cortex` — it has frames after Phase 1), confirm the banner is **absent** (`#frames-warning` has `hidden`). Screenshot.
4. **Positive-rendering check:** in the page, drive the zero-frames state directly to verify styling and copy without needing a frameless project on disk — `browser_evaluate`:
   ```js
   () => { const t=document.getElementById('frames-warning-text'); t.textContent=''; t.append('42 files indexed, 0 frames — reindex via '); const c=document.createElement('code'); c.textContent='cortex index'; t.append(c,' to generate frames.'); const el=document.getElementById('frames-warning'); el.hidden=false; return el.outerHTML; }
   ```
   Screenshot the banner (dark mode). Toggle light mode (the `◐` `#theme-toggle`) and screenshot again to verify the `body.light` variant.
5. **Dismiss check:** click `#frames-warning-dismiss`; confirm the banner hides and no console error.
6. Report findings honestly:
   - Runtime errors / stack traces → block, fix before review.
   - Banner shows on a framed project (false positive) → block, fix.
   - Banner missing/broken when forced on, or unreadable in either theme → block, fix.
   - Aesthetic nits → document, don't block.

   If Playwright/dev server cannot run in this environment, state that explicitly and flag the task as **needing user-driven hand-verify before merge** — do not claim verification that wasn't done.

- [ ] **Step 9: Commit**

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/viewer.js
git commit -m "feat(viewer): zero-frames warning banner"
```

---

## Self-Review

**1. Spec coverage (§8):** "Viewer: a banner on a project with file nodes and no frames" → Task 2. Detection ("project has file nodes but 0 frame_id") → Task 1 `frameCoverage`. CLI surface → explicitly omitted with rationale (C-backed / unreachable from TS); documented in the Scope decision so it's a conscious gap, not a silent one.

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code; the Gate-0 step gives exact Playwright actions + the exact `browser_evaluate` snippet.

**3. Type/name consistency:** `frameCoverage(nodes)` returns `{ fileNodes, framedNodes, zeroFrames }` — same shape in the helper (Task 1), its tests, and the `updateFramesWarning` destructure (`{ zeroFrames, fileNodes }`, Task 2 Step 4). Element ids match across index.html / style.css / viewer.js: `frames-warning`, `frames-warning-text`, `frames-warning-dismiss`. `parseData` reused (already defined in adapters.js).

**4. Ambiguity:** Banner copy is fixed (`"N files indexed, 0 frames — reindex via cortex index to generate frames."`). Dismiss = hide-until-next-load (no persistence) — stated in the Task 2 Step 4 comment.
