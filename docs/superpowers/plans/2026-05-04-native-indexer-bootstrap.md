# Native Indexer Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish CBM as an internal subsystem of Cortex — pull CBM's source under `internal/cbm/` via `git subtree add`, replace the GitHub-release-download install path with a local build, and ship a `bin/cortex-indexer` artifact built from source on `npm install`.

**Architecture:** Two phases. Phase 1 absorbs CBM source preserving its git history; the result is `internal/cbm/` containing 45k LOC of C plus vendored deps, buildable via its existing `Makefile.cbm`. Phase 2 wires that build into Cortex's `npm install`: a new `scripts/build-indexer.sh` invokes CBM's Makefile and produces `bin/cortex-indexer`; the old `scripts/install-cbm.sh` (GitHub release download) and the committed `bin/codebase-memory-mcp` Mach-O binary are removed. After this plan, Cortex still uses the existing MCP tool path with subprocess invocation, but the binary it spawns is locally built and we own its source.

**Tech Stack:** git (subtree), bash, GNU make, npm postinstall, TypeScript (existing Cortex code untouched in this plan), C (CBM's existing build, untouched in this plan).

---

## Spec reference

`docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md` — this plan implements §3 Steps 1–2. Phases 3–8 (storage retarget, schema fold, v0.2 migration, MCP shell strip, repo-root cortex.db + cache, final cleanup) get their own plans after this one merges.

## File structure

**Before this plan:**
```
cortex/
├── bin/codebase-memory-mcp          # downloaded Mach-O binary, committed
├── scripts/install-cbm.sh           # GitHub release download script
├── package.json                     # postinstall: bash scripts/install-cbm.sh
└── (no internal/cbm/)
```

**After this plan:**
```
cortex/
├── internal/cbm/                    # ← from git subtree add
│   ├── src/                         #   CBM C source (45k LOC)
│   ├── vendored/                    #   tree-sitter, sqlite3, yyjson, ...
│   ├── tools/                       #   tree-sitter-form, tree-sitter-magma
│   ├── tests/                       #   CBM's 2586-test suite
│   └── Makefile.cbm                 #   CBM's build rules
├── bin/
│   ├── .gitignore                   # ← new: ignore cortex-indexer artifact
│   └── (cortex-indexer)             #   built locally by postinstall
├── scripts/build-indexer.sh         # ← new
├── package.json                     # postinstall: bash scripts/build-indexer.sh
└── (no scripts/install-cbm.sh, no bin/codebase-memory-mcp)
```

## Branch context

This plan executes on `feature/api/native-indexer` (already created at the start of the session). Each task ends in a commit. After Phase 2 completes, the branch is ready for code review (Gate 1 per `.claude/rules/workflow.md`) but stays open — Phase 3+ continues on the same branch in subsequent plans.

---

## Phase 1 — Subtree merge

Goal of this phase: `internal/cbm/` exists, CBM source is buildable in-place via its own Makefile, CBM's tests pass.

### Task 1.1: Verify prerequisites

**Files:** none modified

- [ ] **Step 1: Verify CBM working tree is clean**

Run:
```bash
cd ../codebase-memory-mcp && git status -sb
```

Expected output: `## <branch>` followed only by untracked items (e.g. `?? HANDOFF.md`). No `M ` (modified-tracked) or `A ` (staged) entries. If modified-tracked files exist, stop and ask the user how to handle them.

- [ ] **Step 2: Identify which CBM branch to import from**

Run:
```bash
cd ../codebase-memory-mcp && git log --oneline main..feature/sfc-extraction | head -10
```

Expected: 5 commits relating to Vue/Svelte SFC extraction (the work the user mentioned: "We added Vue/Svelte/nuxt to CBM"). Confirm with the user: import from `feature/sfc-extraction` (recommended, includes latest SFC work) or from `main` (more stable but missing SFC fixes). The plan assumes `feature/sfc-extraction` — adjust the subtree command in Task 1.2 if the user picks `main`.

- [ ] **Step 3: Verify Cortex working tree is on the right branch**

Run from cortex root:
```bash
git branch --show-current && git status -sb
```

Expected: `feature/api/native-indexer`, status only showing untracked items (`.tmp/`, `.DS_Store`, etc.) and the existing `docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md` already committed. No staged or modified files.

- [ ] **Step 4: Verify nothing under `internal/cbm/` exists yet**

Run:
```bash
test -d internal/cbm && echo "EXISTS — STOP" || echo "absent — ok to proceed"
```

Expected: `absent — ok to proceed`. If `EXISTS — STOP`, stop and investigate before proceeding.

### Task 1.2: Add CBM as subtree

**Files:** creates `internal/cbm/` (and many files within); modifies `.git/` state

- [ ] **Step 1: Add CBM as a remote**

Run from cortex root:
```bash
git remote add cbm-source ../codebase-memory-mcp
git fetch cbm-source
```

Expected: `cbm-source` appears in `git remote -v` (twice, for fetch+push); fetch reports objects fetched.

- [ ] **Step 2: Run subtree add**

Run from cortex root:
```bash
git subtree add --prefix=internal/cbm cbm-source feature/sfc-extraction
```

Expected output ends with: `Added dir 'internal/cbm'`. The command also produces a merge commit on `feature/api/native-indexer`. (If user chose `main` in Task 1.1 Step 2, replace `feature/sfc-extraction` with `main`.)

- [ ] **Step 3: Verify subtree contents**

Run:
```bash
ls internal/cbm/
test -d internal/cbm/src && test -d internal/cbm/vendored && test -f internal/cbm/Makefile.cbm && echo "structure ok"
```

Expected: directory listing shows `src/`, `vendored/`, `tests/`, `tools/`, `internal/`, `docs/`, etc. Final line: `structure ok`.

- [ ] **Step 4: Verify history was preserved**

Run:
```bash
git log --oneline internal/cbm/ | head -5
```

Expected: at least 5 commits, including the SFC commits (`fix(sfc): correct template extraction`, `test(sfc): add 18 comprehensive`, `feat(sfc): implement Vue/Svelte SFC`, etc.). If only one commit shows, the subtree didn't preserve history — investigate before continuing.

- [ ] **Step 5: Remove the cbm-source remote**

Run:
```bash
git remote remove cbm-source
git remote -v
```

Expected: `origin` is the only remote remaining.

- [ ] **Step 6: Commit the subtree state explicitly (no-op if subtree already created a commit)**

The `git subtree add` command in Step 2 created the commit itself. Verify:
```bash
git log -1 --oneline
```

Expected: a commit titled like `Add 'internal/cbm/' from commit 'XYZ'` or similar subtree-add format. If not, run:
```bash
git status -sb
```
and confirm the tree is clean. No additional commit needed at this point.

### Task 1.3: Verify CBM builds in place

**Files:** none modified — invoking CBM's existing build

- [ ] **Step 1: Check build prerequisites**

Run:
```bash
which make cc && cc --version | head -1
```

Expected: paths for both, and a clang or gcc version line. If either is missing, install Xcode Command Line Tools (`xcode-select --install`) on macOS; `apt install build-essential` on Linux.

- [ ] **Step 2: Build the indexer (production target)**

Run from cortex root:
```bash
make -f internal/cbm/Makefile.cbm cbm
```

Expected: build runs; on a clean tree this takes ~30–90 seconds depending on machine. Final output is a binary at `internal/cbm/cbm` (or whatever the Makefile produces — check the Makefile's `cbm:` rule for the output path).

- [ ] **Step 3: Verify the binary works**

Run:
```bash
internal/cbm/cbm --help 2>&1 | head -20
```

Expected: usage text mentioning subcommands like `cli`, `mcp`, etc. Non-zero exit is fine — `--help` may be unsupported; what we want is the binary loading and producing some output, not segfaulting.

- [ ] **Step 4: Smoke-test indexing on a small directory**

Run:
```bash
mkdir -p .tmp/cbm-smoke && cd .tmp/cbm-smoke
echo 'export function hello() { return "world" }' > test.ts
../../internal/cbm/cbm cli index_repository '{"repo_path":"."}'
ls ~/.cache/codebase-memory-mcp/ 2>/dev/null && cd ../..
```

Expected: indexing reports success; a `.db` file appears in `~/.cache/codebase-memory-mcp/`. The exact filename depends on CBM's project-naming logic. (This is the legacy CBM cache location — Phase 7 retargets it; for now we're confirming the binary works.)

- [ ] **Step 5: Run CBM's existing test suite**

Run:
```bash
make -f internal/cbm/Makefile.cbm test 2>&1 | tail -30
```

Expected: most or all of CBM's 2586 tests pass. Some platform-specific tests may skip; document any failures but don't block the plan unless a large fraction fail. If >5% fail, stop and surface to the user — the subtree may not have captured the full source tree.

- [ ] **Step 6: Clean build artifacts (commit hygiene)**

Run:
```bash
make -f internal/cbm/Makefile.cbm clean-c 2>/dev/null || rm -f internal/cbm/cbm internal/cbm/cbm-test* internal/cbm/build/*.o 2>/dev/null
git status -sb | head -10
```

Expected: working tree clean (no untracked artifacts under `internal/cbm/`). If there are untracked build artifacts, decide per-file whether to add to a `.gitignore` (Task 2.4 covers this).

### Task 1.4: Commit Phase 1 milestone

**Files:** none new (the subtree-add commit from Task 1.2 already exists)

- [ ] **Step 1: Verify history is in good shape**

Run:
```bash
git log --oneline feature/api/native-indexer ^main | head -10
```

Expected: shows the spec commit (`docs(spec): native indexer — CBM absorption design`), the spec-revisions commit, and the subtree-add commit (likely a merge commit titled like `Add 'internal/cbm/' from commit 'XYZ'`). No stray commits.

- [ ] **Step 2: Tag the Phase 1 boundary (optional but useful)**

Run:
```bash
git tag -a phase-1-subtree-merged -m "Phase 1: CBM source absorbed via subtree add"
```

Expected: tag created locally. Leave un-pushed.

---

## Phase 2 — Build pipeline integration

Goal of this phase: `npm install` builds `bin/cortex-indexer` from `internal/cbm/`. The downloaded Mach-O binary at `bin/codebase-memory-mcp` and the GitHub-release download script `scripts/install-cbm.sh` are both removed. Cortex's existing MCP code-tools path continues to work (it's still spawning a binary; only the binary's source has changed).

### Task 2.1: Confirm CBM Makefile build characteristics

**Files:** read-only

> **Phase 1 finding:** `internal/cbm/Makefile.cbm` is NOT relocatable — its rules use paths relative to its own directory (e.g. `MAIN_SRC = src/main.c`). It must be invoked with `cd internal/cbm && make -f Makefile.cbm <target>`. Running `make -f internal/cbm/Makefile.cbm cbm` from cortex root fails with "No rule to make target `src/main.c`".
>
> Phase 1 also confirmed: the `cbm` Makefile target produces a binary named `codebase-memory-mcp` (not `cbm`) at `internal/cbm/build/c/codebase-memory-mcp`. ~169 MB. The `cbm` target name and the `codebase-memory-mcp` output filename are CBM's existing conventions; we don't change them inside `internal/cbm/`.

- [ ] **Step 1: Confirm output path**

```bash
cd /Users/rka/Development/cortex
(cd internal/cbm && make -f Makefile.cbm cbm 2>&1 | tail -5)
ls -lh internal/cbm/build/c/codebase-memory-mcp
```

Expected: build runs (or "up to date" if unchanged); binary at `internal/cbm/build/c/codebase-memory-mcp` exists, ~150–200 MB, executable.

- [ ] **Step 2: Verify `make cbm` is idempotent**

Run twice from cortex root:
```bash
(cd internal/cbm && make -f Makefile.cbm cbm) | tail -2
(cd internal/cbm && make -f Makefile.cbm cbm) | tail -2
```

Expected: second invocation reports `make: Nothing to be done for 'cbm'.` or near-instant. Confirms the build script's skip-rebuild logic is needed only as a belt-and-suspenders.

- [ ] **Step 3: Identify CBM's clean target**

```bash
grep -nE "^[a-z][a-z_-]*clean" internal/cbm/Makefile.cbm | head -5
```

Expected: `clean-c` target exists (Phase 1 used it; it removes `internal/cbm/build/c/`).

### Task 2.2: Write `scripts/build-indexer.sh`

**Files:** Create `scripts/build-indexer.sh`

- [ ] **Step 1: Create the script**

Write to `scripts/build-indexer.sh`:

```bash
#!/usr/bin/env bash
# build-indexer.sh — Builds the native indexer (CBM) from internal/cbm/ and
# installs the resulting binary at bin/cortex-indexer. Invoked by npm postinstall.
#
# CBM's Makefile is not relocatable: rules reference src/ paths relative to
# the Makefile's own directory. We cd into internal/cbm/ to invoke it. The
# Makefile's `cbm` target produces a binary named `codebase-memory-mcp` at
# build/c/codebase-memory-mcp; we copy it to bin/cortex-indexer for Cortex.
#
# Skips the build if bin/cortex-indexer is already present and newer than
# anything in internal/cbm/src/ or the Makefile. Set CORTEX_FORCE_REBUILD=1
# to override.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEXER_SRC="$ROOT/internal/cbm"
INDEXER_BUILD="$INDEXER_SRC/build/c/codebase-memory-mcp"
INDEXER_DEST="$ROOT/bin/cortex-indexer"
MAKE_TARGET="cbm"

# Skip path: binary exists, no force, and no source file is newer than the binary
if [ -z "${CORTEX_FORCE_REBUILD:-}" ] && [ -x "$INDEXER_DEST" ]; then
  if ! find "$INDEXER_SRC/src" "$INDEXER_SRC/Makefile.cbm" \
        -newer "$INDEXER_DEST" -print -quit 2>/dev/null | grep -q .; then
    echo "cortex-indexer up to date at $INDEXER_DEST"
    exit 0
  fi
fi

# Build prerequisites
for tool in make cc; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found in PATH" >&2; exit 1; }
done

mkdir -p "$ROOT/bin"

echo "Building cortex-indexer from internal/cbm/ ..."
# Must invoke the Makefile from inside internal/cbm/ — its rules use
# Makefile-relative paths and don't tolerate -f from a parent directory.
(cd "$INDEXER_SRC" && make -f Makefile.cbm "$MAKE_TARGET")

if [ ! -x "$INDEXER_BUILD" ]; then
  echo "error: build succeeded but expected binary not found" >&2
  echo "expected: $INDEXER_BUILD" >&2
  exit 1
fi

cp "$INDEXER_BUILD" "$INDEXER_DEST"
chmod +x "$INDEXER_DEST"
echo "cortex-indexer installed at $INDEXER_DEST"
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x scripts/build-indexer.sh
ls -l scripts/build-indexer.sh
```

Expected: `-rwxr-xr-x` permissions visible.

- [ ] **Step 3: Smoke-test the script standalone**

Run:
```bash
rm -f bin/cortex-indexer
bash scripts/build-indexer.sh
ls -l bin/cortex-indexer
```

Expected: script reports `Building cortex-indexer ...`, then `cortex-indexer installed at .../bin/cortex-indexer`. The binary exists and is executable.

- [ ] **Step 4: Test the skip path**

Run:
```bash
bash scripts/build-indexer.sh
```

Expected: `cortex-indexer up to date at .../bin/cortex-indexer`. Near-instant; no rebuild.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-indexer.sh
git commit -m "feat(build): scripts/build-indexer.sh — builds indexer from internal/cbm/

Skip-rebuild path: binary present + no source newer than binary. Override via
CORTEX_FORCE_REBUILD=1. Locates produced binary in candidate paths (Makefile
may output to internal/cbm/cbm or build/cbm or bin/cbm).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Update `package.json` postinstall

**Files:** Modify `package.json`

- [ ] **Step 1: Read current postinstall**

Run:
```bash
grep -n "postinstall\|install-cbm" package.json
```

Expected: shows `"postinstall": "bash scripts/install-cbm.sh"` in the `scripts` block.

- [ ] **Step 2: Apply the edit**

Use the Edit tool to change `"postinstall": "bash scripts/install-cbm.sh"` to `"postinstall": "bash scripts/build-indexer.sh"`.

Verify:
```bash
grep -n "postinstall" package.json
```

Expected: `"postinstall": "bash scripts/build-indexer.sh"`.

- [ ] **Step 3: Test the new postinstall via npm**

Run:
```bash
rm -f bin/cortex-indexer
npm run postinstall
ls -l bin/cortex-indexer
```

Expected: build runs, binary appears at `bin/cortex-indexer`, executable.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: postinstall builds indexer locally instead of downloading

Replaces 'bash scripts/install-cbm.sh' (GitHub release download) with
'bash scripts/build-indexer.sh' (local make-based build from internal/cbm/).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: Add `bin/.gitignore` for the built artifact

**Files:** Create `bin/.gitignore`

- [ ] **Step 1: Create the gitignore**

Write to `bin/.gitignore`:

```
# Built indexer — produced by scripts/build-indexer.sh during npm install
cortex-indexer
```

- [ ] **Step 2: Verify the binary is now ignored**

Run:
```bash
git check-ignore -v bin/cortex-indexer
```

Expected: `bin/.gitignore:2:cortex-indexer	bin/cortex-indexer` (showing the ignore rule that matches).

- [ ] **Step 3: Commit**

```bash
git add bin/.gitignore
git commit -m "build: gitignore the locally-built bin/cortex-indexer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.5: Remove the old downloaded binary and download script

**Files:** Delete `bin/codebase-memory-mcp`, delete `scripts/install-cbm.sh`

- [ ] **Step 1: Verify these files are no longer needed**

Run:
```bash
grep -rn "codebase-memory-mcp\|install-cbm" src/ scripts/ package.json | grep -v "internal/cbm" | head -20
```

Expected: only references should be (a) the binary path resolution in `src/mcp-server/tools/code-tools.ts` (which references `bin/codebase-memory-mcp` — we'll fix this in Task 2.6), (b) string literals in tests/docs (handled in later cleanup phases).

- [ ] **Step 2: Delete the binary**

Run:
```bash
git rm bin/codebase-memory-mcp
ls bin/
```

Expected: `bin/codebase-memory-mcp` removed from index; `bin/.gitignore` is the only tracked file in `bin/` (the built `cortex-indexer` is gitignored).

- [ ] **Step 3: Delete the install script**

Run:
```bash
git rm scripts/install-cbm.sh
ls scripts/
```

Expected: `scripts/install-cbm.sh` is gone. `scripts/build-indexer.sh` remains.

- [ ] **Step 4: Commit**

```bash
git commit -m "build: remove old GitHub-release-download path

- bin/codebase-memory-mcp (committed Mach-O binary) — gone
- scripts/install-cbm.sh (release-asset downloader) — gone

Replaced by scripts/build-indexer.sh + internal/cbm/ source tree.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.6: Update Cortex TS to point at the new binary path

**Files:** Modify `src/mcp-server/tools/code-tools.ts`

- [ ] **Step 1: Read the existing binary-resolution code**

Read [src/mcp-server/tools/code-tools.ts:23-25](src/mcp-server/tools/code-tools.ts#L23-L25):

Expected current code:
```typescript
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_CBM = join(__dirname, "..", "..", "..", "bin", "codebase-memory-mcp");
const CBM_BINARY = process.env.CBM_BINARY_PATH || (existsSync(LOCAL_CBM) ? LOCAL_CBM : "codebase-memory-mcp");
```

- [ ] **Step 2: Edit the constant names and path**

Use the Edit tool. Change:

```typescript
const LOCAL_CBM = join(__dirname, "..", "..", "..", "bin", "codebase-memory-mcp");
const CBM_BINARY = process.env.CBM_BINARY_PATH || (existsSync(LOCAL_CBM) ? LOCAL_CBM : "codebase-memory-mcp");
```

To:

```typescript
const LOCAL_INDEXER = join(__dirname, "..", "..", "..", "bin", "cortex-indexer");
const INDEXER_BINARY = process.env.CORTEX_INDEXER_PATH || process.env.CBM_BINARY_PATH || LOCAL_INDEXER;
```

(The fallback to a PATH-resolvable `codebase-memory-mcp` is removed — we always use the local build now. `CBM_BINARY_PATH` is kept for backwards compat with users who set it; it will be deprecated in Phase 8 cleanup.)

- [ ] **Step 3: Update references to the old constant name**

Run:
```bash
grep -n "CBM_BINARY\b" src/mcp-server/tools/code-tools.ts
```

Expected: each `CBM_BINARY` reference. Use Edit's `replace_all: true` to change `CBM_BINARY` → `INDEXER_BINARY` in this file.

Verify:
```bash
grep -n "CBM_BINARY\|INDEXER_BINARY" src/mcp-server/tools/code-tools.ts
```

Expected: only `INDEXER_BINARY` references; no `CBM_BINARY` remaining (other than the env var name in the line we just wrote, kept for backwards compat).

- [ ] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: no errors. If errors, the rename missed a spot.

- [ ] **Step 5: Run Cortex's existing test suite**

Run:
```bash
npm test 2>&1 | tail -30
```

Expected: tests pass (existing 179+). The `mcp-contract` tests in particular exercise the indexer binary path; if they pass, the binary swap is working end-to-end.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts
git commit -m "refactor(mcp): point code tools at bin/cortex-indexer

LOCAL_CBM → LOCAL_INDEXER, CBM_BINARY → INDEXER_BINARY. CORTEX_INDEXER_PATH
env var added; CBM_BINARY_PATH kept as fallback for backwards compat
(deprecated, removed in Phase 8 cleanup).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.7: Update README's CBM Integration section

**Files:** Modify `README.md`

- [ ] **Step 1: Locate the CBM Integration section**

Run:
```bash
grep -n "## CBM Integration\|CBM_BINARY_PATH\|codebase-memory-mcp" README.md | head -20
```

Expected: lines with the section heading, env var docs, and binary references.

- [ ] **Step 2: Update the section heading and download language**

Read the existing section (use the Read tool on README.md, focusing on the CBM Integration block — likely 30–60 lines). Replace it with content reflecting the new architecture:

- Section heading: "Native Indexer" instead of "CBM Integration"
- Replace download language ("downloads on npm install") with build language ("builds locally on npm install via internal/cbm/")
- Update env var table: `CBM_BINARY_PATH` → `CORTEX_INDEXER_PATH` (mention `CBM_BINARY_PATH` as deprecated fallback)
- Add: "the indexer source lives at internal/cbm/, absorbed from kalms/codebase-memory-mcp via git subtree on 2026-05-04"

The exact replacement text depends on the current section's structure. Preserve the surrounding sections.

- [ ] **Step 3: Verify references are consistent**

Run:
```bash
grep -n "codebase-memory-mcp\|CBM_BINARY" README.md | head -10
```

Expected: only references in (a) historical notes about the absorption, (b) the deprecated env var note. No remaining "download" or "GitHub release" references for the binary.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): update CBM Integration → Native Indexer section

Reflects post-absorption reality: source under internal/cbm/, built locally
on npm install. CORTEX_INDEXER_PATH replaces CBM_BINARY_PATH (kept as deprecated
backwards-compat fallback).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.8: End-to-end smoke test

**Files:** none modified — verifying the system works

- [ ] **Step 1: Clean rebuild from scratch**

Run:
```bash
rm -f bin/cortex-indexer
(cd internal/cbm && make -f Makefile.cbm clean-c) 2>/dev/null || true
npm install --ignore-scripts
npm run postinstall
ls -l bin/cortex-indexer
```

Expected: build runs (~30–90s), binary appears at `bin/cortex-indexer`. `--ignore-scripts` on `npm install` plus an explicit `npm run postinstall` ensures we exercise the build path even if no deps actually need installing.

- [ ] **Step 2: Run the full Cortex test suite**

Run:
```bash
npm test 2>&1 | tail -50
```

Expected: all tests pass. The `mcp-contract` tests exercise the indexer subprocess; their passing confirms the new binary works as a drop-in replacement.

- [ ] **Step 3: Run a real index against the Cortex repo**

Run:
```bash
node --experimental-vm-modules -e '
import("./dist/index.js").catch(e => { console.error(e); process.exit(1); });
' 2>&1 | head -10 &
SERVER_PID=$!
sleep 3
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
```

(If `dist/index.js` doesn't exist yet because the build hasn't been run, run `npm run build` first.)

Better alternative — invoke the indexer directly:

```bash
mkdir -p .tmp/postbuild-smoke && cd .tmp/postbuild-smoke
echo 'export function bootstrap() { return 1 }' > test.ts
../../bin/cortex-indexer cli index_repository '{"repo_path":"."}'
ls ~/.cache/codebase-memory-mcp/ | head -5
cd ../..
```

Expected: indexing reports success; the legacy CBM cache file gets created. (Phase 7 retargets this to `~/.cache/cortex/`; for now we're just confirming the binary works.)

- [ ] **Step 4: Run code review (Gate 1 per workflow.md)**

Per `.claude/rules/workflow.md` Gate 1: before marking the phase complete, run `/review` on all files changed since branching from main:

```bash
git diff main --name-only
```

Then trigger `/review` (manual user step). Address any **critical** findings; document **warnings** but don't block.

- [ ] **Step 5: Tag the Phase 2 boundary**

Run:
```bash
git tag -a phase-2-build-pipeline -m "Phase 2: local build pipeline; cortex-indexer built from internal/cbm/"
```

---

## Self-review checklist (against spec §3 Steps 1–2)

After completing all tasks above, verify:

- [ ] Spec §3 Step 1 "Subtree merge" — Phase 1 covers it (Tasks 1.1–1.4). ✓
- [ ] Spec §3 Step 1 validation: `make -f internal/cbm/Makefile.cbm test` passes — Task 1.3 Step 5. ✓
- [ ] Spec §3 Step 2 "Build pipeline integration" — Phase 2 covers it (Tasks 2.1–2.8). ✓
- [ ] Spec §3 Step 2 validation: fresh clone + `npm install` produces a working `bin/cortex-indexer` — Task 2.8 Step 1. ✓
- [ ] Spec G1 (CBM under `internal/cbm/` with full git history) — Task 1.2 Steps 2 & 4. ✓
- [ ] Spec G7 (`bin/codebase-memory-mcp`, `scripts/install-cbm.sh`, `~/.cache/codebase-memory-mcp/` discovery — gone) — Task 2.5. The `~/.cache/codebase-memory-mcp/` discovery code (`src/graph/cbm-discovery.ts`) is **NOT** removed in this plan — that's Phase 5 (v0.2 migration) territory. Goal G7 is partially achieved here; `cbm-discovery.ts` still exists as legacy code until Phase 5.
- [ ] Spec G9 (`npm install` builds the indexer locally — no GitHub release fetch) — Task 2.3 Step 3 + Task 2.8 Step 1. ✓

## Out of scope for this plan (deferred to subsequent plans)

- Spec §3 Step 3: Indexer storage retarget (CORTEX_DB env, single-file mode in CBM's storage)
- Spec §3 Step 4: Schema fold (cbm_ table prefix → unified nodes/edges)
- Spec §3 Step 5: v0.2 migration shim
- Spec §3 Step 6: Strip CBM's MCP shell + bridge missing tools
- Spec §3 Step 7: Repo-root cortex.db + cache layer
- Spec §3 Step 8: Final cleanup (rename TS symbols, remove cbm-discovery.ts, delete cbm-attach test)

Each of those phases gets its own plan. Don't bundle them — the spec deliberately split them as merge boundaries.
