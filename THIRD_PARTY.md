# Third-Party Attribution

Cortex incorporates code from a number of upstream projects. We are grateful
to the authors and maintainers of these projects for making their work freely
available.

This document is the single source of attribution for the Cortex repository.
Individual `LICENSE` files for each vendored library remain inside their own
directories (under `internal/indexer/vendored/` and
`internal/indexer/internal/cbm/vendored/`) so that source-level license tooling
and downstream packagers can still locate them.

## codebase-memory-mcp (CBM)

The native structural indexer at `internal/indexer/` originated as a fork of
[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp).
Significant portions of the C source — the tree-sitter parsing pipeline, the
SQLite storage layer (including the bulk-write fast path), the language
grammar selection logic, and graph-traversal helpers — were lifted from that
project and have since been adapted to write directly into Cortex's unified
`nodes`/`edges` schema.

The fork diverged from upstream in 2026 (absorbed via `git subtree` on
2026-05-04) and now lives entirely in this repository; upstream is no longer
tracked.

### Original CBM license

Reproduced verbatim from the upstream `LICENSE` file:

```
MIT License

Copyright (c) 2025 DeusData

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vendored C libraries

The indexer is built with zero system-library dependencies — all C
dependencies are vendored. Each library retains its own `LICENSE` file (or
in-source license header) inside its vendor directory.

| Library    | Used for                    | License            | Source                                                            |
| ---------- | --------------------------- | ------------------ | ----------------------------------------------------------------- |
| mimalloc   | Memory allocator            | MIT                | `internal/indexer/vendored/mimalloc/` (LICENSE in directory)      |
| nomic      | Code-embedding vocabulary + vectors (nomic-embed-code) | Apache-2.0 (upstream model weights / vocabulary) | `internal/indexer/vendored/nomic/` (vocab + pretrained vectors derived from `nomic-ai/nomic-embed-code`) |
| sqlite3    | Embedded database (storage) | Public domain      | `internal/indexer/vendored/sqlite3/` (notice in `sqlite3.h`)      |
| TRE        | Approximate regex matching  | BSD-2-Clause       | `internal/indexer/vendored/tre/` (LICENSE in directory)           |
| xxHash     | Fast non-cryptographic hash | BSD-2-Clause       | `internal/indexer/vendored/xxhash/` (notice in `xxhash.c`)        |
| yyjson     | JSON parser / writer        | MIT                | `internal/indexer/vendored/yyjson/` (notice in `yyjson.h`)        |

### Additional vendored sources under `internal/indexer/internal/cbm/vendored/`

Inherited from the upstream CBM tree and still built into the indexer:

| Library              | Used for                                    | License       | Source                                                                         |
| -------------------- | ------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| tree-sitter runtime  | Incremental parser runtime                  | MIT           | `internal/indexer/internal/cbm/vendored/ts_runtime/` (Max Brunsfeld, 2018)     |
| tree-sitter grammars | Per-language generated `parser.c`/`scanner.c` for ~60 languages | MIT (Clojure: EPL-1.0; FORM and Magma: MIT, custom to DeusData) | `internal/indexer/internal/cbm/vendored/grammars/<lang>/` |
| LZ4                  | Block compression for cache pages           | BSD-2-Clause  | `internal/indexer/internal/cbm/vendored/lz4/` (Yann Collet, 2011-2023)         |
| simplecpp            | C/C++ preprocessor (for extraction passes)  | Per upstream simplecpp project (see in-source header in `simplecpp.h`) | `internal/indexer/internal/cbm/vendored/simplecpp/` |

A full per-grammar table (upstream repo, copyright, license) is preserved in
the upstream CBM `THIRD_PARTY.md` history; the same grammars are still
vendored under `internal/indexer/internal/cbm/vendored/grammars/`. Each
grammar's upstream `LICENSE` accompanies its `parser.c` where the upstream
project provided one. The grammar list and licenses (unchanged from upstream)
are summarised here:

- Most grammars: MIT (tree-sitter org and `tree-sitter-grammars/` org).
- `clojure`: EPL-1.0 (compatible with MIT for downstream consumption).
- `form` and `magma`: custom grammars authored by DeusData, MIT.
- `matlab`: MIT, © Alan Cristoffers.
- `wolfram`: MIT, © LumaKernel.
- `lean`: MIT, © Julian Samarrasinghe.

## Notes

- The vendored libraries' own `LICENSE` and in-source notice files inside
  `internal/indexer/vendored/<lib>/` and
  `internal/indexer/internal/cbm/vendored/<lib>/` are the authoritative
  per-component licenses. This document is a consolidation, not a
  replacement.
- Cortex itself is released under the same terms as its upstream lineage
  (MIT). Contributions to Cortex are accepted under the same license unless
  otherwise noted.
