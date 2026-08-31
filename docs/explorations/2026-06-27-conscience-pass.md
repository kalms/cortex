# Exploration — "Fully utilizing Cortex" → the Conscience Pass

**Date:** 2026-06-27
**Driver:** rka + Claude (Cortex's primary agent consumer)
**Status:** prototype run executed against this repo; findings fixed; follow-ups open

---

## 1. What this exploration was

An open-ended "dream" prompt — *given that Cortex exists, how would its main user
(me, the agent) fully utilize it?* — that converged on one concrete, buildable
idea and then **actually ran it against this repo** instead of staying rhetorical.

The framing that fell out of the dream:

- Cortex is the only tool in the stack that answers not just *"what is the code?"*
  but *"…who calls it, why is it shaped this way, what did we decide, and is that
  decision still true?"* — and keeps that live across sessions.
- The agent's defining failure mode is **amnesia** (re-deriving architecture every
  session) and **silent contradiction** (violating a past decision because nothing
  reminded me). Cortex is the first thing that structurally fights both.

Benefits land at **three moments**:

| Moment | Felt by | Benefit |
|---|---|---|
| Mid-task | the agent | graph lookups replace grep/Read re-derivation (the "amnesia tax") |
| At merge | both | wrong structural claims / contradicted decisions caught before they ship |
| Across time | the user | the gap between *decided* and *built* stays visible and closeable |

The highest-leverage idea was the **conscience pass** (Moment 3): a reconciliation
sweep that surfaces where documented intent has diverged from the code — turning
decision-rot from an invisible inevitability into a tracked, closeable queue.

---

## 2. The conscience pass — mechanism

Built entirely from existing primitives, no new code required:

1. `decision({action:"pending"})` — list every active decision and its
   `last_verdict` (`match` = verified-aligned, `unknown` = never reconciled).
2. For each `unknown`: read the decision prose, read the **current** governed
   code (`get_code_snippet` / `search_code` / `search_graph`), judge
   `match` / `partial` / `drift`.
3. `decision({action:"reconcile", decision_id, verdict, note})` — record the
   honest verdict with cited evidence.
4. Where two decisions describe the **same** change, collapse the redundancy with
   `decision({action:"update", status:"superseded", superseded_by})`.

**Conscience score** = share of active decisions carrying a verified verdict.

---

## 3. Live findings for this repo (2026-06-27)

Snapshot at start: **25 active decisions · 13 `match` · 12 `unknown`** →
conscience score **52%**.

### Finding A — two redundant decision pairs (captured twice, ~21 min apart)

A grep-invisible defect that lives only in the *intent* layer: the same change
was recorded twice in the same session, and neither record knew about the other.

| Pair | Twins | Same change | Resolution |
|---|---|---|---|
| 1 | `D-p603` (seq 57) + `D-v2tc` (seq 59) | 17→3 action-dispatched MCP tool consolidation | `D-v2tc` → superseded by `D-p603` |
| 2 | `D-kxj0` (seq 58) + `D-r6xg` (seq 60) | TODO entity stored in the primitives DB at parity with decisions | `D-r6xg` → superseded by `D-kxj0` |

The twins weren't identical — the earlier records (`D-p603`/`D-kxj0`) carried full
`problem`+`resolution` prose; the later ones (`D-v2tc`/`D-r6xg`) carried extra
governed-file coverage and detail. Supersession (not deletion) preserves the
superseded records, so their detail stays queryable via the chain.

Survivors reconciled to **match** with cited evidence:
- `D-p603` — `registerDecisionDispatcher` / `registerPRDispatcher` present, mcp-contract guard tests present.
- `D-kxj0` — `class TodoService` at `src/todos/service.ts:26`, `todos/*` modules present, consolidated `todo` MCP tool live.

### Finding B — the rest of the unknown set judged (8 decisions)

**7 match · 1 partial · 0 drift.**

The one **partial** is the standout:

- **`D-vmhy`** ("Frame layout: deterministic recenter (both axes)") — the code
  (`frame-layout.ts::layoutFrames`) recenters **X only**; "Y is left to the
  sink-driven bands." The decision's NOTE-corrected "both axes" claim is **not in
  the code**. Either the prose should be corrected back to "x-only", or the
  y-recenter was intentionally dropped when `D-p8bg`'s viewer fit-to-content took
  over vertical framing. → **needs a human call.**

### Finding C — a latent low-severity bug surfaced as a side effect

- **`D-yb1b`** validation field-list names `reason`, but the actual column is
  `Todo.state_reason` — `validatePrimitiveFields` may scan a non-existent input
  field. Low severity, flagged for human review.

---

## 4. Actions taken (durable decisions store)

All mutations are on the durable primitives store (`~/.cortex/<repoId>/decisions.db`),
independent of the replaceable graph DB:

- `D-v2tc` → `status: superseded`, `superseded_by: D-p603`
- `D-r6xg` → `status: superseded`, `superseded_by: D-kxj0`
- Reconciled to `match`: `D-p603`, `D-kxj0`, `D-b0kp`, `D-p8bg`, `D-kkz6`,
  `D-0j21`, `D-87zb`, `D-yb1b`, `D-s72s`
- Reconciled to `partial`: `D-vmhy`

**Result:** 25 active → **23 active** (2 deduped), and **100% of active decisions
now carry a verdict** (22 `match` · 1 `partial` · 0 `drift`).

```
conscience score:  52% ████████░░░░░░░  →  100% ███████████████
```

---

## 5. Suggested changes — prioritized ranking

Ranked by leverage ÷ effort, with a bias toward (a) concrete defects the pass
found and (b) changes that stop the *class* of problem recurring. The actionable
near-term items are captured as Cortex TODOs (dogfooding the entity reconciled in
§3), linked to their governing decision via `SPAWNS_FROM` / `GOVERNS`.

### P0 — concrete latent bug, do now
1. **Fix `reason` vs `state_reason` validation field-name mismatch** — `D-yb1b`'s
   validator field-list names `reason`, but the column is `Todo.state_reason`, so
   `validatePrimitiveFields` may scan a field that doesn't exist. Small, real.
   → **`T-axxz`** (governs `decision-input-validation.ts`, `todos/types.ts`)

### P1 — make the decision layer self-healing (prevents today's recurrence)
2. **Duplicate-capture guard at propose/create time** — the *root cause* of the two
   redundant pairs (§3 Finding A). Make `decision({action:"propose"|"create"})`
   run an FTS/governs-overlap check and surface likely duplicates before writing,
   instead of relying on the advisory "search first" step. Fix the source, not the
   cleanup. → **`T-my9c`** (spawns from `D-p603`)
3. **Automate the conscience pass on a cadence** — turn today's manual run into a
   recurring reconcile sweep (SessionStart/post-commit hook or scheduled agent),
   including the `CORTEX_RECONCILE` on-by-default story. This is the compounding
   Moment-3 win: the conscience score stops decaying silently between manual runs.
   → **`T-ftrd`**

### P2 — needs a human call, then a fix
4. **Resolve `D-vmhy` partial** — code recenters X only; prose claims both axes.
   Decide: correct the prose to "x-only", or restore the y-recenter that `D-p8bg`'s
   viewer fit-to-content took over. Then update prose/code and re-reconcile.
   → **`T-whyh`** (spawns from `D-vmhy`, governs `frame-layout.ts`)

### P3 — bigger platform bets (roadmap, not yet ticketed)
These are the larger "fully utilize Cortex" ideas from the dream; documented here
as direction, to be promoted to TODOs/decisions when picked up.

5. **Pre-edit briefing reflex** — auto-assemble `trace_path(callers)` +
   `decision({why})` + last-touching PRs into a risk profile *before* any edit.
6. **Provenance-chain query** — `todo → decision → PR → code` lineage as a single
   query (the four primitives already exist; wire them).
7. **CI gate = `check_contracts` + decision-contradiction check** — block a diff
   that violates a contract or contradicts an `active` decision.
8. **Cross-repo pattern queries** — `query_graph` across the registry (cortex /
   mesh / private-sales-app) to track pattern propagation between codebases.

---

## 6. What this run demonstrated

This was the Moment-3 "architectural honesty" chart made real: a number that moved
(52% → 100%), a queue that closed (2 redundant pairs deduped, 12 decisions judged),
and two genuine defects — one redundancy, one latent bug — that **no grep or
`git log` could have surfaced**, because they live in the intent layer Cortex owns.

Run the conscience pass on a cadence and decision-rot stops accumulating silently.
