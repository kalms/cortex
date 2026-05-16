# Cortex — Multiplayer Engineering Backlog

Captured at end of session, April 2026. Framing: *multiplayer engineering* — humans and
agents working on a codebase together, in real time, as a shared map. The graph is the
canvas; decisions, synapses, and frames are the shared language.

---

## Primitives established (current prototype)

These are the atoms. Everything else composes from them.

- **Frames** — named regions on the canvas, one per directory. External monospace label
  above, count on the right, hairline border. Activity lights them up briefly.
- **Nodes** — files, functions, and other code entities as neutral dots. Agents
  color them while touching, they fade back to neutral when idle.
- **Synapses** — edges briefly brightening white-on-black when an agent traverses them.
  No particles, no glow, just edge-brightness animation.
- **Agent cursors** — small dots with pill labels. Move along edges (never teleport).
- **Agent pills** — solid filled pills, username in Geist Mono, provider glyph.
  User (Rasmus) = solid white, no glyph. AI agents = color when active, grey when idle.
- **Uncommitted frames** — dashed border, branch name + path labels, `+N` additions
  counter, hollow-ring nodes, dashed edges to other frames.

---

## Decisions — data model and behavior

Decisions are **first-class graph entities that compress understanding**. They are
contextual pointers: they carry self-contained narrative content (what, why, what else
was considered) *and* typed references into the graph (which files, functions, PRs,
and other decisions they relate to). Their job is to reduce the time from "I touched
this code" to "I understand this code in context."

### Schema

```
Decision {
  // Identity
  id: string                      // "D-142"
  summary: string                 // "LOD band projection"

  // Narrative content — the self-contained context
  problem: string                 // what question this answered
  resolution: string              // what was decided
  rationale: string               // why this over alternatives
  alternatives: Alternative[]     // other paths considered, each with rejection reason

  // Provenance
  proposedBy: AgentRef            // @rasmus, @kai, @mira
  proposedAt: timestamp

  // Pointers into the graph (typed refs)
  governs: EntityRef[]            // files, functions, frames
  supersedes: DecisionRef?        // what this replaced
  supersededBy: DecisionRef?      // what replaced this
  relatedTo: DecisionRef[]        // non-hierarchical links
  dependsOn: DecisionRef[]        // prerequisites

  // PR relationships (data only; not yet rendered on canvas)
  introducedIn: PRRef?            // PR where this decision was born
  implementedBy: PRRef[]          // PRs that execute on this decision
  challengedBy: PRRef[]           // PRs that proposed changing this
  discussedIn: PRRef[]            // PRs where this was debated

  // Evidence
  validatedBy: TestRef[]          // tests enforcing this
  observedImpact: Metric[]        // measurements tied to this

  // Derived state (computed, not stored)
  // state: 'proposed' | 'active' | 'stale' | 'superseded' | 'deprecated'
}
```

### State is derived, not stored

Cortex does not have a ratification ceremony. **Decisions are confirmed by code
alignment, not by human approval.** If a decision describes how something works and
the governed code matches that description, the decision is active. If they diverge,
the decision becomes stale — a healing prompt rather than a failure.

Derived states:

- **Proposed / draft** — decision written, code doesn't yet match. Implementation
  pending or experimental.
- **Active** — description aligns with current code. Load-bearing.
- **Stale** — description no longer matches code. Something drifted. Not wrong, but
  needs attention. Visually closer to superseded (on the gradient toward archival)
  without the strike-through finality.
- **Superseded** — another decision has an explicit `supersedes` edge back to this
  one. Archival.
- **Deprecated** — explicitly marked for removal. Code may still match, but intent
  is to migrate.

Only `deprecated` and `supersedes` edges are stored directly. Everything else derives
from reconciliation with code reality.

### Future: declarative vs descriptive decisions

Some decisions are process-level, not code-level ("prioritize correctness over speed",
"no new dependencies this quarter"). These can't be reconciled against code. Handle
these with a `kind: 'declarative'` flag and manual state. Not needed in the first
prototype — all seed decisions are descriptive.

### Visual state treatment on marginalia pills

- **Proposed** — dashed green border, hollow green marker (draft grammar from
  uncommitted frames)
- **Active** — solid green border, solid green marker (baseline)
- **Stale** — desaturated green-grey pill, small amber vertical tick on left edge
  signaling "reconciliation needed." Leader lines to governed nodes in muted
  amber-grey. No strike-through.
- **Superseded** — desaturated green-grey + horizontal strike-through line through
  pill middle. Leader lines very faint grey. Hidden from ambient view; visible only
  when the frame is focused (historical record, not live governance).
- **Deprecated** — active visual + amber 1px ring around marker dot. Still governs,
  but warning.

Progression: active → stale → superseded, visually reading as increasing archival
weight. A user scanning the canvas can sort decisions by "how alive."

### Decision card surface (planned)

When a decision is the focus, it opens as a rectangular card surface (not a pill),
positioned top-center above the focused frame area. Three content zones:

1. **Identity & state** — ID, summary, state pill, provenance (proposed by, at)
2. **Narrative** — problem, resolution, rationale, alternatives
3. **Pointers** — governs list (typed entity refs as pills), supersedes /
   superseded-by chips, PR references grouped by role (introduced / implemented /
   challenged / discussed)

Pointer pills are clickable — navigate to the target entity (focus that file's
frame with the function as anchor, or open another decision's card).

Triggers to open the card:
- Click a marginalia pill on a focused frame
- Click the `under D-XXX` line in a node hover pill
- Click a decision reference in another card

Card does *not* reorganize the canvas (first cut). It opens as an overlay with a
slight canvas dim behind. Siblings don't compress. User returns to prior spatial
context on close.

### Decisions are NOT

- Not files in a folder. There is no `src/decisions/` directory. Decisions are graph
  entities, not files. Any such frame in early prototypes was a modeling mistake.
- Not nodes with `kind: 'decision'` embedded inside frames. They are peer entities
  to files/functions/frames, not children of any container.
- Not ratified by humans. The human has the *ability* to intervene but not the
  requirement. Code alignment is the ratification.
- Not always visible on the ambient canvas. They surface through context:
  marginalia on focused frames, hover pills on governed nodes, the card surface
  when explicitly opened. Ambient decision dots are deferred — decisions appear
  where they're relevant, not as canvas furniture.

---

## MCP server and plugin work implied by this model

Several pieces of the decision model assume capabilities the MCP server and Claude
Code plugin don't fully have yet. Capturing here so they don't get lost when the
prototype hands back to implementation.

### Reconciliation engine

The derived `state` for descriptive decisions requires comparing the decision's
`resolution` prose against the current state of its governed code. This is an
LLM-driven task at the plugin level:

- **Input**: decision text + current source of governed files/functions
- **Output**: `match` | `partial-match` | `drift` with optional list of specific
  nonconformant nodes
- **Cache invalidation**: triggered when any governed file's content hash changes
  (via `codebase-memory-mcp` or equivalent watcher)
- **Performance**: decisions reconcile lazily on demand (when a frame is focused
  or the decision is queried), not continuously

Initial version can be crude: simple string matching on key phrases, flag stale
when matches drop below a threshold. More sophisticated: LLM semantic comparison,
caching result per decision+source-hash pair.

### Decision proposal and authorship tracking

The schema field `proposedBy` assumes agents and humans can author decisions
through a first-class MCP tool. Current Cortex v0.2.0 has decision tracking but
needs:

- **Tool**: `propose_decision(summary, problem, resolution, rationale, alternatives,
  governs, supersedes?)` — creates a new draft decision attributed to the calling
  agent
- **Tool**: `update_decision(id, fields)` — revise an existing decision, tracked
  as a revision event in the graph
- **Tool**: `retire_decision(id, reason)` — mark deprecated
- **Tool**: `supersede_decision(oldId, newId, reason)` — atomic create-new-and-
  mark-old supersede operation

The proposing agent's identity comes from the MCP session — already available.

### PR graph ingestion (bolt-on, later)

PR references (`introducedIn`, `implementedBy`, `challengedBy`, `discussedIn`)
assume PR data is queryable in Cortex's graph. External platforms (GitHub, GitLab)
own the canonical PR data; Cortex mirrors what it needs.

Required plumbing:

- **Webhook listener** or polling integration for PR create / update / merge / close
- **Graph schema extension**: PR as a node type with edges to files/functions it
  touches, decisions it references in its body or commits, authors (human + agent)
- **Decision linking**: when an agent creates a decision inside a session that has
  an open PR context, the decision gets auto-linked via `introducedIn` or
  `discussedIn`
- **State reconciliation**: when a PR merges, its decisions' linked states may
  update (e.g., `proposed` → `active` becomes possible once merged code exists
  to reconcile against)

This is significant infrastructure work and is correctly an "aside for now." But
the data model should be designed so the bolt-on doesn't require restructuring
— the `PRRef` fields are already placeholders in the schema above.

### Decision pointer granularity

The `governs` field uses typed `EntityRef`s: `file`, `function`, `frame`, later
possibly `concept` or `line-range`. Current Cortex likely indexes at file
granularity (via `codebase-memory-mcp`); function-level indexing is needed for the
decision card's pointer pills to target specific functions. This may already be
in place for some languages — confirm at implementation time and extend if needed.

### Search and decision-as-navigation

The decision card's pointer pills are clickable navigation targets. This implies
a lookup `findEntityByRef(ref) → graphNode` that resolves a typed ref to a
positioned node on the canvas. For frames and files this is straightforward; for
functions it requires the function-level indexing mentioned above.

Also implied: a **decisions index view** (future) that lists all decisions with
filters — by state, by proposer, by governed frame. Requires no new MCP work
beyond what's above; it's a UI surface over existing data.

---

## Status snapshot (April 2026)

The design phase for the v5 prototype is complete. The prototype file
(`cortex-frames-prototype-v5.html`) is shipped as the canonical visual reference for
implementation and as a playground for continued design work on feed, sidebar, and
PR interface surfaces.

### Completed in the v5 prototype session

- ✅ **Decision data model** — full schema with narrative content, typed pointers,
  PR refs, five lifecycle states, code-alignment ratification rule
- ✅ **PR data model** — `touches` list, `introducesFrame`, `introducesDecisions`;
  derivation rules for uncommitted frames and hollow-ring nodes
- ✅ **Record drawer** — slides from right, canvas shifts, single surface for both
  decisions and PRs, navigation between records swaps in place, generous typography
- ✅ **Floating entity grammar** — decisions and PRs as 4px dots at rest, offset pill
  tooltip on hover, stable filled ring + leader lines on selection
- ✅ **Ambient filtering** — only active/proposed decisions and open/draft PRs float;
  stale/superseded/merged hidden from ambient view
- ✅ **Merge animation** — 7-beat 2.4-second choreography across frames, nodes, edges,
  decisions; triggers decision ratification proposed → active
- ✅ **Semantic palette** — green (decisions), amber (attention/stale), indigo (PRs),
  agent identities, grey (substrate); rose considered and rejected for PRs
- ✅ **Light mode** — full theme variant with toggle in controls panel; dot/pill/drawer
  surfaces all render correctly on both dark and light canvases
- ✅ **Frame extraction architecture** — three-tier cascade (filesystem / framework
  template / on-demand ACDC), local-first determinism, always-wipe re-run policy,
  agent MCP surface, open questions documented. Full spec in section 8 of
  `cortex-multiplayer-spec.md`. Companion research doc in `cortex-frame-research.md`.

### Next design sessions queued

1. **Feed** — chronological surface for past events (merges, decisions, PR openings,
   agent arrivals, conflicts). Position, density, filtering, and overlap with sidebar
   all open.
2. **PR authoring interface** — the *writing* side of PRs (as opposed to the *reading*
   side which is now handled by the drawer). Open questions around mirroring external
   platforms vs. native PR authoring, review affordances, merge flows.
3. **Sidebar rebuild** — deferred until feed design lands, since the two surfaces
   share responsibility for "what's Cortex tracking right now."
4. **Frame extraction validation** — before major investment in template library breadth,
   run the test corpus (~25 real repos) against Tier 1 baseline and the "top-level dirs
   only" baseline. Confirm the three-tier architecture earns its complexity before
   expanding.

### Queued for implementation (Claude Code)

Full handoff details live in `cortex-multiplayer-spec.md`. Key items:

- Data model extensions (PR entity, richer decision fields, typed EntityRef)
- New MCP tools: `propose_decision`, `update_decision`, `supersede_decision`, `open_pr`,
  `add_pr_touch`, `merge_pr`
- 2D viewer alongside existing 3D viewer
- Multiplayer-test mode with TS DSL scenario runner
- Reconciliation engine v1 (crude string matching, feature-flagged)
- **Frame extraction** (spec section 8) — Tier 1 first, then cache + MCP agent surface,
  then Tier 2 template library starting with one framework, then Tier 3 as opt-in tool

---

## Original backlog items

The remaining items below predate this session and represent future design territory.

### Handoff / shared attention

Right now each agent wanders independently. Real multiplayer work has moments where
agents coordinate:

- **Shared focus** — "come look at what I found." One agent's long-press on a pill
  broadcasts "look here" to others. A shared camera move, Figma multiplayer style.
- **Handoff** — agent A finishes a piece, agent B picks it up. Visible chain:
  last synapse of A's session connects to first synapse of B's session, forming a
  handoff edge between their cursors.
- **Pairing** — two agents at the same frame or node. Visual: pills dock together,
  shared ring around the node.

Decisions captured during a handoff carry extra context — they're cross-agent by
construction — and should visually indicate that.

### Spectator mode

Second-monitor friendly. No controls, no sidebar, just the canvas breathing. Auto-zooms
to wherever activity is happening. Designed to make a non-engineer understand what the
team is doing without reading code. The "watching the codebase work" product.

### Conflict surfacing

When two agents edit overlapping files, the synapses collide. Don't suppress the
collision — amplify it. Overlapping edges pulse with alternating colors, the shared
node gets a diamond-shaped ring, and a subtle alert appears in whatever
context-aware UI exists. The collision itself is the feature.

---

## Open problem — zoom and density

**The next hard problem.** This prototype is tiny. A real Cortex instance has hundreds
of files, thousands of functions. Clustering and zoom behavior determine whether the
product scales gracefully or collapses into a hairball.

Research directions and implementation questions:

### Level-of-detail behavior

The existing `BAND_TABLE` in `src/viewer/shared/projection.js` is a good starting
point: different zoom levels show different node types. At overview, only decisions
and directory supernodes. At mid-zoom, files appear. At full zoom, everything is
visible. But the frames prototype hasn't been reconciled with this — frames *are*
the supernode rendering, which means the LOD band needs to drive when frames appear,
disappear, or transform.

Questions:
- When you zoom *into* a frame, does it become the whole canvas, or does it expand
  in place and push other frames off-screen?
- Do sibling frames stay visible as mini-maps / peripheral context?
- What happens to inter-frame edges when one frame is expanded? Do they attach to
  the frame boundary (treating the frame as a port)?

### Internal clustering within a frame

A frame like `src/viewer` has 142 nodes in the real codebase. Even at full zoom,
that's a hairball. Need sub-clustering:

- By file (each file becomes a mini-frame inside the parent frame)
- By function call density (closely-coupled functions cluster together)
- By decision territory (nodes governed by the same decision cluster visually)
- By recent activity (recently-touched nodes float to the top; stale nodes recede)

Which clustering wins depends on *why* the user zoomed in. If they're following an
agent, activity-clustering wins. If they're exploring architecture, decision-territory
clustering wins. If they're debugging, call-graph clustering wins. This implies the
cluster algorithm needs to be contextually chosen.

### The "blow it up" gesture

Double-click on a frame — or some equivalent dedicated gesture — should expand it
into a focused view. Not just a zoom, but a reorganization. Internal nodes lay out
with more space, labels appear, inter-frame edges become breadcrumbs to siblings.

Question: is this a *mode* (you're in expanded-frame view until you exit) or just
a deeper point on the zoom continuum? Modes are clearer but less fluid. Continuous
zoom is more elegant but requires the layout to reorganize continuously, which is
hard to keep legible.

### Transitions between zoom levels

Abrupt jumps are disorienting; continuous zoom with ~300-500ms camera transitions
is better. But the *content* also has to transition — nodes appearing, labels
fading in, clusters splitting apart. Each transition needs to be timed so the user
doesn't lose their place.

Vercel's map visualizations do this well. Figma's zoom-to-frame does this well.
Google Maps does this well. Study them.

### Density handling

At the overview level, 20+ frames on-screen is already busy. At 100+ frames, we
need to:
- Merge frames into supergroups at extreme zoom-out (entire modules become a single
  node)
- Fade out low-activity frames
- Let the user pin frames they care about (pinned frames stay visible across zoom
  levels)
- Allow filtering by who's working where ("show me only frames where agents are active")

### Inter-frame edges at scale

The current prototype draws every inter-frame edge. At scale this becomes a mess.
Options:
- Edge aggregation — multiple edges between the same two frames become one thicker
  edge with a count
- Edge filtering — only show edges above a usage threshold
- Implicit edges — don't draw edges at all at overview, use proximity to imply
  relatedness, reveal edges on hover/focus

Probably some combination of all three, driven by zoom level.

### Label density

As frames get smaller, their labels either overlap or become unreadable. Need rules:
- At what zoom does a frame's label disappear entirely?
- Do labels collide-avoid (a la map labeling algorithms)?
- Do labels shrink, truncate, or disappear first?

Middle-truncation is already implemented for frame labels. Need similar rules
for node labels that appear at deeper zoom.

### Research references

Before building, go look at:
- **Figma** — frame zoom, focus mode, how they handle hundreds of components
- **Miro** — frame hierarchies, presentation mode as a scripted zoom-sequence
- **Kumu** — their "focus" feature that expands a single node's neighborhood
- **Google Maps / Mapbox** — tile-based LOD, label collision handling, the master
  class in zoom behavior
- **Figma Code Connect / Sourcegraph** — code-specific navigation patterns
- **Understand-Anything** — their React Flow dashboard handles codebase graphs, see
  what they chose
- **InfraNodus** — they have a "cluster expansion" pattern that could inform ours

---

## Methodology note

The v4 prototype took six iterations of course-correction to land. Key lessons for
future sessions:

1. **Kill glows first, ask later.** The instinct to add glow to "make it feel
   futuristic" is always wrong. Flat surfaces, restrained borders, motion as signal.
2. **Color is punctuation, not paint.** Green for decisions. Agents get hues only
   when active. Everything else is monochrome.
3. **Gradients on atmosphere and borders, never on fills.** A 1px gradient border
   reads as premium. A gradient-filled button reads as a toy.
4. **Test with long strings and many nodes.** Truncation rules, density behavior,
   overlapping synapses — these break at scale, not in the demo.
5. **Commit to one aesthetic reference and don't blend.** The Vercel/Neon/Next
   canon is coherent because they all lean into the same typography (Geist), the
   same color discipline, the same restraint. Cortex's aesthetic should be as
   internally consistent.
