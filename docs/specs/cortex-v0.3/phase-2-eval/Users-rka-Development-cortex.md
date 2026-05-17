# Phase 2 Eval — `tfidf+hdbscan` on `self/cortex`

Generated: 2026-05-17T14:19:14.054Z

## Cross-signal + sanity metrics

| metric | value |
|---|---:|
| total_files | 544 |
| cluster_count | 14 |
| noise_rate | 0.528 |
| co_change_agreement_strict | 1.000 |
| co_change_agreement_lenient | 0.108 |
| import_agreement_strict | 0.610 |
| import_agreement_lenient | 0.043 |
| cluster_elapsed_seconds | — |

> **Strict vs. lenient agreement.** Strict drops pairs touching the noise
> cluster from both numerator and denominator — it answers "of the pairs
> the algorithm was confident about, how many agreed?". Lenient counts
> noise-touching pairs in the denominator but never as agreement — closer
> to the spec's plain reading of "fraction of frequently-co-changing pairs
> landing in the same cluster". When `noise_rate` is high, the two diverge.

## Algorithm-internal metrics

| metric | value |
|---|---:|
| silhouette_score | 0.439 |
| vocabulary_size | 2504 |

## Cluster summary

| cluster | files | path prefix | top tokens | sample |
|---:|---:|---|---|---|
| 11 | 68 | `internal/indexer/` | tslexer lexer, parser tslanguage, tslexer, tslanguage, tslanguage ts, lexer | `internal/indexer/tools/tree-sitter-form/src/tree_sitter/parser.h`, `internal/indexer/tools/tree-sitter-magma/src/tree_sitter/parser.h`, `internal/indexer/vendored/grammars/bash/tree_sitter/parser.h` |
| 9 | 61 | `internal/indexer/` | erase _array__grow, grow _array__reserve, reserve _array__splice, array _array__assign, _array__swap swap, splice _array__swap | `internal/indexer/tools/tree-sitter-form/src/tree_sitter/array.h`, `internal/indexer/tools/tree-sitter-magma/src/tree_sitter/array.h`, `internal/indexer/vendored/grammars/bash/tree_sitter/array.h` |
| 3 | 21 | `internal/indexer/` | tre, vendored tre, vendored, indexer vendored, tnfa, foundation | `internal/indexer/src/foundation/compat.c`, `internal/indexer/src/foundation/compat.h`, `internal/indexer/src/foundation/compat_regex.c` |
| 10 | 19 | `internal/indexer/vendored/grammars/` | external create, deserialize, serialize, sitter external, scanner, external | `internal/indexer/vendored/grammars/c_sharp/scanner.c`, `internal/indexer/vendored/grammars/css/scanner.c`, `internal/indexer/vendored/grammars/dart/scanner.c` |
| 12 | 15 | `internal/indexer/vendored/grammars/` | sitter ts_lex, ts_lex ts, ts_lex, ts lex, lex, parser | `internal/indexer/vendored/grammars/cmake/parser.c`, `internal/indexer/vendored/grammars/css/parser.c`, `internal/indexer/vendored/grammars/dockerfile/parser.c` |
| 0 | 10 | `internal/indexer/src/pipeline/` | itoa, pipeline pass, pass, itoa_log, itoa_log itoa, itoa log | `internal/indexer/src/pipeline/pass_calls.c`, `internal/indexer/src/pipeline/pass_definitions.c`, `internal/indexer/src/pipeline/pass_githistory.c` |
| 6 | 10 | `(mixed)` | mcp server, mcp, server, server tools, register, tools | `internal/indexer/src/handlers/handlers.h`, `src/mcp-server/api.ts`, `src/mcp-server/qualified-name.ts` |
| 7 | 10 | `(mixed)` | viewer shared, shared, viewer, client, ws, edge | `src/viewer/shared/animation.js`, `src/viewer/shared/camera.js`, `src/viewer/shared/colors.js` |
| 8 | 9 | `internal/indexer/vendored/ts_runtime/src/` | vendored ts, ts runtime, runtime, ts, vendored, indexer vendored | `internal/indexer/vendored/ts_runtime/src/alloc.c`, `internal/indexer/vendored/ts_runtime/src/atomic.h`, `internal/indexer/vendored/ts_runtime/src/length.h` |
| 13 | 9 | `internal/indexer/vendored/grammars/` | ts_lex_keywords, lex ts_lex_keywords, ts_lex_keywords keywords, keywords, sitter ts_lex, ts lex | `internal/indexer/vendored/grammars/elm/parser.c`, `internal/indexer/vendored/grammars/erlang/parser.c`, `internal/indexer/vendored/grammars/form/parser.c` |
| 2 | 8 | `internal/indexer/extract/` | extract lsp, indexer extract, lsp, extract, ctx, stdlib data | `internal/indexer/extract/lsp/generated/c_stdlib_data.c`, `internal/indexer/extract/lsp/generated/cpp_stdlib_data.c`, `internal/indexer/extract/lsp/generated/go_stdlib_data.c` |
| 4 | 6 | `internal/indexer/vendored/mimalloc/` | mi, vendored mimalloc, mimalloc, page, arena, free | `internal/indexer/vendored/mimalloc/include/mimalloc/internal.h`, `internal/indexer/vendored/mimalloc/src/arena-meta.c`, `internal/indexer/vendored/mimalloc/src/arena.c` |
| 5 | 6 | `src/events/` | events, events worker, worker, mutation, msg, node | `src/events/types.ts`, `src/events/worker-supervisor.ts`, `src/events/worker.ts` |
| 1 | 5 | `internal/indexer/extract/` | walk, indexer extract, handle, extract, emit, try | `internal/indexer/extract/extract_defs.c`, `internal/indexer/extract/extract_env_accesses.c`, `internal/indexer/extract/extract_imports.c` |
