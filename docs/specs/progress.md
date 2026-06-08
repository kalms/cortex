# Cortex v0.3 — Progress Assessment

_Assessment date: 2026-06-08. Derived from the live Cortex graph (index current
as of 2026-06-08T07:16:23Z), the v0.3 design corpus in
[`docs/specs/cortex-v0.3/`](cortex-v0.3/), and the source tree._

Version metadata is consistent: `package.json`, `plugin.json`, and
`.claude-plugin/marketplace.json` are all `0.3.0` (synced on
`fix/config/version-sync`).

The shorthand: **the structural / data half of v0.3 shipped; the
"multiplayer canvas" half is still design.**

---

## Shipped

| Spec area | Status | Evidence |
|---|---|---|
| **Frame extraction pipeline** | ✅ Shipped | [`src/frame-extraction/`](../../src/frame-extraction/) — `cluster-tfidf-hdbscan.ts` + `python/tfidf_hdbscan.py`, `co-change.ts`, `auxiliary-detection.ts`, `path-tokenize.ts` + `structural-tokens.ts` (framework-aware tokenisation), `text-blob.ts` (two content streams), `inject-frames.ts` + `run-frames.ts` (graph integration), `eval-gate.ts`. Surfaced via `code-tools.ts::withFrames` and the CLI. |
| **Pipeline empirical comparison** | ✅ Done — 1 of 3 survived | Eval harness ([`scripts/frame-extraction/`](../../scripts/frame-extraction/): `eval-all.ts`, `corpus.json`, `baselines/`) and `types.ts` (`ClusterResult.algorithm`) anticipate `tfidf+hdbscan \| embedding+hdbscan \| leiden`. Only **tfidf+hdbscan** was built; Leiden and pinned-embedding clusterers were never implemented. The comparison resolved to one winner. |
| **PR data model + tools** | ✅ Shipped (data only) | [`src/prs/service.ts`](../../src/prs/service.ts), [`src/prs/types.ts`](../../src/prs/types.ts) (`OpenPRInput` with `introduces_frame`, `additions`, `external_ref`). MCP tools `open_pr` / `add_pr_touch` / `merge_pr` / `get_pr`. Matches spec §4 schema. **Not rendered on canvas** (spec said so explicitly). |
| **Decision proposal / supersession tools** | ✅ Shipped | `propose_decision`, `supersede_decision`, `promote_decision`, `link_decision`; [`src/decisions/promotion.ts`](../../src/decisions/promotion.ts), `cli/commands/decision.ts::cmdPropose`. |
| **2D frames viewer** | ✅ Shipped | [`src/viewer/`](../../src/viewer/) — `adapters.js` (`groupNodesIntoFrames`, `frameCoverage`), `data-fetch.js`, `layout.js`, `viewer.js`, wired to `/api/graph` / `/api/projects` / `/api/decisions`. |

---

## Spec-only (designed, not built)

| Spec area | Status | Evidence |
|---|---|---|
| **Reconciliation engine** (derived decision state) | ❌ Missing | `%econcil%` matches only the spec/backlog docs — zero code. Decision `status` is a plain column ([`src/decisions/db.ts`](../../src/decisions/db.ts)), not derived from code-alignment. The spec's central "decisions ratified by code, drift → stale" mechanism does not exist. Blocks spec §3 ratification story and §10.3. **Highest-leverage gap.** |
| **Frame ranking / taxonomy** | ❌ Largely missing | [`frame-ranking.md`](cortex-v0.3/frame-ranking.md)'s `FrameKind` payload, layer-first taxonomy, and gravity model have no code counterpart. Labeling (`label-quality.ts`) shipped; the ranking/classification layer did not. |
| **TODO entity** | ❌ Missing | `%odo%` matches only [`todo-entity.md`](cortex-v0.3/todo-entity.md). No schema, state machine, drawer, tools, or external bridge. |
| **Multiplayer-test mode / scenario DSL** | ❌ Missing | `%cenario%` matches only spec §9.3. No TS DSL scenario runner. |
| **Record drawer, merge animation, agent cursors, floating-entity grammar** | ❌ Prototype-only | `drawer` returns no code matches. These live in `cortex-frames-prototype-v5.html`; the live viewer renders frames, not the full multiplayer canvas. |

---

## Decision schema vs. spec §3

[`src/decisions/db.ts`](../../src/decisions/db.ts) persists
`problem` / `resolution` / `rationale` / `alternatives` / `author` / `provenance`
plus a generic `decision_links` table (handles `governs` / `supersedes` /
`relatedTo` / PR refs as typed links).

**Gaps:**
- No `validatedBy` / `observedImpact` (evidence) fields.
- `status` is **stored, not derived** — the reconciliation engine that the spec
  assumes would compute it from code-alignment is absent.

---

## Recommended next step

Build the **reconciliation engine**. Multiple spec sections (§3 ratification,
§10.3, the entire stale-decision lifecycle) assume it, and today decision
`status` is just a manually-set column. It unblocks the most spec surface per
unit of work. _(Brainstorm in progress — design notes to follow.)_
