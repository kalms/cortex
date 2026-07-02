# Field Report — Whole-Project Technical Review & Due Diligence

**Date:** 2026-07-03
**Evaluator:** Claude (Fable 5), session in `/Users/rka/Development/cortex`
**Subject:** Cortex reviewing itself — a full-repo due-diligence pass at v1.2.6: code drift, verbosity vs. leanness, dead code, doc accuracy, test-suite health
**Method:** Six parallel read-only subagent reviews (mcp-server, entity stores, frames+viewer+events, CLI+hooks+glue, docs drift, test suite), each producing file:line findings, plus inline metrics (LOC, churn, decision-reconciliation backlog) gathered through Cortex's own MCP tools

Previous field reports evaluated Cortex as a tool on foreign repos or as a
platform under a consumer (Mesh). This one turns the instrument on itself:
after ~5 months and ~1,700 commits, is the codebase drifting, bloating, or
holding shape?

---

## TL;DR

1. **The codebase is in good health.** Zero critical rot across six deep
   reviews. Exactly one correctness bug found (non-transactional link
   replacement in the decisions/todos services). Architecture docs actually
   match the source — the drift that exists is administrative (stale status
   docs, shipped specs never archived), not structural.
2. **Cortex's own drift detector has an unread backlog.** 25 decisions sit
   in the reconciliation `pending` queue; `CORTEX_RECONCILE` has never been
   run in anger. The system detects drift correctly and nobody reads the
   verdicts. This is the single biggest "has the code drifted?" answer — and
   it is a process gap, not a code gap.
3. **Verbosity is real but bounded: ~700–900 LOC of code and ~3,000 lines of
   docs are trimmable.** The biggest single item is a layering drift, not
   duplication: ~600 LOC of viewer-layout math living in `src/mcp-server/`
   that belongs in `src/frame-extraction/`.
4. **Two areas are too lean, not too fat:** HTTP API routes (~40% test
   coverage) and the viewer (~20%, structurally untestable as a 2,635-line
   IIFE). Several suspected bloat areas came back *justified* — the CLI↔MCP
   split, the 21.4k-LOC test suite, and the 263-line prefer-cortex hook all
   survived scrutiny.

---

## 1. Quantitative baseline (v1.2.6, 2026-07-03)

| Metric | Value |
|---|---|
| Source (TS, `src/`) | 18,597 LOC |
| Viewer assets (JS/HTML/CSS) | 3,907 LOC |
| Tests | 21,414 LOC · 224 files · 1,541 cases · 100% green · ~16 s CI |
| Docs | ~8,500 LOC in `docs/` + 2,158 root-level |
| Runtime deps | 8 (lean) |
| Commits (Feb–Jul 2026) | ~1,700; June alone 783 |
| Graph | 4,657 nodes / 7,282 edges |
| Decision reconcile backlog | **25 pending** |

Largest + hottest file coincide: `src/mcp-server/tools/code-tools.ts`
(884 LOC, 71 commits in 3 months) — the natural first refactor target.

---

## 2. Has the code drifted?

### Code ↔ docs: barely

Load-bearing claims in `docs/architecture/*` were spot-checked against
source and **hold**: graph-storage staging-build + transactional publish,
decisions sidecar at `~/.cortex/<repoId>/decisions.db`, dual-ID scheme,
Zod-enforced HTTP contract with drift-guard test, two-thread event model,
sync-engine snapshot→catch-up→live protocol. README, tool surface, and all
four env gates (`CORTEX_FRESHNESS` / `CORTEX_AUTO_REFRESH` / `CORTEX_BRIEF`
/ `CORTEX_RECONCILE`) in CLAUDE.md are current.

The administrative drift:

- **HANDOFF.md** reflects May state (Plan 3 / T-rm5w status unrefreshed).
- **CHANGELOG.md preamble** still calls 0.9.0 "current" while the top entry
  is 1.2.6.
- **TEST.md** lists 6 of 11 test suites with counts frozen at write time —
  duplicates README's (accurate) table; delete or sync.
- **decisions-storage.md** understates migration entry points: the doc says
  graph→sidecar migration runs at one chokepoint; it actually runs from
  three call sites (repo-context, api, defensively in index_repository).
  Deliberate, but the doc should say so.
- **`docs/specs/cortex-v0.3/` (~2,800 lines) is shipped or abandoned
  reference material.** The four settled design notes (frame-extraction,
  frame-ranking, frame-layout, todo-entity) deserve promotion into
  `docs/architecture/`; the 919-line multiplayer spec, the backlog, and the
  research brief should be archived.
- **`docs/field reports/` has a space in its name** and it genuinely breaks
  tooling — it broke this review's own `wc` sweep on the first command.
  Rename to `field-reports/`.

### Code ↔ its own decision layer: unreconciled

`decision({action:"pending"})` returned **25 drifted decisions** (617 KB of
payload) spanning the viewer focus model, reflex layer, frame taxonomy,
staging-publish, and the grep hook. The working-tree-hash detection works;
the judging loop has never run because `CORTEX_RECONCILE` defaults off. One
flag-on session would clear the backlog and turn the feature from shipped
into used.

### Code ↔ intended layering: one real drift

~600 LOC of pure layout/positioning math lives in `src/mcp-server/` —
`floating-placement.ts` (333), `frame-layout.ts` (279), `frame-map.ts`
(221), plus the pair/flow rollups — consumed **only** by the HTTP viewer
routes in `api.ts`, and depending entirely on `frame-extraction` internals
(corpus index, ranking, diversity selection, kind classification).
`buildFrameMap` is a frame-extraction orchestrator wearing an MCP badge.
Move to `src/frame-extraction/positioning/`; no logic change required.

---

## 3. The one correctness bug

**Link replacement is not transactional.** `replaceLinks` in
`src/decisions/service.ts:119-130` and `src/todos/service.ts:176-182`
deletes old GOVERNS/REFERENCES links and inserts replacements as separate
statements with no `db.transaction()` wrapper. A crash mid-`update` leaves
an entity with half-replaced governance links — and governance links are
the contract that briefing, reconciliation, and `why` all key off. ~30 LOC
fix. The only must-fix finding in the review.

Correctness-adjacent seconds:

- **N+1 in `TodoService.getWithRefs`** (`src/todos/service.ts:111-128`) —
  `findBlocking` re-queries links `findByTodo` already fetched; filter
  in-memory instead (~3 LOC).
- **`LAYER_RGB` palette coupling** — `src/viewer/viewer.js:31-38` manually
  mirrors `frame-kind.ts`'s layer taxonomy. Next layer added without a sync
  = silently wrong legend colors. Needs a single runtime source (serve the
  palette with the frame data).
- **CI silent-skip risk** — 3 MCP-contract suites `skipIf(BINARY_MISSING)`.
  globalSetup guards the common path, but an explicit CI assertion that the
  binary-dependent suites actually ran would close the gap.

---

## 4. Verbosity ledger — where to get leaner

| Area | Finding | Trimmable |
|---|---|---|
| MCP tool layer | `RepoPathField` copy-pasted 6× across tool modules; identical try/catch/error-normalize boilerplate in 10+ action handlers; `AlternativeSchema`/`ProvenanceSchema` defined twice; freshness attachment duplicated between `registerTool` wrapper and `attachWhyFreshness` | ~200–300 LOC via shared `RepoPathField` + an `execAction()` wrapper |
| Frame labeling | Five-pass label-picking in `inject-frames.ts` (~260 LOC incl. relaxed-recovery pass with its own salience floor); passes 3–4 duplicate logic; correct but over-built with no recall/precision test set to defend it | ~100–150 LOC via a flatter parameterized algorithm |
| Entity stores | Three byte-identical `toDecision()` mappers (service/search/promotion); `DecisionLinksRepository` vs `TodoLinksRepository` near-twins with divergent method names; `classifyTarget()` one-line passthrough | ~50 LOC |
| Migrations | Graph→sidecar (~72 LOC) + in-repo relocation (~62 LOC) one-shots, flag-guarded but shipped forever | ~104 LOC — retire after a deprecation window (target 2026-12) |
| Tests | 556 raw `mkdtempSync`/`rmSync` setups; no shared fixture factory; hooks tests consolidatable | ~250–450 LOC |
| Dead code | `src/connectors/types.ts` (17 LOC, zero imports, Phase-2 stub); `findRecentToucher()` stub in viewer.js; `.card-scrim` CSS + HTML | ~25 LOC |
| Docs | v0.3 specs archive/promote; CLAUDE.md's reference-manual half duplicates docs/mcp-tools.md and architecture docs (trimmable to ~150-line routing instructions) | ~3,000 lines |

**Total realistic code trim: ~700–900 LOC (~4% of src+tests). Docs: ~3,000
lines.** This is a healthy number — high enough to be worth a cleanup
branch, low enough to confirm the codebase isn't bloating.

### Suspected bloat that survived scrutiny

- **CLI↔MCP split** — no duplicated business logic; both layers call shared
  services (`DecisionService`, `code-queries`). The split is earned:
  MCP owns routing/validation/event-bus, CLI owns process packaging.
  `decision-rehome.ts` is active with full test coverage, not cruft.
- **Test suite at 1.15:1 test:src ratio** — layered boundary testing (DB
  schema / service / MCP contract / HTTP / CLI), not redundancy. Tests
  assert behavior, not implementation (8-file sample). 16 s CI.
- **prefer-cortex.sh (263 lines)** — complex but degrade-safe (every
  failure path allows), heuristics have documented escape hatches. Known
  soft spots: shallow clones/worktrees in `git_root_of()`, and
  `first_path_token()` misreading a `/`-containing bare pattern; both
  fall through safely.
- **src/db/ (811 LOC)** — cohesive, no dead exports; `resolve-path.ts`
  (186 LOC) is dense but justified by real legacy fallback chains, though
  its branches lack direct tests.
- **src/contracts/, src/ids/, src/git/** — all fully wired, no dead code.

---

## 5. Where the project is too lean

| Area | Coverage | Gap |
|---|---|---|
| `src/mcp-server` HTTP layer | ~40% (2,418 test LOC vs 6,014 src) | `api.ts` routes, `floating-placement.ts`, `frame-layout.ts` under-tested |
| `src/viewer` | ~20% (645 vs 3,256) | Only live-effects has tests; `viewer.js` is a 2,635-line IIFE with closure state and no exports — untestable by construction |
| `resolve-path.ts` fallback chains | — | No tests over the legacy fallback branches; single point of failure for DB discovery |

The viewer monolith is the biggest forward risk: deferred work (PR/commit
event rendering — the event types are already defined in
`src/events/types.ts:87-125` and flowing through the log unused) lands in
that file. Modularize before that feature, not after. Related shape-drift
risk: `adapters.js` re-derives governance client-side that the server
adapters already compute, contradicting the sync engine's own "server is
the single source of truth for entity shape" principle.

---

## 6. Recommended sequence

1. **Fix** — wrap `replaceLinks` in `db.transaction()` (decisions + todos),
   fold in the `getWithRefs` N+1. Small, real, cheap.
2. **Reconcile** — one `CORTEX_RECONCILE=1` session over the 25 pending
   decisions. Free drift audit; turns a shipped feature into a used one.
3. **Docs sweep** (docs-only branch) — archive/promote v0.3 specs, refresh
   HANDOFF/TEST.md/CHANGELOG preamble, rename `field reports/` →
   `field-reports/`, trim CLAUDE.md to routing instructions.
4. **Refactor pass** — shared `RepoPathField` + `execAction` wrapper; move
   frame layout modules to `frame-extraction/positioning/`; unify the
   `toDecision` mappers.
5. **Longer-term** — modularize `viewer.js` before PR/commit rendering;
   backfill HTTP-route and `resolve-path` tests; serve `LAYER_RGB` from the
   server; retire the one-shot migrations after the deprecation window.

---

## 7. Meta-observation: Cortex reviewing Cortex

The review itself was a field test of the toolchain. What worked: the graph
gave the subsystem map and LOC/degree shape in two calls;
`decision({action:"pending"})` turned "has the code drifted?" from vibes
into a queue with 25 concrete entries; six subagents ran the whole audit
through Cortex tools without falling back to grep. What chafed: the
`pending` payload (617 KB) blew the tool-result budget and had to be
grepped from a spill file — it needs a summary mode (`ids+titles` first,
bodies on request); and `search_graph(label="function")` returned empty
where `get_architecture` reported 541 functions — label-casing or
label-matching inconsistency worth a look.

**Verdict: due diligence passed.** One bug, one layering drift, a
self-inflicted reconciliation backlog, and a manageable trim list — for a
5-month-old, 1,700-commit project spanning an MCP server, HTTP API, event
pipeline, viewer, CLI, and native-indexer integration, that is an unusually
clean bill of health.
