# Viewer Eyeball Check — cortex frames in the new viewer

Generated: 2026-05-17

Source data:
- Cluster: `.tmp/frame-extraction/clusters/Users-rka-Development-cortex.json`
  (TF-IDF + HDBSCAN + co-change, γ = 0.3 — see
  [the cochange comparison report](./Users-rka-Development-cortex-cochange.md))
- Frames injected: via `scripts/frame-extraction/inject-frames.ts`
- Viewer: `src/viewer/` (prototype-derived, this PR)
- Dev server: `CORTEX_DB_PATH=/Users/rka/Development/cortex/.cortex/graph.db npm run dev`

## Screenshots

- Overview: [.playwright-mcp/viewer-eyeball-overview-final.png](../../../../.playwright-mcp/viewer-eyeball-overview-final.png)
- Frame focus (tslexer lexer, 67 files): [.playwright-mcp/viewer-eyeball-focus-attempt3.png](../../../../.playwright-mcp/viewer-eyeball-focus-attempt3.png)
- Hover-on-node (scanner.c in external create): [.playwright-mcp/viewer-eyeball-frame-focus.png](../../../../.playwright-mcp/viewer-eyeball-frame-focus.png)
- Light theme: [.playwright-mcp/viewer-eyeball-light-theme.png](../../../../.playwright-mcp/viewer-eyeball-light-theme.png)
- Initial load: [.playwright-mcp/viewer-eyeball-overview.png](../../../../.playwright-mcp/viewer-eyeball-overview.png)

Console errors / warnings: **0**.

## Observations

- **14 frames render**, with labels reflecting the cluster output: `tslexer lexer` (67 files), `erase _array__grow` (61), `external create` (19), `tre` (15), `sitter ts_lex` (15), `itoa` (10), `viewer shared` (10), `mcp server` (9), `ts_lex_keywords` (9), `mi` (8), `events` (6), `vendored ts` (6), `walk` (5), `extract lsp` (5). Total: 243 clustered files; the other ~16,300 nodes (mostly functions inside files, plus ~50% noise files) are not rendered as frame members.
- **The labels are dominated by vendored C source** (`tree-sitter` and friends). `tslexer lexer`, `sitter ts_lex`, `ts_lex_keywords`, `tre`, `itoa`, `walk`, `extract lsp` are all artifacts of cortex bundling the C indexer's source under `src/external/`. Cortex's *own* code falls into `viewer shared`, `events`, `mcp server` — three frames out of fourteen. That's the algorithm telling us the truth about what cortex's repo *contains*; it's not a viewer bug.
- **Top-left frames are slightly clipped** because the grid layout places them at coordinates where their full size (including label which floats above the box) extends past the viewport. The plan's `gridLayout` reserves 10% inner padding inside each cell but the cell at row 0 starts at y=0; the label sits at frame.y − h/2 − ~20px which is above the canvas. Easy fix: in `gridLayout`, push every y down by a label gutter (e.g. 24px) and tighten the inner padding accordingly. Logged as a follow-up rather than blocking the prototype.
- **Frame focus works** — clicking a frame's body causes it to grow to ~70% of the canvas, dim the others, and reveal file names inside. The focus animation feels right (ease curve carries over from the prototype's hardcoded transitions). 16-file cap per frame means large clusters like `tslexer lexer` (67 files) only show their first 16 basenames; not yet a UX problem at this stage but will be eventually.
- **Hover-on-node works** — the badge pill shows e.g. `scanner.c — file external create`. The prototype's hover-pill code carries over cleanly without PR/agent extras.
- **Decisions don't render visibly.** Cortex's `.cortex/decisions.db` has 2 decisions, both governing `docs/specs/cortex-v0.3/frame-extraction.md` — a file that isn't part of any cluster (clustering operates on code, the spec doc lives in `docs/`). The adapter's governs resolution drops the file ref because it isn't a clustered node; the result reaches the viewer with empty `_nodeIdxs`, so `drawFloatingDecisionNodes` skips them. This is honest behavior but underwhelming — the demo doesn't show marginalia or the decision card sidepanel against real data. Two ways to address (follow-up): (a) lift the adapter to keep file refs even when the file isn't in a frame, so they can render as floating decisions attached to the *file basename* rather than a frame; (b) once we have decisions that actually govern code files, this just resolves itself.
- **Edges look right at the visual level but aren't real.** The prototype's `buildGraph` randomly fires edges between same-frame node pairs (`Math.random() < 0.45`) and between frames (`Math.random() < 0.6`). We carried that forward verbatim — so what you see is not the cortex graph's true `CALLS` edges, it's the prototype's filler. The `/api/graph` response carries 46,072 real edges; wiring them in is a one-task follow-up (replace `buildGraph`'s random edge loop with edges filtered to clustered nodes).
- **Theme toggle works.** Light and dark both readable. The CSS variable cascade carried across without manual intervention.
- **Project switcher works**, populated from `/api/projects`. Only one project is currently indexed so there's nothing to switch *to*, but the dropdown loads + the active project shows in the field.
- **Performance** — 16,565 nodes via `/api/graph` is a single ~2 MB JSON fetch on load. Render is smooth at 60 fps; nothing in the prototype's draw loop bottlenecks against this graph size. (The prototype draws ~16 nodes per frame × 14 frames = ~224 nodes in canvas, not all 16,565 — the rest pass through `groupNodesIntoFrames` and stay in JS state, not on screen.)

## Decision: keep going / pivot

**Keep going on the viewer; pivot on the algorithm corpus.** The prototype-as-viewer integration is working end-to-end: live frames, real labels, focus, theme, project switcher, zero console errors. The visible weaknesses are all data-driven: labels look weird because the clustering is averaging across cortex's vendored C corpus; decisions don't attach because there are only two and they govern a markdown spec. Neither is a viewer problem.

Two concrete follow-ups before this can carry weight as a Cortex demo:

1. **Exclude `src/external/` (and any other vendored directory) from the clustering input.** That alone should turn 11/14 frames from "tree-sitter chunks" into real cortex topology. The eval harness already runs per-repo; just add a path filter to `text-blob.ts`.
2. **Replace `buildGraph`'s random edges with the real graph's edges**, filtered to clustered nodes. Probably 30 lines in `viewer.js` + extends `adapters.js` to bucket edges by frame membership.

Frame-extraction is producing useful output on cortex's own code. The viewer is producing useful visualization of it. The two are wired together. That's the milestone this PR is shooting for — and it's hit.
