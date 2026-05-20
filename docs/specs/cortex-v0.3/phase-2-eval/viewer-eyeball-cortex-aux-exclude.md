# Viewer Eyeball Check — cortex frames after auxiliary exclusion

Generated: 2026-05-18

Follow-up to [viewer-eyeball-cortex.md](./viewer-eyeball-cortex.md). PR #11
shipped the viewer wired to live data but flagged that 11 of 14 frames were
labeled from vendored C source (tree-sitter grammars, lz4, mimalloc, etc.) —
algorithm faithfully reflecting cortex's actual corpus but not a useful
demo of cortex's *own* code. This run filters auxiliary paths per the
spec's §"Two content streams" Group A.

Source data:
- Cluster: `.tmp/frame-extraction/clusters/Users-rka-Development-cortex.json`
  (TF-IDF + HDBSCAN + co-change, γ = 0.3)
- Auxiliary filter: `internal/indexer/vendored/`, `dist/`, `build/`, etc.
  (defaults in [scripts/frame-extraction/auxiliary-detection.ts](../../../../scripts/frame-extraction/auxiliary-detection.ts))
- Viewer screenshot: [.playwright-mcp/aux-exclude-overview.png](../../../../.playwright-mcp/aux-exclude-overview.png)

## What changed in the data

| metric | before (PR #11) | after (this PR) |
|---|---:|---:|
| Files entering clustering | 16,565 | ~14,500 (vendored stripped at blob layer) |
| Files in non-noise clusters | 243 | 96 |
| Non-noise clusters | 14 | 5 |
| Noise count | 287 | 141 |
| Top frame label | `tslexer lexer` (67) | `server` (51) |
| Frames named for cortex subsystems | 3/14 | 5/5 |

## Frame inventory

| frame | size | contents |
|---|---:|---|
| `server` | 51 | cortex's TS server: `src/`, `src/events/`, `src/ws/`, `src/decisions/`, `src/mcp-server/` |
| `pipeline pass` | 11 | indexer's pass-pipeline: `internal/indexer/src/pipeline/pass_*.c` |
| `indexer tools` | 11 | indexer's tools/: `internal/indexer/tools/**` |
| `indexer foundation` | 5 | indexer's core foundation: `internal/indexer/extract/foundation/**` |
| `indexer extract` | 4 | indexer's extract subsystem: `internal/indexer/extract/{extract_defs.c,lsp/**}` |

Every frame is now a recognizable cortex subsystem. Labels match what you'd write on a whiteboard.

## Observations

- **The `server` frame is the heaviest at 51 files, drawing all of `src/`.** This is technically one frame in the algorithm output but covers what a human would split into ~4 sub-frames (events, ws, decisions, mcp-server). That's tuning territory — `min_cluster_size` or `min_samples` on HDBSCAN — not an auxiliary-detection problem.
- **The grid layout is comfortable at 5 frames.** No clipping at the top edge (every frame has room for its label). The `server` frame visually dominates because its sqrt(count) scaling earns it the most cell space.
- **No more tree-sitter junk** — `tslexer lexer`, `erase _array__grow`, `tre`, `sitter ts_lex`, `itoa`, `walk`, `extract lsp` and friends are gone. Those frames were 192 files of vendored grammar code being treated as cortex's domain.
- **Decisions still don't visibly attach** — same as PR #11. Cortex's 2 decisions govern `docs/specs/cortex-v0.3/frame-extraction.md`, which is a markdown spec and so is excluded from frame membership. Decision marginalia + cards will need test data (or a hand-written cortex decision that governs a code file) before this demos well.
- **Edges are still the prototype's random ones** — same caveat from PR #11. Wiring real `CALLS` edges is the next follow-up chunk.

## Decision

**Ship.** Auxiliary-detection is a small change with high payoff: it converts a vaguely-suggestive demo into a recognizable cortex map. The implementation follows the spec verbatim (Group A path patterns) and is reusable for other indexed repos (custom segment sets pluggable per call site).

Next chunk: real edges. The graph DB has 46k real edges; replacing `buildGraph`'s `Math.random()` with a filtered edge bucket will make inter-frame connections informative (does `server` actually talk to `pipeline pass`? to `indexer extract`? right now you can't tell).
