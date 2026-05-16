# Cortex — Multiplayer Engineering Specification

**Status:** Design spec complete, prototype shipped
**Date:** April 2026
**Owner:** Rasmus / @kalms
**Context:** Cortex v0.2.0 (CBM-integrated MCP server with 3D viewer) extended into a multiplayer engineering surface

**Artifacts:**
- `cortex-frames-prototype-v5.html` — canonical 2D prototype (dark mode + light mode, toggle in controls panel)
- `cortex-backlog.md` — ongoing backlog tracking next design sessions
- This specification

---

## 0. Purpose of this document

This spec documents the design outcome of an extended prototype session on the 2D multiplayer canvas, decision model, PR handling, and record drawer. It is written for Claude Code to consume when implementing against the real Cortex codebase. It covers:

1. The product framing — what "multiplayer engineering" means as a product category
2. The prototype artifact and what it proves
3. The decision data model and the code-alignment ratification rule
4. The PR model and its canvas treatment
5. The merge animation as a reference motion spec
6. Repository observations vs. what the prototype implemented
7. Frame extraction — how Cortex groups a codebase into semantic regions for the ambient canvas
8. A proposed "multiplayer test" mode so the concepts stay playable while real multi-user infrastructure is deferred
9. Prioritized next slices: feed surface, PR interface

The prototype file (`cortex-frames-prototype-v5.html`) is the canonical visual reference. Where this document and the prototype disagree, **the prototype wins** on visuals and the document wins on data model.

---

## 1. Product framing

Cortex positions itself as **multiplayer engineering** — "Figma for code, Google Docs for software." It is not another code-generation tool. It is a substrate that makes the shape of collaborative engineering work visible and navigable in real time, across humans and agents.

The differentiating claim: **no other tool lets you watch work as a shape**. Codebases are spatial; agent sessions are temporal; existing tools collapse both into logs and diffs. Cortex makes the graph the canvas and the work the motion on it.

Three primitives carry this framing:

- **Frames** — directory-scoped regions on the canvas, one per top-level subsystem. They are the reading units.
- **Nodes** — files, functions, and other code entities. Neutral dots that agents color briefly when touching them, fading back to neutral.
- **Synapses** — edge-brightness bursts along graph edges as agents traverse. The visible heartbeat of activity.

Two richer entities float on top of this substrate:

- **Decisions** — typed pointer entities that carry self-contained narrative (problem, resolution, rationale, alternatives) and typed references into the graph. Green.
- **Pull requests** — typed pointer entities that touch specific nodes, optionally introduce frames or decisions. Indigo.

Both render at rest as 4px colored dots on the canvas. Hovering shows a pill annotation to the right. Clicking opens a drawer surface (slides in from the right) for reading. The selected entity stays emphasized on the canvas — a stable filled ring plus leader lines to every entity it relates to — while the drawer is open.

---

## 2. The prototype artifact

`cortex-frames-prototype-v5.html` is a single-file HTML/Canvas prototype implementing the full interaction model for a fixed demo dataset. It is standalone — no backend, no server, no build step. Opened in a browser it runs the ambient canvas, agent cursors, decision drawer, PR drawer, and merge animation.

What the prototype proves:

- The visual vocabulary (frames, nodes, synapses, agents, decisions, PRs) composes into a legible canvas at rest and in motion
- The drawer surface generalizes across record types (decision, PR) without code-level specialization beyond content shape
- The merge animation reads as a coherent 2.4-second event spanning multiple frames, nodes, edges, decisions, and the PR entity itself
- Ambient canvas density is comfortable with 5-6 floating entities (the current seed)
- The dot-at-rest → pill-on-hover → ring-on-selection grammar is unified and works for both decisions and PRs

What the prototype does *not* prove:

- Scale behavior beyond the fixed seed dataset (no real clustering, no LOD beyond the hardcoded)
- Real agent coordination (agents are simulated with random traversals)
- Authoring flows (you cannot propose a decision or open a PR from within the prototype)
- Reconciliation against real code (all state is manually set in the seed data)
- Persistence (every reload resets state)

The prototype should be referenced during implementation as the truth for motion curves, spacing, color values, and interaction timing.

---

## 3. Decision data model

This is the most important section of the spec. The entire ratification story and a large chunk of MCP surface area rests on it.

### 3.1 Schema

```typescript
interface Decision {
  // Identity
  id: string                      // "D-142"
  summary: string                 // short human title

  // Narrative content — self-contained context
  problem: string                 // what question this answered
  resolution: string              // what was decided
  rationale: string               // why this over alternatives
  alternatives: Alternative[]     // other paths considered, with rejection reason

  // Provenance
  proposedBy: AgentRef            // @rasmus, @kai, @mira
  proposedAt: timestamp

  // Typed pointers into the graph
  governs: EntityRef[]            // files, functions, frames, symbols
  supersedes: DecisionRef | null
  supersededBy: DecisionRef | null
  relatedTo: DecisionRef[]
  dependsOn: DecisionRef[]

  // PR relationships (data kept even when not rendered)
  introducedIn: PRRef | null
  implementedBy: PRRef[]
  challengedBy: PRRef[]
  discussedIn: PRRef[]

  // Evidence (future — deferred)
  validatedBy: TestRef[]
  observedImpact: Metric[]

  // Derived (computed, not stored)
  // state: 'proposed' | 'active' | 'stale' | 'superseded' | 'deprecated'
}

interface Alternative {
  title: string
  reason: string                  // why rejected
}

type EntityRef =
  | { kind: 'frame',    id: string, label?: string }
  | { kind: 'file',     path: string }
  | { kind: 'function', path: string, name: string }
  | { kind: 'symbol',   path: string, name: string }
  | { kind: 'decision', id: string }
```

### 3.2 The ratification rule

**Code is the ratification.** Decisions are not confirmed by human approval ceremony, voting, or explicit ratification events. They are confirmed by their governed code matching their resolution text.

Derived states:

- **Proposed** — the decision exists but the code does not yet match. An agent or human has articulated something; implementation is pending or experimental.
- **Active** — description aligns with the current state of governed code. The rule holds. Load-bearing.
- **Stale** — description used to match but no longer does. Something drifted. Needs attention — not wrong, not right, just unreconciled.
- **Superseded** — another decision carries a `supersedes` edge back to this one. Archival.
- **Deprecated** — explicitly marked for removal. Code may still match but intent is to migrate away.

Only `supersededBy` edges and `deprecated` flag are stored as canonical state. Everything else is derived from reconciliation with code reality.

The ID format is `D-<number>`. There is no special "pending" or "draft" ID — proposed decisions have normal IDs from the moment they are proposed.

### 3.3 Declarative vs descriptive decisions (future)

Some decisions are process-level, not code-level ("prioritize correctness over speed"). These cannot be reconciled against code. Handle via a `kind: 'declarative'` flag and manual state. Not needed in first implementation — all seed decisions are descriptive.

### 3.4 What decisions are NOT

- Not files in a folder. There is no `src/decisions/` directory.
- Not nodes with `kind: 'decision'` embedded inside frames. They are peer entities, not children of any container.
- Not ratified by humans. Humans *can* intervene but are not *required* to.
- Not always ambient. Only `active` and `proposed` decisions appear on the ambient canvas. Stale, superseded, and deprecated decisions exist in the graph but only surface contextually (marginalia on focused frames, hover pills on governed nodes, explicit navigation).

### 3.5 Visual state treatment

At rest on the canvas, decisions are 4px dots:

- **Active**: solid green (#4ade80) at 95% opacity
- **Proposed**: same green at ~42% opacity — "present but unclaimed"
- **Stale**: hidden from ambient (marginalia only)
- **Superseded**: hidden from ambient (navigable but archival)
- **Deprecated**: solid green + amber ring at 80% alpha

On hover, a pill appears to the right of the dot showing `D-142 · LOD band projection`. The pill flips to the left near viewport edges. Leader lines to governed nodes fade in at reduced opacity.

On selection (drawer open), the dot grows a stable filled ring at 50% opacity, leader lines render at full opacity across the graph, and the drawer opens with the full decision content.

In marginalia (pills attached to the right edge of a focused frame), each state has a distinct visual detailed in the prototype's `drawMarginaliaForFrame` function. The progression active → stale → superseded desaturates progressively; stale adds a small amber tick on the left edge; superseded adds a strike-through.

---

## 4. Pull request data model

### 4.1 Schema

```typescript
interface PullRequest {
  number: number
  title: string
  state: 'draft' | 'open' | 'merged' | 'closed'
  author: AgentRef
  openedAt: timestamp
  mergedAt?: timestamp
  branch: string
  description: string
  touches: Touch[]

  introducesFrame: string | null        // frame this PR creates
  introducesDecisions: string[]          // decisions this PR proposes
  referencesDecisions: string[]          // decisions this PR implements/challenges
  linkedPrs: number[]                    // stacked/dependent PRs
  additions: number                      // +N lines
  commentCount: number
  lastActivityAt?: timestamp
}

interface Touch {
  frameId: string
  nodeName: string
  action: 'added' | 'modified'
}
```

### 4.2 Derivation rules

PRs are graph entities that float in canvas space. Several frame/node states are derived from open or draft PRs:

- **Frame is uncommitted** iff any open/draft PR has `introducesFrame` pointing at it
- **Node has hollow-ring treatment** iff it is touched by an open/draft PR with `action: 'added'`
- **Node has solid+dashed-indigo-ring treatment** iff it is touched by an open/draft PR with `action: 'modified'`
- **Edge is dashed** iff either endpoint is in an uncommitted frame

Merged and closed PRs are hidden from the ambient canvas. They remain queryable in the graph (accessible via decision drawer PR refs, future feed, node hover pills).

### 4.3 Ratification on merge

When a PR merges, every decision in its `introducesDecisions` array promotes from `proposed` to `active`. This is the concrete instance of the code-alignment rule: the code now matches the decision's description, so the decision becomes active.

Merge also:
- Flips PR state to `merged`
- Sets `mergedAt` timestamp
- Updates introduced frame's committed node count
- Removes the PR from ambient canvas rendering

### 4.4 Canvas treatment

At rest: 4px indigo dot at the centroid of touched nodes, with frame-repulsion so the dot doesn't fall inside a frame the PR doesn't touch. Same hover/selection grammar as decisions.

On focused frame that the PR touches: PR pill automatically expands. On selection: stable filled ring, dashed indigo leader lines to every touched node across every frame.

PR state color variants (all indigo family):
- **Draft**: slate-500 (`#64748b`), border dashed
- **Open**: indigo-400 (`#818cf8`)
- **Merged**: indigo-600 (`#4f46e5`) — only briefly visible during merge animation
- **Closed**: slate-600 (`#475569`) — not shown in ambient

---

## 5. The record drawer

A single reusable surface renders both decision and PR content.

### 5.1 Layout

- Slides in from right, 500px wide, full viewport height
- Canvas shifts -200px in lockstep (same 360ms ease-out curve)
- Presence stack shifts -500px to clear drawer territory
- Logo and controls stay put (they are left-positioned)
- No scrim — the canvas remains visible as context
- Generous spacing: 20-26px body padding, 26px section gaps, 62ch max-width prose, 1.65 line-height

### 5.2 Content zones

Header:
- Monospace ID (green for decisions, indigo for PRs)
- State pill (color-coded by state)
- Summary/title in display font
- Provenance: `proposed by @agent on YYYY-MM-DD`
- Close button

Body sections (varies by record type):

**Decision body:**
- Problem (prose)
- Resolution (prose)
- Rationale (prose)
- Alternatives considered (faded-yellow cards, one per alternative)
- Governs (ref pills by type)
- Supersession chain (if applicable)
- Related decisions
- Pull requests (grouped by role: introduced in, implemented by, challenged by, discussed in)

**PR body:**
- Description (prose)
- Touches (grouped by frame, with action badge per file)
- Introduces decision (ref pill)
- Introduces frame (if applicable)
- Referenced by decisions (reverse lookup)
- Discussion stub (comment count, last activity)

### 5.3 Navigation

Click a pointer pill inside the drawer → drawer content swaps in place (no stack, no back button). Opens a different record. Closing returns to ambient canvas.

Escape key closes drawer. Clicking on canvas anywhere outside the drawer closes it. Clicking a different floating entity swaps the drawer content.

### 5.4 Colors reference

Palette established during this session:

- `--text: #ededed` primary text
- `--text-2: #a1a1aa` secondary
- `--text-3: #71717a` tertiary
- `--text-4: #52525b` quaternary
- `--bg-card: #181818` drawer surface
- `--border: rgba(255,255,255,0.06)` subtle
- `--border-2: rgba(255,255,255,0.1)`
- `--border-3: rgba(255,255,255,0.18)`
- Decision green: `#4ade80` (dot), `#86efac` (pill text)
- PR indigo family: `#4f46e5` merged, `#818cf8` open, `#64748b` draft, `#475569` closed, `#a5b4fc` text accent
- Alternative yellow: `#eab308` title, `rgba(234,179,8,0.05)` fill, `rgba(234,179,8,0.35)` border
- Attention amber: `#f59e0b`, `#fbbf24` text
- Agent colors: white (`#ededed`) @rasmus, sky blue (`#60a5fa`) @kai, violet (`#c084fc`) @mira

Typography: Geist Sans + Geist Mono, weights 400/500 only. Mono for IDs, labels, code-adjacent content. Sans for prose and titles.

---

## 6. Merge animation reference

The merge animation is the product's "ship it" moment. A 2.4-second choreographed sequence across seven beats. All timings in ms from merge start.

| t | beat | effect |
|---|---|---|
| 0–300 | Ignite | PR badge transitions to "merging"; synapses fire across every inter-frame edge connecting touched frames |
| 300–900 | Border seal | Uncommitted frame's dashed border crossfades to solid |
| 600–1200 | Node fill | Added hollow-ring nodes fill to solid, BFS-ordered ~60ms stagger per node; each gets a brief white pulse at mid-fill; modified nodes' indigo rings fade out |
| 900–1400 | Edge solidify | Dashed inter-frame edges morph to solid |
| 1200–1600 | Counter roll | `+12` additions counter rolls to 0, eased; frame node count rolls up to include new nodes |
| 1600–2000 | Decision ratify | `introducesDecisions` promote from proposed (dashed + faded) to active (solid + full saturation); green glow pulses behind pill |
| 2000–2400 | PR settle | Floating PR dot/pill fades out; branch label and glyph fade on the introduced frame |

Implementation shape in the prototype:

```js
const MERGE_DURATION = 2400
const MERGE_BEATS = {
  IGNITE:    [0,    300],
  BORDER:    [300,  900],
  NODE_FILL: [600,  1200],
  EDGE_SET:  [900,  1400],
  COUNTER:   [1200, 1600],
  DECISION:  [1600, 2000],
  PR_SETTLE: [2000, 2400],
}
```

Each render path checks if a merge is in progress for its frame/node/edge/decision and interpolates accordingly. The merge state is per-PR; multiple concurrent merges are supported by the structure but not tested in the prototype.

On merge completion:
- PR state → `merged`, `mergedAt` set
- Introduced decisions → `active`
- Introduced frame node count updated
- Merge state cleared; subsequent frames render normal committed state

---

## 7. Repository observations vs. prototype

This section is written with the caveat that I'm working from memory of prior conversations about the Cortex repo, not a fresh read. Claude Code should treat these as starting points to verify, not facts.

### 7.1 What exists in `github.com/kalms/cortex` (inferred)

- TypeScript codebase, Node 20+
- `better-sqlite3` as storage, with `codebase-memory-mcp` (CBM) attached read-only for structural code data
- MCP SDK with `zod` for schema validation
- 18 MCP tools exposed (as of v0.2.0 in April 2026)
- 3 skills, 2 hooks shipped as a Claude Code plugin
- 3D WebGL viewer using Three.js / 3d-force-graph
- CBM integration for Vue/Svelte indexing added in v0.2.0
- Native decision tracking in a unified SQLite graph
- Positioned as a decision-provenance substrate consumable by agent platforms via MCP

### 7.2 What the prototype adds that isn't in the repo

The prototype demonstrates:

- A **2D canvas viewer** alongside the existing 3D force-directed viewer. The 2D viewer uses frame-based spatial layout (directories as bounded regions), not force simulation. Different aesthetic register from Obsidian-style graphs.
- The **record drawer** surface for reading decisions and PRs as primary content
- **Ambient floating entities** (decisions and PRs as dots) on the canvas
- **Multi-agent presence** — three agents visible simultaneously as cursors traversing edges, with pill labels and avatar stack
- **The merge animation**
- **Marginalia governance rendering** on focused frames

### 7.3 Data model additions required in the repo

Comparing the prototype's data model to what's likely in the repo:

**Probably exists:**
- Decision entity with id, summary, state, governs, supersession edges
- Agent identity and provenance tracking
- Some form of code-structural graph via CBM

**Probably missing / needs extension:**
- Rich decision narrative fields: `problem`, `resolution`, `rationale`, `alternatives[]`
- Typed `EntityRef` with discrimination beyond files (functions, symbols, frames)
- `relatedTo`, `dependsOn` decision edges
- Full `PullRequest` entity type
- `touches`, `introducesFrame`, `introducesDecisions` relationships
- State derivation logic (reconciliation engine — section 9)
- Frame as a first-class entity (rather than derived from directory structure at read time)

Claude Code should audit the existing schema in `src/graph/schema.ts` (or equivalent) against section 3.1 and 4.1 of this spec and propose a migration path that preserves existing v0.2.0 data.

### 7.4 MCP surface additions

New tools implied by the design:

- `propose_decision(summary, problem, resolution, rationale, alternatives, governs, supersedes?)` — creates a new proposed decision attributed to the calling agent
- `update_decision(id, fields)` — revise, tracked as a revision event
- `retire_decision(id, reason)` — mark deprecated
- `supersede_decision(oldId, newId, reason)` — atomic create-new-and-mark-old operation
- `open_pr(title, description, branch, introducesFrame?, introducesDecisions?)` — creates a PR entity in the graph. In the multiplayer-test mode this is purely graph-local; in real deployments it would mirror GitHub/GitLab state.
- `add_pr_touch(prNumber, frameId, nodeName, action)` — appends a touch entry
- `merge_pr(prNumber)` — triggers the merge state machine; promotes introduced decisions; fires the ambient animation via event stream

The reconciliation engine (section 9.1) is a separate background task, not an MCP tool.

### 7.5 Plugin/hook additions

Current hook set (2 hooks) probably covers session lifecycle. The design implies:

- **PostEditHook** — after a file edit, check which decisions govern that file and mark them as "needing reconciliation" in the graph. A lazy reconciliation worker then reads the marked set and recomputes `state` for each.
- **DecisionProposalHook** — intercept agent-driven decision authoring to ensure they come through `propose_decision` rather than being written as markdown in the codebase.

---

## 8. Frame extraction

> **⚠ Superseded.** The frame-extraction design in this section has
> been replaced by the brainstorm-pass notes:
> [`frame-extraction.md`](frame-extraction.md) (extraction algorithm),
> [`frame-ranking.md`](frame-ranking.md) (ranking + taxonomy),
> [`frame-layout.md`](frame-layout.md) (layout). The three-tier-with-templates
> cascade described below was inverted to a semantic-first
> intrinsic-only model during 2026-04-21 — 2026-05-03 brainstorming.
> Read the notes for the current design; this section is preserved as
> historical context until v0.3 ships, at which point the notes are
> promoted and this section is rewritten. See
> [`README.md`](README.md) for full corpus orientation.

### 8.1 What frames are and aren't

A frame is a named semantic region of a codebase — "auth", "the viewer", "routes", "data models". Frames are the primary organizing element of the ambient canvas: they give a casual viewer a readable map of what the codebase contains. Decisions, PRs, agent activity, and node heat are all layered on top of frames.

Three things frames are explicitly not:

**Not filesystem directories.** A frame may happen to correspond to a directory (and often does), but the correspondence is coincidence, not definition. A frame can span multiple directories ("auth" pulling from `middleware/`, `lib/`, and `routes/`), and a single directory can be split across frames. Filesystem structure is a strong prior, not a truth.

**Not user-editable.** Cortex computes frames and is the arbiter of what changes. The user never hand-edits a frame config, proposes renames, or resolves groupings. Algorithmic quality is the path forward; user editorial control is explicitly out of scope for v1 and all currently planned iterations. If the grouping is wrong, the fix is to improve the algorithm, not to patch the output.

**Not recursive.** Frames exist at one layer on the ambient canvas. They do not contain sub-frames. A frame with internal structure — multiple subdirectories, mixed concerns — is still rendered as a single frame at rest; internal structure is revealed by zoom/focus interactions at the viewer level, not by nested containment at the data-model level. This is a hard-won conclusion from prototype iteration (see section 8.10).

### 8.2 Why this matters — the product claim

The canvas-as-map metaphor only works if the map is stable. A viewer who spends time understanding "this codebase has auth, routing, middleware, and a viewer" needs to come back a day, a week, or a month later and see those same regions. Frames are the skeleton; activity is the motion on top of the skeleton. If the skeleton reshapes on every file change, the canvas fails as a mental model.

This is the reason frames are not activity-driven (an earlier design direction that was considered and rejected). Heat, agent presence, decision refs, and PR touches all surface on the canvas, but they modulate the frame's appearance — they never reshape the frame set itself.

### 8.3 Three-tier extraction cascade

The extraction algorithm runs as a deterministic cascade. Cheap checks first, expensive analysis only when justified. Each tier is a distinct code path, not a stage in a pipeline.

**Tier 1 — Trivial.** The filesystem already produces 3–12 readable frames. Top-level directories (excluding ignorable paths) are enumerated, each becomes a frame. No framework detection, no graph analysis. A Cortex-like repo with `src/`, `docs/`, `tests/`, `skills/`, etc. lands here naturally. Decision criteria: count of top-level dirs is in target band, each has non-trivial file count, and no single dir dominates (>60% of files).

**Tier 2 — Heuristic.** A known framework or monorepo template applies. Framework detection reads manifest files (`package.json`, `Gemfile`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `turbo.json`, `pnpm-workspace.yaml`, etc.) plus marker files (`next.config.*`, `config/routes.rb`). On confident detection, a hand-authored template maps glob patterns to frame names in the framework's vocabulary. Examples:

- `nextjs-app`: `{routes: 'app/**|pages/**', api: 'app/api/**|pages/api/**', components: 'components/**', data: 'lib/**', config: 'next.config.*|middleware.ts'}`
- `rails-app`: `{models: 'app/models/**', controllers: 'app/controllers/**', views: 'app/views/**', routing: 'config/routes.rb', jobs: 'app/jobs/**'}`
- `monorepo-js`: one frame per workspace package, named from the package's `name` field

Files matching no template glob are left unassigned (section 8.5). Templates are versioned content — adding a new framework is a template library addition, not an algorithm change.

**Tier 3 — ACDC on demand.** Pattern-driven clustering derived from Tzerpos & Holt's ACDC (2000). Runs the dominator, support-library, dispatcher, and orphan-adoption patterns against the import graph from CBM. Does NOT run automatically. Invoked explicitly by an agent or human operator via an MCP tool, scoped to a whole repo or a subset (typically the unassigned files from baseline extraction).

The rationale for making Tier 3 opt-in rather than automatic: baseline Tier 1/2 is fast and predictable; Tier 3 requires graph queries that may be expensive on large codebases; and most repos don't benefit enough from Tier 3 to justify always paying its cost. Agents invoking Tier 3 is a first-class use case — an agent trying to understand an unfamiliar repo can request deeper analysis when baseline output leaves too much unassigned.

### 8.4 Selection between tiers

The cascade runs in order. The first tier that produces acceptable output wins.

```
if top_level_dirs_readable(repo):
    return tier_1_extract(repo)
elif framework_detected(repo, confidence_threshold=HIGH):
    return tier_2_extract(repo, template)
else:
    return tier_1_fallback(repo)  # best-effort directory extraction
```

Tier 3 is never in this default path. If the baseline produces many unassigned files or a frame that feels wrong, a user or agent can invoke Tier 3 separately.

An important nuance: **unassigned is a valid output state, not a failure.** A `lib/` directory with miscellaneous helpers genuinely isn't "one thing." Files in that directory should render as unassigned rather than being forced into a phantom "lib" frame. The canvas treats unassigned files as a soft cluster at the edge, findable and navigable but clearly not claimed by a named region.

### 8.5 The unassigned state

Unassigned files are first-class. They:

- Appear in the graph (decisions can govern them, PRs can touch them, search finds them)
- Render on the canvas in a visible but distinct "unassigned" area — an edge strip or a softly-bordered region, deliberately not shaped like a frame
- Can be the target of Tier 3 invocation: "run ACDC on just the unassigned files to see if a new frame should be proposed"

Unassigned is not a warning. It's a legitimate ongoing state. A codebase with 60 files in named frames and 8 in unassigned is not broken — it has 8 files that don't clearly belong to any single region, and the canvas is being honest about that.

### 8.6 Determinism requirements

Team consistency is achieved through determinism, not through shared state. Every client runs the same algorithm against the same committed code and the same CBM graph, producing identical output. This is a load-bearing property.

Requirements:

- Every SQL query against CBM must have explicit `ORDER BY` clauses
- All tie-breaking is lexicographic (sort by ID, then by path, deterministically)
- No use of random seeds or hash-table iteration order
- Template library is versioned; output records the template version used
- LLM labeling, if used (section 8.9), must be temperature=0 and content-hash-cached — two clients asking for the same label should get the same answer

Because output is deterministic, two developers on the same commit produce byte-identical frames independently. No synchronization protocol required between clients for frame consistency. A shared Cortex server is still useful for multiplayer features (presence, live events, shared sessions), but the frame map itself is a local-first property.

### 8.7 Storage model — local cache

Frames are stored locally per-client, in the Cortex SQLite database, as a materialized cache. The canonical state is "whatever the current extraction algorithm produces on the current committed code and graph." The table is a cache of that computation, not an authoritative store.

Schema:

```sql
frames(
  id TEXT PRIMARY KEY,
  label TEXT,
  tier TEXT,                    -- '1' | '2' | '3'
  template_version TEXT,        -- for tier 2
  created_from TEXT,            -- debug trail: which rule produced this frame
  cache_key TEXT                -- hash of inputs that produced this frame set
)

frame_members(
  frame_id TEXT,
  file_path TEXT,
  PRIMARY KEY (frame_id, file_path)
)

frame_extraction_runs(
  run_id TEXT PRIMARY KEY,
  completed_at TIMESTAMP,
  cache_key TEXT,
  tier_used TEXT,
  duration_ms INTEGER,
  trigger TEXT                  -- 'cbm_reindex' | 'manual' | 'startup' | etc.
)
```

The cache key is a hash of inputs: git HEAD + CBM graph version + template library version + extractor algorithm version. If any input changes, the cache is stale and extraction re-runs.

### 8.8 Re-run policy — always wipe

Every extraction run is a full replacement. The newest run is the newest truth. No preservation of previous frames, no merging of old and new output, no special-case "keep this because it looked good."

This applies equally to Tier 3 output. If an agent invokes Tier 3 today and the results are useful, tomorrow's baseline extraction still runs Tier 1 or Tier 2 and wipes the Tier 3 output. If the Tier 3 insight was valuable enough to preserve, the path forward is to improve the baseline algorithm or add a template — not to cache manual extractions indefinitely.

Rationale: keeps the mental model clean. Baseline extraction is ground truth; Tier 3 is an on-demand view layered on top. Mixing them creates ambiguity about what produced a given frame and when it will change.

Triggers for re-extraction:

- **CBM reindex completes** — the graph changed, cache is stale, recompute
- **Git HEAD advances** — the committed code changed, cache is stale, recompute
- **Template library version bumps** — algorithm changed, recompute
- **Explicit invocation** — agent or user requested a re-run (possibly with a Tier override)

Frame extraction is not itself an expensive operation for Tier 1 or 2 (milliseconds on most repos). The cache exists primarily to make reads cheap for agents and the viewer, not to avoid extraction cost.

### 8.9 Labeling priority

Each frame gets a human-readable label. Priority order, first match wins:

1. **Template-assigned name** — for Tier 2 output, the template specifies the name
2. **Dominator filename** — for ACDC output, the dominating file's name (stripped, prettified)
3. **Directory name** — for Tier 1 output or clean directory-aligned frames
4. **Markdown-section match** — if the repo's README has a section heading referencing ≥2 files all in the same frame, the section heading becomes the label. This is a genuinely novel signal; no other tool labels clusters from the project's own documentation.
5. **LLM fallback** — deterministic (temp=0, structured output, ≤3 words), cached by `(repo_hash, frame_file_list)` hash. Used only when 1–4 produce nothing meaningful.

### 8.10 Agent surface

Frames are moderately useful for agents — not the core value, but a genuine quality-of-life improvement for scoping, context packaging, and shared vocabulary with humans.

Agents consume the frame graph via a thin MCP API:

- `get_frame_for_file(path) → frame | null` — which region does this file belong to
- `get_files_in_frame(frame_id) → file[]` — return the member files of a frame
- `list_frames() → frame[]` — enumerate the current frame set
- `search_within_frame(query, frame_id) → results[]` — scoped search
- `trigger_tier3_extraction(scope?) → extraction_run_id` — on-demand deeper analysis

What agents explicitly do NOT see:

- Extractor implementation details (tier logic, template matching internals)
- The ability to edit or override a grouping
- Any prompt to "validate" a frame before using it

Agents treat frames as given, the same way humans do. The agent's job is to use the grouping, not to question it, recompute it, or understand how it was produced.

**A concern worth naming:** agents will trust frames more than humans will. A human glancing at the canvas can visually perceive "that frame seems too big / too mixed." An agent consuming `get_files_in_frame` as JSON has no such perceptual check — it takes the data at face value. This creates a subtle failure mode where an agent reasons within a bad grouping and produces confidently-wrong results.

Mitigations:

- Each frame's response includes provenance metadata (`tier`, `created_from`, `template_version`, confidence indicators). An agent can weight its trust accordingly — a Tier 1 frame from pure directory extraction warrants less confidence than a Tier 2 template-matched frame.
- When an agent's query matches both a frame's contents and some unassigned files, both should be returned. Never assume the frame is complete.
- `trigger_tier3_extraction` is the first-line response when a frame seems wrong. Agents should invoke it when they detect a mismatch between a frame's label and its apparent contents.

### 8.11 The three-tier architecture was not obvious

This section exists because the algorithm design went through meaningful iteration. A new agent continuing this work should understand what was tried and rejected, so they don't repeat the work or, worse, re-introduce the rejected approach.

**Rejected: recursive frame nesting.** An earlier prototype (v6) attempted to render frames as recursive containers — frames contained sub-frames contained nodes. This fails in several ways:

- Frame sizes become unpredictable. A top-level frame containing 8 subdirectories becomes 4 rows × 138px tall, producing skyscrapers that don't fit any reasonable viewport
- Edge semantics break down. Edges between nodes must cross frame boundaries, but when frames themselves are inside frames, "crossing a boundary" becomes meaningless
- Decisions can't cleanly target deeply-nested nodes — `governs: [frame: src/events/worker]` has to traverse multiple containment layers
- The graph-as-canvas reading collapses into a hierarchy-as-canvas reading, losing the product's core metaphor

The v5 prototype's one-layer-of-frames discipline is load-bearing and should not be relaxed in future iterations.

**Rejected: user-editable frame configs.** An earlier direction had a `.cortex/frames.yaml` committed to the repo, edited by users, PR-reviewed, merged like any other team artifact. This was rejected for several reasons:

- Needless complexity. Frames are a visualization concern; agents and the graph already work without them
- Forces teams to maintain a view config for a tool some members might not use
- Opens a whole architecture of proposal queues, concurrent-edit resolution, drift detection
- If the grouping is wrong, "let the user fix it" is a worse answer than "improve the algorithm"

**Rejected: activity-driven frame discovery.** An earlier proposal suggested frames should emerge from where agent activity concentrates — heat-map-as-grouping. This was rejected because it makes the canvas unstable. A frame that appears and disappears based on what agents are currently touching is disorienting. Frames must be stable semantic anchors; activity is the motion on top.

**Rejected: pure community detection.** Running Louvain/Leiden on the import graph and calling the output "frames" produces clusters that are structurally coherent but unnameable and unstable. The research literature (Bunch, LIMBO, WCA) has decades of this approach and it doesn't satisfy the "legible to a casual viewer" requirement. ACDC's pattern-driven approach — which produces named, stable clusters — is a better anchor.

**Accepted: the three-tier cascade as the synthesis.** Filesystem as strong default (Tier 1), framework templates as explicit structure recognition (Tier 2), ACDC graph analysis as opt-in deep mode (Tier 3). Each tier is simple enough to reason about; together they cover the variance in real codebases without forcing the expensive analysis on simple cases.

### 8.12 Open questions and gaps in knowledge

The following are genuine uncertainties at the time of writing. A new agent should treat them as empirical questions to resolve through prototyping and testing, not as solved problems.

**Is the tier selection logic correct?** The cascade's decision criteria (`top_level_dirs_readable`, `framework_detected(confidence=HIGH)`) are informed guesses. Real codebases will expose edge cases. Specifically: what happens when a repo has a `package.json` claiming Next.js but a non-standard `app/` structure? Does template matching misfire confidently, or correctly fall through to Tier 1?

**How do we validate output quality across codebases?** The research brief (see `cortex-frame-research.md` if available) proposes a 25-repo test corpus spanning Rails, Next.js, Django, Python ML, Go, Rust, monorepos, and research codebases. The methodology proposes MoJoFM scoring against expert ground truth and a "casual-viewer test" (show frame names, ask what the codebase does). Neither has been executed. The casual-viewer test is nominally the primary metric but hasn't been correlated with actual product success.

**Will Tier 1/2 produce output meaningfully better than "just use top-level directories"?** Unknown. Most well-organized codebases have already structured their `src/` reasonably. The marginal value of Tier 2's framework templates over pure directory output is an open empirical question. This should be tested early — run "top-level dirs only" as a baseline against the test corpus before investing heavily in Tier 2 template library breadth.

**Performance at scale.** Tier 3 ACDC queries against CBM's import graph for a large repo (e.g. Kubernetes, ~60k files) have not been benchmarked. "Expensive" is an assumption, not a measurement. If Tier 3 turns out to be fast even at scale, the rationale for making it opt-in weakens.

**ML/research codebases are underserved.** Baseline output on a codebase like `transformers` or `scikit-learn` will be something like `{src, tests, docs, examples, scripts}` — technically correct but uninformative. This effectively positions Cortex as a web-app tool unless ML-specific templates are added. Not a blocker for v1, but a significant scope limitation that should be honest about.

**Markdown labeling hit rate.** The README-section-matching signal is novel and promising, but has unknown hit rate. Many repos have bad READMEs or no README structure that matches code files. The signal is a bonus when it fires, not load-bearing.

**CBM schema assumptions.** The queries proposed for Tier 3 (dominator, support-library, etc.) assume specific table and column names in the CBM SQLite schema (e.g. `cbm.nodes`, `cbm.edges`, `kind`, `src_id`). These names should be verified against the actual CBM output before coding. The research brief flagged this explicitly — don't bake CBM-specific edge type names into algorithm code; treat CBM as an adapter over "a queryable edges table" so a future native implementation is easy.

**The fragmented-domain problem is not solved.** If auth code lives in `middleware/`, `models/`, and `routes/`, Tier 1 and Tier 2 will produce three separate frames, none of them called "auth." The research brief's position is that frames are structural ("where things are") and semantic cross-cutting ("show me auth") is a separate feature handled by search and decisions. This is a reasonable architectural split but will be a real product gap — users will ask for it. Name the concern explicitly rather than hoping users don't notice.

**Re-extraction frequency vs. stability trade-off.** Always-wipe is clean, but if CBM reindexes trigger re-extraction and re-extraction produces slightly different frames (because, e.g., new files tipped a tier decision), the canvas visibly reshuffles. This hasn't been observed yet but is predictable. Possible mitigation: hysteresis on tier selection (don't switch tiers unless the decision criteria are exceeded by a margin, not just barely).

### 8.13 Implementation order

When a new agent picks up this work, recommended order:

1. **Write the tier selection logic first.** Given a tree + framework fingerprints + file count, which tier applies? Pure function, easy to test in isolation with fixtures.
2. **Implement Tier 1.** Enumerate top-level dirs, produce frames. Write against a small real repo (Cortex itself is a reasonable starting point).
3. **Implement the baseline cache and re-run mechanics.** Hash inputs, store output, detect staleness. No Tier 2 or 3 yet.
4. **Stand up the agent MCP surface.** `get_frame_for_file`, `get_files_in_frame`, `list_frames`. Agents can read frames even though only Tier 1 produces them.
5. **Add Tier 2 for one framework.** Pick Next.js or Rails — both well-documented, both common. Template + confident framework detection. Iterate until output is obviously better than Tier 1 on that framework's repos.
6. **Expand the template library.** 6–8 frameworks for v1: `nextjs-app`, `nuxt-app`, `rails-app`, `django-project`, `monorepo-js-turbo`, `monorepo-js-nx`, `go-stdlib-service`, `rust-crate`.
7. **Implement Tier 3 as a manually-invoked tool.** ACDC patterns over CBM graph. Confirm the CBM schema before coding queries. Start with the dominator pattern only — it's the most load-bearing.
8. **Run the test corpus.** Score Tier 1 output, Tier 2 output, and Tier 3 output across 25 repos. Use both MoJoFM and the casual-viewer test. Iterate on the parts that score worst.

Steps 1–4 unblock the ambient canvas against real data. Steps 5–8 earn the algorithmic claim.

---

## 9. Multiplayer test mode

The hardest multiplayer problems — auth, hosting, presence sync, conflict resolution — are all outside the scope of Cortex v0.3. But we can keep the *feel* of multiplayer playable by implementing a local-only "multiplayer test" mode that runs in the browser against the SQLite graph.

### 9.1 Goal

Preserve the ability to play with the collaborative canvas exactly as the prototype does — multiple agents visible, actions animating in real time, decisions and PRs surfacing as entities — while running entirely single-user and single-host.

This keeps the design cycle fast (no auth complexity, no deployment, no server) and defers the hard infrastructure work until the product shape is proven.

### 9.2 Shape

A mode flag (`--multiplayer-test` or similar) that:

1. **Simulates multiple agent sessions** alongside the real user. When active, two or three synthetic agents drift through the graph on scripted or random traversals, just like the prototype's `@kai` and `@mira`. They touch nodes, fire synapses, and occasionally propose decisions or open PRs via the MCP tools.
2. **Replays scripted scenarios** on demand. A scenario file (YAML or JSON) describes a sequence of events: "@mira opens PR #512 touching these 7 nodes, @kai proposes D-167, user merges PR, decision ratifies." Running the scenario animates the canvas through the events at natural pacing.
3. **Routes all writes through the normal MCP surface.** The synthetic agents call the same `propose_decision`, `open_pr`, `add_pr_touch`, `merge_pr` tools the real MCP server exposes. This means the test mode exercises the whole stack — data model, reconciliation, animation, drawer rendering — without needing real network multiplayer.
4. **Surfaces event stream over WebSocket** same as production will — but the WS server runs in-process, the client connects to `localhost`, and there's no auth. This preserves the real-time feel and lets the viewer code be the same in both modes.

### 9.3 Scenario DSL

Scenarios are TypeScript files. This gives autocomplete on decision/PR payloads via imported types, lets scenarios compose (helpers, loops, shared fixtures), and keeps the type system honest about what's a valid MCP call.

The DSL exposes a single async `scenario()` function that receives a context object with methods mapping to MCP tools plus timeline helpers. Scenarios read top-to-bottom like a story.

```typescript
// scenarios/temporal-subsystem-merge.ts
import { scenario, agent, Decision, PR } from '@cortex/scenarios'

export default scenario({
  name: 'Temporal subsystem merge',
  description: '@mira opens a cross-frame PR, proposes causal ordering decision, then merges',

  run: async (ctx) => {
    await ctx.agentPresent('mira')

    await ctx.wait(200)
    await ctx.agentTraverse('mira', {
      from: 'src/events/emitter.ts',
      to: 'src/ws/protocol.ts',
    })

    await ctx.wait(1000)
    const pr = await ctx.openPr({
      number: 512,
      author: 'mira',
      title: 'Introduce temporal/causal ordering subsystem',
      branch: 'feature/temporal-reasoning-with-causal-ordering',
      introducesFrame: 'temporal',
      introducesDecisions: ['D-167'],
      description: 'Adds a new src/temporal subsystem for establishing causal order across agent events.',
      touches: [
        { frameId: 'temporal', nodeName: 'timeline.ts',  action: 'added' },
        { frameId: 'temporal', nodeName: 'ordering.ts',  action: 'added' },
        { frameId: 'temporal', nodeName: 'causality.ts', action: 'added' },
        { frameId: 'temporal', nodeName: 'index.ts',     action: 'added' },
        { frameId: 'events',   nodeName: 'emitter.ts',   action: 'modified' },
        { frameId: 'events',   nodeName: 'dispatch.ts',  action: 'modified' },
        { frameId: 'ws',       nodeName: 'protocol.ts',  action: 'modified' },
      ],
    })

    await ctx.wait(200)
    await ctx.proposeDecision({
      id: 'D-167',
      summary: 'causal ordering',
      proposedBy: 'mira',
      problem: 'Decisions and synapses need a clear temporal order when multiple agents act in overlapping code.',
      resolution: 'Use Lamport timestamps per agent, combined with server receipt time as tiebreaker.',
      rationale: 'Lamport gives causal consistency without clock sync. Wall-clock tiebreaker handles genuinely concurrent events.',
      alternatives: [
        { title: 'Vector clocks',    reason: 'Heavier per-event overhead' },
        { title: 'Wall clock only',  reason: 'Breaks across machines' },
      ],
      governs: [{ kind: 'frame', id: 'temporal' }],
    })

    // Hand off to the user for the merge action
    await ctx.pauseForUser('Click the merge button when ready')

    // Respond to the user-driven merge with a follow-up beat
    await ctx.onMerged(pr, async () => {
      await ctx.wait(400)
      await ctx.fireSynapse({ from: 'temporal', to: 'events' })
    })
  },
})
```

Context API surface (representative, not exhaustive):

```typescript
interface ScenarioContext {
  // Timeline primitives
  wait(ms: number): Promise<void>
  at(ms: number, fn: () => Promise<void>): Promise<void>   // absolute time from scenario start
  pauseForUser(message?: string): Promise<void>
  onMerged(pr: PR, fn: () => Promise<void>): void           // fires when the user (or another actor) merges

  // Agent actions (synthetic — these drive canvas animation)
  agentPresent(agent: AgentId): Promise<void>
  agentDepart(agent: AgentId): Promise<void>
  agentTraverse(agent: AgentId, path: { from: NodeRef; to: NodeRef }): Promise<void>
  fireSynapse(edge: { from: FrameId | NodeRef; to: FrameId | NodeRef }): Promise<void>

  // MCP-mirrored authoring (routed through the real tool surface)
  openPr(input: OpenPRInput): Promise<PR>
  addPrTouch(pr: PR, touch: Touch): Promise<void>
  mergePr(pr: PR): Promise<void>
  proposeDecision(input: ProposeDecisionInput): Promise<Decision>
  updateDecision(id: DecisionId, patch: Partial<Decision>): Promise<void>
  supersedeDecision(oldId: DecisionId, newId: DecisionId, reason: string): Promise<void>
}
```

Composition helpers (shipped alongside the DSL):

```typescript
// scenarios/lib/fixtures.ts
export async function ambientNoise(ctx: ScenarioContext, agents: AgentId[], durationMs: number) {
  // Random traversals in the background while the scripted story plays
  // Useful when the main scenario wants "multiplayer feel" without choreography
}

export async function openAndMerge(ctx: ScenarioContext, pr: OpenPRInput) {
  const opened = await ctx.openPr(pr)
  await ctx.wait(800)
  await ctx.mergePr(opened)
  return opened
}
```

Scenarios can import each other for layered scripts — a "big demo" scenario can compose several smaller ones.

Why TS over a serialized format:

- Types catch malformed PR payloads (e.g., `action: 'addded'`) at author time rather than scenario-runtime
- `await` in the DSL naturally expresses "wait until X, then do Y" without a separate wait-condition syntax
- `onMerged` and similar hooks are real functions, not string references to handlers
- Composition via imports beats YAML anchors for any non-trivial reuse
- Renames and refactors to the data model cascade through scenarios automatically

Cost: scenarios need `ts-node` or a build step to run. Acceptable — the existing repo is already TypeScript.

### 9.4 What this mode is not

- Not real multiplayer. Two people on different machines cannot connect.
- Not authenticated. There's no user identity beyond the scenario-provided agent labels.
- Not persistent across restarts in any shared way — each session starts from a scenario.

When real multiplayer comes, this mode stays available as a playground and demo surface. The scenario format becomes useful for regression tests, demos, and reproducing bug reports.

### 9.5 Implementation sketch

- Add a `cortex dev --scenario <path>` CLI that starts the MCP server, loads the scenario TypeScript module, injects a synthetic agent runner, and invokes the exported `run` function with the `ScenarioContext`
- Context methods are thin wrappers over the real MCP client — `ctx.proposeDecision(...)` invokes the same tool an agent would
- Scenarios run in a separate process from the MCP server but connect as a privileged client (the `synthetic-agent-runner` identity, trusted by the server in `--multiplayer-test` mode only)
- Viewer connects normally via WebSocket; it cannot distinguish a scripted agent from a real one
- `cortex dev --random-agents 2` spawns two synthetic agents with random traversal behavior — useful as ambient background, independent of any scenario
- `cortex dev --replay <scenario>` runs a scenario non-interactively for regression testing; `pauseForUser` becomes a no-op that logs the prompt
- Project layout: `scenarios/` directory at repo root, one file per scenario, `scenarios/lib/` for shared fixtures and composition helpers

---

## 10. What's next after this spec

Two feature slices queued for the next design sessions.

### 10.1 The feed

The feed is a chronological surface showing what's happened recently — merges, decisions, new PRs, agent arrivals, conflicts. Sits at the opposite end of the canvas from the presence stack; probably top-left or bottom-right.

Open questions the next session needs to answer:
- Temporal window: last hour, last session, unread-since-last-visit?
- Entry shape: one line per event, expandable to reveal more
- What's in the feed that's not on the canvas (and vice versa) — the canvas shows present tense, the feed shows past tense
- Linking: feed entries should link to the drawer surface (clicking a "PR #512 merged" entry opens the PR drawer)
- Filtering: per-agent, per-frame, per-event-type
- Visual density: the feed risks being a wall of text; probably wants entity-coloring throughout (green for decision events, indigo for PR events, agent colors for agent events)

### 10.2 The PR interface

The PR drawer in the prototype covers the *reading* side. The *authoring* side — opening, reviewing, merging PRs from inside Cortex — is still undesigned.

Questions:
- Does Cortex open PRs directly, or does it always mirror an external PR (GitHub/GitLab)?
- If mirroring: what's the ingestion path (webhook, polling, explicit sync)?
- If native: how does code review happen — diff view, threaded comments, code annotations tied to graph nodes?
- What about stacked PRs, force-pushes, rebases — how do those events read on the canvas?
- Where does the merge button live in real usage — inside the PR drawer, or in a separate review surface?

### 10.3 Reconciliation engine (supporting work)

Needed to make the `state` derivation story real:

- **Input**: decision (text) + current source of governed files/functions
- **Output**: `match` | `partial-match` | `drift` with optional list of specific nonconformant nodes
- **Cache invalidation**: triggered when any governed file's content hash changes (via CBM or equivalent watcher)
- **Performance**: lazy — decisions reconcile on demand (when focused, when queried), not continuously
- **First version**: crude string matching on key phrases; mark stale when matches drop below threshold
- **Mature version**: LLM-driven semantic comparison; cache results per decision+source-hash pair

This can ship behind a feature flag before the UI ever reads from it.

### 10.4 Sidebar rebuild

The v4 prototype had a sidebar that was removed. With the new visual language locked in, the sidebar wants to return — it's the summary surface for "what's Cortex tracking right now." Overlaps with the feed; we should design them together to avoid duplication.

### 10.5 Later

- Handoff / shared attention between agents (one agent "tags in" another on a focus area)
- Spectator mode (zero-chrome ambient viewing, for a monitor in the office)
- Conflict surfacing (two agents touching overlapping code — amplify rather than suppress)
- Multi-focus (two frames focused simultaneously, with reflow)
- Density and clustering (the real scaling problem, once 20+ decisions / 10+ PRs are on the canvas)
- Under-governance click-through in node hover pills
- Declarative decisions (non-code-aligned, process-level rules)
- Time-travel / history filter (surface merged PRs and superseded decisions from a past window)

---

## 11. Implementation order suggestion

If Claude Code is picking up work from this spec, my recommended order:

1. **Audit data model** — verify current Cortex schema against sections 3.1 and 4.1. Propose migration.
2. **Add PR entity type and relationships** — PRs become first-class graph nodes with touches, introducesFrame, introducesDecisions.
3. **Add decision narrative fields** — problem, resolution, rationale, alternatives. Migrate existing decisions with empty fields populated lazily.
4. **Implement MCP tools** — `propose_decision`, `update_decision`, `supersede_decision`, `open_pr`, `add_pr_touch`, `merge_pr`.
5. **Stand up the 2D viewer** — port the prototype's rendering into the real repo. Could be a new web route alongside the existing 3D viewer, or gradually replace it depending on how much of the 3D viewer is still valued.
6. **Multiplayer test mode + scenario file support** — so we can keep playing with the design without real multiplayer infrastructure.
7. **Reconciliation engine v1** — crude string matching, lazy invocation, feature-flagged.
8. **Feed + PR interface design sessions** — these should happen against a real running system once steps 1-6 are done, so design decisions are grounded in working software rather than more prototype work.

---

## Appendix A: Session credits

Design session April 2026 between Rasmus (@kalms) and Claude (Claude Opus 4.7). The prototype (`cortex-frames-prototype-v5.html`) and this specification are the artifacts.

## Appendix B: Key principles worth preserving

These came up repeatedly during the design session and should carry into implementation:

- **Restraint is the default.** Aggressively monochrome, two font weights, gradients only on atmosphere/borders never fills, no glows, motion as information. The Vercel/Neon/Next design canon.
- **Color is punctuation, not decoration.** Five semantic colors in the system: green (knowledge/decisions), amber (attention/stale), indigo (work-in-flight/PRs), agent identities, grey (substrate). Adding a sixth requires a real argument.
- **Code is the ratification.** The whole decision model collapses to something worse if human approval becomes required. Resist the temptation to add ceremony.
- **Ambient canvas stays clean.** Only active/proposed decisions float. Only open/draft PRs float. Everything else is queryable but not surfaced without explicit navigation.
- **One drawer, not many.** The record drawer is a reusable surface. Adding a separate surface for a new entity type should be a high bar.
- **Motion is information.** Don't animate for decoration. Each transition means something (focus change, state ratification, merge completion). If a motion doesn't carry information, remove it.
