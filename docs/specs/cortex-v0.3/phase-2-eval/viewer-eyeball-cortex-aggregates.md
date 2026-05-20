# Viewer Eyeball Check — aggregates on cortex

Generated: 2026-05-18

Follow-up to [viewer-eyeball-cortex-aux-exclude.md](./viewer-eyeball-cortex-aux-exclude.md).
PR #12 excluded auxiliary paths from clustering — that left ~340 cortex files
invisible. This PR renders them as **aggregate bare dots** along a strip at
the bottom of the canvas (spec §"Two content streams").

Source data:
- API: `GET /api/aggregates?project=Users-rka-Development-cortex` → 12 aggregates
- Viewer screenshot: [.playwright-mcp/aggregates-overview.png](../../../../.playwright-mcp/aggregates-overview.png)

## Aggregate inventory

| label | count | sample |
|---|---:|---|
| `grammars` | 270 | `internal/indexer/vendored/grammars/sql/scanner.c` |
| `mimalloc` | 41 | `internal/indexer/vendored/mimalloc/src/static.c` |
| `ts_runtime` | 31 | `internal/indexer/vendored/ts_runtime/src/lib.c` |
| `tre` | 19 | `internal/indexer/vendored/tre/tre-match-utils.h` |
| `sample-project` | 4 | `tests/fixtures/sample-project/src/router.ts` |
| `generated` | 3 | `internal/indexer/extract/lsp/generated/cpp_stdlib_data.c` |
| `lz4` | 2 | `internal/indexer/vendored/lz4/lz4.c` |
| `nomic` | 2 | `internal/indexer/vendored/nomic/code_vectors.h` |
| `sqlite3` | 2 | `internal/indexer/vendored/sqlite3/sqlite3.h` |
| `simplecpp` | 1 | `internal/indexer/vendored/simplecpp/simplecpp.h` |
| `xxhash` | 1 | `internal/indexer/vendored/xxhash/xxhash.c` |
| `yyjson` | 1 | `internal/indexer/vendored/yyjson/yyjson.h` |

## Observations

- **12 dots render in a horizontal strip** at the bottom of the canvas, sized by `sqrt(member_count)`. `grammars` (270) is visibly the largest.
- **The strip is spatially separated from frames.** Grid layout reserves 90px at the bottom of the canvas so frame boxes never overlap the aggregate dots.
- **`generated` aggregate captures `internal/indexer/extract/lsp/generated/*.c`** — files we explicitly stripped out so they don't pollute clustering, but now they're visible to the user as a marker of "yes, generated code exists here." This is exactly what the spec calls out: aggregates make the filtered content legible without re-pollluting frames.
- **`sample-project` aggregate (4 files) is a test fixture.** That's a `fixtures` auxiliary segment hit. Correct.
- **Frame focus, theme toggle, project switcher all continue to work.** Zero console errors.
- **Hover/click affordances are not wired** — clicking a dot does nothing. The spec calls for a "drawer with member list" on click; that's the natural next step but not in this PR.

## Decision

**Ship.** The auxiliary content is now visibly accounted for. The viewer answers two questions cleanly:
1. "What is this repo about?" → frames (`server`, `pipeline pass`, etc.)
2. "What does this repo ship alongside its code?" → aggregates (`grammars`, `mimalloc`, etc.)

Per the spec, clicking an aggregate should open a drawer with the member list. That's the next follow-up for aggregate-side polish.
