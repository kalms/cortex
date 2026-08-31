# Field Report — Building Mesh M1 on Cortex: the Platform-Consumer Perspective

**Date:** 2026-06-12
**Evaluator:** Claude (Fable 5), session in `/Users/rka/Development/cortex` (work primarily in `../mesh`)
**Subject:** Cortex in two roles simultaneously — (a) MCP exploration tool during development, (b) embedded platform consumed by a real downstream product
**Session scope:** Full Mesh M1 build (Electron host + chat + event log + Claude Code driver + substrate canvas fed by Cortex's HTTP API), plus follow-up fixes and a deliberate token-economics retrospective requested by the user

Previous field reports evaluated Cortex as an exploration tool on foreign
repos (private-monorepo). This session is different in kind: Mesh is the first
*product built on top of Cortex* — it spawns `dist/index.js` as a sidecar,
consumes `/api/projects` / `/api/graph` / `/api/decisions` live, and renders
decision provenance as a first-class UI element. That makes this the first
report written from the platform-consumer seat, not just the tool-user seat.

---

## TL;DR

1. **Decisions are the moat.** The structural code graph is good-but-replicable;
   the decision layer changed agent behavior in measurable ways this session
   (prevented dead-end searches, shaped implementation choices) and made
   Mesh's flagship UI feature real on day one. Everything in the improvement
   plan below should be weighed by whether it compounds this asset.
2. **Token economics were roughly neutral this session** — per-call wins
   (`get_code_snippet`, annotated `search_code`) were offset by a fixed
   per-turn tax (~30 tool schemas + routing docs in every turn) and noisy
   unranked search output. On cortex-heavy exploration sessions the ledger
   goes clearly positive; on build-elsewhere sessions like this one it
   doesn't. The biggest savings (avoided dead ends via decisions) never show
   up in per-call accounting.
3. **The platform surface is undocumented and unversioned.** Mesh consumes
   API shapes verified by reading Cortex source. The `dist/` asset bug found
   this session existed precisely because no consumer had ever exercised the
   embedded path. Freshness — Cortex's signature trust feature — is invisible
   over HTTP, forcing Mesh into a blind TTL cache.
4. **Top mitigation:** a `context_pack` composite tool, search ranking,
   target-repo-aware grep hook, and a versioned HTTP contract. Detailed plan
   in §5.

---

## 1. Where Cortex won

### Decisions as a behavioral substrate — the standout

This is the part that worked better than its own documentation suggests, and
the wins were concrete, not vibes:

- **`D-chfd` (indexer split) prevented an entire dead-end search arc.** The
  CLAUDE.md note backed by the decision stopped me from hunting for
  `internal/indexer/` in-tree. Cost avoided: a multi-call exploration ending
  in confusion. This category of saving — *redundant exploration that never
  happens* — is invisible in per-call token accounting and is the largest
  single item on the positive side of the ledger.
- **`D-sq61` (grep enforcement hook) converted friction into policy.** When
  the hook denied a grep, knowing the denial was a ratified decision rather
  than an accident changed my response from "work around it" to "comply with
  it." Provenance literally changed agent behavior.
- **Decision content made Mesh's UI real.** The substrate canvas's decision
  pills and cards rendered actual rationale and alternatives from
  `/api/decisions` on first wiring. A demo built on lorem ipsum would have
  proven nothing; this proved the product thesis immediately.

The general principle: code answers *what*, git answers *when/who*, decisions
are the only artifact answering *why and what was rejected*. The
rejected-alternatives field is uniquely valuable to an agent because it
prevents re-proposing paths already walked away from.

### Tool ergonomics that worked

- **`get_code_snippet` by qualified name** beat `Read`+offset every time it
  was used — one call returned the exact semantic unit (e.g. cortex's full
  bootstrap module, with comments) instead of a search plus one or two file
  reads mostly full of irrelevant lines. Estimated cost: ⅓–½ of the
  grep+Read equivalent per lookup.
- **`ambiguous_input` errors carrying candidates** resolved to the right
  symbol in one retry. Same pattern as `MissingRepoPathError` carrying
  `available_projects`: errors that contain the next move are the single
  best agent-ergonomics pattern in the codebase. Extend it everywhere.
- **`search_code`'s structural annotations** ("in function X") let me pick
  the right hit without opening files to learn what scope a match landed in.
- **The freshness banner + auto-refresh** meant index trust was never a
  question this session. The 2026-06-07/08 stale-read incidents did not recur.

### The behavioral loop as a whole

CLAUDE.md routing + inline decision references + the enforcement hook +
the SessionStart banner genuinely steered behavior. The product insight worth
stating plainly: **Cortex is less a code-search tool than a behavioral
substrate** — it makes session N+1 start with the judgment of sessions 1–N.
Mesh is the right bet because it makes that substrate visible to the human.

---

## 2. Where Cortex cost

### Search is noisy and unranked

`search_graph(name_pattern="%serve%")` returned 70+ flat results — files,
folders, doc sections, plan-task headings, variables — with no relevance
ranking and doc/plan nodes dominating. I scanned it by eye; the scan itself
likely cost more tokens than a tight grep would have. Indexing docs as
first-class nodes is a strength (it's the substrate `why_was_this_built`
depends on), but in *name search* results they are mostly noise.

### The grep hook has a cross-repo blind spot

The hook keys its allow/deny on the **cwd repo's** index state, not the
**target's**. Working on Mesh (unindexed) from a cortex cwd (indexed), it
denied legitimate greps against mesh files twice. Each false positive is a
wasted roundtrip — and worse, it teaches the agent to reach for the
`cortex:grep-ok` escape token reflexively, which erodes the policy the hook
exists to enforce.

### Decision capture coverage is the whole game, and it leaked

This session generated roughly fifteen decision-worthy choices in Mesh
(D1–D11 plus implementation-time calls). They live in `MESH.md` prose — not
a queryable store — because Mesh has no `.cortex` and capture is manual
discipline applied per-repo. The one cortex-side decision captured (`D-ypz8`)
happened because CLAUDE.md told me to. The decision asset compounds with
coverage; coverage depends on capture being near-zero-friction at the moment
of decision.

### The three-roundtrip symbol pattern

Understanding one symbol properly costs three calls: `get_code_snippet` →
`trace_path` → `why_was_this_built`. Each MCP roundtrip carries schema +
envelope overhead and burns context window. The composite is what the agent
actually wants (see P1).

### The fixed per-turn token tax

~30 Cortex tool schemas plus the routing/freshness/decision-capture sections
of CLAUDE.md ride in context on **every turn**, whether or not Cortex is
touched that turn. Over a long session this is probably the largest single
line item on either side of the token ledger, and it's structural — no
amount of per-call efficiency touches it.

### Platform-consumer findings (new category)

Building Mesh against Cortex surfaced gaps no tool-user session could:

- **`npm run build` shipped a broken `dist/`** — `worker-bootstrap.mjs` and
  `schema.sql` weren't copied by `tsc`, so a clean checkout's sidecar crashed
  on spawn. Fixed this session (0.8.2), but the bug existed because the
  embedded-consumer path had zero coverage until Mesh became its de facto
  regression test.
- **No versioned HTTP contract.** Mesh consumes `/api/projects`,
  `/api/graph`, `/api/decisions` shapes verified by reading Cortex source.
  One silent shape change breaks Mesh with no signal.
- **Freshness is MCP-only.** The signature trust feature is invisible over
  HTTP, so Mesh runs a blind 30s TTL cache — a spec deviation forced by the
  platform, and exactly the "stale derived artifact" problem freshness was
  built to solve.
- **Frame coverage fallback degrades the substrate.** Most cortex nodes
  reached Mesh without `frame_id`; path-fallback produced one `SRC·863`
  mega-frame that attracts nearly all decision pills. Already understood
  (frame-ranking is queued in v0.3) — noted here because a downstream
  *product* now visibly depends on frame quality.

---

## 3. Token economics — the honest accounting

Asked directly "did Cortex save you tokens this session," the honest answer
is: **roughly neutral, possibly slightly negative for this particular
session** — because the session was mostly building Mesh in a different repo,
so the fixed tax ran every turn while high-value lookups were occasional.

| Ledger item | Direction | Notes |
|---|---|---|
| `get_code_snippet` lookups | save, ~50–65% per lookup | vs. grep + 1–2 Reads |
| `search_code` annotations | save | fewer follow-up file opens |
| Decisions preventing dead ends | save, large but unmeasurable | whole search arcs that never happened |
| Unranked `search_graph` dumps | cost | 70+ results scanned to find one |
| Hook false-positive roundtrips | cost | 2 incidents this session |
| Three-call symbol pattern | cost | composite would be 1 call |
| Fixed schema + routing tax | cost, every turn | likely the largest single item |

Two structural conclusions:

1. The **marginal call is already efficient**; the room for improvement is in
   the fixed overhead and the multi-call patterns.
2. The decision layer's value is mostly **avoided wrong turns**, which saves
   wall-clock and review effort, not just tokens — judge it on that axis.

---

## 4. Verdict

The structural-graph half of Cortex is good but will be commoditized. The
decision-provenance half, wired into agent behavior through hooks, docs, and
now a downstream product UI, is the defensible asset. The improvement plan
below is ordered accordingly: fix the friction that taxes every session,
then deepen the moat.

---

## 5. Mitigation & improvement plan

Ordered by (impact on agent experience) ÷ (effort). Items marked ⏩ already
sit in the v0.3 queue and are reaffirmed, not new.

### P1 — `context_pack(qualified_name)` composite tool

**Problem:** three roundtrips per symbol (snippet → callers → decisions).
**Plan:** one MCP tool returning `{ snippet, callers, callees,
governing_decisions, recent_commits }` for a qualified name. All the data
already exists behind `get_code_snippet`, `trace_path`, and
`why_was_this_built` — this is composition, not new capability. Cap each
section (e.g. 10 callers, 3 commits) and include a `truncated` marker.
**Impact:** would immediately become the most-used tool; cuts the dominant
exploration pattern to ⅓ of its roundtrips. **Effort:** small.

### P2 — Search ranking + kind weighting

**Problem:** flat unranked `search_graph` output; doc/plan nodes drown code.
**Plan:** (a) rank by kind priority (function/class/route > module > section)
with exact-name and path-proximity boosts; (b) default-demote `section`
nodes in name search unless `kinds` explicitly requests them; (c) return a
top-N with a `total_matches` count instead of the full dump.
**Impact:** converts the worst token-waster into a save. **Effort:** small–medium.

### P3 — Target-repo-aware grep hook

**Problem:** hook keys policy on cwd, denying legitimate greps against
unindexed sibling repos.
**Plan:** in `prefer-cortex.sh`, resolve the *search target's* git root
(from the Grep `path`, Glob `path`, or Bash command's path arguments; fall
back to cwd only for bare unscoped patterns) and check *that* repo's
`.cortex/db` before denying.
**Impact:** removes the false-positive class entirely; protects the policy
from escape-token erosion. **Effort:** small (shell), needs careful tests.

### P4 — Warm-path decision drafting

**Problem:** capture is manual discipline; this session leaked ~15 decisions
into prose.
**Plan:** extend the `seed-decisions` machinery to the warm path — at
merge/PR time, run `decision_candidates` over the branch diff, draft
proposed decisions (`status: "proposed"`, `author: "cortex:draft"`), and
surface them for one-tap ratification. The suggest-capture hook becomes a
*drafting* trigger, not a reminder.
**Impact:** directly compounds the moat asset; coverage is the whole game.
**Effort:** medium (the seeding machinery exists; this re-aims it).

### P5 — Cross-repo decision search

**Problem:** decisions are per-repo silos; "have I decided anything about X
anywhere?" is unanswerable.
**Plan:** add a `crossRepo: true` mode to `search_decisions` that fans out
over the registry's `root_path` entries and merges FTS results with a
`repo` field per hit. The registry already federates graphs; reuse it.
**Impact:** unlocks the multi-repo workflow (cortex + mesh + client repos)
that is now the normal case. **Effort:** small–medium.

### P6 — Versioned HTTP contract + freshness over HTTP

**Problem:** Mesh consumes unversioned, undocumented API shapes; freshness
is MCP-only, forcing downstream blind caching.
**Plan:** (a) freeze JSON Schemas for `/api/projects`, `/api/graph`,
`/api/decisions` (and `/api/frames` / `/api/file-edges` when Mesh adopts
them) under `docs/api/` with a version field in responses; (b) expose the
freshness verdict as a response header (`X-Cortex-Freshness:
fresh|stale:…|empty`) or a `/api/freshness` endpoint so Mesh can replace
its TTL cache with event-accurate invalidation.
**Impact:** Mesh stops being coupled to Cortex internals; freshness trust
extends to the product surface. **Effort:** small for schemas, small for the
header.

### P7 — Reduce the fixed token tax

**Problem:** ~30 tool schemas + routing docs in every turn of every session.
**Plan, in order of preference:** (a) consolidate low-traffic tools
(`promote_decision`/`propose_decision`, the PR quartet) behind fewer
entry points with a `mode` param; (b) tighten tool descriptions —
several restate the per-tool reference that already lives in
`docs/mcp-tools.md`; (c) where the host supports deferred/lazy MCP schema
loading, mark the long tail deferred.
**Impact:** addresses the largest single ledger item; benefits every session
including ones that never call Cortex. **Effort:** medium; (a) is a breaking
change for existing prompts, so do it behind a decision.

### P8 — Temporal layer

**Problem:** the graph is a snapshot; "what changed in this subsystem since
D-2exa was captured, and does it still hold?" requires git spelunking.
**Plan:** a `changes_since(ref_or_date, scope?)` tool joining commit history
against graph nodes and decisions made/reconciled in the window. Pairs
naturally with reconciliation (`CORTEX_RECONCILE`) when that graduates.
**Impact:** completes the why-layer with a when-layer. **Effort:** large;
sequence after P1–P6.

### Reaffirmed operational items ⏩

- **Frame ranking / extraction coverage** (already v0.3 queue) — now has a
  downstream product visibly depending on it; the `SRC·863` mega-frame is
  the demo-killer.
- **C test suite rot** (~196 red, not in CI) — erodes agent trust in
  touching indexer-adjacent code; either fix against the Phase-4 schema or
  formally retire the suite so its redness stops signaling.

### Suggested sequencing

P3 (hook fix) and P2 (ranking) are quick wins that remove daily friction —
do them first. P1 (`context_pack`) next; it changes the default exploration
loop. P6 unblocks Mesh's next milestone and should land before Mesh's
viewer-adaptation work consumes `/api/frames`. P4/P5 deepen the moat and can
ride alongside. P7 needs a decision first; P8 is the long-pole follow-on.

---

## 6. Method note

Findings come from a single extended session with the work still on screen:
the Mesh M1 build (17-task plan, subagent-driven), the cortex `dist/` fix
(0.8.2), and a deliberate retrospective prompted by the user. Token-ledger
judgments are directional estimates from observed call patterns, not
measured counts — the harness does not expose per-call token figures to the
agent. Where a claim rests on a single incident (e.g. hook false positives:
n=2), the count is stated rather than generalized.
