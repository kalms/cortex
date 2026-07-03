# Field Report — New CLI, Cached Re-indexing, and Lingering Coverage Gaps

**Date:** 2026-05-26
**Evaluator:** Claude (Opus 4.7, 1M context), session in `/Users/rka/Development/anthill-cloud`
**Subject repo:** anthill-cloud — same Turborepo monorepo as the 2026-05-20 and 2026-05-21 reports
**Re-indexed at start of session:** 5,537 nodes / 6,403 edges (imported from content-hash cache `73731b3da2f3…`, near-instant)
**Prompt:** "What can Cortex tell you about the repo? Is the output from Cortex more useful now? (It has a new CLI for you to peruse and other nice upgrades)"

Third field session against this repo. The prior reports covered cold-orientation (2026-05-20) and active-design (2026-05-21) failure modes. Today's session was deliberately exploratory — touring the new CLI surface and re-running representative queries to see what's improved.

Six observations follow, ordered by load-bearing-ness for an LLM agent operating in this repo.

---

## TL;DR

1. **The CLI is a real upgrade.** `cortex` is on PATH with proper namespaces (`code` / `decision` / `graph` / `index` / `eval`), per-command help, a `tour` walkthrough, and project auto-detection from cwd. For ad-hoc use it removes the "preload the MCP schema" friction entirely — I can shell out from any Bash call. This is the single biggest delta since the last report.
2. **Content-hash build cache works.** Re-indexing returned `imported from cache key 73731b3da2f3…` instantly, with no parsing. This makes the "always re-index at session start" instruction in the SessionStart hook costless.
3. **New edge types are visible and useful.** `SEMANTICALLY_RELATED` (66), `SIMILAR_TO` (14), `FILE_CHANGES_WITH` (35), `CONFIGURES` (35) all appear in `get_architecture` output. None of these existed in the 2026-05-20 schema dump.
4. **Vue coverage has improved at the *symbol* layer but not the *file* layer.** Functions defined inside `.vue` files now show up in the graph (e.g. `apps.arcane.app.pages.arcane.discover.startConversation`). But `.vue` files themselves are still not `file` nodes — `MATCH (f:file) WHERE f.qualified_name CONTAINS ".vue"` returns 0. Pinia stores still aren't a node class (`useFoundationStore` returns no symbols).
5. **Lockfile entries leak into the `route` label.** Routes now total 183, but a significant fraction are package tarball URLs (`https://anthill-code-artifacts-…/win32-x64-0.28.0.tgz`) extracted from pnpm-lock.yaml. Inflates counts and pollutes route-listing queries.
6. **`cortex index changes` errors with "project not found".** Minor CLI bug — `cortex index status` works fine on the same project.

---

## Observation 1 — The CLI changes how Cortex feels to use

### What's new

`/Users/rka/.local/bin/cortex` is in PATH and exposes a well-shaped namespace tree:

```
cortex code search|find|show|where|calls|arch|schema
cortex decision list|show|why|create|update|link|propose|promote|supersede|delete
cortex graph query|sql
cortex index status|changes|list|delete
cortex eval run|baseline|report
cortex tour                   # 60-second walkthrough
cortex help <topic>           # concept-level (qualified-names, projects, …)
```

Every subcommand has `--help`. Output defaults to JSON for graph queries (pipe-friendly) and TSV for list/find (also pipe-friendly). Project auto-resolves from cwd.

### Why it matters for agent workflows

Previously, every Cortex call was an MCP tool call — schema preload via `ToolSearch`, JSON parameters, separate tool-result returns. That has overhead and pulls focus from the shell. Today the same queries are one-line Bash invocations that compose with grep/jq/awk. Concrete examples from this session:

- `cortex code find requireCloudAdmin` → instant symbol lookup, returns TSV rows
- `cortex graph query 'MATCH (fn:function {name:"createFoundationStore"})-[:CALLS]->(c) RETURN c.qualified_name'` → returns `useGroupCrud` + `useAutoSave`, matching the real composables called from `_foundationFactory.ts`
- `cortex code arch` → architecture dump as JSON, immediately pipeable into jq
- `cortex tour` → ergonomic onboarding when you've forgotten the surface

The MCP tools are still there and still work — but for exploratory work the CLI is faster and lower-overhead.

### Friction that remains

- `cortex code show <relative-path>` rejects filesystem-style paths (e.g. `apps/activator/app/stores/_foundationFactory.ts:createFoundationStore`). The "find first to get the canonical qn, then show" two-step is still required for anything but bare names.
- Error messages helpfully suggest `cortex help qualified-names` — good. But the qualified-name form (`Users-rka-Development-anthill-cloud.apps.activator.app.stores._foundationFactory.createFoundationStore`) is awkward to type and remember. Accepting filesystem paths directly would close the gap.

---

## Observation 2 — Re-indexing is now free

`index_repository` on this 5.5k-node project returned `imported from cache key 73731b3da2f3…` and completed instantly. This wasn't true in the 2026-05-20 session (re-indexing took noticeable wall time and reported a fresh parse).

This matters because the SessionStart Cortex hook instructs the agent to "run `index_repository` before any code exploration." Previously that was a real cost — a few seconds at minimum, plus tokens in the response. Now it's effectively free. The hook's advice can stay as written without any cost concern.

---

## Observation 3 — New edge types are doing real work

From `cortex code arch`:

| Edge type | Count | Where it came from |
|---|---|---|
| `DEFINES` | 4,756 | existing |
| `CALLS` | 591 | existing |
| `CONTAINS_FILE` | 446 | existing |
| `IMPORTS` | 234 | existing |
| `CONTAINS_FOLDER` | 155 | existing |
| `USAGE` | 92 | existing |
| `SEMANTICALLY_RELATED` | 66 | **new** |
| `SIMILAR_TO` | 14 | **new** |
| `FILE_CHANGES_WITH` | 35 | **new** — git co-change |
| `CONFIGURES` | 35 | **new** |
| `WRITES` | 1 | new |

I didn't exercise these edges in queries this session (the session was about touring, not deep analysis), so I can't yet say how high-quality the inferences are. But the schema shape is right: `FILE_CHANGES_WITH` is the answer to "what should I touch when I touch X" and `SEMANTICALLY_RELATED` is the answer to "what's a near-duplicate of this function" — both are blast-radius questions that the previous schema couldn't answer.

**Suggested follow-up:** a future field report should pick one real PR from this repo, derive its file set, and check whether `FILE_CHANGES_WITH` would have predicted the touched files. That's the test that tells you whether the edge is useful or noise.

---

## Observation 4 — Vue coverage: half-resolved

The 2026-05-21 report flagged that `.vue` files were entirely invisible to the graph. That has partly improved: functions defined inside `<script setup>` blocks now appear as `function` nodes with sensible qualified names. Example from this session:

```
Users-rka-Development-anthill-cloud.apps.arcane.app.pages.arcane.discover.startConversation
Users-rka-Development-anthill-cloud.apps.arcane.app.pages.arcane.discover.handleSubmit
Users-rka-Development-anthill-cloud.apps.cloud.app.pages.onboarding.slugify
Users-rka-Development-anthill-cloud.apps.cloud.app.pages.onboarding.submit
```

`apps/arcane/app/pages/arcane/discover.vue` is a real `.vue` file and those are real function declarations inside its `<script setup>`. The parser is reading SFCs now.

What's *still* missing:

- **File-level Vue nodes**: `MATCH (f:file) WHERE f.qualified_name CONTAINS ".vue" RETURN count(f)` → 0. Functions surface, but the file they live in isn't a `file` node, which means:
  - `governs` linking by file path likely still fails for `.vue` (didn't re-test this session)
  - `FILE_CHANGES_WITH` co-change edges can't anchor to Vue files
  - `cortex code show some/component.vue` has nothing to resolve
- **Pinia stores as a symbol class**: `cortex code find useFoundationStore` returns 0 matches. The store is declared via `defineStore` inside a factory (`createFoundationStore`) and the resulting `useXxxStore` composables aren't being captured as their own symbols. This is the dominant data-access pattern in apps/activator and apps/arcane, so it's a meaningful blind spot.
- **`<template>` references between components**: I didn't see evidence that `<ACardFooter />` template usages create `CALLS` or `USES` edges. (Didn't verify this session — flagging as the next thing to check.)

Net: the 2026-05-21 recommendation was "a minimal Vue parser would solve this." A minimal parser appears to have shipped for the `<script setup>` block. Extending it to (a) emit a file-level node, (b) recognize `defineStore` / `useXxx` patterns, and (c) parse `<template>` for component references would close the remaining gap.

---

## Observation 5 — Lockfile noise in the `route` label

`MATCH (r:route) RETURN r.qualified_name LIMIT 15` returned a mix of real Nuxt API routes and pnpm-lock tarball URLs:

```
__route__ANY__/api/platform/accounts                            ← real
__route__ANY__/api/arcane/threads                               ← real
__route__ANY__/api/auth/me                                      ← real
__route__ANY__https://api.anthropic.com/v1/messages             ← arguable
__route__infra__{integrity: sha512-…, tarball: https://…/win32-x64-0.28.0.tgz}  ← lockfile leak
__route__infra__{integrity: sha512-…, tarball: https://…/win32-x64-0.27.7.tgz}  ← lockfile leak
```

The `route` label total is 183, but I'd estimate the lockfile-derived entries are a substantial chunk — when I ran a wider sweep with `cortex code arch` the lockfile-route count dwarfed the API-route count.

**Why this matters:** "list all routes in the app" is a natural question for a Nuxt monorepo and the answer should be ~30, not ~180. A second category like `external_url` or `package_resource` (separate from `route`) would let the agent filter cleanly. Alternatively, the indexer could skip `pnpm-lock.yaml` entirely — the value of parsing it is unclear vs. the noise it introduces.

---

## Observation 6 — `cortex index changes` errors

```
$ cortex index changes
ERROR: project not found
```

…against the same cwd where `cortex index status` returns:

```
{
  "project": "Users-rka-Development-anthill-cloud",
  "nodes": 5537,
  "edges": 6403,
  "status": "ready"
}
```

Minor — probably a missing project-resolution call in the `changes` subcommand. Flagging because the SessionStart hook copy specifically tells agents about this command as the way to refresh stale indexes.

---

## What I did not test this session

For honesty: this was a tour, not a deep dive. I did not exercise:

- `FILE_CHANGES_WITH` against a real PR
- `SEMANTICALLY_RELATED` for refactor-candidate hunting
- `cortex decision create` (0 decisions exist for this repo — the most load-bearing follow-on per the 2026-05-21 report)
- `governs` linking against `.vue` file paths (the regression test from 2026-05-21)
- `cortex eval` against this repo

These would each be a worthwhile separate session.

---

## Recommendations, ordered

1. **Emit file-level nodes for `.vue` files**, even if the parse stays shallow. Unblocks `governs`, co-change anchoring, and `cortex code show`. The `<script setup>` symbol extraction proves the file is being read — adding a file node is mostly a graph-write change.
2. **Recognize `defineStore` / Pinia patterns**, or at minimum surface the `useXxxStore` identifier as its own function node. Pinia is the de-facto data-access layer in Nuxt apps and the current invisibility is a real blind spot.
3. **Separate lockfile-derived URLs from real routes**, or skip `pnpm-lock.yaml` during indexing. The route-label inflation hurts a common query.
4. **Fix `cortex index changes` project resolution**. Small bug, but the SessionStart hook copy refers to it.
5. **Seed decisions for the heavy architectural calls in anthill-cloud** — layered apps/cloud composition, semantic utility class system, promotion chain, governance guards. The repo has rich CLAUDE.md and memory-file rationale that's currently invisible to `cortex decision why`. This is project-side work, not Cortex-side, but the tool's value here is gated on someone doing it.
6. **Accept filesystem-style paths in `cortex code show`** (and similar). Saves the find-first-then-show two-step for the common case.

---

## Net assessment

Cortex is meaningfully more useful than it was on 2026-05-21. The CLI alone justifies that — it changes the cost calculus of reaching for the tool from "preload a schema, pay tokens" to "type four words into a shell." Content-hash caching makes re-indexing free. New edge types open up question shapes that weren't previously expressible.

The same fundamental gap is still here, narrower than before: Vue files are partially indexed (functions yes, file nodes no), and the dominant Vue idioms in this repo (Pinia stores, template-level component composition) remain invisible. For server/API/TS-heavy code Cortex is a real tool here; for Vue-heavy UI work, grep+Read is still often faster.
