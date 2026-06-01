# Cold-Start Decision Seeding — Design

**Date:** 2026-05-28
**Status:** Design — pending implementation
**Branch:** `feature/decisions/cold-start-seeding`

## Problem

When a new user installs Cortex as a plugin and runs `index_repository` for
the first time, `decisions.db` is empty. That makes `why_was_this_built`,
`search_decisions`, and the whole decision-governance layer inert on day one —
exactly when the user is forming a first impression of the tool. The repo
almost always *already contains* decision signal (commit history, ADRs,
architecture docs); we just aren't harvesting it.

We want to bootstrap the decision store from existing git history and/or
documentation at cold start — **without** undermining the trust contract that
makes decisions valuable.

## The trust contract this must not break

CLAUDE.md draws a hard line: `graph.db` is a replaceable derived artifact;
`decisions.db` is **durable**. A decision record earns its keep through
`rationale` + `alternatives` + `GOVERNS` links — not just a title. Therefore:

> **Reliability principle:** Reliability is not "the extractor is correct." It
> is "an incorrect extraction is cheap to catch and *impossible* to silently
> pollute the durable store." Every guardrail below serves that principle.

Silently writing `active` decisions at cold start is rejected: a
wrong-but-confident record is worse than an empty DB, because it poisons trust
in the governance layer permanently.

## Goals

- Turn an empty `decisions.db` into a reviewed, useful starting set on first use.
- Make provenance **machine-derived**, so human review is *verification*, not
  *re-derivation*.
- Never promote a candidate to `active` without explicit human approval.
- Be discoverable automatically (most users won't hunt for a hidden command),
  but never nag an established repo.

## Non-goals

- Continuous/ongoing extraction. This is a **cold-start** seed; ongoing capture
  stays with the existing `propose_decision` / `create_decision` flow.
- A second decision-writing pipeline inside the Node indexer. The indexer's
  contribution is read-only candidate framing (see Piece 2).
- Perfect recall. A capped, high-signal candidate set the user can review in
  one sitting beats exhaustive extraction.

## Decisions already settled (during brainstorming)

| Fork | Decision |
|---|---|
| What may be written to the durable store? | `proposed`-status candidates only, with provenance; user is prompted to act. |
| What does the extracting? | LLM/skill does judgment + authoring, fed by a thin **deterministic candidate-framing pre-pass** (CLI, no DB writes). |
| When does it run? | **Agent follow-up after first index**, prompted by the check-index hook on indexed-but-zero-decisions. |
| Ratification primitive? | Reuse `update_decision({ status: "active" })`. No new `ratify`-without-PR primitive. |
| Source priority? | Run **both** docs + git every time, tagged by confidence. |

## Flow

```
first index_repository (cold start)
        │
        ▼
check-index.sh hook: indexed AND decision_count == 0 ?
        │ yes
        ▼
prompt agent: "No decisions captured yet. Scan git + docs and propose some?"
        │ user says yes
        ▼
cortex decision candidates   ← deterministic pre-pass (CLI, NO DB writes)
   emits compact JSON manifest: ADR/doc paths + commit clusters + files touched
        │
        ▼
seed-decisions skill (LLM)   ← judgment + authoring
   manifest → `proposed` decisions (provenance + confidence attached)
        │
        ▼
agent presents the batch → user approves a subset
   approved → status active   |   unapproved → discarded by default
```

## Components

### Piece 1 — Cold-start detector (`hooks/check-index.sh`)

The hook already classifies the repo as `indexed` / `not-indexed` by probing
for `graph.db`. Extend the `indexed` branch to also report decision count.

- **Detection:** must work in any cwd with no hard dependency on a system
  `sqlite3`. Add a tiny read-only CLI helper (e.g. `cortex decision count`,
  emitting an integer) and call it from the hook. If the helper is unavailable,
  the hook degrades silently to today's behavior — never errors.
- **Trigger condition:** `indexed && decision_count == 0`. Emits a one-time
  prompt block inviting the agent to run the seed flow. Because it keys on
  count, it self-disables the moment any decision exists — it cannot nag an
  established repo.

### Piece 2 — Candidate-framing pre-pass (`cortex decision candidates`)

A new CLI command (`src/cli/commands/decision.ts` already hosts the `decision`
namespace; add a `candidates` subcommand wired through `src/cli/router.ts`).
**Writes nothing to any DB** — pure read + stdout JSON.

Responsibilities:
1. **Doc discovery** — find ADR/design-doc files by path + shape
   (`docs/adr/**`, `docs/decisions/**`, `**/adr-*.md`, files whose headings
   match the ADR skeleton: Context / Decision / Consequences). Classify each as
   `adr` (structured) or `prose` (free-form architecture doc).
2. **Commit clustering** — read `git log` and group commits by
   conventional-commit scope + overlapping files-touched into candidate
   clusters. Merge/squash-PR bodies are preferred sources of "why".
3. **Emit a manifest** — a compact JSON array of ~15–20 ranked candidates.
   Capping + ranking keeps the LLM input small and the review tractable.

This is the only "hybrid" sliver, and it exists for two reasons: keep raw git
log out of the LLM's context window, and make **provenance machine-derived
rather than LLM-guessed**.

**Manifest schema (per candidate):**

```jsonc
{
  "kind": "adr" | "prose" | "commit_cluster",
  "confidence": "high" | "medium" | "low",   // adr=high, prose=medium, commits=low
  "title_hint": "string",                     // best-effort label, LLM may rewrite
  "provenance": {
    "doc_path": "docs/adr/0007-....md",        // for adr/prose
    "commit_shas": ["abc123", "def456"],       // for commit_cluster
    "files_touched": ["src/x/y.ts", "..."]     // union across the cluster/doc refs
  },
  "raw_excerpt": "string"                       // doc section or commit-body text the LLM summarizes from
}
```

### Piece 3 — Extraction skill (`skills/seed-decisions/SKILL.md`)

A new skill the agent runs after the hook prompt (and reusable as a manual
command). It does the judgment the indexer can't.

1. Run `cortex decision candidates`, read the manifest (never raw history).
2. For each candidate, decide whether it is one decision or several.
3. Author the record:
   - **`adr` (high confidence):** lift `problem`/`rationale`/`alternatives`
     near-verbatim from the structured doc.
   - **`prose`/`commit_cluster` (medium/low):** summarize, and keep claims
     conservative — do not invent alternatives that aren't evidenced.
4. Derive `GOVERNS` links from `files_touched` (resolve to qualified names via
   `search_graph`/`search_code` where a precise symbol is warranted, else link
   the file path).
5. **Dedupe** against existing decisions via `search_decisions` before writing.
6. Write each as `status: "proposed"` (see Provenance & markers below).

### Piece 4 — Review & ratify

The agent presents the batch as a numbered list, each line showing
`title · confidence · provenance`. The user approves a subset.

- **Approved →** `update_decision({ status: "active" })`.
- **Unapproved →** discarded by default (`delete_decision`), to avoid a
  graveyard of stale `proposed` records that itself erodes trust. The user may
  ask to keep specific ones as `proposed` instead.
- No PR is involved — this is the non-PR ratification path the cold-start case
  needs anyway.

## Provenance & markers

The `Decision` data JSON is freeform, so provenance is **additive** — no schema
migration:

- Add a `provenance` object to the decision's `data`:
  `{ source: "adr"|"prose"|"commits", doc_path?, commit_shas?, confidence }`.
- Set `author: "cortex:seed"` to mark machine-proposed origin, distinguishing
  seeded records from human-authored ones in review and audit.
- Where a candidate came from a doc, add a `REFERENCES` link to that doc path so
  `why_was_this_built` surfaces the source.

## Guardrails (the reliability surface)

- **Proposed-only into the durable store** — honors the durability contract; an
  un-reviewed candidate never reads as `active`.
- **Mandatory machine-derived provenance** — review is verification, not
  re-derivation; the LLM cannot fabricate which commits/docs a claim came from.
- **Confidence tiers** — focuses reviewer attention where the LLM was guessing.
- **`author: "cortex:seed"` marker** — seeded records are always identifiable.
- **Volume cap + dedupe** — ~15–20 ranked candidates, deduped against existing
  decisions, so re-runs and large repos stay tractable.
- **Idempotency** — re-running on a partly-seeded repo proposes only net-new
  candidates (dedupe by title + provenance).

## Implementation phases

1. **CLI helper `cortex decision count`** — read-only integer for the hook.
2. **CLI command `cortex decision candidates`** — doc discovery + commit
   clustering + manifest emission. Unit-tested against fixture repos.
3. **Hook extension** — `check-index.sh` decision-count probe + cold-start
   prompt; degrade-safe when the helper is missing.
4. **`seed-decisions` skill** — manifest → proposed decisions → review/ratify.
5. **Provenance/markers** — `provenance` object + `cortex:seed` author +
   `REFERENCES` doc links in the write path.
6. **Docs, READMEs & CLI help** — update `CLAUDE.md` (tool routing + decision
   storage sections), the decisions-storage architecture doc, plugin README,
   and `cortex` CLI `--help`/`help.ts` text to document the new command, skill,
   and cold-start flow. *(Explicit phase — this is the kind of step that
   silently rots if left implicit.)*

## Testing

- **Pre-pass (deterministic):** fixture repos — one with ADRs, one with only
  conventional commits, one with neither (must emit empty manifest, not error).
  Assert manifest shape, ranking, cap, and correct file/SHA provenance.
- **Hook:** indexed-with-zero-decisions emits the prompt; indexed-with-N>0 and
  not-indexed do not; missing CLI helper degrades without error.
- **Skill (judgment):** verified by walkthrough on this repo (it has both ADR-ish
  architecture docs and conventional commits) rather than asserted in unit tests.
- **Idempotency:** second run proposes only net-new candidates.

## Open questions

- Should `prose` (free-form architecture doc) extraction ship in v1, or should
  v1 be ADR + commit clusters only, with prose as a fast follow? Prose is the
  noisiest source; gating it reduces v1 risk.
- Ranking signal for the cap — recency, cluster size, scope breadth, or a blend?
