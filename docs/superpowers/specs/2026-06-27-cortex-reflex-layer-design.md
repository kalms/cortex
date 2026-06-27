# Cortex Reflex Layer — Design

**Date:** 2026-06-27
**Status:** design — pending implementation plan
**Scope:** Tier 1 of the "fully utilize Cortex" exploration (see
[docs/explorations/2026-06-27-conscience-pass.md](../../explorations/2026-06-27-conscience-pass.md))

---

## 1. Purpose

Close the agent's **amnesia** failure mode at the three lifecycle moments where it
bites — by injecting the right Cortex context *at the right moment*, automatically,
so the behavior is reflexive rather than dependent on the agent remembering.

The motivating sentence from the exploration: *"the difference between editing
blind and editing with the blast radius in front of me"* — and *"I stop saying
confident things the graph would have told me were false."*

Three reflexes, mapped to three lifecycle moments:

```
  ENTER repo/session   →   BEFORE editing a symbol   →   AFTER changing it
  (orient)                 (brief)                       (capture)
  #2 onboarding            #1 pre-edit briefing          #3 decision capture
  SessionStart hook        study-time + edit backstop    PostToolUse commit
  (extend)                 (NEW — the gap)               (suggest-capture.sh, done)
```

Two of the three moments already have a hook. The middle one — pre-edit
briefing — is the gap this design primarily fills.

## 2. Design principle (the governing constraint)

**Signal-gated headline + progressive disclosure.** The make-or-break risk is
context flooding (inject on everything → noise) vs worthlessness (inject only
pointers → ignored). Resolved by three rules:

1. **Silence is the default.** Nothing is injected unless a hard signal gate trips.
   Most edits / reads / commits → zero added context. Firing *rarely* is what
   prevents flooding — not trimming the payload.
2. **When it fires, inject a bounded headline (≤ ~5 lines), never a dump.** The
   headline carries the *actual high-value fact* (governing decision + verdict,
   blast-radius number) plus a pointer to pull the full body on demand
   (`context_pack(qn)`).
3. **Intervention strength scales with stakes** — the ladder:
   `silent allow → headline inject → block-once`. Only a `partial`/`drift`/
   `unreconciled` governing decision earns a block.

## 3. The #1 gate

A target trips the gate when **either**:

- it is governed by an active decision (`DecisionSearch.findGoverning` — walks the
  qn/path hierarchy), **or**
- its blast radius exceeds `N` callers (default `N = 12`, env-configurable via
  `CORTEX_BRIEF_FANOUT`).

A governing decision whose verdict is `partial` / `drift` / `unreconciled`
**escalates** the intervention to `block-once`. Everything ungated stays silent.

## 4. #1 architecture — two triggers joined by a session ledger

`PreToolUse`-on-`Edit` alone is *post-hoc*: it fires after the edit is composed, so
for the non-blocking case the briefing lands after the action — awareness, not a
*pre*-edit briefing. The faithful design briefs the agent **while it is still
reasoning**, with the edit hook demoted to a backstop.

### 4.1 Primary — study-time enrichment (in-process, no hook)

`get_code_snippet` and `trace_path` are MCP tools the server already enriches with
the freshness signal (`attachFreshness`). The briefing rides the **same mechanism**:
when the agent deliberately fetches/traces a gated symbol, the server appends the
briefing headline to the response. This is the moment the agent forms its mental
model — the true "before I write a line." In-process, no subprocess, no latency,
gated, headline-sized.

### 4.2 Backstop — edit-time hook (`PreToolUse` on `Edit|Write|MultiEdit`)

Fires **only** when the agent is about to edit gated code it **never studied via
Cortex** (the genuine "flying blind" case). Behavior:

- Cheap shell pre-filter against the SessionStart **gate-cache** (§4.4). Miss → silent
  allow, **zero Node spawns**.
- Hit **and** target already in the **briefed ledger** (§4.3) → silent allow (already
  briefed at study-time; don't re-brief).
- Hit and **not** briefed → spawn `cortex brief <path>`, **block-once** with the
  headline as the denial reason so the briefing precedes the edit; the agent
  re-issues, now informed. `partial`/`drift` adds a louder escalation line.

### 4.3 The join — session "briefed" ledger

A per-session sentinel file (e.g. `.cortex/.briefed-<session>`) listing targets
already briefed. Study-time enrichment (§4.1) appends to it; the edit hook (§4.2)
reads it to suppress re-briefing. Net effect: **studying disarms the backstop**, and
the backstop only ever interrupts when the briefing was skipped entirely.

### 4.4 The gate-cache (per-edit cost control)

The edit hook fires on *every* `Edit`/`Write`, but must do work only on the gated
minority. At **SessionStart**, `check-index.sh` precomputes the gate sets once —
governed paths + high-fanout files (> N callers) — into a cache file (the sentinel
pattern the auto-index already uses). The per-edit hook does a cheap shell lookup
against it; the 90 % ungated case costs an O(1) grep, no Node spawn. The cache is a
*gate*, not a source of truth: on a hit, `cortex brief` re-checks live (so a
mid-session fanout change can't produce a stale *briefing*, only a stale *gate
decision*, which fails safe toward briefing).

## 5. Components & interfaces

| Unit | Responsibility | Interface | Depends on |
|---|---|---|---|
| `composeBriefing(repo, target)` | The single source of briefing truth: governing decision + verdict, caller count, last-touching PR → bounded headline + gate/escalation signal | `(repo, target) → { gated: bool, escalate: bool, headline: string }` | `DecisionSearch.findGoverning`, graph caller query, PR-link lookup |
| MCP response-enricher | Study-time injection on `get_code_snippet` / `trace_path` | wraps tool result like `attachFreshness` | `composeBriefing`, briefed-ledger writer |
| `cortex brief <path>` (CLI) | Thin wrapper for the edit hook; prints headline, exit code signals gate/escalate | `argv → stdout + exit code` | `composeBriefing` |
| `brief-edit.sh` (hook) | `PreToolUse` backstop: pre-filter, ledger check, block-once | reads gate-cache + ledger, calls `cortex brief` | gate-cache, briefed ledger |
| gate-cache builder | SessionStart precompute of governed paths + high-fanout files | writes cache file | graph + decisions |
| briefed ledger | Shared session record of briefed targets | append (enricher) / read (hook) | — |

`composeBriefing` is the keystone: one pure-ish, unit-tested TS function with two
callers (the MCP enricher and the CLI), so the briefing is identical whichever path
surfaces it.

## 6. #2 onboarding & #3 capture

- **#2 — onboarding headline.** `check-index.sh` (SessionStart) emits a one-time,
  ≤ ~8-line architecture headline (top modules + entrypoints) on a repo not yet
  oriented this session, via a `cortex architecture --headline` mode. Same
  silence-by-default discipline (one-time, sentinel-gated). Builds naturally
  alongside the gate-cache precompute in §4.4 (one SessionStart pass).
- **#3 — decision capture.** `suggest-capture.sh` already fires post-commit and
  nudges `decision({action:"create"})` + reindex. It is a *reminder*, which is the
  correct tool here: the rationale being captured does not exist in the graph yet,
  so there is nothing real to inject. **No change** beyond keeping it in the
  documented layer.

## 7. Configuration (consistent with existing `CORTEX_*` knobs)

- `CORTEX_BRIEF=0` — disable the #1 reflex entirely (enrichment + hook).
- `CORTEX_BRIEF_FANOUT=<int>` — blast-radius threshold `N` (default 12).
- `CORTEX_BRIEF_BLOCK=0` — downgrade the edit backstop from `block-once` to
  non-blocking headline injection (escape hatch for users who find blocking
  intrusive).
- Reuses existing `CORTEX_AUTO_REFRESH` / index plumbing; degrade-safe like the
  other hooks.

## 8. Error handling & degrade-safety

- The MCP enricher must **never** break or delay a tool response: `composeBriefing`
  failures are swallowed; the unenriched result is returned (same contract as
  `attachFreshness`).
- The hook is degrade-safe (missing `jq`/CLI/cache → allow), matching
  `prefer-cortex.sh`. A failed `cortex brief` → allow (never block on tooling
  failure).
- The gate-cache and briefed ledger are best-effort: absence → the hook treats
  every gated edit as un-briefed (fails safe toward briefing, never toward
  blocking on error).

## 9. Testing strategy

- **`composeBriefing`** — unit tests: governed/ungated, each verdict, fanout
  boundary at `N`, missing PR link, headline length bound (≤ 5 lines).
- **MCP enrichment** — parity tests mirroring the freshness suite
  (`attach-freshness.test.ts`): enriched when gated, untouched when not; never
  alters the structured payload.
- **`cortex brief`** — CLI snapshot tests for headline + exit codes.
- **Hook** — integration: pre-filter miss = silent/no spawn; hit+briefed = silent;
  hit+unbriefed = block-once with headline; `CORTEX_BRIEF_BLOCK=0` = non-blocking.
- **Gate-cache** — built at SessionStart, shape + staleness-fail-safe behavior.

## 10. Open questions / risks

- **Gate-cache staleness.** New files or fanout shifts mid-session aren't in the
  cache. Accepted: the cache only decides *whether to consult* `cortex brief`;
  misses fail safe (no briefing) rather than wrong briefings. Revisit if the miss
  rate proves high.
- **Noise tuning for `N`.** Default 12 is a guess; the env knob lets it be tuned
  per-repo. Validate against this repo's actual fanout distribution during
  implementation.
- **Edit-hook latency on a gated hit.** One Node spawn per *gated, un-briefed*
  edit. Rare by construction (gated + not-yet-studied); acceptable, and the
  pre-filter keeps the common case spawn-free.
- **Block-once intrusiveness.** Mitigated by `CORTEX_BRIEF_BLOCK=0` and by the
  ledger (a file is blocked at most once per session, and not at all if studied).

## 11. Out of scope

Tier 2 (provenance chain, trace fusion, CI gate) and Tier 3 (cross-repo, viewer
"show your work", specialist subagents, graph-as-grader). This design is Tier 1 —
the reflex layer — only.
