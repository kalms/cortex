# MCP Tool Contract Repair — Verifiable Correctness for Every Tool

**Date:** 2026-04-20
**Status:** Proposed
**Scope label:** Project A (precedes Project B — Cold-start reliability)

## Problem

The `feature/viewer/layout-redesign` branch landed ~3,880 lines of new code over six days while the CBM graph index remained frozen at 2026-04-14. During that work, Cortex's own MCP tools were never used to assist implementation — the very premise of the project. Three interacting causes:

1. **Silent staleness.** `search_graph("forceGovernance") → No results found` is indistinguishable from "the function does not exist." An LLM session cannot tell when it should re-index vs. when it should stop looking.
2. **Broken tools.** `detect_changes` — the tool whose job is to signal staleness — returns `"project not found"` even when `list_projects` confirms the project exists. `get_code_snippet` returns `"No code entity found"` for inputs the documentation advertises.
3. **Untested tool contracts.** No integration tests exercise the MCP surface. The existing `tests/graph/cbm-attach.test.ts` hand-rolls a fixture DB using `src/server.ts::handleRequest` — the colon-form qualified name — but the real CBM binary produces `<project>.src.server.handleRequest` — dotted form. Tests passed; production lied.

Result: Claude sessions see "No results," fall back to `Grep`/`Read`, complete tasks without the graph, and never discover that the graph is broken.

## Goal

Every MCP tool exposed by `src/mcp-server/` has a correctness contract expressed as a Zod schema, is tested against that contract via an integration harness that exercises the real binary and real SQLite layer, and fails loudly — not silently — when the contract is violated.

This is project A of a two-part repair. Project B (cold-start reliability — auto-reindex, staleness warnings wired into session start) is out of scope here and depends on A.

## In Scope

- Audit and fix every tool in:
  - `src/mcp-server/tools/code-tools.ts` (10 tools)
  - `src/mcp-server/tools/decision-tools.ts` (7 tools)
  - `src/mcp-server/tools/promotion-tools.ts` (1 tool)
- Qualified-name normalizer module (`src/mcp-server/qualified-name.ts`), pure functions with exhaustive test table.
- Shared response contract module (`src/mcp-server/response.ts`) — Zod schemas for `SuccessResponse | NoResultsResponse | ErrorResponse` and constructor helpers.
- MCP contract test suite (`tests/mcp-contract/`) — fixture-backed, indexes via real `bin/codebase-memory-mcp` at suite setup, invokes tools through an in-process MCP client/server pair.
- Fixture repo (`tests/fixtures/sample-project/`) — 3–5 small TS/JS files with known symbols and `CALLS` edges, plus one markdown file for `Section` coverage.
- One Cortex decision record capturing the qualified-name normalization rule.

## Out of Scope

- **Project B: cold-start flow** — auto-reindex on session start, freshness signal wired into tool responses, hook integration. Built on top of A.
- **CBM Go binary changes.** Upstream lives in `kalms/cortex`. If a bug is unambiguously binary-side, the harness test lands asserting the desired behavior, fails, and a ticket opens against the upstream repo. No TS-side workaround unless it blocks all downstream tests.
- **Any change to the decision-capture pipeline, viewer, event stream, or WS server.**
- **`list_projects` name format cosmetic cleanup** (`Users-rka-Development-cortex` → `cortex`). Noted but deferred.

## Architecture

### Shared contract layer

```
src/mcp-server/
├── response.ts       ← Zod ResponseSchema + ok() / empty() / error() helpers
├── qualified-name.ts ← normalize() / denormalize() pure functions
├── server.ts         (unchanged)
├── api.ts            (unchanged)
└── tools/
    ├── code-tools.ts       ← uses response.ts + qualified-name.ts
    ├── decision-tools.ts   ← uses response.ts
    └── promotion-tools.ts  ← uses response.ts
```

### Response contract

All tool handlers return one of three shapes, each a Zod schema in `response.ts`:

- **SuccessResponse** — `{ content: [{ type: "text", text: "..." }] }`. Data found.
- **NoResultsResponse** — Content text starts with the stable prefix `"No results:"`, followed by the query that returned empty. LLM-readable; programmatically detectable by prefix.
- **ErrorResponse** — `{ isError: true, content: [{ type: "text", text: "ERROR reason=<slug>: <detail>" }] }`. MCP's native error channel. Reason slugs are a closed set: `project_not_found`, `binary_failed`, `malformed_input`, `internal_error`, `fs_error`.

Every tool wraps its handler body through the helpers:

```ts
// Before
return { content: [{ type: "text" as const, text: "No results found." }] };

// After
return empty(`search_graph(name_pattern=${params.name_pattern})`);
```

Tests assert `ResponseSchema.parse(result)` — schema is contract, contract is test.

### Qualified-name normalizer

`src/mcp-server/qualified-name.ts` exports two pure functions:

```ts
normalize(input: string, project: string): string
// Colon form   "src/foo/bar.ts::baz"         → "<project>.src.foo.bar.baz"
// Member form  "src/foo.ts::Cls.method"      → "<project>.src.foo.Cls.method"
// Dotted form  "<project>.src.foo.bar.baz"   → unchanged
// Wildcard     "%baz%" or "src/foo.ts::%"    → normalized with wildcards preserved
// Malformed    ""                            → throws ValidationError

denormalize(stored: string, file_path: string): string
// Given "<project>.src.foo.bar.baz" + "src/foo/bar.ts"
// Returns "src/foo/bar.ts::baz"
```

Normalizer test table lives in `tests/mcp-contract/qualified-name.test.ts` with ~20 input/output pairs including malformed inputs that must throw, verified exhaustively.

### Test harness

**Layout:**
```
tests/
├── fixtures/
│   └── sample-project/           ← committed fixture repo
│       ├── src/
│       │   ├── server.ts         (handleRequest, parseBody)
│       │   ├── router.ts         (Router class, route method)
│       │   └── utils.js          (formatLog)
│       └── docs/guide.md         (## Overview section)
├── mcp-contract/
│   ├── setup.ts                  ← globalSetup: tmpdir, copy fixture, run binary, expose paths
│   ├── harness.ts                ← in-process McpServer + McpClient pair
│   ├── qualified-name.test.ts
│   ├── code-tools.test.ts
│   ├── decision-tools.test.ts
│   └── promotion-tools.test.ts
```

**Harness flow (globalSetup, runs once):**
1. Create tmpdir.
2. Copy `tests/fixtures/sample-project/` into tmpdir (isolation — no pollution of the committed fixture).
3. Spawn `bin/codebase-memory-mcp cli index_repository '{"path":"<tmpdir>"}'` against a tmpdir CBM DB path.
4. Export `{ fixturePath, cbmDbPath, projectName }` to `vitest.context`.

**Per-test flow:**
1. Open fresh `GraphStore` pointing at the tmpdir DBs.
2. Instantiate `McpServer`, register tool handlers.
3. Instantiate `McpClient` connected via the SDK's in-process transport (`InMemoryTransport` — verified during plan-writing; if unavailable, fall back to direct handler invocation with the same Zod assertions).
4. Call tools through the client. Assert via `ResponseSchema.parse(...)` and content equality/regex.

**Assertions per tool (four axes):**
1. **Happy path** — known input → known output (verbatim or regex).
2. **Empty-but-valid** — input that *should* return empty returns `NoResultsResponse` shape (stable prefix).
3. **Error path** — malformed input, binary failure, missing project → `ErrorResponse` with correct `reason` slug.
4. **Round-trip** (qualified-name tools only) — `search_graph` output → `get_code_snippet` input → valid snippet. This is the single most important assertion.

**Runtime budget:** < 15s for full suite. Index runs once (~2–5s). Each tool test ~50–100ms. 18 tools × ~4 assertions ≈ 72 assertions total.

**Subprocess tool tests:** `index_repository`, `detect_changes`, `delete_project` call the real binary with a 60s timeout. Skip (not fail) if `bin/codebase-memory-mcp` is absent — CI without the binary is expected to skip these, not block.

## Per-Tool Fix Summary

Tools marked **Fix** have a known contract bug. Tools marked **Audit** have no observed bug but get Zod schemas + smoke tests; audit during implementation may reveal issues that get folded in.

### code-tools.ts

| Tool | Status | Fix |
|------|--------|-----|
| `search_graph` | Fix | Normalize `qn_pattern` input via `normalize()`. Emit colon form in output via `denormalize()`. Empty → `empty()` helper with stable prefix. |
| `trace_path` | Fix | Define multi-hop contract: add `max_depth` param (default 3), return per-hop list with depth annotation. Normalize output to colon form. |
| `get_code_snippet` | Fix | Normalize input via `normalize()` before passing to `searchGraph({ qn_pattern })`. Header comment uses `denormalize()`. |
| `get_graph_schema` | Fix | Include per-label and per-edge-type counts (description promises "and their counts"; response omits). |
| `search_code` | Fix | Distinguish missing tooling (`rg` and `grep` both absent) from empty match. Missing tooling → `ErrorResponse` reason `internal_error`. Empty match → `NoResultsResponse`. |
| `list_projects` | Audit | Zod schema + smoke test. |
| `index_status` | Audit | Zod schema + smoke test. |
| `index_repository` | Audit | Subprocess test against fixture. |
| `detect_changes` | Fix | Default `path` to `process.cwd()` (mirror `index_status` line 201). If binary still fails, return `ErrorResponse` reason `project_not_found` with diagnostic detail (not silent error). |
| `delete_project` | Audit | Subprocess test: delete-and-reindex round-trip. |

### decision-tools.ts

All 7 tools (`create_decision`, `update_decision`, `delete_decision`, `get_decision`, `search_decisions`, `why_was_this_built`, `link_decision`) get the standard treatment: Zod schema + fixture-backed happy/empty/error tests. Any failures surfaced during implementation become additional fix entries. One test asserts the full lifecycle: create → get → update → link → search → delete.

### promotion-tools.ts

`promote_decision` — one round-trip test asserting state transition behavior against the fixture decision store.

## Decision record

As part of the spec delivery, land:

```ts
create_decision({
  name: "MCP qualified-name normalization",
  description: "Tool inputs accept colon form (src/file.ts::sym) or dotted form; outputs emit colon form. Internal SQL uses dotted stored form.",
  rationale: "DB stores dotted; docs, humans, and prior Claude sessions produce colon. Normalizer at the tool boundary reconciles both without breaking either.",
  alternatives: [
    "Dotted form only everywhere (rejected: forces every downstream consumer to learn DB shape)",
    "Separate resolve_symbol tool (rejected: adds a tool call to every lookup)"
  ],
})
link_decision({ decision_id: "<new>", target: "src/mcp-server/qualified-name.ts", relation: "GOVERNS" })
```

## Implementation Order

1. Write fixture repo (`tests/fixtures/sample-project/`) and verify it indexes cleanly with the binary.
2. Write `response.ts` — Zod schemas and helpers. Unit test.
3. Write `qualified-name.ts` — normalizer and denormalizer. Exhaustive test table.
4. Write test harness (`tests/mcp-contract/setup.ts` + `harness.ts`). Verify in-process MCP pair works; fall back to direct handler calls if `InMemoryTransport` is unavailable.
5. Fix code-tools.ts tools one at a time; each lands with its own contract test.
6. Fix/audit decision-tools.ts; lifecycle test.
7. Fix/audit promotion-tools.ts.
8. Land the decision record via `create_decision` + `link_decision`.
9. Re-index cortex itself; confirm tools now return current viewer-redesign symbols (`forceGovernance`, etc.). This is the smoke test for the whole effort.

## Success Criteria

- Every tool in `src/mcp-server/tools/*` has a Zod `ResponseSchema` and ≥ 3 integration tests (happy, empty, error). Round-trip test present for qualified-name tools.
- `detect_changes` returns a structured response against this repo — never the string `"project not found"` (success or `ErrorResponse`, both acceptable; silent prose-error is not).
- `get_code_snippet("src/mcp-server/tools/code-tools.ts::registerCodeTools")` returns the real snippet, not `"No code entity found"`.
- `npm test -- mcp-contract/` runs green in < 15s.
- A `create_decision` entry exists for the qualified-name normalization rule, linked to `src/mcp-server/qualified-name.ts`.
- Re-indexing this repo and re-running the exploration from the brainstorm session produces graph hits for `forceGovernance`, `adaptiveScale`, `derivePathGroups`, etc.
