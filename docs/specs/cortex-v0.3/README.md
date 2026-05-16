# Cortex v0.3 — design corpus

This directory contains the design materials for Cortex v0.3 (the
multiplayer-engineering extension of v0.2.0). The design went through
multiple brainstorm passes between 2026-04-21 and 2026-05-03;
historical artifacts and current-state notes coexist in this folder
and serve different purposes.

---

## Files

### Authoritative — current design

These four notes files describe the **current design direction**.
They reconcile against each other, are internally consistent, and
supersede the corresponding sections of the original spec.

| File | What it covers |
|---|---|
| [`frame-extraction.md`](frame-extraction.md) | Frame extraction algorithm: semantic-first, intrinsic-only, three-pipeline empirical comparison (Leiden vs TF-IDF + HDBSCAN vs pinned-embedding + HDBSCAN). Co-change, framework-aware tokenisation, two content streams, aggregate nodes, bare nodes as gravity. **Supersedes spec §8.** |
| [`frame-ranking.md`](frame-ranking.md) | Ambient ranking: information-density target, layer-first taxonomy, `FrameKind` payload, classification sources, gravity model for layout. **Companion to spec §8.** |
| [`frame-layout.md`](frame-layout.md) | Layout implementation: D3-force, mulberry32 PRNG, deterministic seeding, 300-iteration count, frame-size scaling, floating-entity placement. Closes the layout-algorithm risk. |
| [`todo-entity.md`](todo-entity.md) | New TODO entity type: schema, state machine, drawer surface, MCP tools, external-system bridge. **Adds a new section to spec §3 (data model).** |

### Reference — original spec and historical artifacts

| File | What it is |
|---|---|
| [`cortex-multiplayer-spec.md`](cortex-multiplayer-spec.md) | Original spec (April 2026). Sections 1–7 (product framing, prototype, decision model, PR model, drawer, merge animation, repo observations) and 9–11 (multiplayer-test mode, what's next, implementation order) are still authoritative. **Section 8 is superseded by the notes above.** |
| [`cortex-frames-prototype-v5.html`](cortex-frames-prototype-v5.html) | Canonical 2D prototype (dark + light mode). Authoritative for visual treatment, motion curves, spacing, color values, and interaction timing. |
| [`cortex-backlog.md`](cortex-backlog.md) | Design backlog from the brainstorm sessions that produced the original spec. Historical context. Some items have since been resolved or superseded by the notes; treat as reference, not authority. |
| [`cortex-frame-research.md`](cortex-frame-research.md) | Research brief on frame extraction (CFX-1 algorithm, prior art, test methodology). Underlies the design choices in `frame-extraction.md` but is itself historical — the actual extraction approach diverged from CFX-1 during brainstorm. |

---

## Reading order for a new session

If you're picking this up cold:

1. **`cortex-multiplayer-spec.md` §1–2** (15 minutes) — product framing and prototype context. Skip §8 for now; it's been replaced.
2. **`cortex-multiplayer-spec.md` §3–6** — decision model, PR model, drawer, merge animation. Still authoritative; design hasn't changed here.
3. **`frame-extraction.md`** — current §8 design. Start with the "Position" section, then "Two content streams", then the "Extraction cascade" and "Verification" sections.
4. **`frame-ranking.md`** — ranking and taxonomy that sits on top of extraction.
5. **`frame-layout.md`** — how positions are computed from the gravity model.
6. **`todo-entity.md`** — new entity type added during brainstorm.
7. **`cortex-multiplayer-spec.md` §9–11** — multiplayer-test mode and next-feature slices.

The prototype HTML is the visual truth — open it in a browser when designing visual treatments.

---

## Status as of 2026-05-03

**Settled:**
- Decision model (spec §3)
- PR model (spec §4)
- Record drawer (spec §5)
- Merge animation (spec §6)
- Frame extraction direction (`frame-extraction.md`)
- Ranking + taxonomy (`frame-ranking.md`)
- Layout (`frame-layout.md`)
- TODO entity (`todo-entity.md`)

**In flight (code work):**
- `feature/api/pr-entity-and-decision-extensions` branch — PR entity and decision narrative extensions partially shipped via recent commits

**Open work threads (next sessions):**
1. **Reconciliation engine v1 semantics** — when does a decision become "stale" given string-matching? Affects spec §3 ratification story and §10.3.
2. **Phase 1 corpus selection** — concrete GitHub repo list for the index-stats survey, spanning target archetypes (Nuxt, React, Vue, CommonJS, Go, Swift, Python).
3. **Implementation order** — sequence the work across all four notes files plus the in-flight branch.
4. **Schema migration plan** — v0.2.0 → v0.3 migration for `Frame`, `Aggregate`, `Todo` entities.
5. **Cross-entity MCP tools** — `entity_relations`, `assert_consistency` not yet specified.
6. **Ranking/layout MCP tools** — `get_ambient`, `get_ranking_score`, `recompute_layout` not yet specified.
7. **Hook additions** — `PostMergeHook` extension, `PostDecisionHook` not yet specified.

**First build target** (recommended, when transitioning out of design):
- Finish and merge the in-flight `feature/api/pr-entity-and-decision-extensions` branch
- Then start Phase 1: a small Node script that clones N active GitHub repos, runs CBM index, computes `(entity_count, edge_density, directory_depth, language_mix)` per repo. Output is the calibration data the rest of the work depends on.

---

## Promotion plan

When v0.3 ships:

- Promote `frame-extraction.md` content into spec §8 (replacing the existing three-tier-cascade content)
- Promote `frame-ranking.md` content into spec §8.14 (or new §8a) "Ambient ranking and taxonomy"
- Promote `frame-layout.md` content into spec §8.15 (or §8b) "Layout"
- Promote `todo-entity.md` content into spec §3a "TODO data model" alongside the existing decision and PR sections
- Update spec §7.4 (MCP surface) and §11 (implementation order) to reflect the v0.3 tool surface and build order

Until then, the notes are canonical and the spec's superseded sections stay marked.
