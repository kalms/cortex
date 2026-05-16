# Cortex Frame Extraction — Research Brief

> Companion document to `cortex-multiplayer-spec.md` section 8 (Frame extraction).
> Captures the prior-art research and algorithmic detail that informed the spec's
> three-tier cascade. Where this document and the spec conflict, the spec wins —
> this is source material, the spec is the conclusion.

---

## 1. What we're solving

Cortex (github.com/kalms/cortex) is a multiplayer engineering canvas that renders a codebase as a graph of **frames** — semantic regions of interest (e.g. "auth", "routing", "the viewer", "data models"). We need an algorithm that automatically groups any repository's files into 5–12 frames that:

- **Read well to a casual viewer** unfamiliar with the codebase. Glance-legible: "this codebase has auth, routes, packages, and a viewer."
- **Are consistent across team members** on the same repo.
- **Are not user-editable.** Cortex is arbiter; algorithmic quality is the path forward.
- **Work across wildly different codebases**: small Rails apps, large Next.js/Vue monorepos, Python ML projects, Go services, research codebases.

### Signals available
- Filesystem tree (names, nesting, file counts)
- Framework/convention detection via manifests and marker files
- Import/call graph from `codebase-memory-mcp` (CBM)
- File type distribution
- Naming patterns

### What's been ruled out
- User-editable frames
- Pure LLM-directed grouping (not reliably stable across runs; expensive to recompute)
- Community detection alone (unstable, produces unnameable clusters)

---

## 2. Cortex indexing architecture — CBM handoff

Cortex does NOT re-parse code. A Go binary does that:

**CBM (`codebase-memory-mcp`):** Go binary, tree-sitter grammars (TS/JS/Python/Go/Rust/etc.), emits a graph of nodes (files, functions, classes, methods, symbols, markdown sections) and edges (`CALLS`, `IMPORTS`, `EXTENDS`, `CONTAINS`). Writes to `~/.cache/codebase-memory-mcp/<project>.db`. Handles incremental reindex via git-watch + file-hash diffing.

**Cortex (TS):** Discovers the CBM DB via `src/graph/cbm-discovery.ts`, does `ATTACH DATABASE <cbm.db> AS cbm` read-only (`src/graph/store.ts:330`). Writes OWN native tables for decisions, PRs, events, relationships. Queries `cbm.*` for structural code data.

**Plausible CBM schema (confirm exact names before coding):**
```
cbm.nodes(id, kind, file_path, qualified_name, name, start_line, end_line)
  kind ∈ ('file','function','class','method','symbol','markdown_section')
cbm.edges(src_id, dst_id, kind)
  kind ∈ ('CALLS','IMPORTS','EXTENDS','CONTAINS', ...)
```

**Implication:** ACDC's whole pattern set (dominator, support-library, dispatcher, orphan adoption) becomes executable SQL against `cbm.edges`. No parsing, no new infra.

**Future direction (parked):** replace CBM with native TS + tree-sitter-WASM. Write the frame extractor as an adapter over "a queryable edges table" so the migration is trivial; don't bake CBM-specific edge-type names into algorithm code.

---

## 3. Prior art — the compressed landscape

### Academic clustering (most relevant)
- **Bunch** (Mancoridis/Mitchell, 1999) — optimization-based, maximizes Modularization Quality (MQ). **Unstable across runs**, produces unnameable clusters. Fatal for our consistency requirement. MQ is still the baseline metric everyone benchmarks against.
- **ACDC** (Tzerpos/Holt, 2000) — **closest prior art to what Cortex needs.** Pattern-driven, comprehension-first. Uses subsystem patterns (source-file clusters, subgraph dominators, support-library/dispatcher fan patterns). Names clusters meaningfully. Stable. Weakness: C-era patterns, doesn't know modern framework conventions. **We extend ACDC with a framework-template stage in front.**
- **Reflexion models** (Murphy/Notkin/Sullivan, 1995) — user sketches model, tool compares to code. This is the user-editable pattern we've ruled out; CodeScene is the modern commercial version.
- **Newer work** uses Louvain/Leiden community detection on import graphs. Evaluated with **MoJoFM** — useful for our test methodology.

### Shipping tools (and how casual viewers actually react)
- **CodeCity** — classes as buildings, packages as districts. Gorgeous. Viewer sees scale/shape, **not what the codebase does.** Grouping = directory structure, period.
- **Gource** — animated tree. Beautiful, learns viewer nothing about semantic structure.
- **Sourcetrail** — symbol-level graph. Great for drill-in from one symbol, no overview story.
- **Structure101** (now Sonar) — dependency views + user-defined architecture spec.
- **CodeScene** — auto-generates components from globs, lets users edit. Legibility is borrowed from whoever named the directories well.
- **Polyglot / Voronoi treemaps** — organic, pretty, hierarchical. Viewer sees *sizes* of things, not *what they are*.
- **IDE structure views** — pure namespace hierarchy, no semantic grouping.
- **LLM-based (Understand-Anything, Graphify, etc.)** — fast-growing. Everyone either uses dir structure verbatim or runs Leiden then LLM-labels. **Nobody has cracked "stable, legible, and automatic."**

### Honest summary
Almost every shipping tool uses directory structure verbatim or lets the user edit. The algorithmic non-user-input approaches (Bunch, LIMBO, WCA) are unstable, unnameable, or both. **ACDC is the closest thing to what we want — 26 years old, underexploited.** Both opportunity and warning.

---

## 4. The proposed algorithm — CFX-1

> Note: the spec (section 8) adopts a refined version of this, splitting the original
> six-stage pipeline into three distinct tiers with clear selection criteria. This
> section preserves the original CFX-1 framing for reference.

Deterministic pipeline, runs as one Cortex-side script that opens the CBM read-only attach and writes native tables.

### Native tables Cortex writes
```sql
frames(id TEXT PRIMARY KEY, label TEXT, tier TEXT, stability_hash TEXT,
       template_version TEXT, created_from TEXT)
frame_members(frame_id TEXT, file_path TEXT, PRIMARY KEY (frame_id, file_path))
frame_provenance(file_path TEXT, rule TEXT, frame_id TEXT)  -- for debugging drift
```
`tier ∈ ('template','directory','orphan','merged')` — governs what can merge with what.

### Stages

**Stage 0 — Normalize.** Ignore `node_modules`, `.git`, `dist`, `build`, `target`, `vendor`, `.venv`, files from `.gitignore`, lockfiles, minified bundles.

**Stage 1 — Framework detection.** Walk manifests (`package.json`, `Gemfile`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `*.csproj`, `composer.json`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`) + marker files (`next.config.*`, `nuxt.config.*`, `config/routes.rb`, `manage.py`). Classify: `nextjs-app`, `nuxt-app`, `rails-app`, `django-project`, `go-service`, `rust-crate`, `python-lib`, `python-ml-project`, `monorepo-js` (sub-typed), `monolithic-unknown`.

**Stage 2 — Template matching.** Each repo type has a hand-authored template mapping glob patterns → frame names in the framework's own vocabulary.

Templates discard frames with <3 files; unmatched files flow to Stage 3.

**Stage 3 — Directory fallback.** For unmatched files (or `unknown` repos): take top-level dirs; if one dominates (>60% of files), descend; tiny dirs park in `scaffolding` for Stage 4 orphan adoption. Promote `src/` children, prettify names.

**Stage 4 — ACDC patterns via SQL on `cbm.edges`.**

*Subgraph-dominator* — a file with lots of in-directory dependents, few out-of-dir:
```
Threshold: in_dir_dependents >= 5 AND out_dir_dependents <= 2
```

*Support-library / dispatcher* — extreme fan-in/fan-out (threshold 20, or `max(10, 0.02 * total_files)`). Exile to orphan pool, don't anchor frames.

*Orphan adoption* — each unassigned file → existing frame it imports from most. Tie-break: `ORDER BY affinity DESC, frame_id ASC` (lexicographic = determinism).

**Stage 5 — Cap at 5–12.**
- Target by repo size: ≤50 files → 3–5; 50–500 → 5–8; 500–5000 → 7–10; >5000 → 10–12.
- **Over 12:** merge pair with highest inter-frame coupling (from `cbm.edges`). Only within same tier. Never merge template-distinct frames.
- **Under 5:** *(the spec's position is: just show fewer frames, don't invent padding)*

**Stage 6 — Labeling, in priority order:**
1. Template-assigned name
2. Dominator filename (stripped, prettified)
3. Directory name
4. **Markdown-section match** — if a README section references ≥2 files all in the same frame, use the section heading as the label. Novel contribution.
5. LLM fallback — deterministic (temp=0, structured output, ≤3 words), cached by `(repo_hash, frame_file_list)`.

### Determinism guarantees
- All tie-breaking is lexicographic. No randomness.
- Every query has explicit `ORDER BY`.
- LLM labels cached by content hash.
- Templates are versioned; record `template_version` on output.
- `stability_hash` per frame: hash of sorted `(file_path, node_count_in_file)`.

---

## 5. Test methodology

### Corpus (~25 repos spanning variance)
| Type | Candidates |
|---|---|
| Rails | gitlabhq, discourse, mastodon |
| Next.js | vercel/next.js (adversarial — framework itself), cal.com, vercel/commerce |
| Nuxt | nuxt/nuxt, directus/directus |
| Django | django/django, saleor, zulip |
| Python ML | huggingface/transformers, scikit-learn, ultralytics |
| Go | grafana, kubernetes, hashicorp/terraform |
| Rust | ratatui, rust-lang/cargo, denoland/deno |
| Turborepo | vercel/turbo, vercel/commerce |
| Nx | nrwl/nx, angular/angular |
| Research/notebook | rasbt/LLMs-from-scratch |
| Tiny | any repo <30 files |

For each: expected frame count, expected frame names (from 2-3 engineers), and the "this codebase has X, Y, Z" sentence a casual viewer should produce.

### Metrics
1. **MoJoFM vs. expert ground truth.** Target ≥70 average, no repo below 55.
2. **Frame-name precision** — % of generated names that fuzzy-match expert name for same cluster.
3. **Stability** — byte-identical output across run order shuffles; MoJo distance ≤2 between adjacent commits.
4. **Frame count in target band.**
5. **Casual-viewer test** — show frame names only, ask "what does this codebase do?" Score 0/1/2 on match. **This is the primary metric.** Catches "technically correct but unreadable" output.

### Failure modes to instrument
- **Dumping-ground frame** — no frame should contain >40% of files.
- **Phantom frame** — low intra-frame import density + high export density.
- **Fragmented domain** — "auth" split across three frames. Detect via cross-frame co-change hotspots in git history. *The algorithm will most often get this wrong.*
- **Monorepo flattening** — treating all `packages/*` as one frame. Check monorepo detection fired.
- **Controller swallow** — `app/controllers/` with 80 files while `app/services/` has 5. Per-frame size variance.

### Validation step not yet done
- **Run the "just use top-level directories" baseline** against the same corpus with the same metrics. Establishes the floor CFX-1 has to beat. Without this baseline, the value of the full algorithm is unquantified.

---

## 6. Open questions — honest ranking

### Tractable (don't over-think)
- Framework detection — finite list of manifest/marker fingerprints.
- Monorepo package boundaries — tools emit structured data already.
- Cap-to-12 merging logic — priority-queue merge.
- Determinism — discipline problem (lexicographic tie-break, no randomness).

### Genuinely hard — defensible-but-not-obvious choices
- **The fragmented-domain problem is not solved by CFX-1.** Frames are structural with framework-vocabulary labels. "Auth lives in middleware + models + routes" stays fragmented. **UX resolution:** frames are *where things are*; decisions and search cut across them semantically. Validate the cross-frame coupling count (Stage 5's merge query) is surfaceable in UI as "show me auth" at relationship level.
- **Research / ML codebases.** Output will be `src / notebooks / scripts / data` — correct but uninformative. Accept for v1; consider ML-specific sub-templates (Hugging Face layout, Ultralytics layout) later.
- **Naming-pattern auto-splitting** (e.g. big `models/` → `user-models`, `billing-models`). Needs confidence threshold + minimum-cluster floor or it over-applies. Where most bug reports will come from.
- **Stability vs. recency trade-off.** When frames update, is it noise or progress? Product question driving algorithm policy (e.g. "frames stable unless partition changes >20%, then re-label with announcement commit").
- **Evaluation ground-truth** — for conventional repos experts agree; for research/hybrid they won't. Can hit ≥70 MoJoFM on conventional corpus and still miss ambiguous ones.
- **CBM ordering** — tree-sitter may emit nodes in parse order, which depends on FS traversal order. Audit every query for explicit `ORDER BY`.

---

## 7. What wasn't done — next sessions

Two highest-leverage follow-ups:

1. **Prototype on one repo.** Pick one well-understood Next.js codebase (cal.com or trimmed fixture). Have CBM index it. Wire up the SQL queries against a real `cbm.*` attach. Hand-run each stage. Compare to frames you'd draw yourself. Most interesting failures surface in first 90 minutes.

2. **Draft the template library.** 6-8 templates for v1: `nextjs-app`, `nuxt-app`, `rails-app`, `django-project`, `monorepo-js-turbo`, `monorepo-js-nx`, `go-stdlib-service`, `rust-crate`. Each is ~20 lines of YAML (glob → frame-name + match predicate).

### Also worth doing
- **Re-read the 2000 ACDC paper end to end.** Two things to verify:
  - *Body-header conglomeration* — C-specific; find the TS analog (`Component.tsx` + `Component.test.tsx` + `Component.module.css` as an atomic unit before any step runs?)
  - *File-shared-neighbors pattern* — cluster files sharing many import neighbors. Useful adjunct to dominator query.
  - *Cluster cardinality bound* — ACDC caps at 20 nodes and recurses. Worth checking if that still applies at our granularity.

---

## 8. Directives for future conversations

- Do NOT propose user-editable frames. Ruled out.
- Do NOT propose replacing CBM in the critical path. Parked, not blocking.
- Algorithm must be deterministic. Every tie-break lexicographic. Every SQL has explicit ORDER BY.
- Framework templates are hand-authored content, not inferred. That's a feature.
- ACDC is the intellectual anchor. Everything else sits on top of or feeds into ACDC's pattern set.
- Markdown-section labeling is a genuinely novel angle we should exploit.
- Frames are structural with semantic labels. Pure semantic grouping ("show me auth across directories") is a *different* Cortex feature (search, decisions, cross-frame coupling surfacing) — not a frame-extraction problem.
- When in doubt about a specific choice: optimize for the casual-viewer test, not for MoJoFM.
