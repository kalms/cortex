# cortex-indexer Repo Standup — Implementation Plan

> **For agentic workers:** This is plan #1 of 3 for the indexer split (see the design spec `docs/superpowers/specs/2026-06-10-cortex-indexer-repo-split-design.md`, decision `D-chfd`). Unlike plan #2 (the cortex consumption layer), this plan is largely an **operational runbook** — git history surgery, GitHub Actions, and release publishing — plus one real C task (`--version` JSON). Steps use checkbox (`- [ ]`) syntax. Tasks are verification-gated rather than strictly TDD where TDD does not apply (git/CI/release ops).

**Goal:** Stand up a standalone `cortex-indexer` git repository (extracted from `internal/indexer/`, C-engine-era history, vendored pruned from history) with a CI build+test matrix and a tag-driven release pipeline that publishes the per-platform tarballs + checksums that cortex's `scripts/fetch-indexer.mjs` consumes.

**Architecture:** `git filter-repo` extracts the C lineage into a new repo rooted at the indexer tree. The existing `Makefile.indexer` builds `build/c/cortex-indexer`; CI builds it on a 4-target matrix (native runners), runs the C test suite, and on a `v*` tag produces `cortex-indexer-<version>-<os>-<arch>.tar.gz` (+ `.sha256`) attached to a GitHub Release with `-DCTX_VERSION` injected from the tag. One C change makes `--version` emit the JSON `{version,schema,protocol}` that cortex's `ensureIndexer` parses.

**Tech stack:** C (existing Makefile.indexer, clang/gcc), `git-filter-repo`, GitHub Actions (`macos-14`, `macos-13`, `ubuntu-24.04`, `ubuntu-24.04-arm`), `gh` CLI, `tar`, `shasum`.

---

## Cross-repo & authorization notes

- **Working directories.** Most steps run in a **scratch clone** (`/tmp/cortex-indexer-extract`) and then the **new repo**, NOT inside the cortex checkout. Each task states its CWD.
- **User-gated steps** (cannot be done autonomously; the plan pauses for the user): creating the GitHub repo, the first `git push`, and publishing the first release. These are marked **[USER]**.
- **Version coupling.** cortex pins `CORTEX_INDEXER_VERSION = "0.3.0"` (plan #2). To make cut-over (plan #3) a no-op on the pin, **the first release here is tagged `v0.3.0`** and its binary must be functionally equivalent to today's `bin/cortex-indexer`. This resolves the spec's open "v0.1.0 vs mirror" item → **v0.3.0**.
- **Repo slug.** `scripts/fetch-indexer.mjs` defaults its base URL to `https://github.com/ruevu/cortex-indexer/releases/download`. This plan creates **`ruevu/cortex-indexer`**. If the owner differs, the user must say so (it changes the slug in plan #3's fetcher default).
- **Asset contract** (must match plan #2's fetcher exactly): asset basename `cortex-indexer-<version>-<os>-<arch>.tar.gz` where `<os>` ∈ {darwin,linux}, `<arch>` ∈ {arm64,x64}; the tarball contains an executable named `cortex-indexer` at its root; a sibling `<asset>.sha256` whose first whitespace token is the tarball's sha256.

---

## New-repo file structure (post-extraction)

At the new repo root (renamed from `internal/indexer/`):
- `Makefile.indexer` — build (kept by name; CI calls `make -f Makefile.indexer indexer`). The `cbm` alias target is removed.
- `src/`, `extract/`, `tools/`, `tests/` — the C sources + test suite (moved from `internal/indexer/`).
- `vendored/` — tree-sitter grammars, re-added as a single fresh commit (pruned from history).
- `scripts/vendor-grammar.sh` — grammar vendoring helper (for future additions).
- `.clang-format`, `.clang-tidy`, `LICENSE` — retained.
- **New:** `.github/workflows/ci.yml` (build+test matrix), `.github/workflows/release.yml` (tag → release), `README.md`, `tests/smoke_version.sh` (the `--version` JSON smoke check).

---

## Phase A — Prepare extraction

### Task A1: Install git-filter-repo and back up cortex

**CWD:** cortex checkout (`/Users/rka/Development/cortex`).

- [ ] **Step 1: Confirm/install git-filter-repo**

Run: `git filter-repo --version || pip3 install git-filter-repo || brew install git-filter-repo`
Expected: prints a version (e.g. `git-filter-repo 2.x`). If neither installer is available, STOP and ask the user to install it.

- [ ] **Step 2: Full safety backup of cortex (history rewrite happens in plan #3, but back up now)**

Run:
```bash
git -C /Users/rka/Development/cortex bundle create /tmp/cortex-prestandup.bundle --all
ls -lh /tmp/cortex-prestandup.bundle
```
Expected: a multi-MB bundle file exists. This is the recovery artifact for the whole split effort.

- [ ] **Step 3: Record the C-engine-era root commit**

Run: `git -C /Users/rka/Development/cortex log --oneline --reverse -- internal/cbm internal/indexer | head -3`
Expected: confirms `59d40d4` ("v0.5: CBM tree-sitter engine, 59 vendored language grammars") is the intended new-root anchor. Note its full SHA:
```bash
git -C /Users/rka/Development/cortex rev-parse 59d40d4
```
Record the full SHA for Task B1.

---

## Phase B — Extract into a new repo

### Task B1: filter-repo extract the C lineage (C-engine era, rename to root)

**CWD:** `/tmp`.

- [ ] **Step 1: Fresh mirror-style clone (filter-repo requires a fresh clone)**

```bash
rm -rf /tmp/cortex-indexer-extract
git clone /Users/rka/Development/cortex /tmp/cortex-indexer-extract
cd /tmp/cortex-indexer-extract
```
Expected: a clone on `main`.

- [ ] **Step 2: Keep only the C lineage paths, rename to root, graft at the C-engine era**

```bash
git filter-repo \
  --path internal/cbm/ \
  --path internal/indexer/ \
  --path-rename internal/cbm/: \
  --path-rename internal/indexer/: \
  --refs <FULL_SHA_OF_59d40d4>..HEAD
```
Expected: filter-repo reports rewriting a subset of commits; the working tree now has `src/`, `extract/`, `tests/`, `Makefile.indexer`, `vendored/`, etc. at the **root**.

- [ ] **Step 3: Verify the graft + tree**

```bash
git log --oneline --reverse | head -3      # new root should be the C-engine-era commit, NOT "codebase-memory-mcp v0.0.1"
git rev-list --max-parents=0 HEAD          # exactly ONE root commit
ls                                          # Makefile.indexer, src/, extract/, tests/, vendored/ at root — NO internal/ prefix
```
Expected: single root at the C-engine era; no Go-prototype (`cmd/`, `go.mod`) commits; tree rooted correctly.

**Fallback (if grafting via `--refs` proves finicky):** drop `--refs` to keep the full lineage including the Go prototype (the spec allows recovery from backup either way). If you take the fallback, NOTE it in the Task B1 checkbox and proceed — it does not block the release pipeline.

### Task B2: Prune vendored from history, re-add as a fresh snapshot

**CWD:** `/tmp/cortex-indexer-extract`.

- [ ] **Step 1: Stash the current vendored snapshot (it's the artifact we re-add)**

```bash
cp -R vendored /tmp/cortex-indexer-vendored-snapshot
du -sh /tmp/cortex-indexer-vendored-snapshot
```
Expected: ~693M copied (the working-tree grammars).

- [ ] **Step 2: Strip vendored/ from ALL history**

```bash
git filter-repo --path vendored/ --invert-paths --force
git log --oneline | tail -1                 # history still rooted at C-engine era
test ! -d vendored && echo "vendored removed from tree"
```
Expected: `vendored/` is gone from every commit (and the working tree); `.git` is dramatically smaller.

- [ ] **Step 3: Re-add the vendored snapshot as one fresh commit**

```bash
cp -R /tmp/cortex-indexer-vendored-snapshot vendored
git add vendored
git commit -m "vendor: re-add tree-sitter grammars (pruned from history, fresh snapshot)"
du -sh .git                                  # large working tree, but only ONE commit carries the grammar blobs
```
Expected: a single commit adds `vendored/`; history before it carries no grammar blobs.

---

## Phase C — Normalize the new repo

### Task C1: Drop the `cbm` Makefile alias; verify the build

**CWD:** `/tmp/cortex-indexer-extract`.

- [ ] **Step 1: Remove the `cbm` alias target**

In `Makefile.indexer`, delete the alias and its comment (around lines 478-480):
```make
# (e.g. older copies of scripts/build-indexer.sh) may still invoke `cbm`.
cbm: indexer
```
and remove `cbm` from the `.PHONY` line (around line 345): `.PHONY: test ... indexer cbm clean-c ...` → drop the bare `cbm` token.

- [ ] **Step 2: Build from a clean tree**

```bash
make -f Makefile.indexer clean-c 2>/dev/null || true
make -f Makefile.indexer indexer
test -x build/c/cortex-indexer && echo "BUILT"
```
Expected: compiles; `build/c/cortex-indexer` exists and is executable. (If grammars need (re)generation, the build/vendor step handles it; the snapshot from B2 supplies them.)

- [ ] **Step 3: Smoke-run the binary + the C test suite**

```bash
./build/c/cortex-indexer --version           # currently prints: cortex-indexer dev   (plaintext — fixed in Phase D)
make -f Makefile.indexer test 2>&1 | tail -20
```
Expected: `--version` prints `cortex-indexer dev`; record the C test result. The C suite is known-rotted (~196 red per project history) — capture the current pass/fail counts as the BASELINE; rehabilitating it is explicitly **out of scope** for this plan (tracked separately). The release does not gate on a fully-green C suite, but DO note the baseline so regressions are visible.

---

## Phase D — `--version` emits JSON (the one real code task)

cortex's `ensureIndexer` (plan #2) parses `--version` stdout as JSON and reads `.version`. Today it's plaintext. Make it JSON, keeping `version` load-bearing and `schema`/`protocol` as forward-looking diagnostic integers.

### Task D1: JSON `--version` + smoke test

**CWD:** `/tmp/cortex-indexer-extract`.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke_version.sh`:
```bash
#!/usr/bin/env bash
# Asserts `cortex-indexer --version` emits JSON with a non-empty .version.
set -euo pipefail
BIN="${1:-build/c/cortex-indexer}"
out="$("$BIN" --version)"
echo "version output: $out"
# Must be valid JSON with a non-empty string .version (python is available on all CI runners).
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert isinstance(d.get('version'),str) and d['version'], 'missing/empty .version'; print('OK schema=%s protocol=%s' % (d.get('schema'), d.get('protocol')))" "$out"
```
Make it executable: `chmod +x tests/smoke_version.sh`.

- [ ] **Step 2: Run it to confirm it fails against the current plaintext output**

Run: `./tests/smoke_version.sh ./build/c/cortex-indexer`
Expected: FAIL — `json.loads` raises on `cortex-indexer dev` (not JSON).

- [ ] **Step 3: Change `--version` to emit JSON**

In `src/main.c`, replace the `--version` branch (around lines 133-136):
```c
        if (strcmp(argv[i], "--version") == 0) {
            printf("cortex-indexer %s\n", CTX_VERSION);
            return 0;
        }
```
with:
```c
        if (strcmp(argv[i], "--version") == 0) {
            /* JSON so cortex's ensureIndexer can parse .version. schema/protocol
             * are forward-looking diagnostics (DB schema + cli JSON contract). */
            printf("{\"version\":\"%s\",\"schema\":%d,\"protocol\":%d}\n",
                   CTX_VERSION, CTX_DB_SCHEMA, CTX_CLI_PROTOCOL);
            return 0;
        }
```
Add the two constants near the existing `#define CTX_VERSION "dev"` (around line 29 of `src/main.c`):
```c
#ifndef CTX_DB_SCHEMA
#define CTX_DB_SCHEMA 1
#endif
#ifndef CTX_CLI_PROTOCOL
#define CTX_CLI_PROTOCOL 1
#endif
```
(Leave `#define CTX_VERSION "dev"` and its `-DCTX_VERSION` CI override intact.)

- [ ] **Step 4: Rebuild and pass the smoke test**

```bash
make -f Makefile.indexer indexer
./tests/smoke_version.sh ./build/c/cortex-indexer
```
Expected: `version output: {"version":"dev","schema":1,"protocol":1}` then `OK schema=1 protocol=1`.

- [ ] **Step 5: Verify version injection works (simulates the release build)**

```bash
make -f Makefile.indexer clean-c
make -f Makefile.indexer indexer CFLAGS_EXTRA='-DCTX_VERSION=\"0.3.0\"'
./build/c/cortex-indexer --version
```
Expected: `{"version":"0.3.0","schema":1,"protocol":1}`. This is the exact mechanism the release workflow uses.

- [ ] **Step 6: Commit (in the new repo)**

```bash
git add src/main.c tests/smoke_version.sh Makefile.indexer
git commit -m "feat: emit JSON from --version; drop cbm Makefile alias; add version smoke test"
```

---

## Phase E — CI: build + test matrix

### Task E1: Add `.github/workflows/ci.yml`

**CWD:** `/tmp/cortex-indexer-extract`.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build-test:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: macos-14,        os: darwin, arch: arm64 }
          - { runner: macos-13,        os: darwin, arch: x64 }
          - { runner: ubuntu-24.04,    os: linux,  arch: x64 }
          - { runner: ubuntu-24.04-arm, os: linux, arch: arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - name: Build indexer
        run: make -f Makefile.indexer indexer
      - name: Version smoke test
        run: ./tests/smoke_version.sh ./build/c/cortex-indexer
      - name: C test suite (non-gating baseline)
        run: make -f Makefile.indexer test || echo "::warning::C suite has known failures (baseline); see project_c_test_suite_rot"
```
NOTE: the C suite step is intentionally non-gating (`|| echo ::warning::`) because the suite is currently red and its rehabilitation is a separate effort. The build + version smoke ARE gating. When the C suite is rehabilitated, drop the `|| echo` to make it gating.

- [ ] **Step 2: Lint the YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml OK')"`
Expected: `ci.yml OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build + version-smoke matrix (darwin/linux × arm64/x64), C suite non-gating"
```

---

## Phase F — CI: release pipeline

### Task F1: Add `.github/workflows/release.yml`

**CWD:** `/tmp/cortex-indexer-extract`.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/release.yml`:
```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write          # required for the GitHub Release upload
jobs:
  build-assets:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: macos-14,        os: darwin, arch: arm64 }
          - { runner: macos-13,        os: darwin, arch: x64 }
          - { runner: ubuntu-24.04,    os: linux,  arch: x64 }
          - { runner: ubuntu-24.04-arm, os: linux, arch: arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - name: Derive version from tag
        id: ver
        run: echo "v=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"   # v0.3.0 -> 0.3.0
      - name: Build with injected version
        run: make -f Makefile.indexer indexer CFLAGS_EXTRA='-DCTX_VERSION=\"${{ steps.ver.outputs.v }}\"'
      - name: Verify version + strip
        run: |
          ./build/c/cortex-indexer --version | grep -q "\"version\":\"${{ steps.ver.outputs.v }}\""
          strip build/c/cortex-indexer || true
      - name: Package tarball + checksum
        run: |
          ASSET="cortex-indexer-${{ steps.ver.outputs.v }}-${{ matrix.os }}-${{ matrix.arch }}.tar.gz"
          install -m 0755 build/c/cortex-indexer cortex-indexer
          tar -czf "$ASSET" cortex-indexer
          shasum -a 256 "$ASSET" > "$ASSET.sha256"
          echo "ASSET=$ASSET" >> "$GITHUB_ENV"
      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            ${{ env.ASSET }}
            ${{ env.ASSET }}.sha256
```
This produces exactly the asset names + `.sha256` format the fetcher expects (`shasum -a 256` output is `<hash>  <file>`; the fetcher reads the first whitespace token).

- [ ] **Step 2: Lint the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('release.yml OK')"`
Expected: `release.yml OK`.

- [ ] **Step 3: Add a minimal README and commit**

Create `README.md`:
```markdown
# cortex-indexer

Native (C) code-graph indexer for [Cortex](https://github.com/ruevu/cortex).
Extracted from `cortex` (originally `codebase-memory-mcp`, MIT). Cortex consumes
the prebuilt binary from this repo's GitHub Releases — see cortex's
`scripts/fetch-indexer.mjs`.

## Build
    make -f Makefile.indexer indexer      # -> build/c/cortex-indexer

## Release
Tag `vX.Y.Z` → CI builds darwin/linux × arm64/x64, injects `-DCTX_VERSION`,
and publishes `cortex-indexer-X.Y.Z-<os>-<arch>.tar.gz` (+ `.sha256`).
```
Then:
```bash
git add .github/workflows/release.yml README.md
git commit -m "ci: tag-driven release pipeline producing per-platform tarballs + checksums"
```

---

## Phase G — Publish & verify against cortex

### Task G1: **[USER]** Create the GitHub repo and push

**CWD:** `/tmp/cortex-indexer-extract`.

- [ ] **Step 1: Confirm the LICENSE attribution is present**

Run: `head -20 LICENSE`
Expected: the MIT text + the `codebase-memory-mcp` attribution rides along from history. The derived C code now LIVES here, so this is where the attribution belongs.

- [ ] **Step 2: **[USER]** Create the repo and push** (requires the user's GitHub auth/decision)

```bash
gh repo create ruevu/cortex-indexer --private --source=. --remote=origin --push
```
Expected: repo created, `main` pushed. **Pause here for the user** if `gh` is not authenticated or the owner/visibility needs confirmation.

- [ ] **Step 3: Confirm CI is green on push**

Run: `gh run watch` (or check the Actions tab). Expected: the `ci` workflow's build + version-smoke steps pass on all 4 runners (C-suite step may warn).

### Task G2: **[USER]** Cut v0.3.0 and verify cortex can consume it

- [ ] **Step 1: **[USER]** Tag and release**

```bash
git tag v0.3.0
git push origin v0.3.0
gh run watch     # release workflow
```
Expected: a `v0.3.0` GitHub Release with 8 assets (4 tarballs + 4 `.sha256`).

- [ ] **Step 2: Verify the asset names match the fetcher contract**

Run: `gh release view v0.3.0 --json assets -q '.assets[].name'`
Expected (exact): `cortex-indexer-0.3.0-darwin-arm64.tar.gz` (+`.sha256`), `…-darwin-x64…`, `…-linux-x64…`, `…-linux-arm64…`.

- [ ] **Step 3: End-to-end check against cortex's fetcher** (CWD: cortex checkout)

```bash
cd /Users/rka/Development/cortex
rm -rf /tmp/fetch-verify && mkdir -p /tmp/fetch-verify
CORTEX_INDEXER_BASE_URL="https://github.com/ruevu/cortex-indexer/releases/download" \
  node -e "import('./scripts/fetch-indexer.mjs').then(async m => { const r = await m.fetchIndexer({ destDir: '/tmp/fetch-verify/bin', cacheDir: '/tmp/fetch-verify/cache' }); console.log(r); });"
/tmp/fetch-verify/bin/cortex-indexer --version
```
Expected: `{ installed: true, ... }` and `--version` prints `{"version":"0.3.0","schema":1,"protocol":1}`. This proves plan #2's fetcher + the release pipeline agree end-to-end, and that the `0.3.0` pin will resolve at cut-over with no pin change.

- [ ] **Step 4: Record completion**

Capture a cortex decision noting the repo + first release exist and the asset contract is verified (link to `D-chfd`):
```
search_decisions({ query: "indexer prebuilt release", repo_path: "/Users/rka/Development/cortex" })
# then create_decision or update D-chfd's resolution to mark plan #1 done.
```

---

## Self-Review (against the spec + plan #2's contract)

**Spec coverage:**
- Extraction (C-engine era, vendored pruned, rename to root) → Tasks B1, B2. *(Go-prototype graft has a documented fallback.)*
- Drop `cbm` Makefile alias → Task C1.
- Independent C CI matrix (4 native targets incl. `ubuntu-24.04-arm`) → Task E1; C-suite rehab explicitly deferred (baseline captured).
- Release pipeline producing the fetcher's exact asset contract → Task F1, verified G2.
- `--version` JSON the runtime guard needs → Task D1.
- Attribution stays with the derived code → Task G1 Step 1 (consistent with the spec's cut-over caveat).

**Contract consistency with plan #2 (`scripts/fetch-indexer.mjs`):** asset basename `cortex-indexer-<version>-<os>-<arch>.tar.gz` (Task F1 matches `assetNameFor`), tarball member `cortex-indexer` at root (F1 `tar -czf "$ASSET" cortex-indexer`), `.sha256` first-token hash (F1 `shasum -a 256` matches the fetcher's `.split(/\s+/)[0]`), `--version` JSON `.version` (D1 matches `ensureIndexer`), first tag `v0.3.0` matches the pin.

**Placeholder scan:** the only deliberate placeholder is `<FULL_SHA_OF_59d40d4>` in Task B1 Step 2 (the engineer fills it from A1 Step 3). The `ruevu` owner slug is flagged for user confirmation.

**Out of scope (carried to plan #3):** cortex history purge, postinstall flip, `ensureIndexer` wiring into `invokeIndexer`, the `TODO(cut-over)` legacy-tolerance narrowing, and the LICENSE/THIRD_PARTY attribution-removal decision **on the cortex side**.

**Open items:** confirm the `ruevu` owner + repo visibility (Task G1); whether to wire `CTX_DB_SCHEMA`/`CTX_CLI_PROTOCOL` to real values now or leave at `1` (left at `1` — `.version` is the only load-bearing field for plan #2).
