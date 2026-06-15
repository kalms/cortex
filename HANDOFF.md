# Cortex — Session Handoff

## ✅ DONE (2026-06-14 — search-noise line: field-report P2 + follow-ons)

Four gated merges to `main`, **all pushed to origin** (`1104351`, 2026-06-14),
each through the full design → plan → subagent-driven TDD → two-stage review →
gated release cycle. This closes the field report's **§2 "search is noisy and
unranked" / P2** item and the follow-ons it surfaced. Decisions **`D-fq9g`**
(search_graph ranking) and **`D-qfz9`** (shared code_search engine), both linked
to the frame kind-weight lineage.

- **0.3.11 — `search_graph` ranking + section exclusion + pagination (P2).**
  New pure ranker [`src/graph/node-ranker.ts`](src/graph/node-ranker.ts)
  (`KIND_WEIGHT × nameMatchQuality`, deterministic tie-break → stable across
  pages); doc/plan `section` nodes (1771 vs 528 functions here) excluded from
  name/qn results by default with a `K section nodes suppressed` header hint;
  new `kinds`/`limit`/`offset` params + `showing A–B of N` header. Pure
  render/clamp in [`src/mcp-server/tools/search-format.ts`](src/mcp-server/tools/search-format.ts);
  `countSuppressedSections` in [`code-queries.ts`](src/graph/code-queries.ts).
  Decision `D-fq9g`; [design](docs/superpowers/specs/2026-06-14-search-graph-ranking-design.md).
- **0.3.12 — suppression-note scoping fix + search-syntax docs + `cortex code
  find` parity.** The suppression hint now fires only under the default filter
  (an explicit `kinds`/`label` no longer misreports hidden sections). Documented
  the previously-undocumented match syntax in [`docs/mcp-tools.md`](docs/mcp-tools.md)
  (`name_pattern` = ci substring/LIKE wildcards; `qn_pattern` = non-auto-wrapped
  LIKE; exact kind match). `cortex code find` brought to parity with the tool:
  ranked, section-excluded-by-default, `--kind`/`--kinds`/`--limit`/`--offset`
  (honors the `--kind` flag the help already advertised but the command ignored);
  `clampLimit`/`clampOffset` relocated to
  [`src/graph/search-params.ts`](src/graph/search-params.ts) so the CLI doesn't
  depend on mcp-server.
- **0.3.13 — shared ripgrep engine; `cortex code search` fixed (the "only .md"
  report).** Root cause: the CLI ran the indexer binary's `search_code`, which
  caps at ~10 results and orders doc-first — `extract` (91 code files) returned
  only `.md`. Extracted the MCP tool's ripgrep + enclosing-symbol engine into a
  shared [`src/graph/code-search.ts`](src/graph/code-search.ts) (`runCodeSearch`
  + `rankSearchHits`); the MCP `search_code` tool is now a thin wrapper over it
  (**output byte-identical** — contract tests are the guard); the CLI `search`
  command runs the same engine, ranks **code-first** (markdown hits enclose to a
  `module` node and sink), renders structured rows, redirects `--kind` to `find`.
  Decision `D-qfz9`; [design](docs/superpowers/specs/2026-06-14-shared-code-search-engine-design.md).
- **0.3.14 — `prefer-cortex` hook over-match fix.** A `git commit -m "…grep…"`
  was misread as a code search and denied; the Bash branch now strips quoted
  string literals before probing for a command-position search tool (a real code
  search keeps its tool word unquoted, so it still redirects; scope detection
  still uses the original command). +4 tests.
  ⚠ **NOT the field report's P3** (the *target-repo-aware cross-repo* hook) —
  that was a separate fix, since **shipped** (decision `D-mmtb`). Hooks load at
  SessionStart, so this fix is live next session.

Full suite **1131/1131** throughout; live Gate 0 confirmed `cortex code search
extract` now leads with code instead of `.md`.

## ▶ NEXT STEP

**▶▶ IMMEDIATE:** ✅ done — **enable slice 3b — layer-diversity** shipped (0.3.19)
**and flipped default-ON (0.3.20)** after a positive corpus observe verdict
(decision **`D-wvsz`** resolution). `CORTEX_LAYER_DIVERSITY` is now an opt-out
(`"0"` restores the kind-weighted-only ambient set). Observe highlights: vueuse
interface 7→4 / data 1→3, nuxt/ui 2 layers → 5, saleor interface 7→3 +data,
rubygems re-surfaces a domain frame; ceremony cap held everywhere, no junk
promoted on coverage alone, neutral on already-diverse/tiny repos. **Next open
item: the layout slice** (item 5) — layer-adjacency force in `frame-layout.ts`.
Two deferred test follow-ups (non-blocking, measure-zero under geometric decay):
a multi-layer simultaneous-promotion test and a zero-score floor edge case
(final-review I3/I1).

1. ✅ **Observe-polish branch landed** (0.3.7): fixture regen + coverage guard,
   handler-suffix orchestration signal, palette separation, tie/fallback report.
2. ✅ **Domain question resolved** — earnable domain via an *earned-fallback*
   runtime signal in the middle sink band (decision **`D-8vbv`**, spec
   [2026-06-13-earnable-domain-signal-design.md](docs/superpowers/specs/2026-06-13-earnable-domain-signal-design.md)).
   `W_DOMAIN_RUNTIME = 0.5` (earn bar ≈80% runtime), held aside so any real
   layer signal still wins. **Measured:** earns domain for anthill's
   `dsl/primitives` / `rbac-policies` / `activator`; earns nothing on cortex
   (test-co-clustering depresses runtimeFrac — the frame-quality ceiling, not a
   defect). Substrate-band core domain (`dsl/compiler`) still needs the deferred
   Louvain `concern` axis. Enable-slice weights settled: **earned domain 1.00,
   fallback domain 0.50.**
3. ✅ **Enable slice 3a — kind-weight shipped** (flag-gated, decision **`D-g4qb`**,
   spec [2026-06-13-kind-weight-enable-slice-design.md](docs/superpowers/specs/2026-06-13-kind-weight-enable-slice-design.md)).
   `score ×= kind_weight` (earned domain 1.00 / interface 0.90 / orchestration
   0.85 / data 0.75 / infra 0.55 / fallback-domain 0.50 / ceremony 0.20), behind
   `CORTEX_KIND_WEIGHT` **default off (inert — ranking byte-identical when off)**.
   Ranker stays pure (kind_weight a plain number on `FrameRecord`); weights +
   flag at the call site. **Observe verdict (corpus, 11 repos, `eval-layers.ts`
   ambient before/after):** kind-weight ON consistently evicts ceremony/config
   noise (eslint-config, playwright-config, tsconfig, training/scripts, test
   cassettes, json-schemas) and tilts ambient toward interface/domain/data; the
   0.50 fallback-domain demotion correctly yields fallback-domain to interface
   (rubygems `mailer`); **no junk leapfrogged into ambient** (D-qn7z trap held).
   Neutral on tiny/already-diverse repos (cobra/click/vueuse).
   **→ Default flipped ON in 0.3.10** (`CORTEX_KIND_WEIGHT` now an opt-out, `"0"`
   disables; Gate 0 confirmed clean render). The kind-weighted ambient set is
   the default user-visible ranking.
4. ✅ **Enable slice 3b — layer-diversity shipped (0.3.19) + default-ON (0.3.20)**,
   decision **`D-wvsz`**, spec
   [2026-06-15-layer-diversity-enable-slice-design.md](docs/superpowers/specs/2026-06-15-layer-diversity-enable-slice-design.md).
   The `× diversity` term as a new pure module `frame-diversity.ts`
   (`selectAmbientByDiversity`) consumed at the frame-map call site (ranker stays
   layer-free). Two phases: greedy fill with **geometric repeat-decay**
   (`× 0.6^k`) + **ceremony cap** (≤1); then **bounded coverage repair** —
   guarantees ≥1 of domain/interface/data when present by promoting over the
   weakest safely-displaceable frame, but only above a `0.5 ×` floor (D-qn7z
   guard). **Observe verdict POSITIVE** (corpus `eval-layers` diversity Δ): on
   interface-heavy repos it collapses redundant interface and surfaces
   domain/data (vueuse interface 7→4 / data 1→3, nuxt/ui 2 layers → 5, saleor
   interface 7→3 +data, rubygems re-surfaces a domain frame), ceremony cap held
   everywhere, no junk promoted on coverage alone, neutral on already-diverse/
   tiny repos. **→ Default flipped ON in 0.3.20** (`CORTEX_LAYER_DIVERSITY` now an
   opt-out, `"0"` restores the kind-weighted-only ambient set); Gate 0 confirmed a
   clean default-on render.
5. **Layout slice**: layer-adjacency force in `frame-layout.ts` using
   *measured* adjacency from `rollupFrameFlows` (not categorical), then
   floating-entity placement (subsumes the `D-xwxj` promotion stopgap).
   End-state visual direction was previewed + approved in the 2026-06-12
   brainstorm (`.superpowers/brainstorm/` mockups).
6. **Co-change lens** (parallel, small): `FILE_CHANGES_WITH` minus structural
   edges = hidden coupling — a sibling row in the layers menu, dashed quiet
   style, ~55 edges of ink. The lens pattern (menu + deterministic + off =
   identical) is established; follow it.
7. **Agentic-experience P1–P8** (from the [2026-06-12 field report](docs/field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md) §5).
   3 of 8 shipped. Remaining, in suggested sequence:

   | # | Item | Status | What it is | Effort |
   |---|---|---|---|---|
   | **P2** | Search ranking + kind weighting | ✅ **Shipped** (0.3.11–0.3.13) | Ranked, section-excluded, paginated `search_graph` + `cortex code search`/`find`. Decisions `D-fq9g` / `D-qfz9`. | — |
   | **P3** | Target-repo-aware grep hook | ✅ **Shipped** | `prefer-cortex.sh` now gates on the **search-target** repo's index (resolved from Grep/Glob `path` or the Bash command's path args; cwd only for bare patterns), and background-indexes high-certainty git siblings on first grep. Decision `D-mmtb` (+ 0.3.18 `/tmp` denylist follow-up). **Distinct from the 0.3.14 quoted-word fix.** | — |
   | **P1** | `context_pack(qualified_name)` composite | ✅ **Shipped** | One tool returning `{ snippet, callers, callees, governing_decisions, recent_commits }` (caps 10/10/5/5 + truncation note). Pure composition of `get_code_snippet` + `trace_path` + `why_was_this_built` + git log; cuts the 4-roundtrip symbol pattern to 1. Decision `D-bptf`. | — |
   | **P6** | Versioned HTTP contract + freshness over HTTP | ⬜ Open — **gates Mesh** | (a) Freeze JSON Schemas for `/api/projects`/`/api/graph`/`/api/decisions` (+ `/api/frames`/`/api/file-edges`) under `docs/api/` with a response `version`; (b) expose freshness as `X-Cortex-Freshness:` header or `/api/freshness` so Mesh drops its blind TTL cache. **Land before Mesh's viewer-adaptation milestone consumes `/api/frames`.** | small |
   | **P4** | Warm-path decision drafting | ⬜ Open | At merge/PR time, run `decision_candidates` over the branch diff and draft `status:"proposed"`, `author:"cortex:draft"` decisions for one-tap ratification — re-aims the existing `seed-decisions` machinery + suggest-capture hook from *reminder* to *drafter*. Compounds the decision moat. | medium |
   | **P5** | Cross-repo decision search | ⬜ Open | `crossRepo:true` mode on `search_decisions` that fans out over the registry's `root_path` entries and merges FTS hits with a `repo` field. Unlocks the now-normal multi-repo workflow (cortex + mesh + client repos). | small–medium |
   | **P7** | Reduce the fixed token tax | ⬜ Open — **needs a decision first** | ~30 tool schemas + routing docs ride every turn. (a) Consolidate low-traffic tools (`promote`/`propose`, the PR quartet) behind a `mode` param; (b) tighten descriptions that restate `docs/mcp-tools.md`; (c) mark the long tail deferred where the host supports lazy schema loading. (a) is a breaking prompt change → capture a decision. | medium |
   | **P8** | Temporal layer | ⬜ Open — long pole | `changes_since(ref_or_date, scope?)` joining commit history against graph nodes + decisions made/reconciled in the window. Completes the why-layer with a when-layer; pairs with `CORTEX_RECONCILE`. Sequence after P1–P6. | large |

   **Reaffirmed operational items ⏩** (not new P-items):
   - **Frame ranking / extraction coverage** — the `SRC·863` mega-frame / frame-quality ceiling. Being chipped at by the taxonomy arc (NEXT STEP items 3b–4 above); the deferred Louvain `concern` axis is the real fix for substrate-band core domain.
   - **C test suite rot** (~196 red, not in CI) — either fix against the Phase-4 schema or formally retire the suite so its redness stops signaling.
8. ✅ **Pushed to origin** (`785bcbe`, 2026-06-13). Note: pushing `main`
   directly **bypasses** the branch-protection rule (PR + "CI gate" status
   check) — the account has bypass permission. Consider routing future
   releases through a PR so CI actually runs.
9. **Mesh side** (separate repo, waiting on Figma): faithful viewer
   adaptation + threads-to-top; keep pan/zoom. Mesh consumes the `layer`
   field for free once its sidecar runs ≥0.3.4.

---

_Previous handoff content (graph-DB transactional-swap publish, 2026-06-10,
decision `D-47xb`; freshness signal + auto-refresh, 2026-06-07, decision
`bbf0fce5`) is superseded-and-stable: shipped, verified, and documented in
[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md) and
CLAUDE.md. progress.md's Known-issues section now reflects their resolution._
