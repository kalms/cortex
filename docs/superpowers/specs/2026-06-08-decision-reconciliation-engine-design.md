# Decision Reconciliation Engine v1 — Design

- **Date:** 2026-06-08
- **Status:** Approved (design); implementation pending
- **Scope:** Cortex v0.3 — the reconciliation engine that derives a decision's
  code-alignment from its governed source.
- **Supersedes/implements:** the "Reconciliation engine" backlog item
  ([cortex-backlog.md](../../specs/cortex-v0.3/cortex-backlog.md) §"Reconciliation engine")
  and spec §10.3 ([cortex-multiplayer-spec.md](../../specs/cortex-v0.3/cortex-multiplayer-spec.md)).
  Item 7 of the spec's implementation order.

---

## 1. Problem

A Cortex decision carries narrative prose (`problem` / `resolution` /
`rationale`) and typed links to the code it `governs`. The v0.3 design says a
decision's lifecycle **state is derived from code alignment, not stored**: if the
governed code still matches the decision's `resolution`, the decision is
`active`; when they diverge, it becomes `stale` — a healing prompt, not a
failure.

Today none of that exists. `status` is a single stored column on the `decisions`
table (default `active`), set only by explicit tools. There is no machinery that
compares a decision against its governed code, so "stale" can never arise on its
own. This blocks the spec's §3 ratification story and §10.3.

This document specifies a v1 reconciliation engine that makes the derived
code-alignment signal real, shipped behind a feature flag.

## 2. Decisions taken (brainstorm outcomes)

1. **Judgment is agent-delegated.** The match/drift judgment runs in the
   in-session Claude agent, not server-side. No API key, no server token cost,
   and it reuses the LLM already in the loop. Mirrors the existing
   `seed-decisions` skill pattern. The server's job is to detect *which*
   decisions need judging, hand the agent the prose + current source, store the
   verdict, and surface the derived state.
2. **Two orthogonal axes** (not a single collapsed `state`). `status` stays the
   explicit human-intent lifecycle; a separate derived `reconciliation` verdict
   carries code-alignment. "Stale" is a projection, never stored.
3. **Triggers: on-read (opportunistic, self-healing) + SessionStart sweep
   (proactive).** Not a user-invoked skill or a post-commit hook in v1 (both are
   noted as later additions).
4. **The hash tracks the working tree, not `HEAD`** — see §5, the property that
   sets this engine apart.

## 3. State model

Two independent axes on a decision:

| Axis | Stored? | Values | Set by |
|---|---|---|---|
| `status` (human intent) | stored | `proposed` · `active` · `superseded` · `deprecated` | explicit tools (`create`/`update`/`supersede`) |
| `reconciliation` (code-alignment) | derived verdict, cached | `match` · `partial` · `drift` · `unknown` | the agent, via `record_reconciliation` |

**"Stale" is never stored — it is a read-time projection:**

```
displayState(status, reconciliation):
  status != active        → status              # superseded/deprecated/proposed dominate
  status == active:
     match                → "active"
     partial              → "active · drifting"
     drift                → "stale"              # spec's stale = active ∧ drift
     unknown              → "active · unreconciled"
```

**Verdict freshness** is distinct from the verdict itself, mirroring the existing
graph freshness signal. We store the `governed_source_hash` the verdict was
judged against; at read time we recompute the current hash:

- current hash **==** `reconciled_source_hash` → stored verdict is current.
- current hash **!=** `reconciled_source_hash` → verdict is **stale-pending**: the
  last verdict still shows, tagged `(code changed since — recheck)`. This is what
  triggers re-judgment.
- `reconciled_at` is null → `unknown` (never judged).

A decision with **zero GOVERNS links** is not reconcilable (it is effectively a
*declarative* decision — process-level, explicitly out of scope per the spec).
It is fixed at `reconciliation = unknown` and never prompts; no false "stale."

## 4. Schema

Additive columns on the existing `decisions` table, applied via an idempotent
`ALTER` exactly like the current `ensureProvenanceColumn` migration in
[`src/decisions/db.ts`](../../../src/decisions/db.ts). Existing rows and the FTS5
triggers are untouched (the new columns are not part of the FTS index).

```sql
reconciliation_verdict   TEXT   -- 'match' | 'partial' | 'drift' | NULL (unknown)
reconciled_at            TEXT   -- ISO timestamp of the last judgment
reconciled_source_hash   TEXT   -- governed_source_hash at judgment time
reconciled_by            TEXT   -- model/agent id (provenance)
nonconformant_nodes      TEXT   -- JSON array of {ref, note} that drifted (optional)
reconciliation_note      TEXT   -- one-line human summary of the drift (optional)
```

Latest-verdict-only; no history table in v1 (the spec does not require an audit
trail). A `decision_reconciliations` history table is a clean later addition if
the canvas wants a timeline.

## 5. Computing `governed_source_hash`

The hash **is** the invalidation trigger, so its definition is load-bearing. It
reuses the deterministic file-set hashing primitive already in
[`src/db/cache.ts`](../../../src/db/cache.ts) (`grammarPackHash`:
`sha256(sorted(relpath \0 filebytes))`), lifted into a `hashGovernedSource()`
helper.

**Granularity: file-level (v1).** Hash the whole file for each governed file (or
the file containing a governed symbol). This matches the spec's invalidation rule
literally ("any governed file's content hash changes"), avoids depending on graph
line-ranges (which drift against the working tree), and is conservatively safe —
an unrelated edit in the same file forces a recheck, which over-judges slightly
but never *misses* a real drift. Symbol-level hashing (hash just the function
snippet) is a documented later refinement.

### 5.1 Why the working tree, not `HEAD` — the defining property

`hashGovernedSource` reads **current bytes from disk**, deliberately *unlike*
`cache.ts`'s `gitTreeHash`, which hashes `git rev-parse HEAD^{tree}`. This single
choice is what sets the reconciliation engine apart from a git-based staleness
report, and it is intentional:

- **In-session drift, before any commit.** An agent editing governed code mid-session
  immediately sees those decisions flip to `stale-pending` — no commit, no
  reindex required. Reconciliation is *live*, not a batch report.
- **Decoupled from index freshness.** The verdict reflects what is on disk *now*,
  independent of when the graph was last indexed. A decision can be flagged stale
  even while the graph is mid-refresh.
- **Uncommitted experiments are visible.** A spike that diverges from a governing
  decision shows the divergence in real time, which is exactly when a human or
  agent wants to be reminded "this contradicts decision D-x."
- **HEAD-based would hide all of the above** until commit, collapsing the engine
  into "re-run after every merge" — strictly less useful.

The cost is that the hash reflects transient editor state (a half-saved file
hashes to a drifted value). That is acceptable and even desirable: the recheck is
cheap (a hash compare) and the agent only *judges* when it reads the decision.

### 5.2 Algorithm

```
hashGovernedSource(repoPath, governedRefs) →
  1. resolve each GOVERNS ref (from decision_links) to a file path:
       "src/x.ts"            → that file
       "src/x.ts::sym" / qn  → the file part (before "::", via denormalize)
       a folder / frame      → walk it, sorted (grammarPackHash style)
  2. for each resolved path, sorted + deduped:
       h.update(ref); h.update("\0");
       h.update(existsSync(p) ? readFileSync(p) : "<missing>");   // deletion = drift
       h.update("\0");
  3. return h.digest("hex")        // one sha256 over the sorted set
```

**Edge cases**
- **Governed file deleted** → `<missing>` sentinel → hash changes → drift
  surfaced; the agent sees the file is gone.
- **Zero GOVERNS links** → not reconcilable (see §3).
- **Order independence** → refs sorted before hashing.

## 6. Reconciliation flow

### 6.1 On-read (opportunistic, self-healing)

Rides the `registerTool` chokepoint where the freshness verdict already attaches,
gated by `CORTEX_RECONCILE`. Applies to the **deep single-decision reads** —
`why_was_this_built`, `get_decision` — where inlining source is proportionate.

For each returned **active** decision, recompute `governed_source_hash`:
- matches `reconciled_source_hash` → verdict current → **attach nothing** (zero
  agent work, the common case).
- differs, or never judged → attach a **reconciliation block**:

```jsonc
reconciliation: {
  verdict: "<last verdict or 'unknown'>",
  state:   "stale-pending",
  governed_source: [ { ref, source /* current bytes/snippet, capped */ } ],
  instruction: "This decision's governed code changed since it was last
    reconciled. Judge whether the code still satisfies the decision's
    resolution, then call record_reconciliation(decision_id, verdict,
    nonconformant?, note?)."
}
```

The agent judges from prose (already in the payload) + inlined source, then calls
`record_reconciliation`. Self-heals as a side effect of normal use.

`search_decisions` (list) is **not** a judging site — it appends only a
lightweight `⚠ N drifted` count computed over the returned page, never inlines
source.

### 6.2 SessionStart sweep (proactive)

Pure deterministic gate — no LLM in the hook:

- [`hooks/check-index.sh`](../../../hooks/check-index.sh) calls a cheap
  `cortex reconcile status` (sibling to `cortex freshness`) that counts active
  decisions where current `governed_source_hash` != `reconciled_source_hash`.
- Banner: `↻ N decisions drifted since last reconciliation` plus a nudge to
  refresh — mirroring the seed-decisions cold-start prompt and the freshness
  banner.
- The hook only *informs*. The agent acts on the nudge by calling
  `pending_reconciliations` (§7) and judging the batch.

**Cost control:** source is inlined only for a single focused decision and
capped; the hash gate means current decisions cost nothing; lists never inline;
the `⚠ N` count is bounded by the existing `search_decisions` result cap.

## 7. Tool surface

**Write**
- **`record_reconciliation(repo_path, decision_id, verdict, nonconformant?, note?)`**
  — the agent calls this after judging. `verdict ∈ {match, partial, drift}`. The
  **server recomputes `governed_source_hash` itself** and stamps it with
  `reconciled_at` + `reconciled_by` — the verdict is bound to the source the
  *server* sees, never a hash the agent passes. Rejects decisions with zero
  GOVERNS links.

**Read**
- **`pending_reconciliations(repo_path, limit?)`** — the batch enumerator the
  SessionStart sweep points to. Returns active decisions whose current hash !=
  `reconciled_source_hash` (or never judged), each with prose + capped governed
  source + last verdict, so the agent judges the whole set in one turn and records
  each.
- **`why_was_this_built` / `get_decision`** — gain the reconciliation block (§6.1)
  and the derived `displayState` projection.
- **`search_decisions`** — appends `⚠ N drifted` over the returned page; no source
  inlined.

**CLI**
- **`cortex reconcile status`** — deterministic count + decision ids for the hook
  banner; reuses `hashGovernedSource`, no LLM.

## 8. Feature flag

**`CORTEX_RECONCILE`, default off in v1** (spec: "ship behind a flag before the UI
ever reads it"), symmetric with `CORTEX_FRESHNESS`. Off ⇒ no reconciliation
blocks, no banner line, no `displayState` projection (status shows raw).
`record_reconciliation` stays registered so manual use works.

## 9. Testing

- **Pure functions:** `displayState(status, reconciliation)` truth table;
  `hashGovernedSource` determinism + invalidation (governed file edit flips it,
  unrelated file does not, deletion → sentinel, order-independent).
- **Migration idempotency:** additive columns applied once; existing rows
  untouched; FTS5 triggers intact.
- **`record_reconciliation`:** stamps the server-side hash; rejects zero-GOVERNS;
  validates the verdict enum.
- **On-read:** attaches the block only when drifted **and** the flag is on;
  nothing when current; nothing when the flag is off.
- **`pending_reconciliations`:** excludes superseded/deprecated/proposed and
  zero-GOVERNS decisions.
- **CLI `reconcile status`:** count matches the gate.
- **Full-loop contract test:** create a decision governing a file → edit the file
  → `why_was_this_built` shows `stale-pending` + source → `record_reconciliation(drift)`
  → `displayState = stale` → fix the code → re-read shows drift again →
  `record_reconciliation(match)` → `displayState = active`.

## 10. Out of scope (v1) / future

- **Symbol-level hashing** — hash the governed function snippet rather than the
  whole file. More precise, needs current-parse line ranges.
- **Server-side LLM judgment** — an alternative to agent-delegation for headless
  contexts; the SDK is already bundled.
- **Post-commit hook trigger** and a **user-invoked `/reconcile-decisions` skill**
  — additional triggers beyond on-read + SessionStart.
- **`decision_reconciliations` history table** — verdict timeline for the canvas.
- **Canvas surfacing** — the amber-tick "reconciliation needed" treatment on
  marginalia pills (the viewer does not yet render decisions; §progress.md).
- **`partial` semantics refinement** — v1 treats `partial` as a distinct display
  state but does not act on the nonconformant-node list beyond storing it.

## 11. References

- [docs/specs/progress.md](../../specs/progress.md) — gap analysis naming
  reconciliation the highest-leverage v0.3 gap.
- [docs/specs/cortex-v0.3/cortex-backlog.md](../../specs/cortex-v0.3/cortex-backlog.md)
  §"Reconciliation engine".
- [docs/specs/cortex-v0.3/cortex-multiplayer-spec.md](../../specs/cortex-v0.3/cortex-multiplayer-spec.md)
  §3 (decision model), §10.3 (reconciliation engine).
- Decision `bbf0fce5` — the graph freshness signal whose pattern this reuses.
- [src/db/cache.ts](../../../src/db/cache.ts) — `grammarPackHash` hashing primitive.
- [src/decisions/db.ts](../../../src/decisions/db.ts) — `ensureProvenanceColumn`
  additive-migration pattern.
