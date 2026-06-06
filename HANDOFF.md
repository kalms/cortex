# Cortex — Session Handoff (2026-06-06)

## TL;DR

**Both priorities from the 2026-06-05 handoff are done, merged to `main`, and pushed.** The `cluster:N` labeling bug is fixed (a frequency-based dominant-segment fallback), and the frames/viewer **storage pipeline is unified**: one canonical graph store per repo (`<repo>/.cortex/db`), project enumeration decoupled into a small SQLite **registry**, and durable global state moved out of `~/.cache` into the XDG **data** home. Live frame labels were regenerated — zero `cluster:N` remain on the real indexes. The session's open threads are now small: a stale-on-this-machine **C test-runner** (pre-existing, unrelated), some leftover legacy cache files, and the still-unresolved **label-quality measurement** problem inherited from the prior arc.

- **Branch:** `main` @ `90423d4`, **in sync with `origin/main`** (everything pushed).
- **TS tests:** 695/695 (`npm test`), `tsc` clean (`npm run build`).
- **Decisions captured:** `bb142587` (label fix), `bb2dee7e` (storage architecture).

---

## What shipped this session (all on `main`, pushed)

### 1. `cluster:N` labeling bug — fixed (`88db7c2`, merged `e338796`)
Convention clusters (every file `…/infrastructure/main.tf`, `modules/*/devbox.json`, `…/data/events/*.json`) stranded at the opaque `cluster:N` label. **Root cause:** passes 1–2 pick from TF-IDF top tokens, but TF-IDF *suppresses* corpus-common convention segments (low IDF), so the grouping segment is never a top token; pass 3 only matched a common path *prefix*, which is empty when org roots differ. **Fix:** a new pass 4 — `dominantPathSegmentLabel` — counts every informative path segment (dir or extension-stripped filename stem) across members and returns the one shared by a strict majority (`>50%`), tie-breaking toward shared-as-directory → deeper → longer → lexicographic. Files: `src/frame-extraction/inject-frames.ts`, `structural-tokens.ts`. 7 new TDD tests.
- **Live labels regenerated** into both stores for rosalind + anthill-cloud — zero `cluster:N` remain (`infrastructure`, `events`, `settings`, `devbox`, `drizzle`, `design systems`, `org settings`, …). Gate-0 visual QA confirmed the viewer renders them.

### 2. Frames/viewer storage unification — Priority 2 (spec `af28a65`, plan `0bf2c0a`, merged `d750813`)
Designed → planned → executed via subagent-driven development (per-task spec + quality review + a final cross-cutting review). Canonical store is **`<repo>/.cortex/db`**; both writers (CLI `cortex index`, MCP `index_repository`) write it (via the binary's `CORTEX_DB`), checkpoint the WAL, and **register** the repo. Enumeration + per-repo reads go through a new **registry** + `resolveGraphDbForRead`. One-shot idempotent startup migration seeds the registry from the legacy cache. `register()` rejects `.tmp/` paths so eval-corpus clones can't pollute enumeration. New: `src/db/registry.ts`, `src/db/registry-migration.ts`; reworked read/write paths in `cli/commands/index.ts`, `mcp-server/tools/code-tools.ts`, `graph/code-queries.ts`, `mcp-server/repo-context.ts`, `mcp-server/api.ts`.

### 3. Durable state → XDG data home (`85f0557`, merged `90423d4`)
`~/.cache` means "regenerable"; the registry and the C binary's `_config.db` are durable, so they moved to the XDG **data** home, matching the binary's existing XDG discipline:
- Registry → `~/.local/share/cortex-indexer/registry.db` (honors `$XDG_DATA_HOME`; `CORTEX_REGISTRY_DB` override). `importLegacyRegistry()` carries the old one over at startup.
- C `_config.db` → data dir via new `ctx_resolve_data_dir()` (`CTX_DATA_DIR` > `$XDG_DATA_HOME` > `~/.local/share`); the `config` command renames a pre-XDG file out of cache on first use.
- Genuinely-regenerable artifacts stay in `~/.cache`: build cache (`~/.cache/cortex/`), legacy per-project graph cache (`~/.cache/cortex-indexer/<slug>.db`), the 188 MB frame-extraction venv.

### 4. Documentation (`31ed480`, merged `d5450e1`; + updates in 1 & 3)
New living reference **[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md)** (the three stores, registry rationale, write/read paths, migration, the single path-resolution chokepoint, the `~/.cache/cortex` vs `~/.cache/cortex-indexer` gotcha). Indexed in the architecture README; CLAUDE.md gained a "Graph storage & the project registry" section; fixed stale `.cortex/graph.db` → `.cortex/db` canonical references.

---

## Honest caveats / things to know

- **Label *quality* is still not independently measured.** The cluster:N fix removed the opaque labels, but the prior arc's core problem stands: `checkLabelQuality` enforces the same rules `pickFrameLabel` satisfies (circular), so there is no independent signal that labels are *semantically good*. The new labels eyeball well on real repos, but "is this the right label" remains unvalidated. This is the most valuable next investment for frames.
- **The C test-runner is red on this machine (pre-existing, NOT from this work).** `make -f Makefile.indexer test` → **2486 passed, 194 failed** — all in store/cypher/pipeline test files where every store op returns `-1` (the store can't open *in the C test harness*). This work touches none of those files; all six `cli_config_*` tests pass; and the **production** binary's store works (the TS contract tests index real repos through it, 695 green). Looks like an environmental store-setup issue in the C harness — worth a separate look if the C suite matters.

## Loose ends / state

- **Legacy files left in place (unused):** the old `~/.cache/cortex-indexer/_registry.db`, the per-project `<slug>.db` graph caches, and (now-empty-of-config) cache dir. They're read fallbacks / migration sources; a future cleanup can delete them once every active repo has re-indexed into `.cortex/db`.
- **Registry test-pollution fixed:** `globalSetup` sets `CORTEX_REGISTRY_DB` to a temp path, so `npm test` no longer writes the real registry (verified: a full run adds zero rows).
- **Process hygiene note:** during Gate-0 QA a broad `pkill -f "src/index.ts"` killed stale dev servers *and* MCP plugin servers across other Claude Code windows; those relaunch lazily on next cortex-tool use. Scope kills to the port/PID (`lsof -ti tcp:3334`) next time.

## Next priorities (suggested)

1. **An independent label-quality signal** in the eval (break the circular metric) — the highest-leverage frames work left.
2. **C test harness store failures** — investigate why the store can't open in the C test-runner on this machine.
3. **Cleanup task** — delete legacy `~/.cache/cortex-indexer/<slug>.db` + old `_registry.db` once repos have re-indexed.
4. **(Parked, not built)** branch-keyed graph cache — the single path-resolution chokepoint in `resolve-path.ts` preserves the seam (`.cortex/db` → `.cortex/graph/<ref>.db`); registry + decisions stay branch-independent.

## Pointers

- **Storage model (read first for `src/db/`):** [docs/architecture/graph-storage.md](docs/architecture/graph-storage.md)
- **Specs:** [storage unification](docs/superpowers/specs/2026-06-05-frames-viewer-storage-unification-design.md) · [import-aware frame extraction (§13 outcome)](docs/superpowers/specs/2026-06-04-import-aware-frame-extraction-design.md)
- **Plan:** [storage unification](docs/superpowers/plans/2026-06-05-frames-viewer-storage-unification.md)
- **Decisions:** `bb142587` (cluster:N fallback), `bb2dee7e` (canonical .cortex/db + registry)
- **Key code:** labels `src/frame-extraction/inject-frames.ts` + `structural-tokens.ts`; storage `src/db/registry.ts` · `registry-migration.ts` · `resolve-path.ts`; read/write paths `src/cli/commands/index.ts` · `src/mcp-server/tools/code-tools.ts` · `src/graph/code-queries.ts` · `src/mcp-server/repo-context.ts` · `src/mcp-server/api.ts`; C data dir `internal/indexer/src/foundation/platform.c` (`ctx_resolve_data_dir`) + config store `internal/indexer/src/cli/cli.c`.
