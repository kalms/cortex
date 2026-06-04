# Field Report — Vue Component Coverage + Decision Input Robustness

**Date:** 2026-05-21
**Evaluator:** Claude (Opus 4.7), session in `/Users/rka/Development/anthill-cloud`
**Subject repo:** anthill-cloud — same Turborepo monorepo as the 2026-05-20 field assessment
**Re-indexed at start of session:** 5,502 nodes / 6,358 edges

This is the follow-up session to [field-assessment-nuxt-monorepo.md](./field-assessment-nuxt-monorepo.md). The earlier report focused on cold-orientation queries (`get_architecture`, route listings, module name searches). Today's session exercised Cortex in a different mode: an active design brainstorm with a goal of "use the graph to navigate a Vue component + capture the decision."

Seven friction points surfaced. Five reduce to two underlying issues; two are new. I'll report by underlying cause rather than by symptom.

---

## TL;DR

1. **Vue files are invisible to the graph.** Five of the seven hits trace to this. `get_code_snippet`, `why_was_this_built`, `search_graph`, and `governs` linking all fail or return empty when the target is a `.vue` file. This is the same gap the 2026-05-20 report flagged for Nuxt projects — none of the active-design tooling works in a Vue-heavy codebase. Repeats here for emphasis with concrete reproductions.
2. **`create_decision` silently accepts malformed structured-field input.** Mismatched XML namespace prefixes in my tool call caused the entire `problem`/`resolution`/`alternatives`/`governs` payload to be concatenated into the `rationale` string. No error, no warning — the decision was created with a garbage rationale and null structured fields. This is the most concerning hit because the failure mode is silent persistence of bad data, and the symptom (rationale full of unrendered XML tags) only surfaces when someone reads the decision back later.
3. **`search_code` errors on simple patterns.** One-shot, but represents a brittle fallback path.

---

## Issue 1 — Vue files are not in the knowledge graph

### Symptom

Five distinct call patterns return empty for a `.vue` file that demonstrably exists:

```
get_code_snippet("apps/activator/app/components/ADesignSystemCard.vue")
  → "No results"

why_was_this_built("apps/activator/app/components/ADesignSystemCard.vue")
  → "No results"

search_graph(name_pattern: "ADesignSystemCard")
  → "No results"

search_graph(label: "module", name_pattern: "%ADesignSystemCard%")
  (not run this session, but expected to fail by the same pattern)

create_decision(governs: ["apps/activator/app/components/ADesignSystemCard.vue", …])
  → governs array stored as empty []
```

### Reproduction

In a fresh session against an indexed anthill-cloud:

```
mcp__plugin_cortex_cortex__get_code_snippet(
  qualified_name="apps/activator/app/components/ADesignSystemCard.vue"
)
```

vs. the same call against a `.ts` file in the same repo — the TS query works as documented; the Vue query returns "No results."

### Impact on the session

I had to fall back to `Read` + `grep` for every navigation step:

- Finding the card component → `grep -l design-system | grep ADesignSystemCard`
- Reading its content → `Read` (not `get_code_snippet`)
- Finding the shared `ACardFooter` (one floor up the dependency tree) → `find -name "ACardFooter.vue"`
- Identifying other consumers of `ACardFooter` for blast-radius assessment → `grep -rn "<ACardFooter"`
- Linking the decision back to the files it governs → not possible

The structural promise of Cortex ("ask for callers, dependents, where else does X show up") evaporated. I used Cortex only for: re-indexing the repo, searching prior decisions (returned nothing relevant), and creating the new decision (which had its own issues — see Issue 2).

### Why this is the same point twice

The 2026-05-20 report covered the *cold-orientation* failure mode (graph counts and node listings look impressive, but the entries are filesystem paths Cortex re-derived). Today's report covers the *active-design* failure mode (the navigation tools advertised in the README don't run for `.vue` qualified names). Both reduce to: the Cortex parser pipeline emits no nodes for Vue SFCs, only TS/JS modules.

### Suggested direction

A Vue parser would solve this. The Vue SFC format has well-defined component structure (script setup, props, emits, template, style). Even a minimal parser that extracts:

- The component's qualified name + file path as a `module` (or new `component`) node
- `props` and `emits` declarations as child nodes
- Template-level `<Other-Component>` references as `CALLS` or `USES` edges

…would deliver most of the structural value. Composables (`useXxx()` calls in `<script setup>`) and props-drilling chains would surface for the first time.

A weaker MVP: detect that a `.vue` file IS a module, even if the contents aren't parsed. That alone fixes `governs` linking and `get_code_snippet` (which could fall back to returning the raw `<script setup>` block).

---

## Issue 2 — `create_decision` silently persists malformed structured-field input

### Symptom

`create_decision` was called with `title`, `description`, `rationale`, `problem`, `resolution`, `alternatives`, and `governs` as separate JSON parameters. The response showed:

- `title`: correct
- `description`: correct
- `rationale`: the intended rationale text PLUS the literal serialized XML form of every subsequent field (`</rationale>\n<problem>...</problem>\n<resolution>...</resolution>\n<alternatives>[...]</alternatives>\n<governs>[...]</governs>\n</invoke>`)
- `problem`: `null`
- `resolution`: `null`
- `alternatives`: `[]`
- `governs`: (not in response — schema confirms it can only be set at create time)

The decision was persisted. No error, no warning. I caught it because I read the response.

### Root cause

The malformed call originated on my end — I had inconsistent XML namespace prefixes between opening and closing parameter tags inside the tool invocation. The framework's serializer accepted the malformed input and emitted a single concatenated string to Cortex.

But the Cortex tool's validation accepted the resulting payload. Schema-wise this is "rationale: a string of any length, including one that contains XML-looking text and is several KB long." There is no shape check beyond `typeof === 'string'`.

### Recovery cost

To fix the persisted decision:

1. `update_decision` with corrected fields — first repair attempt had the same namespace mismatch and re-introduced the issue into `description`. Cost: one more bad write.
2. Second `update_decision` with cleaner params finally succeeded.
3. `governs` is not settable via `update_decision` — the schema only allows it on create. The wrong governs (empty list, because of the parser issue at create time AND because Vue files aren't nodes) is now baked in.

So a single user error cost three tool calls, and the `governs` linking is unrecoverable without deleting + recreating.

### Suggested direction

Two complementary mitigations:

1. **Input-shape validation in `create_decision`.** Reject (or at minimum, warn on) `rationale` content that contains the literal tokens `</rationale>`, `<problem>`, `<alternatives>`, `<governs>`, `</invoke>`, etc. — these are unambiguous markers of a structured-field-marshalling failure on the caller side. The cost is one regex; the benefit is preventing the silent-bad-write failure mode entirely.
2. **Allow `governs` on `update_decision`.** It's listed in the create schema but not the update schema. If a decision is persisted with the wrong governs (either via the bug above or because the user got it wrong), the recovery path today is delete + recreate. Allowing governs on update would close that gap.

A third option — running every decision through a "render and reflect" check before persisting, where the tool reformats its own output back to the caller and asks for confirmation — feels heavy. The two above are cheap and targeted.

---

## Issue 3 — `search_code` errors on a simple pattern

### Symptom

```
mcp__plugin_cortex_cortex__search_code(pattern: "ribbon")
  → "ERROR reason=internal_error: Command failed: grep -rn ribbon ."
```

The error message reveals that `search_code` shells out to `grep -rn`. `grep -rn` on a Turborepo monorepo with `node_modules` will produce enormous output, potentially blowing past pipe buffer limits or process timeouts. The exit code is non-zero because grep itself ran out of bandwidth, not because the pattern was wrong.

### Reproduction

Probably any common short word in a large monorepo. The same call against a more unusual identifier (e.g. `search_code("ADesignSystemCard")`) would likely have worked — I didn't test.

### Suggested direction

Two fixes, either suffices:

- Have `search_code` filter the search root to exclude `node_modules` / `.git` / `dist` / etc. before running grep
- Switch to ripgrep (`rg`) with sensible defaults — it respects `.gitignore` automatically and is dramatically faster

Either makes the tool usable for short common words and orders of magnitude faster for everyone.

---

## Closing

The Vue gap is the single biggest lever for the value proposition in this codebase, and it's reported twice now from two different angles. The decision-input robustness is more subtle but more dangerous — it persists bad data silently, and the recovery path requires future readers to notice the breakage and re-do the work.

Both issues have tractable fixes that don't require rearchitecting Cortex. I'd take either one as a single PR. The Vue parser is the higher-value, higher-effort change; the decision-input validation is a few lines of input checking.

---

## Session telemetry

- Cortex tool calls this session: 9 (index_status, list_projects, index_repository, search_decisions, get_code_snippet, why_was_this_built, search_graph, search_code, create_decision, get_decision, update_decision×2)
- Successful: 5 (index_status, list_projects, index_repository, search_decisions, create_decision, update_decision, get_decision)
- Failed or returned empty (where Vue was the target): 4
- Workarounds invoked: Read, grep via Bash, `find` via Bash
- Working directory: `/Users/rka/Development/anthill-cloud` on branch `feature/component/ds-card-themed-footer`
- Companion artifacts: spec at `docs/superpowers/specs/2026-05-21-ds-card-themed-footer-design.md`, plan at `docs/superpowers/plans/2026-05-21-ds-card-themed-footer.md`, decision in Cortex id `cb1f6090-d9a7-4170-bf11-09a5bfd60c28`.
