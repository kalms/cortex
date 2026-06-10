# Cortex Cut-Over & History Purge — Implementation Plan

> **For agentic workers:** Plan #3 of 3 for the indexer split (spec `docs/superpowers/specs/2026-06-10-cortex-indexer-repo-split-design.md`, decision `D-chfd`). **Hard prerequisite: plan #1 is complete** — `ruevu/cortex-indexer` exists and has published a verified **v0.3.0** release whose assets satisfy the fetcher contract. This plan flips cortex to consume the prebuilt binary, removes the in-tree C indexer, and rewrites cortex history to sever the `codebase-memory-mcp`/CBM lineage. The code phases (A–C) are TDD/verification-gated and reversible. The destructive phases (D attribution, E history purge) are **[USER]**-gated and irreversible without the backup bundle.

**Goal:** Make cortex a pure TypeScript/MCP project that fetches a prebuilt `cortex-indexer` at install, with the runtime version guard live, the in-tree C code gone, and no `codebase-memory-mcp`/CBM lineage left in working tree or history.

**Architecture:** Three reversible code steps (postinstall→fetcher, narrow `ensureIndexer` legacy-tolerance, wire `ensureIndexer` into `invokeIndexer`), then delete `internal/indexer/` + `scripts/build-indexer.sh`, then a one-time `git filter-repo --invert-paths internal/` history rewrite + force-push. The CBM/derived lineage in cortex's namespace lives entirely under `internal/` (verified), so the purge targets that single tree.

**Tech stack:** TypeScript/vitest (code phases), `git-filter-repo`, `gh` (branch-protection toggle), bash.

---

## Preconditions (gate — do not start until all true)

- [ ] **P1.** `gh release view v0.3.0 --repo ruevu/cortex-indexer` lists 4 tarballs + 4 `.sha256` (from plan #1, Task G2).
- [ ] **P2.** The fetcher end-to-end check (plan #1 Task G2 Step 3) returned `{installed:true}` and `--version` → `{"version":"0.3.0",...}`.
- [ ] **P3.** Working tree clean on `main`, suite green: `git status` clean, `npx vitest run` → all pass.
- [ ] **P4.** Fresh backup bundle: `git bundle create /tmp/cortex-precutover.bundle --all` (separate from the plan-#1 bundle; this one captures the merged consumption layer).

Create the working branch: `git checkout -b feature/api/indexer-cutover`.

---

## Phase B — Code cut-over (reversible, on the feature branch)

### Task B1: Flip postinstall to the fetcher

**File:** `package.json`

- [ ] **Step 1: Edit**

Change the `postinstall` script (keep the `fetch-indexer` alias for manual re-fetch):
```json
    "postinstall": "node scripts/fetch-indexer.mjs",
    "fetch-indexer": "node scripts/fetch-indexer.mjs",
```

- [ ] **Step 2: Verify a clean install fetches the prebuilt** (uses the real v0.3.0 release)

```bash
rm -f bin/cortex-indexer
node scripts/fetch-indexer.mjs
./bin/cortex-indexer --version
```
Expected: WARN-free install log; `--version` → `{"version":"0.3.0","schema":1,"protocol":1}`. (If offline, the soft-warn fires and exits 0 — that's the contract; re-run when online before proceeding.)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(indexer): postinstall fetches prebuilt binary (was build-indexer.sh)"
```

### Task B2: Narrow `ensureIndexer` legacy-tolerance (TDD)

**Files:** `src/indexer/binary.ts`, `tests/indexer/binary.test.ts`

The current `catch` (binary.ts:79-88) swallows ALL `--version` failures as "legacy." Now that the shipped binary emits JSON, narrow it: tolerate only **non-JSON / missing-field** output (a genuine legacy plaintext binary); **surface** spawn errors, non-zero exits, and timeouts (a broken binary).

- [ ] **Step 1: Write the failing test** (append inside `describe("ensureIndexer", …)` in `tests/indexer/binary.test.ts`)

Add a fake binary that exits non-zero on `--version` (near `fakeLegacyIndexer`, using the existing `trackedTmp` helper):
```ts
/** Fake indexer that crashes (exit 1) on --version. */
function fakeBrokenIndexer(): string {
  const dir = trackedTmp("fake-broken-");
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "boom" >&2; exit 1; fi\n`);
  chmodSync(bin, 0o755);
  return bin;
}
```
and the test:
```ts
  it("surfaces an error when --version fails to run (non-zero exit), not treated as legacy", async () => {
    const bin = fakeBrokenIndexer();
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true })).rejects.toThrow();
  });
```
The existing test "treats a non-JSON --version as a legacy binary and does not throw" must still pass (plaintext → tolerated).

- [ ] **Step 2: Run — confirm the new test fails**

Run: `npx vitest run tests/indexer/binary.test.ts -t "surfaces an error"`
Expected: FAIL — current code swallows the non-zero exit (resolves instead of rejecting).

- [ ] **Step 3: Narrow the catch** in `src/indexer/binary.ts` — replace lines 77-92 (the `if (shouldAssert) { … }` block) with:

```ts
  if (shouldAssert) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 }));
    } catch (e) {
      // The binary exists (accessSync passed) but failed to RUN --version:
      // spawn error, non-zero exit, or timeout. That's a broken binary, not a
      // legacy one — surface it rather than silently tolerating.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `cortex-indexer --version failed (${msg}). The binary may be corrupt; ` +
        `run \`npm run fetch-indexer\` to reinstall the pinned version.`,
      );
    }
    let reported: string | undefined;
    try {
      reported = (JSON.parse(stdout) as { version?: string }).version;
    } catch {
      reported = undefined; // non-JSON --version: a legacy/plaintext binary — tolerated.
    }
    if (reported && reported !== CORTEX_INDEXER_VERSION) {
      throw new IndexerVersionMismatchError(reported, CORTEX_INDEXER_VERSION);
    }
  }
```

- [ ] **Step 4: Run the full binary suite**

Run: `npx vitest run tests/indexer/binary.test.ts`
Expected: all pass — the new "surfaces an error" test plus the still-tolerated non-JSON legacy test plus the prior cache/mismatch/not-installed cases.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/binary.ts tests/indexer/binary.test.ts
git commit -m "feat(indexer): narrow ensureIndexer legacy-tolerance to non-JSON only; surface broken --version"
```

### Task B3: Wire `ensureIndexer` into `invokeIndexer` (TDD)

**Files:** `src/mcp-server/tools/code-tools.ts`, `tests/indexer/code-tools-binary.test.ts`

- [ ] **Step 1: Update the source-grep regression test** in `tests/indexer/code-tools-binary.test.ts` — the wiring symbol changes from `resolveIndexerBinary` to `ensureIndexer`:
```ts
  it("resolves the binary via the ensureIndexer guard", () => {
    expect(src).toContain("ensureIndexer");
  });
```

- [ ] **Step 2: Run — confirm it fails**

Run: `npx vitest run tests/indexer/code-tools-binary.test.ts`
Expected: FAIL — `code-tools.ts` does not yet contain `ensureIndexer`.

- [ ] **Step 3: Edit `code-tools.ts`**

Change the import (line 34) from:
```ts
import { resolveIndexerBinary } from "../../indexer/binary.js";
```
to:
```ts
import { ensureIndexer } from "../../indexer/binary.js";
```
Replace the head of `invokeIndexer` (line 327, `const binary = resolveIndexerBinary();`) so the guard runs and its errors become a structured response (preserving the MCP tool contract — never throw out of `invokeIndexer`):
```ts
  let binary: string;
  try {
    binary = await ensureIndexer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse("indexer_unavailable", msg);
  }
  try {
    const { stdout } = await execFileAsync(binary, ["cli", tool, JSON.stringify(args)], {
```
(The rest of `invokeIndexer` is unchanged. `ensureIndexer` is cached, so the `--version` check runs once per process, not per tool call.)

- [ ] **Step 4: Run tests + tsc + a live smoke**

```bash
npx vitest run tests/indexer tests/mcp-server
npx tsc --noEmit
```
Expected: all green; tsc clean (no dangling `resolveIndexerBinary`).
Then a live check that real indexer calls still work through the guard (the fetched v0.3.0 binary emits matching JSON):
```bash
node -e "import('./dist/mcp-server/tools/code-tools.js').catch(()=>{})" 2>/dev/null || true
# Functional smoke: run an actual indexed query via the CLI path if available, e.g.
./bin/cortex-indexer --version   # must equal the pin so ensureIndexer passes at runtime
```
Expected: `--version` matches `0.3.0`. (If `bin/cortex-indexer` is a stale local build emitting plaintext, `ensureIndexer` tolerates it as legacy — but re-fetch via `npm run fetch-indexer` to exercise the real assertion.)

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/indexer/code-tools-binary.test.ts
git commit -m "feat(indexer): wire ensureIndexer version guard into invokeIndexer"
```

---

## Phase C — Remove the in-tree C indexer

### Task C1: Delete `internal/indexer/` + `build-indexer.sh`; update doc refs

**Files:** `internal/indexer/` (delete), `scripts/build-indexer.sh` (delete), doc references.

- [ ] **Step 1: Verify `internal/` is CBM-exclusive before deleting** (cortex keeps nothing else there)

```bash
git ls-files internal/ | grep -v '^internal/indexer/' | head
```
Expected: NO output (everything under `internal/` is `internal/indexer/`). If anything else appears, STOP and report — the purge assumptions change.

- [ ] **Step 2: Remove the tree + the build script**

```bash
git rm -r internal/indexer
git rm scripts/build-indexer.sh
```

- [ ] **Step 3: Update doc references to build-indexer.sh** (non-spec/plan docs only)

In `docs/superpowers/2026-05-16-frame-extraction-phase-1.md:438`, replace the runnable command `CORTEX_FORCE_REBUILD=1 bash scripts/build-indexer.sh` with `npm run fetch-indexer   # downloads the prebuilt cortex-indexer`. Then grep for any other live build-indexer references in `CLAUDE.md` and `docs/architecture/`:
```bash
grep -rniE 'build-indexer|internal/indexer' CLAUDE.md docs/architecture/ | grep -v superpowers
```
Update any operational reference there to the fetch model. (Historical specs/plans under `docs/superpowers/` keep their references — they're a record.)

- [ ] **Step 4: Verify install + suite still green sourcing ONLY the prebuilt**

```bash
rm -f bin/cortex-indexer && node scripts/fetch-indexer.mjs && ./bin/cortex-indexer --version
npx vitest run
```
Expected: binary fetched (`0.3.0` JSON); full suite green. This proves cortex no longer needs the C source to build or test.

- [ ] **Step 5: Confirm the `cbm` code-gate is still clean post-removal** (now `internal/indexer` can't reintroduce it)

```bash
grep -rniI 'cbm' src/ scripts/ tests/ hooks/ bin/ package.json TEST.md --exclude-dir=.venv | grep -v node_modules
```
Expected: NO output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(indexer): remove in-tree C indexer + build-indexer.sh; cortex consumes prebuilt only"
```

---

## Phase D — [USER] Attribution + docs fork-name sweep

The MIT-derived C code now lives in `cortex-indexer`; the `codebase-memory-mcp` attribution moves there. Whether to remove it from cortex's `LICENSE`/`THIRD_PARTY.md` is a **legal judgment for the user** (per the spec's attribution caveat).

- [ ] **Step 1: [USER] Decide the attribution disposition.** Present the user with: cortex no longer contains `codebase-memory-mcp`-derived code (verified in Phase C), so its MIT attribution can move entirely to `cortex-indexer`. Options: (a) remove the `codebase-memory-mcp` stanza from cortex `LICENSE`/`THIRD_PARTY.md` and ensure `cortex-indexer` carries it (plan #1 retained it there); (b) keep a courtesy attribution in cortex. **Do not edit `LICENSE`/`THIRD_PARTY.md` without the user's explicit choice.**

- [ ] **Step 2: Apply the chosen disposition** to `LICENSE` and `THIRD_PARTY.md`.

- [ ] **Step 3: Sweep remaining fork-name residue in non-historical docs.** `TEST.md:102` (`~/.cache/codebase-memory-mcp/`) and any other current-doc (not `docs/superpowers/` history, not the split spec) references to `codebase-memory-mcp`/`code-graph-mcp`. Reword to the indexer/cortex model. Verify:
```bash
grep -rniE 'codebase-memory-mcp|code-graph-mcp' README.md TEST.md CLAUDE.md docs/architecture/ | grep -v superpowers
```
Expected after edits: only legally-intended attribution remains (per Step 1), nothing else.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: move codebase-memory-mcp attribution to cortex-indexer; scrub residual fork-name refs"
```

---

## Phase E — [USER] History purge + force-push (destructive, irreversible)

Rewrites every commit SHA. **Requires the Phase P4 backup, user confirmation, and temporarily relaxing branch protection.**

### Task E1: Rewrite history to remove the CBM lineage

**CWD:** a fresh scratch clone (filter-repo requires it).

- [ ] **Step 1: Land Phases B–D first.** Merge `feature/api/indexer-cutover` into `main` (`--no-ff`), suite green, BEFORE rewriting — so the rewrite operates on the final pre-purge `main`. (Do not push yet if you want to inspect the rewrite first.)

- [ ] **Step 2: Determine the full purge path set** (in the cortex checkout)

```bash
# internal/ is the CBM/derived home (verified C1 Step 1).
echo "internal/"
# Did root-level Go-era paths ever exist in THIS repo's namespace? (--full-history defeats simplification)
git log --all --full-history --oneline -- cmd go.mod go.sum | head
```
If the `git log` finds commits, add `cmd/ go.mod go.sum` to the purge set; if it finds none (expected — the Go prototype was imported under `internal/`), the purge set is just `internal/`. Record the final set.

- [ ] **Step 3: Fresh clone + filter-repo**

```bash
rm -rf /tmp/cortex-purge && git clone /Users/rka/Development/cortex /tmp/cortex-purge
cd /tmp/cortex-purge
git filter-repo --invert-paths --path internal/ [--path cmd/ --path go.mod --path go.sum]   # bracketed only if Step 2 found them
```
Expected: filter-repo rewrites history; `internal/` (and the 693M vendored blobs it carried) is gone from all commits.

- [ ] **Step 4: Inspect the rewrite BEFORE pushing** (verification gate)

```bash
cd /tmp/cortex-purge
test ! -d internal && echo "internal/ gone from tree"
du -sh .git                                   # should be dramatically smaller than the original ~93M packed
git log --oneline | tail -3                   # history intact for the TS/cortex work
git ls-files | grep -E '^(src|tests|docs|scripts)/' | head   # cortex's kept files present
# Critical: confirm cortex's own files were NOT collaterally removed
test -f package.json && test -d src/indexer && test -f scripts/fetch-indexer.mjs && echo "cortex tree intact"
npm ci && npx vitest run                      # full suite green on the rewritten clone (postinstall fetches the prebuilt)
```
Expected: `internal/` gone, `.git` much smaller, cortex tree + suite intact. **If anything cortex-owned is missing, ABORT** — do not push; restore from the backup bundle.

- [ ] **Step 5: [USER] Force-push the rewritten history**

This breaks all existing clones/permalinks. **Get explicit user confirmation.** The user must temporarily allow force-push on `main` (GitHub branch protection):
```bash
cd /tmp/cortex-purge
git remote -v                                 # confirm origin = ruevu/cortex
git push --force origin main
```
Then the user re-enables branch protection. Everyone re-clones; the local `/Users/rka/Development/cortex` checkout should be re-cloned or hard-reset to the new `origin/main`.

- [ ] **Step 6: Re-point any raw-SHA references.** Decision links survive (qn/path + PR-number keyed). Scan for decisions/docs citing pre-rewrite commit SHAs and update:
```bash
search_decisions({ query: "commit", repo_path: "/Users/rka/Development/cortex" })
```

---

## Phase F — Finalize

- [ ] **F1.** Re-clone or hard-reset the canonical checkout to the rewritten `origin/main`; reindex: `index_repository({ repo_path, mode: "full" })`.
- [ ] **F2.** Update decision `D-chfd`'s resolution (via `update_decision`) to mark all three plans complete; optionally capture a short cut-over decision linking `D-chfd` and recording the force-push date + the new `.git` size.
- [ ] **F3.** Update `CLAUDE.md`: the graph-storage / indexer sections that describe the in-tree build model should now describe the prebuilt-fetch model (postinstall → `fetch-indexer.mjs`, `CORTEX_INDEXER_VERSION` pin, `ensureIndexer` guard, `cortex-indexer` repo). Commit.
- [ ] **F4.** Final gates:
```bash
grep -rniI 'cbm' src/ scripts/ tests/ hooks/ bin/ package.json TEST.md --exclude-dir=.venv | grep -v node_modules   # empty
test ! -d internal/indexer && echo "in-tree indexer gone"
npx vitest run                                                                                                       # green
```

---

## Self-Review (against spec + plans #1/#2)

**Spec coverage:**
- Flip postinstall to fetch → B1. Wire the runtime version guard → B3. Narrow legacy-tolerance (`TODO(cut-over)`) → B2.
- Remove `internal/indexer/` so installs are toolchain-free → C1; the `cbm` gate stays clean → C1 Step 5 / F4.
- LICENSE/THIRD_PARTY attribution decision (legal, user-gated) → D1; docs fork-name sweep → D3.
- History purge severing the CBM lineage + shedding vendored blobs, with backup + inspection gate + force-push → E1; SHAs rewritten, decision links survive (qn/path + PR number) → E1 Step 6.

**Dependencies & ordering:** Preconditions gate on plan #1's v0.3.0 release. Code phases B–C are reversible and land on `main` before the irreversible purge (E). The purge runs on a fresh clone and is inspected before any push.

**Reversibility / safety:** two backup bundles (P4 here + plan #1's), an explicit pre-push inspection gate (E1 Step 4) that aborts on collateral loss, and user confirmation for both the attribution edit and the force-push.

**Risk notes:** (1) force-push breaks clones/permalinks — accepted, recorded in `D-chfd`. (2) The purge path set is verified empirically (E1 Step 2) rather than assumed; `internal/` is the confirmed CBM home. (3) After Phase C the only binary source is the fetched prebuilt — if the v0.3.0 release is unavailable, installs soft-warn and first use raises `indexer_unavailable`; this is the intended degraded behavior, not a regression.

**Open items:** the attribution disposition (D1) is the user's call; the `cmd/go.mod/go.sum` purge inclusion is decided empirically at E1 Step 2.
