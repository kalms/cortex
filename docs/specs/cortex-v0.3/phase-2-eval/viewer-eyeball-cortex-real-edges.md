# Viewer Eyeball Check — real edges on cortex

Generated: 2026-05-18

Follow-up to [viewer-eyeball-cortex-aggregates.md](./viewer-eyeball-cortex-aggregates.md).
PRs #11/#12/#13 wired the viewer to live data with the prototype's
`Math.random() < 0.45` edge generator still in place — every line was
visual filler. This PR replaces it with **real CALLS edges** aggregated
to file-level, weight-thresholded and opacity-scaled.

Source data:
- API: `GET /api/file-edges?project=Users-rka-Development-cortex`
- Viewer screenshot: [.playwright-mcp/real-edges-overview.png](../../../../.playwright-mcp/real-edges-overview.png)

## Pipeline

1. Server reads all CALLS edges between function/method nodes (7,822 on cortex).
2. Aggregates by `(source_file_path, target_file_path)` — undirected, dedup by `min(a,b) < max(a,b)`.
3. Threshold: weight ≥ 2 (single one-off calls dropped as noise).
4. Returns 657 file-pairs (full project, including auxiliary).
5. Viewer drops pairs where either endpoint isn't on canvas (auxiliary, noise, or in 17+ position of its frame's 16-cap).
6. `drawEdges` scales opacity by `sqrt(weight / max_weight)` so heavy CALLS read visibly heavier.

## Observations

- **`server` frame is densely connected internally.** Heavy edges concentrate on the left side — `src/decisions/*`, `src/events/*`, `src/index.ts`, `src/mcp-server/*` calling each other. Reflects cortex's TS server actually being a tight system.
- **`pipeline pass` frame has light intra-connectivity.** Each `pass_*.c` file is roughly independent (which is the design — pipeline passes operate independently and dispatch through a shared core).
- **`indexer foundation` has intra-frame edges + at least one inter-frame edge** going to `server` and to `pipeline pass`. That's the foundation library being used by both higher-level systems. Real semantic signal.
- **`indexer extract` is visually disconnected** from anything in this view. With only 4 files visible (out of 4 clustered) and weight≥2 thresholding, none of its CALLS to other frames hit two clustered files. Honest result, not a viewer bug.
- **`indexer tools` is mostly disconnected.** Tools are independent CLI utilities — they don't call each other. Sparse-by-design.
- **Top file-pair edges in the data are all `.c ↔ .h` pairs in vendored code** (yyjson 186, xxhash 97, lz4 55, etc.). All filtered out at the canvas level because their files are in aggregates, not frames. The visible edges in frames are the cortex-meaningful ones.
- **Zero browser console errors.** Frame focus, theme toggle, aggregate strip all continue to work.

## Decision

**Ship.** Real edges replaced visual filler with information that maps to actual code coupling. Frames that *should* be tight (the TS server) read tight; frames that *should* be sparse (independent pipeline passes, independent tools) read sparse; cross-frame edges show actual dependencies rather than randomness. The single most informative cortex view we've had.

Follow-ups (deferred):
1. **Hover on an edge** to see the underlying file pair + weight.
2. **Drill-in for aggregates** — click `grammars` to see member list.
3. **Direction** — CALLS is directed; current rendering is undirected. Arrows would add information at the cost of visual density.
4. **Other relations** — `IMPORTS`, `USAGE`. Currently only `CALLS`.
