# Design — Cross-Language Contract Edges (RPC seam first)

**Type:** Design spec.
**Date:** 2026-06-07
**Author:** Claude (Opus 4.8, 1M context) + rka
**Status:** Approved (brainstorming) → pending implementation plan.
**Motivation:** [2026-06-07 research report](../../research/2026-06-07-label-quality-verdict-and-rendering.md) closing note + the session's tool-use assessment: the graph isn't reached for because grep is a complete substitute for everything it does *today*. The one class it can't do — and the one that bit us (`detect_changes`) — is **cross-language contract** tracing.

---

## Problem

Cortex's graph models code symbols and call edges within a language. But the changes that most need impact analysis often cross a **language boundary**, and there the graph is blind, so the agent falls back to grep:

- The whole indexer is wired across a C↔TS seam. TS callers do `callIndexer("<tool>", { <keys> })` (e.g. [code-tools.ts:450](../../../src/mcp-server/tools/code-tools.ts#L450)); the binary dispatches by tool name to `handle_<tool>` in [handlers.c](../../../internal/indexer/src/handlers/handlers.c), which reads args by key via `ctx_mcp_get_string_arg(args, "<key>")`.
- The `detect_changes` bug (HANDOFF #4 / decision noted) is exactly a **key-set mismatch** across that seam: TS now sends `{ repo_path }`, but `handle_detect_changes` still reads `project` → `get_project_root(srv, NULL)` → "project not found". Grep can string-match `detect_changes` but cannot tell that the *sent* keys and *read* keys are disjoint, cannot follow it across languages, and cannot distinguish a real reference from a coincidence.

The graph should make that contract a **first-class, queryable fact** — both for impact traversal and for a mechanical mismatch check.

## Goals

1. **Cross-boundary traversal.** `query_graph` / `trace_path` can answer "what consumes RPC tool X" and "what handler provides it" across the C↔TS seam.
2. **Mechanical contract check.** A check surfaces arg-key mismatches (sent-but-not-read, required-but-not-sent) — i.e. it would have flagged `detect_changes`.
3. **Reached-for by the agent.** The check is exposed as an MCP tool, so it's invoked mid-task when about to change a contract — not just a CI guard.
4. **Trustworthy (self-knowledge).** The extractor reports its own coverage (anchors found, providers, consumers, unmatched, unrecognized shapes) so a "no mismatches" result is believable, not blind.
5. **Generalizable foundation.** The data model is a general anchor/shared-key shape so event-name and config-key contracts can be layered on later with no rework — but only the RPC convention is extracted now.

## Non-goals (explicit YAGNI)

- Event-name, config-key, or route-string anchors (the model supports them; we don't extract them yet).
- A typed/generated shared contract manifest that both sides are checked against (Approach C — a dispatch-layer refactor; noted as future work).
- Filling the stubbed `get_architecture(mode='cross_service')` C handler (it stays a stub; the new check is TS-native).
- Type-level checking (we compare *key presence*, not value types).

## Approach

**A on B's foundation** (chosen over A-only, B-first, and C). Build the targeted RPC-contract extractor and check now, but represent results as a general anchor/shared-key model so the mechanism generalizes. Extraction lives in TS (post-index pass), not in the C binary.

### Data model (general)

Two additions to the property graph, written into `.cortex/db`:

- **`Anchor` node** — a named cross-boundary key.
  `{ label: "Anchor", key: "detect_changes", kind: "rpc_tool" }`. `kind` is the extension point (`"event"`, `"config_key"`, … later).
- **`BINDS_KEY` edge** — from a code node (function / call site) **→ `Anchor`**, with properties `{ role: "provides" | "consumes", keys: string[] }`.
  - C `handle_detect_changes` → `BINDS_KEY(role="provides", keys=["project"])` → Anchor `detect_changes`.
  - TS `callIndexer("detect_changes", { repo_path })` site → `BINDS_KEY(role="consumes", keys=["repo_path"])` → Anchor `detect_changes`.

A "contract" is an `Anchor` plus its `BINDS_KEY` edges. The bug becomes a graph fact: consumer `{repo_path}` vs provider `{project}` — disjoint.

> **Assumption to confirm in planning:** new label/relation values reuse the existing generic nodes/edges tables (the store is a property graph queried by Cypher), so no DDL migration is needed — only new rows. Verify with `get_graph_schema` before building. If a migration *is* required, it's an additive one.

### Extractor — TS post-index enrichment pass

A new pass under **`src/contracts/`** (sibling in spirit to `frame-extraction`'s `inject-frames`), run in the **same post-index phase** as frame injection, for both the CLI and MCP `index_repository` paths. It:

1. Queries the graph for candidate sites — `handle_*` C functions and `callIndexer` TS call sites — to get each one's file + line span. (Falls back to a file scan of the known dirs if the graph lacks call-site nodes; confirm node availability in planning.)
2. Reads source **within each span** and matches the two known shapes:
   - **TS consumer:** `callIndexer("<tool>", { <key>: … , … })` → `{ tool, keys, role: "consumes" }`. Also handle the `callIndexerCache` variant.
   - **C provider:** within `handle_<tool>`, each `ctx_mcp_get_{string,int,bool}_arg(args, "<key>")` → accumulate `{ tool, keys, role: "provides" }`. Tool name derived from the `handle_<tool>` symbol and/or the dispatch table.
3. Upserts `Anchor` nodes and `BINDS_KEY` edges into the graph DB (idempotent — like inject-frames, re-running replaces prior anchors for the repo).
4. Emits a **coverage summary** (counts; see Goal 4). Unrecognized call shapes are skipped and counted, never fatal.

Extraction logic is split into **pure functions** (string span → parsed contract) from the **graph I/O** (upsert), so the parsing is unit-testable without a DB.

### Surfacing

- **Traversal:** the persisted `BINDS_KEY` edges + `Anchor` nodes are immediately queryable via `query_graph` (Cypher) and reachable by `trace_path`, so "who consumes tool X across the boundary" works as a general capability.
- **`check_contracts` MCP tool (TS-native, in `src/mcp-server/`):** reads the **persisted** anchors/edges from `.cortex/db` (the graph is the source of truth; results are therefore as fresh as the last index — the general staleness limitation, out of scope here), and for every `Anchor` with both a provider and a consumer, diffs the key sets. Returns, per contract: `provider_keys`, `consumer_keys`, `missing_on_provider` (sent but never read — the `detect_changes` shape), `missing_on_consumer` (read but never sent), and a `status` (`ok` | `mismatch`). Plus a top-level **coverage** block and one-sided anchors flagged as warnings (handler with no caller / caller with no handler). Requires `repo_path` per the MCP contract.
- **Regression guard:** a test (à la [decisions-cross-repo-isolation.test.ts](../../../tests/regression/decisions-cross-repo-isolation.test.ts)) runs the extractor + diff over the cortex repo and asserts **zero mismatches** — a living guard that fails on the next contract break. (Until `detect_changes` itself is fixed, this test documents the known mismatch via an allowlist of one, removed when HANDOFF #4 lands — so the guard goes green honestly.)

### Error handling

- Unrecognized call shapes → skipped, counted in coverage (not a crash, not a silent drop).
- One-sided anchors → warning, not failure (dead handler or missing handler is informative, not necessarily wrong).
- Malformed source / unparseable span → that site skipped + counted; the pass never aborts indexing (mirrors inject-frames' resilience).

### Testing (TDD)

- **Pure unit tests:** `parseTsConsumer(spanSrc) → {tool, keys}`; `parseCHandler(spanSrc) → {tool, keys}`; `diffContract(provider, consumer) → {missing_on_provider, missing_on_consumer}`. Cover the `detect_changes` case, exact-match case, extra/missing keys, and unrecognized shapes.
- **Coverage report unit test:** counts add up; one-sided anchors flagged.
- **Real-repo regression test:** runs over the cortex repo; asserts the contract set is non-empty (extractor actually found the seam) and mismatches == the known allowlist (→ empty once `detect_changes` is fixed). This is the proof-on-the-actual-bug.

## Scope summary

**In:** `Anchor`+`BINDS_KEY` schema; TS post-index extractor for the RPC convention (pure parse + idempotent graph upsert); coverage report; `check_contracts` MCP tool; regression guard; the boundary edges being query/trace-able.

**Out (named follow-ups):** event/config/route anchors; `cross_service` mode fill; typed contract manifest (Approach C); value-type checking.

## Future work

- Layer additional `kind`s onto the same `Anchor`/`BINDS_KEY` model (event names, config keys) — the string-key-contract lever.
- Fix `detect_changes` (HANDOFF #4); then drop the regression allowlist.
- Consider the typed manifest (Approach C) for the RPC layer specifically if key-presence checking proves insufficient and value-type drift becomes a problem.

## Open questions for planning

1. Does the graph already store `callIndexer` **call-site** nodes (with spans), or only function defs? Determines step 1 of the extractor (graph query vs. scoped file scan). Verify with `search_graph`/`get_graph_schema`.
2. Exact post-index hook point shared by CLI and MCP `index_repository` (where inject-frames runs) — wire the pass there.
3. New-label/relation persistence: confirm no DDL migration needed (assumption above).
