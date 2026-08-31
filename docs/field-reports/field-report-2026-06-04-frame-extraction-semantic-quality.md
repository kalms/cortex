# Field Report — Frame-Extraction Semantic Quality: Two-Repo Eval

**Date:** 2026-06-04
**Evaluator:** Claude (Opus 4.8, 1M context), session in `/Users/rka/Development/cortex`
**Subject:** Cortex frame extraction — clustering + labeling (`src/frame-extraction/*`)
**Trigger:** User noticed private-monorepo had no frames in the viewer. Root-causing that led to a quality assessment of the frames it *does* produce, across two repos.

---

## TL;DR

Frame extraction's **clustering is good** — it finds real architectural seams on both a Nuxt monorepo (private-monorepo) and Cortex's own polyglot tree. The **labeling is the weak link**, and it fails in two specific, reproducible ways:

1. **Label-with-no-domain-token** — when a cluster forms on a *structural* directory that legitimately spans several domains, there is no shared topical token, and the picker grabs an arbitrary leaf. Worked example: private-monorepo's `activator email` (7 sibling feature pages: banners, briefs, email, slides, presentations… labeled after one of them).
2. **Cluster-too-coarse** — heavily cross-importing modules fuse into one blob spanning multiple subsystems. Worked example: cortex's `cli commands` (24 files = CLI + decisions layer + MCP server, all under one label).

A first pass blamed private-monorepo's *layout*. That was wrong (see "Correction" below). private-monorepo is well organized; the labeler is defeated by **framework idioms** (route params `[orgId]`, convention prefixes `use*Store`), not by poor naming. Because private-monorepo is well organized, its awkward labels are unambiguously the **tool's** fault — which makes it the sharper test case, not the weaker one.

Separately, a **delivery bug** surfaced during root-cause: frame extraction only runs on the TS index path (the MCP `index_repository` tool and the `cortex index` CLI). Indexing via the raw C binary (`cortex-indexer cli index_repository`) silently produces a frameless graph. See "Operational root cause."

---

## What was evaluated

Both repos were freshly indexed via the TS `cortex index` path (which runs the C indexer **then** `runFrameExtraction`):

| Repo | Files clustered | Clusters | Notes |
|---|---|---:|---:|
| private-monorepo | 152 | 9 | Nuxt 3 monorepo (`apps/* + packages/*`) |
| cortex | 118 | 8 | Polyglot: TS app + C indexer + evals |

Frame membership was read directly from `nodes.data` (`frame_id` / `frame_label`) in each project's cache DB.

---

## Finding 1 — Clustering is sound; labeling underperforms it

The clusters on **both** repos correspond to real subsystems a human would draw:

- **private-monorepo:** design-system API routes; the `dsl` compiler package; design-system Vue pages; Pinia stores; cross-app server utils; admin pages; DB migrations.
- **cortex:** the C `pipeline` passes; the C `foundation` layer; `extract/*`; eval assertions; the frame-extraction subsystem itself.

These are correct. The problem is that the **label text** is frequently a poor representative of the cluster, which makes the viewer feel less semantic than the clustering actually is. Crucially, cortex's clustering was *not* better than private-monorepo's — cortex's `cli commands` blob is a worse coherence failure than anything in private-monorepo (Finding 3). cortex only *reads* better because its directory nouns happen to be ideal labeler input (Finding 2).

## Finding 2 — The variable is organizing-axis × labeler, not naming quality

> **Correction to a first-pass claim.** I initially framed cortex's cleaner labels as a reward for being "well-named" and private-monorepo's as a naming deficiency. That is wrong. private-monorepo is *very* well laid out for a monorepo — clean `apps/* + packages/*` split, idiomatic Nuxt file-based routing, a RESTful resource hierarchy (`orgs/[orgId]/design-systems/[dsId]/…`), domain-named stores (`stores/colors.ts`), a properly factored `packages/dsl/`. The directory nouns *are* semantic.

The real differentiator is how the repo's organizing axis interacts with a **naive path-token label picker** (highest-TF-IDF path token, minus a generic stop-list):

- **cortex is partitioned by subsystem**, with one distinctive domain noun at *shallow* depth (`foundation`, `pipeline`, `extract`, `assertions`). The distinctive token *is* the subsystem name — ideal input.
- **private-monorepo is partitioned by feature × layer.** Its distinctive tokens are either (a) **framework conventions the picker doesn't understand** — Nuxt dynamic segments leak in (`[orgId]` → "orgid design"), the Pinia `use*Store` prefix surfaces ("use store") — or (b) **absent**, when a cluster forms on a structural directory spanning multiple domains (Worked example A).

The path-token signal dominates content and co-change signal. That's fine on a subsystem-partitioned tree and adversarial on a feature×layer monorepo — independent of how well either is organized.

## Worked example A — `activator email` (label-with-no-domain-token)

Cluster (7 files):
```
apps/activator/app/pages/activator/banners.vue
apps/activator/app/pages/activator/briefs.vue
apps/activator/app/pages/activator/email.vue
apps/activator/app/pages/activator/index.vue
apps/activator/app/pages/activator/modular-content.vue
apps/activator/app/pages/activator/presentations.vue
apps/activator/app/pages/activator/slides.vue
```
These are the activator app's top-level feature pages. They co-locate under `pages/activator/` (structural proximity) but span distinct domains (banners, email, slides, presentations…). There is **no shared domain token**, so the picker grabbed one leaf — `email` — which misrepresents the other six. A human label is "activator feature pages" or "activator content types."

**This is not a naming problem in private-monorepo.** The cluster boundary fell on a structural directory that genuinely contains multiple domains; the labeler has no fallback for that case.

## Worked example B — `cli commands` (cluster-too-coarse)

Cluster (24 files, abridged):
```
src/cli/commands/{code,decision,decision-rehome,eval,graph,help,index}.ts
src/cli/paths.ts
src/decisions/service.ts, src/decisions/types.ts
src/mcp-server/server.ts, repo-context.ts, api-decisions.ts
src/mcp-server/tools/{code-tools,decision-tools,decision-input-validation}.ts
```
Three distinct subsystems — the CLI, the **decisions** layer, and the **MCP server** — fused into one frame because they are all TS and import each other heavily. This is the largest and least coherent frame on either repo, and it is mislabeled (decisions and the MCP server each deserve their own frame). Notably, an entire session's worth of multi-project-routing + decisions work lives here undifferentiated.

Lexical (path-token) similarity cannot separate these — they share `src/`, they're all `.ts`. **Import-graph modularity** (community detection on the call/import graph) likely would, since the CLI→decisions→MCP edges are denser within each subsystem than across.

## Finding 3 — Generated/vendored artifacts form low-value frames

Both repos produced a frame that is generated or vendored code rather than a subsystem:
- private-monorepo: `arcane drizzle` (13) — mostly `drizzle/meta/000N_snapshot.json` migration artifacts; `drizzle config` (8) — a junk-drawer of `*.config.ts` + `seed.ts` + scripts + a test.
- cortex: `indexer tools` (11) — generated tree-sitter grammars (`parser.c`, `grammar.js`, `node-types.json`).

The auxiliary-detection pass correctly peeled off some of this (private-monorepo's `css`, `momentum-728x90`, `studio-assets` grouped as auxiliary), but generated migrations, configs, and vendored grammars slipped through into "real" frames.

## Operational root cause (the original trigger)

Frame extraction is a **TS-side post-index step**. `runFrameExtraction` (co-change → HDBSCAN → `injectFrames`) is invoked only from:
- the MCP `index_repository` tool ([`src/mcp-server/tools/code-tools.ts`](../../../src/mcp-server/tools/code-tools.ts), via `withFrames`), and
- the `cortex index` CLI ([`src/cli/commands/index.ts`](../../../src/cli/commands/index.ts)).

The raw C binary `cortex-indexer cli index_repository` builds the graph but never runs it. private-monorepo (and cortex) had been reindexed via the raw C binary during unrelated verification work, leaving frameless graphs with **no warning**. Re-running through `cortex index` restored frames (private-monorepo 152/9, cortex 118/8). This is an easy footgun for any tool, hook, or script that drives the C binary directly.

---

## Recommendations

Ordered by leverage.

1. **Framework-convention awareness in the label picker.** Strip/down-weight Nuxt-style bracketed dynamic segments (`[orgId]`, `[id]`, `[...slug]`) and known convention affixes (`use*` for composables/stores, `.get/.post` route suffixes) before TF-IDF label selection. Directly fixes "orgid design", "use store". (Low effort; isolated to [`inject-frames.ts`](../../../src/frame-extraction/inject-frames.ts) label logic.)
2. **No-domain-token fallback.** When a cluster has no token shared across most members above a salience threshold, label by the **common path prefix** (`activator pages`) or explicitly mark it a *structural* (not topical) cluster, rather than grabbing a leaf. Fixes "activator email".
3. **Rebalance path-token vs symbol/content weight.** The clusters are path-dominated; weighting symbol names / imported identifiers higher would make quality robust to repos whose distinctive vocabulary isn't in the path. (Medium; touches [`text-blob.ts`](../../../src/frame-extraction/text-blob.ts) / [`cluster-tfidf-hdbscan.ts`](../../../src/frame-extraction/cluster-tfidf-hdbscan.ts).)
4. **Let import-graph modularity influence boundaries.** Lexical similarity can't split the `cli commands` blob; community detection on the import/call graph can. (Larger; changes the clustering input.)
5. **Route generated/vendored/config files to auxiliary.** Extend auxiliary-detection to catch migration snapshots, `*.config.*`, and vendored grammar trees so they don't form pseudo-subsystem frames.
6. **Warn on "file nodes present, zero frames."** Surface a non-fatal warning (CLI + viewer) when a graph has file nodes but no `frame_id`, so a raw-C-binary index doesn't silently look frameless. Closes the operational footgun.

## Suggested eval

Use these two repos as a fixed regression pair for frame quality: private-monorepo (feature×layer monorepo, framework-idiom-heavy) and cortex (subsystem-partitioned polyglot). They exercise opposite failure modes. A good change should improve private-monorepo's labels **without** regressing cortex's already-clean ones, and should split cortex's `cli commands` blob.

---

## Appendix — frames as evaluated

**private-monorepo (9):** `orgid design` (35, design-system API routes) · `dsl compiler` (30, ✓) · `arcane server` (23, cross-app server utils) · `activator design` (14, design-system pages) · `arcane drizzle` (13, migrations) · `use store` (12, Pinia stores) · `account` (10, admin pages, mixed) · `drizzle config` (8, junk-drawer) · `activator email` (7, **Worked example A**)

**cortex (8):** `cli commands` (24, **Worked example B**) · `frame extraction` (20, ✓) · `events worker` (14, events + decisions/seed) · `pipeline pass` (11, ✓) · `indexer tools` (11, generated grammars) · `evals assertions` (9, ✓) · `indexer extract` (9, ✓ minor leak) · `indexer foundation` (7, ✓)
