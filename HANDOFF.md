# Cortex — Session Handoff

## ✅ DONE (2026-06-24 — 1.0.0: consolidated tool surface + TODO entity foundation)

Shipped **1.0.0** via PR [#27](https://github.com/ruevu/cortex/pull/27) (merge
`1b9b378`) through the full design → plan → subagent-driven TDD → review → gated
release cycle. CI gate passed on the PR; worktree removed. **First major
version** — the per-release detail and the old→new tool migration table live in
[`CHANGELOG.md`](CHANGELOG.md); the architectural choices are decisions in Cortex
(`D-v2tc`, `D-r6xg`, `D-s72s`, `D-yb1b`, `D-87zb`).

- **Consolidated MCP tool surface (17 → 3).** `decision`, `pr`, and `todo` are
  now single, `action`-dispatched tools; the 17 old names (`create_decision`,
  `why_was_this_built`, `open_pr`, …) are **removed, not aliased** (clean break).
  Handler logic was extracted verbatim into `*Action` functions the dispatchers
  call — byte-parity contract tests guard that no behavior changed. `pr touch`'s
  inner `action` field is renamed `change`. This is field-report **P7(a)**.
- **TODO entity foundation** — the third user-authored primitive (future planned
  work). Durable storage in the primitives DB (`todos`/`todo_links`/`todos_fts`,
  `T-` ids, reusing the `id_sequences` mint), `TodoService` with a table-driven
  state machine (`open → in_progress → blocked → done/cancelled`), the `todo`
  MCP tool (`propose`/`get`/`list`/`search`/`update`/`link`/`transition`), and
  full HTTP-contract parity (`AdaptedTodo` + pure `api-todos.ts` adapter +
  `GET /api/todos` + drift-guarded `docs/api/todos.schema.json`). Shared
  `validatePrimitiveFields` across decisions + todos.
- **Verification:** full suite **1342/1342** green; dev-server smoke
  (`/api/health` + `/api/todos` → 200, `version:1`); Gate-1 review clean.

> ⚠ The MCP server only exposes the new `decision`/`pr`/`todo` tools after a
> restart (it loads `src/` once at startup). Old-name calls will fail until then.

**Prior release, still current:** **0.9.0** — the versioned, Zod-enforced HTTP
contract + hardening (field-report **P6**): single-source schemas in
`api-schemas.ts`, `version` on every response, freshness via `X-Cortex-Freshness`
+ `/api/freshness` + ETag/304, `/api/health`, env-gated hardening (loopback bind,
CORS allowlist, opt-in bearer auth, traversal guard). Decision `D-tszm`;
[onboarding](docs/architecture/http-api-contract.md).

## ▶ NEXT STEP

In rough priority order (full state in
[`docs/specs/progress.md`](docs/specs/progress.md)):

1. **TODO viewer slice** — render the now-durable TODO data: yellow dots, the
   drawer surface, marginalia pills, decision→TODO leader lines, the
   decision-drawer "Tasks" section. The `/api/todos` contract already feeds it;
   only the pixels remain. **Fold in the GOVERNS qn-classification fix** while in
   `src/todos/` (see below).
2. **TODO hooks + external bridge** (later slice) — `PostMergeHook`
   auto-completing `resolvedBy` TODOs on PR merge; `PostDecisionHook` linking
   `spawnsFrom`; Linear/JIRA/GitHub mirroring (bidirectional sync is v1.5).
3. **Frame-quality + Louvain `concern` axis** (larger) — the upstream fix for
   fragmented/test-mixed clusters and substrate-band core domain (`SRC·863`
   mega-frame), the ceiling the taxonomy observe phase repeatedly hit. Deferred
   in `D-8vbv`.
4. **Remaining agentic-experience items** (2026-06-12 field report): **P4**
   warm-path decision drafting, **P5** cross-repo decision search, **P7(b/c)**
   tighten tool descriptions / lazy-load the long tail, **P8** temporal
   `changes_since`. (P1/P2/P3/P6 shipped; P7(a) shipped in 1.0.0.)

**Known latent issue to fix (pre-existing, low-severity).** `classifyTarget` in
both `src/decisions/service.ts` and `src/todos/service.ts` uses
`includes("/") ? "path" : "qn"`, so a real qualified name (`dir/file.ts::sym`,
always contains `/`) is misclassified `"path"` and silently dropped by
`resolveGovernsRef` in the HTTP API. The TODO code mirrors decisions exactly (not
a 1.0.0 regression) — a cross-primitive fix (check `::` first) is worth doing
before the TODO viewer slice depends on it.

**Parallel, non-blocking:** the **co-change lens** (`FILE_CHANGES_WITH` minus
structural edges = hidden coupling, as a sibling row in the layers menu); the
deferred 3b test follow-ups (multi-layer promotion test, zero-score floor edge
case); **mesh** (separate repo, waiting on Figma): faithful viewer adaptation +
threads-to-top, and it must migrate off the 17 old tool names per the CHANGELOG
table.

---

_Prior handoff content is superseded-and-stable: the **frame-layers taxonomy
arc** (0.8.4–0.8.23, classify → observe → enable → layout), the **search-noise
line** (0.8.11–0.8.14, P2), the **graph-DB transactional-swap publish** (`D-47xb`),
and the **freshness signal + auto-refresh** (`bbf0fce5`) all shipped, verified,
and documented in [`CHANGELOG.md`](CHANGELOG.md),
[`docs/specs/progress.md`](docs/specs/progress.md),
[`docs/architecture/graph-storage.md`](docs/architecture/graph-storage.md), and
the decision store._
