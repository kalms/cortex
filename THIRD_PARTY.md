# Third-Party Attribution

Cortex incorporates code from a number of upstream projects. We are grateful
to the authors and maintainers of these projects for making their work freely
available.

## Licensing summary

Cortex is split into two licensing zones:

- **`internal/indexer/`** — derivative of
  [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp).
  Governed by the **MIT License**; see [`internal/indexer/LICENSE`](./internal/indexer/LICENSE).
- **Everything else in this repository** — Cortex's TypeScript code, viewer,
  MCP server, decision tooling, build scripts, plugin manifest, documentation,
  etc. **Proprietary, all rights reserved**; see the root [`LICENSE`](./LICENSE).

Vendored C libraries inside `internal/indexer/vendored/` retain their own
licenses (MIT, BSD-2-Clause, Apache-2.0, Public Domain, EPL-1.0 — see the
table below) and are unaffected by either of the above; their per-directory
`LICENSE` and in-source notice files remain authoritative for source-level
license tooling and downstream packagers.

This document is the single consolidated source of attribution for the Cortex
repository.

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

### Additional vendored sources (lineage: CBM)

These four sit alongside the libraries above in `internal/indexer/vendored/`
and were inherited from the upstream CBM tree:

| Library              | Used for                                    | License       | Source                                                                         |
| -------------------- | ------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| tree-sitter runtime  | Incremental parser runtime                  | MIT           | `internal/indexer/vendored/ts_runtime/` (Max Brunsfeld, 2018)                  |
| tree-sitter grammars | Per-language generated `parser.c`/`scanner.c` for ~60 languages | MIT (Clojure: EPL-1.0; FORM and Magma: MIT, custom to DeusData) | `internal/indexer/vendored/grammars/<lang>/` |
| LZ4                  | Block compression for cache pages           | BSD-2-Clause  | `internal/indexer/vendored/lz4/` (Yann Collet, 2011-2023)                      |
| simplecpp            | C/C++ preprocessor (for extraction passes)  | Per upstream simplecpp project (see in-source header in `simplecpp.h`) | `internal/indexer/vendored/simplecpp/` |

A full per-grammar table (upstream repo, copyright, license) is preserved in
the upstream CBM `THIRD_PARTY.md` history; the same grammars now live under
`internal/indexer/vendored/grammars/<lang>/`. Each grammar's upstream
`LICENSE` accompanies its `parser.c` where the upstream project provided
one. The grammar list and licenses (unchanged from upstream) are summarised
here:

- Most grammars: MIT (tree-sitter org and `tree-sitter-grammars/` org).
- `clojure`: EPL-1.0 (compatible with MIT for downstream consumption).
- `form` and `magma`: custom grammars authored by DeusData, MIT.
- `matlab`: MIT, © Alan Cristoffers.
- `wolfram`: MIT, © LumaKernel.
- `lean`: MIT, © Julian Samarrasinghe.

## Notes

- The vendored libraries' own `LICENSE` and in-source notice files inside
  `internal/indexer/vendored/<lib>/` are the authoritative per-component
  licenses. This document is a consolidation, not a replacement.
- Cortex as a whole is proprietary (all rights reserved); see the root
  `LICENSE`. The MIT terms apply only to the derivative indexer code in
  `internal/indexer/` (per `internal/indexer/LICENSE`) and to those vendored
  libraries whose individual licenses are MIT.
