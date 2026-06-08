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
| **Reconciliation engine** (derived decision state) | ✅ Shipped (flag-gated) | Agent-delegated reconciliation behind `CORTEX_RECONCILE` (default off in v1). Working-tree (not HEAD) source hash in [`src/decisions/reconciliation.ts`](../../src/decisions/reconciliation.ts); `record_reconciliation` / `pending_reconciliations` tools ([`src/mcp-server/tools/reconciliation-tools.ts`](../../src/mcp-server/tools/reconciliation-tools.ts)); on-read drift block + derived `display_state` in `get_decision` / `why_was_this_built` ([`src/mcp-server/reconciliation-attach.ts`](../../src/mcp-server/reconciliation-attach.ts)); `cortex reconcile status` CLI and SessionStart banner. Design: [`docs/superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md`](../superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md); plan: [`docs/superpowers/plans/2026-06-08-decision-reconciliation-engine.md`](../superpowers/plans/2026-06-08-decision-reconciliation-engine.md). |

---

## Spec-only (designed, not built)

| Spec area | Status | Evidence |
|---|---|---|
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
- `status` is stored, but a **derived `display_state`** now layers on top of it:
  the reconciliation engine detects working-tree source-hash drift and the agent
  judges whether the decision's prose still matches the code, projecting
  `match`/`partial`/`drift` into `active` / `active · drifting` / `stale`
  (shipped flag-gated behind `CORTEX_RECONCILE`).

---

## Recommended next step

The **reconciliation engine** — previously the highest-leverage gap — is now
**shipped behind `CORTEX_RECONCILE`** (agent-delegated, working-tree hash,
on-read + SessionStart triggers), so spec §3 ratification and the §10.3 /
stale-decision lifecycle are unblocked in v1. Next-highest remaining gaps are
**frame ranking / taxonomy** and the **TODO entity**.
