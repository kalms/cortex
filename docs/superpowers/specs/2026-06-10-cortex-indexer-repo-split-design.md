# Cortex Indexer Repo Split — Design Spec

**Date:** 2026-06-10
**Status:** Approved (pending writing-plans)
**Author:** rka + Claude

## Goal

Extract the native C indexer (`internal/indexer/`) into its own repository
(`cortex-indexer`) with an independent release pipeline, and have the `cortex`
repo consume a **prebuilt binary** instead of building C from source. After the
split, **nothing from the indexer/CBM fork lineage remains in the cortex
repository** — not in the working tree, not in comments, not in git history.

### Why

- `internal/indexer/` is already a self-contained C project (own `Makefile`,
  `LICENSE`, clang configs, test suite, vendored grammars). It is a
  repo-within-a-repo.
- The vendored tree-sitter grammars dominate the cortex repo (~693M working
  tree, ~93M packed) — a TS/MCP project carrying a C toolchain.
- The C test suite has rotted (~196 red, not in CI) because it shares a single
  CI pipeline with the TS suite. Its own repo gives it a proper build matrix.
- Prebuilt binaries make general releases and verification much easier:
  installs become toolchain-free, and the TS↔C contract becomes explicit and
  versioned.

The TS↔C seam is already a clean process boundary — a single chokepoint at
[`code-tools.ts:219-221`](../../../src/mcp-server/tools/code-tools.ts#L219-L221)
invokes the binary as `execFile(binary, ["cli", tool, JSON.stringify(args)])`
and parses JSON. No linking, no shared memory. The split is therefore
low-risk on coupling; the only genuinely new work is binary distribution.

## Decisions (settled)

| Topic | Decision |
|---|---|
| Distribution | postinstall **downloads** the platform binary from a `cortex-indexer` GitHub Release, verifies a sha256 checksum, drops it at `bin/cortex-indexer`. |
| Platform matrix | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (glibc). musl/Alpine + Windows out of scope (source-build documented). |
| Version pin | **Exact pin + runtime check.** cortex declares one exact indexer version; postinstall fetches that tag; first invocation asserts `--version` matches. |
| Fetch failure | **Soft warn, defer.** postinstall warns and exits 0; first use raises a clear, actionable "indexer not installed" error. |
| CBM legacy | **Killed entirely.** No `CBM_BINARY_PATH` alias, no `cbm` Makefile target, no `cbm` naming residue anywhere in the cortex tree. Grep-clean is an acceptance gate. |
| Git extraction | `cortex-indexer` preserves **C-engine-era history only** (from ~`59d40d4` "v0.5: CBM tree-sitter engine"), vendored blobs pruned. |
| cortex history | **Rewritten** to sever the entire `f63c708` codebase-memory-mcp/CBM ancestry. Nothing pre-fork remains. |

## Architecture

### Two repos, one contract

- **`cortex-indexer`** (new) — owns the C codebase + release pipeline. Receives
  everything in `internal/indexer/`: `src/`, `extract/`, `tests/`, `tools/`,
  `Makefile.indexer`, `scripts/vendor-grammar.sh`, clang configs, `LICENSE`.
- **`cortex`** (this repo) — drops `internal/indexer/` entirely, consumes a
  prebuilt binary. No C toolchain required to install.
- **The contract**, made explicit and versioned: the `cortex-indexer cli <tool>
  <json>` CLI interface + the graph-DB schema. Surfaced via `--version`.

### `cortex-indexer` release pipeline

- **On PR/push:** build + run the C test suite per platform (clang on Linux per
  the existing pin). The rotting C suite gets its own CI home and matrix,
  isolated from cortex's TS suite.
- **On tag `vX.Y.Z`:** matrix build for the 4 targets → strip → tarball each →
  emit sha256 → attach all assets + a checksums file to the GitHub Release.
- **Asset naming:** `cortex-indexer-<version>-<os>-<arch>.tar.gz` — a stable
  convention the cortex fetcher computes from `process.platform`/`process.arch`.
- **`--version` output:** JSON `{ version, schema, protocol }`. `schema` lets
  cortex emit precise stale-DB diagnostics on mismatch.
- The `Makefile` target is renamed `indexer` → `cortex-indexer`; the legacy
  `cbm` alias target is **dropped**.

### cortex consumption

- A single pinned constant `CORTEX_INDEXER_VERSION = "X.Y.Z"` (module export,
  the one source of truth for the fetcher and the runtime check).
- `scripts/build-indexer.sh` → replaced by **`scripts/fetch-indexer.mjs`**
  (postinstall): map os/arch → asset name → download from the pinned release →
  verify sha256 → extract → `chmod +x` → `bin/cortex-indexer`. Cache under
  `~/.cache/cortex-indexer/bin/<version>/<os>-<arch>/` so reinstalls/reverts
  skip the download.
- **Soft-warn fallback:** on any failure (offline, unsupported platform,
  GitHub outage), warn and exit 0 — never block `npm install`.

### Runtime guard

Behind the existing chokepoint, the legacy CBM fallback is removed:

```ts
const INDEXER_BINARY = process.env.CORTEX_INDEXER_PATH || LOCAL_INDEXER;
```

A lazy `ensureIndexer()` runs in front of the first indexer invocation (not at
MCP startup — keeps the server fast and avoids failing when the indexer isn't
used):

- **Binary absent** → throw the actionable "indexer not installed" error
  (the deferred failure from the soft-warn): supported platforms, how to build
  from the `cortex-indexer` repo, and the `CORTEX_INDEXER_PATH` override.
- **Present** → run `--version` once, cache the result, assert `version ===`
  the pinned version. On mismatch, a clear upgrade/reindex message (citing the
  `schema` field when relevant). `CORTEX_INDEXER_PATH` bypasses the version
  assertion (local dev against a freshly built binary).

### cortex CI

cortex CI stops compiling C. It downloads the pinned prebuilt (or sets
`CORTEX_INDEXER_PATH` to a cached binary), the same path as any user. Indexer
correctness lives in the `cortex-indexer` matrix.

## Clean break from CBM (acceptance gate)

A grep gate, run before cut-over is called done:

```
grep -rniI 'cbm' src/ scripts/ tests/ hooks/ bin/ package.json docs/ \
  --exclude-dir=.venv   # python venv carries unrelated base64/url 'cbm' noise
```

…returns **zero** hits. This covers:

- the `CBM_BINARY_PATH` env alias (removed in the runtime guard),
- comment-residue sites renamed:
  [`store.ts:266`](../../../src/graph/store.ts#L266) (`CBM_LABEL_MAP` /
  `cbm_nodes` → graph terms), [`events/types.ts:23`](../../../src/events/types.ts#L23)
  ("CBM project name" → "indexer project name"),
  [`decisions-adapter.test.ts:17`](../../../tests/api/decisions-adapter.test.ts#L17)
  (comment reworded),
- confirmation that `internal/indexer/` (home of the `cbm` Makefile alias) is
  fully gone.

**Principle:** after cut-over, nothing referencing the old `cbm` /
`code-graph-mcp` / `codebase-memory-mcp` fork name remains anywhere in the
cortex tree. `cortex-indexer` is the only name.

**Attribution caveat (cut-over decision, not the `cbm` scrub):** `LICENSE`
and `THIRD_PARTY.md` carry the MIT attribution to
`DeusData/codebase-memory-mcp`. While `internal/indexer/` (the MIT-derived
code) is still in the cortex tree, this attribution is **legally required and
must be retained** — the `cbm` functional scrub (consumption layer) does not
touch it. At cut-over, when the derived code physically moves to
`cortex-indexer`, the attribution moves with it to that repo; cortex — then
pure original TypeScript — can have the `codebase-memory-mcp` attribution
removed. This is a legal judgment for the user to confirm at cut-over, not an
automatic scrub. The broader `codebase-memory-mcp` fork-name references in
`docs/` and `internal/indexer/docs/` are likewise handled at cut-over (docs
sweep / repo removal), not by the code-dir `cbm` gate.

## History surgery

cortex has **two root commits** (merged histories):

- **`f63c708` "codebase-memory-mcp v0.0.1"** — the fork origin. Started as a Go
  project (`cmd/`, `go.mod`, `internal/`), evolved into the C tree-sitter engine
  (`59d40d4` "v0.5: CBM tree-sitter engine"), lived at `internal/cbm`, renamed
  to `internal/indexer` (`a59669e`).
- **`c531449`** (tree: `docs`) — the cortex/TS lineage; `src/` scaffolded later;
  the two histories were merged.

### `cortex-indexer` (extract, preserve C-engine era)

`git filter-repo` keeping the indexer's historical paths — `internal/indexer/`,
its predecessor `internal/cbm/` — starting from the C-engine era (~`59d40d4`),
**dropping the earlier Go prototype**. `--path-rename` normalizes to the new
repo root. Prune `vendored/` blobs in the same pass (re-vendor fresh via
`scripts/vendor-grammar.sh`). The dropped Go-prototype provenance remains
recoverable from the cortex pre-rewrite backup.

### `cortex` (purge the CBM lineage)

`git filter-repo --invert-paths` removing the indexer's historical paths
(`internal/indexer/`, `internal/cbm/`, and the root-level codebase-memory-mcp
origins `cmd/`, `go.mod`, `go.sum`, root `Makefile`, original `internal/`) from
every commit, severing the `f63c708` ancestry. cortex's history begins cleanly
with the TS/MCP work.

**Accepted consequences** (the rewrite is destructive):

- Every commit SHA from the rewrite point forward changes → force-push
  required; all existing clones/forks must re-clone; GitHub commit/PR
  permalinks to old SHAs break.
- Decision links survive — they key on qualified-name/path and PR number, not
  commit SHA (per `docs/architecture/decisions-storage.md`). Any decision/doc
  that cites a raw commit SHA must be re-pointed.
- A full backup (tag + bundle, e.g. `git bundle create ../cortex-prerewrite.bundle --all`)
  is taken before the rewrite and retained.

## Migration sequencing

1. **Stand up `cortex-indexer`:** filter-repo extract (C-engine era, prune
   vendored) → re-vendor grammars → wire CI (test matrix + tag-release
   pipeline) → cut a `vX.Y.Z` tag whose binary matches today's
   `bin/cortex-indexer`.
2. **Cortex, additive:** add `scripts/fetch-indexer.mjs`, the
   `CORTEX_INDEXER_VERSION` pin, and the `ensureIndexer()` runtime guard —
   while *keeping* `internal/indexer/` so nothing breaks mid-flight.
3. **Cut over:** flip `postinstall` to fetch; verify a clean-machine install +
   CI green against the prebuilt; remove the `CBM_BINARY_PATH` alias.
4. **Purge:** take the cortex backup bundle → `filter-repo --invert-paths` to
   delete `internal/indexer/` + the CBM lineage from history → run the grep
   acceptance gate → force-push.
5. **Docs + decision:** update `CLAUDE.md` (graph-storage section,
   build-indexer references), `README`, capture a Cortex decision recording the
   split, the exact-pin contract, and the rejected alternatives.

## Testing

- **cortex unit tests:** the os/arch → asset-name mapping; the sha256
  verification; the `--version` assertion logic (against a fake binary stub).
- **cortex integration test:** `fetch-indexer.mjs` against a real release asset
  in CI; `ensureIndexer()` absent/mismatch/ok paths.
- **cortex-indexer:** the existing C suite runs in its own CI matrix (the
  rehabilitation of the ~196 red tests is tracked separately, not a blocker for
  the split itself).

## Out of scope (YAGNI)

- Windows builds.
- A musl/Alpine release asset (source-build documented instead).
- `optionalDependencies` per-platform npm packaging (rejected in favor of
  postinstall download).
- Auto-clone-and-build fallback (rejected — re-introduces the C toolchain into
  cortex installs).
- Rehabilitating the rotted C test suite (separate effort).

## Open items

- Whether the first `cortex-indexer` tag is `v0.1.0` or mirrors an existing
  internal version number — resolved in the implementation plan.

## Resolved

- **`linux-arm64` CI:** native GitHub-hosted ARM runners (`ubuntu-24.04-arm`).
  Lets the C test suite execute on-arch (not just cross-compile) and avoids
  QEMU emulation overhead.
