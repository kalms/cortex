# TODO entity — design notes

> Companion to `cortex-multiplayer-spec.md`. New entity type for v0.3.
> Complements `Decision` (past/present substrate) and `PullRequest`
> (in-flight work) by representing future planned work. Adopted
> direction; promote into the spec as `§3a TODO data model` (or
> similar) when v0.3 lands.

---

## Position

Engineering work has three time horizons. Cortex needs an entity for
each:

| Entity | Time horizon | Color | Lifecycle |
|---|---|---|---|
| Decision | Past/present substrate (rationale, governance) | Green | Proposed → active → stale / superseded / deprecated |
| Pull request | Now (in-flight work) | Indigo | Draft → open → merged / closed |
| TODO | Future (planned work) | Yellow | Open → in-progress → done / cancelled (or blocked) |

TODOs fill the future-work gap. Decisions document *why* and PRs
document *now*; TODOs are *what's next*. Without TODOs, planned work
is invisible to the canvas — which breaks the "watch work as a shape"
product claim for the period before code starts moving.

TODOs also act as a bridge to upstream PM systems (Linear, JIRA,
GitHub Issues, etc.) without requiring them. Cortex is the canonical
source of truth for TODOs; external systems are *optional* mirrors,
not authority.

---

## Cortex as source of truth

A solo developer working in Cortex without any external PM system
should be able to use TODOs fully. This was a load-bearing
requirement: Cortex isn't a visualization layer over external state,
it's an authoritative engineering substrate.

Consequences:

- `externalRefs` is purely optional metadata on TODO records
- TODOs originate via `propose_todo` MCP tool, no upstream required
- External integrations are bridges, not requirements
- Bidirectional sync (Cortex ↔ Linear/JIRA) is conceptually allowed
  but full state-syncing is deferred to v1.5; v1 ships
  one-shot mirroring

---

## Schema

```typescript
interface Todo {
  // Identity
  id: string                          // "T-042"
  summary: string                     // short title
  description: string                 // markdown body

  // State
  state: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'

  // Provenance
  proposedBy: AgentRef
  proposedAt: timestamp
  startedAt?: timestamp
  closedAt?: timestamp
  assignee?: AgentRef                 // nullable — not all TODOs are assigned

  // Typed pointers
  governs: EntityRef[]                // files, functions, frames the TODO concerns
  blockedBy: TodoRef[]                // dependency
  blocks: TodoRef[]                   // reverse (derived)
  relatedTo: TodoRef[]
  spawnsFrom: DecisionRef | null      // follow-up to a decision; null for standalone TODOs
  resolvedBy: PRRef[]                 // PRs that close this TODO

  // External system bridge (optional)
  externalRefs: ExternalRef[]
}

interface ExternalRef {
  system: 'linear' | 'jira' | 'github-issue' | 'gitlab-issue' | 'asana'
  id: string                          // upstream ticket ID
  url: string                         // direct link
  syncedAt?: timestamp                // last successful sync (when set)
}
```

`EntityRef` reuses the existing typed-ref discriminated union from the
decision schema (file / function / symbol / frame / decision).

---

## State machine

```
       open ─────────► in_progress ──────► done
        │                  │
        │                  │
        ▼                  ▼
     cancelled          blocked ───┐
                           ▲       │
                           └───────┘
                         (unblock returns to in_progress or open)
```

- `open` — created, not started
- `in_progress` — actively being worked on (typically tied to an open PR or active session)
- `blocked` — work cannot proceed; usually has `blockedBy` pointers
- `done` — completed; closed via PR merge or explicit complete
- `cancelled` — abandoned without completion

State transitions are authored via dedicated MCP tools (`start_todo`,
`block_todo`, etc.), not via direct state mutation.

---

## Visual treatment

At rest on the canvas, TODOs are 4px dots, same dot-pill-ring grammar
as decisions and PRs:

| State | Visual |
|---|---|
| Open | Solid yellow (`#facc15` or similar) at 95% opacity |
| In progress | Agent's identity color (whoever is the assignee) |
| Blocked | Yellow + amber ring at 80% alpha |
| Done | Hidden from ambient (queryable via search / drawer) |
| Cancelled | Hidden from ambient (queryable via search / drawer) |

Hover shows a pill: `T-042 · migrate auth to OAuth`. Selection opens
the drawer.

In marginalia (right edge of focused frame), TODO pills stack
alongside decision and PR pills for any TODO whose `governs` includes
an entity in the focused frame.

When a decision is selected and has child TODOs (TODOs with
`spawnsFrom: this_decision`), leader lines render from the decision
dot to each child-TODO dot, same as decision-to-governed-entity
leader lines.

### Palette change

Adding TODO yellow brings the palette to six semantic colors:

- Green — knowledge / decisions (substrate)
- Amber — attention / stale / blocked-state ring (warning)
- Indigo — in-flight work (PRs)
- Yellow — future work (TODOs)
- Agent identity colors (white/sky/violet)
- Grey — substrate

Yellow and amber are visually adjacent but semantically distinct:
yellow is "future, planned"; amber is "needs attention, drift". The
adjacency reads as related domains (both warn), the distinction reads
as different time-stances (planning vs reconciliation).

---

## Drawer surface

Reuses the same right-side drawer chrome as decisions and PRs.
Content sections:

- **Header.** Monospace ID (yellow for TODOs); state pill; summary in
  display font; provenance (`proposed by @agent on YYYY-MM-DD`); close
  button.
- **Description** (prose, markdown-rendered).
- **Governs.** Ref pills by type (frames, files, functions). Same as
  decision drawer.
- **Spawned from.** If `spawnsFrom` set, link to the parent decision.
- **Resolved by.** Pills for any PRs that close this TODO.
- **Dependencies.** `blockedBy` and `blocks` lists.
- **Related TODOs.** `relatedTo` list.
- **External refs.** Pills with `system` icon + ID + open-in-tab link
  (Linear, JIRA, etc.). Empty if no upstream link.
- **Activity** (future — deferred). Comment threads, status changes,
  state transitions.

### Decision drawer additions

Decision drawer gains a new section: **Tasks**, listing TODOs with
`spawnsFrom: this_decision`. Pills show TODO ID, summary, state.
Click pill → drawer content swaps to the TODO (same in-place
navigation as existing decision↔PR drawer pivots).

---

## MCP tool surface

Native tools (Cortex as source of truth):

- `propose_todo(summary, description, governs?, spawnsFrom?, blockedBy?)` —
  create a new TODO attributed to calling agent
- `update_todo(id, fields)` — revise summary, description, governs,
  assignee
- `start_todo(id)` — open → in_progress
- `block_todo(id, reason, blockedBy?)` — → blocked, with optional
  dependency pointer
- `unblock_todo(id)` — blocked → in_progress (or open if not started)
- `complete_todo(id, resolvedBy?)` — → done, with optional resolving PR
- `cancel_todo(id, reason)` — → cancelled
- `assign_todo(id, agentRef)` — set assignee
- `link_todo(id, target, relation)` — connect to decisions / PRs / other
  TODOs (matching the `link_decision` pattern)
- `get_todo(id)` — full content
- `search_todos(query)` — full-text + structured search
- `list_todos(filter?)` — by state, assignee, frame, governing
  decision

External-system bridge tools:

- `link_external(todoId, externalRef)` — record an upstream link without
  creating it (e.g., link an existing JIRA ticket to a Cortex TODO)
- `pull_external_todo(externalRef)` — create a Cortex TODO mirroring an
  existing upstream ticket
- `push_todo_to_external(todoId, system)` — push to upstream (create new
  ticket via the system's API; record returned external ref)

True bidirectional auto-sync is v1.5 work.

---

## Hooks (plugin-side)

- `PostMergeHook` extension — on PR merge, complete TODOs marked as
  `resolvedBy` this PR (transition them to `done`, set `closedAt`)
- `PostDecisionHook` (new) — when a decision is proposed with
  follow-up TODOs in the same session, link them via `spawnsFrom`

---

## Open questions

1. **External-system conflict resolution.** When a TODO has
   `externalRefs` and the upstream changes state, what's authoritative
   on conflict? v1: don't auto-sync, just record links. v1.5: design
   conflict policy.
2. **Assignee constraints.** Can a TODO be assigned to a synthetic
   agent? Probably yes — agent identity is uniform across human and
   synthetic in the multiplayer model. The assignee field is just an
   AgentRef.
3. **Discussion / comments on TODOs.** Deferred — same time as the
   feed/PR-interface design sessions per spec §10. TODOs may inherit
   whatever discussion model lands there.
4. **TODO templates / boilerplate.** Some teams have standard TODO
   shapes ("migrate X to Y", "add tests for Z"). Out of scope for v1;
   could be a future skill or hook.
5. **TODO-to-TODO supersession.** Decisions have it; PRs effectively
   have it (a new PR replaces a closed one). TODOs don't currently —
   if a TODO is replaced by a better-scoped one, the old one should be
   cancelled and the new one created. Probably no `supersedes` edge
   needed; cancel + create is sufficient.

---

## Determinism stance

TODOs are user-authored, like decisions. They don't shape extraction
(per the rule that user-authored entities don't influence the
algorithm). They live in the graph as canonical shared state, synced
across clients via the same multiplayer infrastructure as decisions
and PRs. Determinism preserved.

External-system mirrors are *additional* state; their out-of-band
changes don't affect the canonical Cortex state until explicitly
pulled via `pull_external_todo`. Sync is opt-in per TODO.

---

## Status

Adopted as v1 direction 2026-05-01 during brainstorm pass on the v0.3
MCP tool surface audit. Schema, state machine, visual treatment,
drawer surface, MCP tool list, hooks, and open questions all defined.
Promote into `cortex-multiplayer-spec.md` as a new section (likely
`§3a TODO data model`) when v0.3 lands.

Cross-references:
- Visual treatment lives alongside decision/PR rendering in the
  prototype (extend the v5 prototype's dot-pill-ring grammar with the
  yellow-state variant).
- Drawer surface reuses spec §5 chrome verbatim with the new content
  sections defined above.
- MCP tool surface integrates with the broader v0.3 audit in the
  brainstorm corpus.
