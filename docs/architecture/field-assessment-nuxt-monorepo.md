# Field Assessment: Cortex on a Nuxt 4 Monorepo

**Date:** 2026-05-20
**Evaluator:** Claude (Opus 4.7), session in `/Users/rka/Development/anthill-cloud`
**Subject repo:** anthill-cloud — Turborepo monorepo, Nuxt 4 apps + TS packages
**Index size:** 5,010 nodes / 5,746 edges (indexed 2026-05-20T02:37:58Z)

This is a candid evaluation of how Cortex performed as a "powerful aid" for an
exploratory "tell me what you know about this project" task, versus what
`find` + `grep` + reading `CLAUDE.md` would have delivered. Written from inside
the session, with the actual queries and results still on the screen.

---

## TL;DR

For *this* repo, Cortex underdelivered relative to baseline tooling. Two
structural gaps in how it handles Vue/Nuxt projects erase most of the value
proposition; a third is an indexer bug that produces actively misleading
output. The fixes are tractable and would change the verdict completely.

---

## Where Cortex Won

- **One-shot architectural histogram.** `get_architecture` returned node-label
  and edge-type counts in a single call. Useful for cold-orientation; deriving
  the same via shell would have been ~5 commands.
- **Counting modules / functions / edges.** `find … | wc -l` works, but the
  Cortex numbers come with a label breakdown that's hard to replicate cheaply.
- **Indexed long-form docs as `module` nodes.** `docs/superpowers/specs/*.md`
  and `docs/superpowers/plans/*.md` are first-class nodes. This is the
  substrate `why_was_this_built` queries depend on, and it's there.
- **Latent edge types I didn't fully exercise.** `FILE_CHANGES_WITH` (42
  edges) and `SEMANTICALLY_RELATED` (66) are non-trivial to derive by hand.
  These deserve more credit than this session gave them; the value is real
  even if I didn't pull on them.

## Where Cortex Lost to `grep` + Reasoning

### 1. Page/route listings are just `find` output, re-derived

The most useful Cortex queries I ran in this session were of the form:

```cypher
MATCH (m:module) WHERE m.name CONTAINS 'server/api' RETURN m.name LIMIT 80
```

The output is literally the same as `find apps/activator/server/api -name '*.ts'`.
No structure was layered on top — Cortex returned path strings that the
filesystem already had. That's not a knowledge graph, that's a filesystem
walk with a Cypher facade.

### 2. The `route` label is poisoned by pnpm-lock URLs

`MATCH (r:route) RETURN r.name, r.file_path LIMIT 40` returned 40 rows of
**npm tarball URLs from `pnpm-lock.yaml`** — strings like:

```
{integrity: sha512-…, tarball: https://…codeartifact…/@esbuild/win32-x64/…}
```

These were classified as routes. They aren't. The indexer regex is treating
the `tarball:` field in lockfile entries as URL-like and emitting `route`
nodes for them. For a repo with a large `pnpm-lock.yaml`, this swamps any
legitimate route signal. Active harm, not just a gap.

### 3. The "killer query" returns empty

```cypher
MATCH (f:function) WHERE f.degree > 5 RETURN f.name, f.file_path, f.degree
```

→ **zero rows.**

In a 410-module Nuxt monorepo with composables, stores, Nitro handlers, and a
DSL compiler, there are obviously many high-fan-in functions. The reason none
show up: the indexer doesn't extract functions from:

- Vue SFC `<script setup>` blocks (every page and component)
- Nitro `defineEventHandler(() => …)` bodies (every API route)
- Pinia store `defineStore(…, () => …)` setup-style stores
- Composables exported as named arrow functions in `app/composables/*.ts`

That's ~90% of the meaningful symbols in the repo. Without them in the graph,
`trace_path`, dead-code detection, fan-in/fan-out analysis, and risk-labeled
traces all degrade to "no results."

### 4. No `HTTP_CALLS` edges for this project

The schema declares `HTTP_CALLS` (75 edges globally across all indexed
projects), but this project's graph contains zero. The single
highest-value cross-cutting query for a Nuxt app —

> "Which Vue page calls `/api/orgs/[orgId]/design-systems/[dsId]/variables`?"

— is unanswerable. `grep -r "design-systems/\[dsId\]/variables" apps/` does
it in 50ms with perfect recall. The indexer isn't extracting `$fetch(…)` or
`useFetch(…)` call sites as HTTP edges.

### 5. No decisions / ADRs recorded

`search_decisions("anthill")` and `search_decisions("cloud")` both returned
no results. The repo has 15+ spec documents under `docs/superpowers/specs/`
that are explicitly design-decision records. None have been promoted to
Cortex decisions, which means `why_was_this_built` falls back to whatever
text-search Cortex does over indexed sections — i.e. roughly equivalent to
`grep -r` over markdown.

### 6. Startup hook lied about index state

The session-start hook printed:

```
Repo: /Users/rka/Development/anthill-cloud
Index state: not-indexed
```

But `list_projects` showed the repo indexed 90 seconds *before* the
Cortex-tool indexing block. Minor, but it primed redundant work and erodes
trust in the routing prompt.

### 7. `search_graph` without `project=` returns wrong project

Calling `search_graph(label="route")` without an explicit `project` argument
returned routes from the *Cortex* project, not anthill-cloud. The "active
project" default isn't sticky to CWD; the tools need a project arg every
time. Easy to forget, easy to misread results.

---

## Why This Matters: The Nuxt/Vue Shape

Cortex's design assumes the dominant programming model is "explicit
functions in code files, with explicit cross-module references." That fits
Go, Python, Java, and most TS backends.

Nuxt 4 inverts that:

- **The file path *is* the API.** A file at
  `server/api/orgs/[orgId]/design-systems/[dsId]/variables/index.get.ts`
  defines `GET /api/orgs/:orgId/design-systems/:dsId/variables`. There is
  no symbol to point at — the convention is the contract.
- **Vue SFCs are the call sites.** Pages and components live in
  `.vue` files with `<script setup>` blocks. A normal AST parser sees them
  as XML.
- **Auto-imports erase explicit `import` statements.** Composables, stores,
  and Nuxt utilities get magic-imported. `IMPORTS` edges (214 in this graph)
  catastrophically under-represent the real dependency surface.
- **HTTP boundaries are stringly-typed.** `useFetch('/api/orgs/…')` is the
  glue. Without HTTP-call extraction, front-end and back-end look like
  disconnected islands in the graph.

A code graph that doesn't model any of this is, on a Nuxt monorepo, a
slightly-fancier `find`.

---

## What Would Change the Verdict

In rough priority order:

1. **Parse Vue SFCs.** Extract `<script setup>` top-level identifiers, function
   declarations inside them, and component definitions, as `function` /
   `component` nodes. This single change probably 5×s the useful node count.
2. **Extract Nitro handler bodies.** Every
   `export default defineEventHandler(async (event) => { … })` is a function;
   currently it's just a module. Treat the file path as the route name.
3. **Build `HTTP_CALLS` edges from `$fetch` / `useFetch` / `useLazyFetch`
   string literals.** Even a regex-based first pass would unlock the
   page→handler queries that are 80% of why one would want a graph.
4. **Tighten the `route` extractor** so `tarball:` fields in pnpm-lock
   YAML aren't classified as routes. Either skip `pnpm-lock.yaml` entirely
   (it's machine-generated and adds no architectural signal) or anchor the
   regex on `http(s)://[^/]+/[^,}]+` followed by route-like path tokens.
5. **Make `search_graph` default to the project matching `pwd`**, not "last
   active." A small but high-frequency papercut.
6. **Fix the startup hook's index-state check** so it doesn't claim
   "not-indexed" for repos that *are* indexed.
7. **Promote `docs/superpowers/specs/*.md` to decisions automatically**, or
   at least surface them in `why_was_this_built` results with high weight.
   The corpus is the right substrate; the schema just doesn't know it yet.

---

## Implementation Order I'd Actually Take

Reordering the list above by "fastest path from this report to a different
verdict," after a follow-up read of the indexer source:

1. **Fix the startup hook (was #6).** One-line change to add the cache-dir
   fallback that the MCP server's `resolveCortexDbPath()` already supports.
   Stops misleading agents into redundant `index_repository` calls. Free
   trust gain on day one.
2. **Extract `$fetch` / `useFetch` as `HTTP_CALLS` (was #3).** Highest
   single-fix leverage on a Nuxt repo. The `detect_url_in_args` fallback in
   `pass_parallel.c` already fires on any call whose first arg looks like a
   URL — the question is why auto-imported callees aren't reaching it.
   Likely a day of work, not a week.
3. **Model the Nuxt auto-import table.** Read `.nuxt/types/imports.d.ts`
   (or `auto-imports.d.ts`) and treat its entries as implicit `IMPORTS`
   edges. This one change unlocks composables, Pinia stores, *and* the
   `$fetch`/`useFetch` resolution above as a side effect — it's the
   upstream root cause shared by claims #1, #2, and #3.
4. **Audit, don't rebuild, SFC integration (was #1).** `extract_sfc.c`
   already exists and parses `<script setup>`. The action is figuring out
   why its outputs aren't surfacing in `f.degree > 5` queries — most
   likely an integration or fast-mode interaction, not a missing parser.
   Cheap to investigate, expensive to assume.
5. **Nitro handler bodies (was #2).** Treat
   `defineEventHandler(async (event) => …)` as a named function with the
   file path as the canonical name. Same shape as existing route-decorator
   extraction in `extract_defs.c`.
6. **Repro and fix the tarball→route bug (was #4).** Default-mode YAML
   processing should not be producing `HTTP_CALLS` edges — YAML's
   `lang_specs.c` entry has no `call_types`. Needs a targeted repro to
   find the actual entry point before patching.
7. **`search_graph` per-request project resolution (was #5).** Reframe:
   `indexerProject` is locked at MCP server startup from `process.cwd()`,
   so it goes stale on cwd change rather than "defaults to last active."
   Fix is per-request resolution or a required `project` arg, not a
   different default.
8. **Promote spec docs to decisions (was #7).** Lowest leverage; deferred
   to last. The corpus is the right substrate but the gap costs less than
   the others.

The first three items alone would move the verdict from "underwhelming"
to "essential." Items 4–6 widen the moat. Items 7–8 are polish.

---

## What Cortex *Is* Already Good For (in this repo)

Even with the gaps above, there are queries that genuinely beat shell tools:

- **"What files tend to change together?"** — `FILE_CHANGES_WITH` is hard to
  compute without a graph layer. Worth surfacing more prominently.
- **"What's semantically similar to this spec doc?"** — embeddings on
  indexed sections are something `grep` can't do.
- **Cross-project queries** — once we index `anthill-platform-core` and
  `anthill-design-system` separately, queries across the three become
  uniquely valuable. (Today, all three are linked via pnpm overrides; a
  graph that *spans* them would be a real differentiator.)

---

## Closing Thought

Cortex on this repo today is a sophisticated `find` with broken edge
extraction. Cortex on this repo *with Vue SFC parsing and HTTP-call edges*
would be the single best tool I have for understanding the codebase — better
than any combination of `grep`, `tree`, and reading `CLAUDE.md`. The gap
between "underwhelming" and "essential" is two parsers and a regex fix.
