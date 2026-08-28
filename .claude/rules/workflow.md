# Development Workflow — Branching, Review & QA Gates
---

## Branch-first rule

Never commit directly to `main`. At the start of every session:

1. Run `git branch --show-current`
2. If on `main`, create a new branch before making any file modifications
3. Pull latest `main` if remote has changes: `git pull origin main`

### Branch naming convention

```
feature/<scope>/<short-description>   — new capability or component
fix/<scope>/<short-description>       — bug fix (visual, functional, or config)
refactor/<scope>/<short-description>  — restructuring without behavior change
docs/<description>                    — documentation only
```

**Scope** is one of: `component`, `page`, `api`, `store`, `config`, `layout`, `css`, `db`.

Examples:

- `feature/page/ds-variables`
- `feature/api/ds-patch-meta`
- `fix/css/dark-mode-border`
- `fix/api/colors-put-transaction`
- `refactor/store/foundation-factory`
- `db/add-format-channels`

### Commit discipline

- Atomic commits — one logical change per commit
- Message format: `<type>(<scope>): <description>`
  - e.g. `feat(page): add variables foundation page`
  - e.g. `fix(api): handle missing dsId in colors PUT`
- Verify with `git diff --stat` before committing

---

## Worktree-first rule (features, fixes, refactors)

Every new **feature, fix, or refactor** MUST be developed in a dedicated git
**worktree**, created *before* any file modification — not merely a branch in
the main checkout. A worktree isolates in-progress work from the main checkout
(which may hold unrelated uncommitted edits) and lets independent efforts run
without colliding.

```bash
git worktree add -b <type>/<scope>/<desc> ../cortex-wt-<desc> main
cd ../cortex-wt-<desc>
```

Use the branch naming convention above. When the work has merged, remove the
worktree: `git worktree remove ../cortex-wt-<desc>` then `git worktree prune`.

**Exempt** (a plain branch — or a direct edit on a `docs/` branch — suffices):
documentation-only, memory, and one-off chore/CI edits that touch no `src/` or
`tests/`. When in doubt, use a worktree.

---

## Gate 0 — Visual QA before code review (for any UI-visible change)

**Rule:** Every UI-visible change must pass a visual QA pass on the running
application **before merge**.

**Batch by branch, not by task:**

- **Single / one-off UI change** → run Gate-0 before its code review.
- **Multi-task UI branch** (several tasks painting the same surface, e.g. a
  subagent-driven plan) → do **NOT** run Gate-0 per task. Per task, rely on
  code review + a parse/syntax check + unit tests; run **one** consolidated
  Gate-0 at the end of the branch. That pass also satisfies Gate-2's visual
  verification — run it once, not twice.

### Procedure

1. Start the dev server in the background (`npm run dev` or the project's
   equivalent)
2. Wait for it to come up; verify via HTTP fetch or log signal
3. Drive the UI via Playwright (or equivalent browser automation available
   in the environment):
   - Navigate to the relevant page/viewer
   - Capture an initial screenshot + check browser console for errors
   - Exercise the specific behavior the task added (zoom, click, filter,
     search, dblclick, Esc, etc.)
   - Capture screenshots at key states

   **Screenshot location:** All QA screenshots MUST be written to
   `.playwright-mcp/` (Playwright MCP default) or `.tmp/` — never to the
   repo root or any other tracked directory. Both paths are gitignored.
   If the tool defaults elsewhere, pass an explicit path (e.g. the
   `filename` arg to `browser_take_screenshot`). Screenshots at the repo
   root clutter `git status` and risk committing large binary artifacts.
4. Report findings:
   - **Runtime errors / stack traces** → block completion, fix before review
   - **Visible regressions vs. previous state** → block completion
   - **Missing or broken rendering** (e.g. a feature doesn't show up at the
     zoom level it's supposed to) → block completion
   - **Aesthetic polish issues** → document, don't block
5. Only after Visual QA passes, run code review (Gate 1)

### When to skip

Visual QA may be skipped for tasks that involve **only**:

- Pure modules with no entry-point wiring (unit tests cover them)
- Backend/server-side code with no UI impact
- Documentation, memory, or git-only operations

**Do NOT skip** for: render-loop changes, event handler changes, shape /
animation / transition changes, any modification to the entry file or
any file that the render loop touches.

### Honest reporting

If Visual QA cannot be run in the current environment (e.g. no Playwright
available, no display, server won't start), state that explicitly and flag
the task as **needing user-driven hand-verify before merge**. Never claim
verification that wasn't done.

---

## Gate 1 — Code review before task completion

**Rule:** Before marking any TodoWrite task as `completed`, run `/review`
on all files changed since branching. For UI-visible changes, Gate 0 must
have passed first.

### Procedure

1. Run `git diff main --name-only` to identify changed files
2. Run `/review` (it reads the diff and all changed files)
3. Review findings:
   - **Critical** findings → fix before marking the task complete
   - **Warning** findings → document but don't block completion
   - **Suggestion** findings → consider but don't block
4. If fixes were needed, re-run `/review` to confirm resolution
5. Only then mark the task as `completed` in TodoWrite

### When to skip

Code review may be skipped for tasks that involve **only**:

- Documentation changes (`.md` files, comments)
- Memory file updates
- Git operations (branching, merging)

---

## Gate 2 — QA before merge

**Rule:** Before merging any branch back to `main`, invoke the `qa` agent
(or run an equivalent full QA pass for the project's stack). Gate 0 (visual
QA) must have been run on every UI-visible commit in the branch — this gate
is the broader, full-feature verification.

### Procedure

1. Ensure all tasks on the branch are complete (Gate 1 passed for each; Gate 0 per the batching rule)
2. Invoke the `qa` agent — it runs these verification areas:
   - Build health (`nuxt build` exit code 0 — adapt per project: `npm test`
     pass + clean dev server startup for Cortex/Node projects)
   - Visual verification (light + dark mode where applicable; full feature
     walkthrough for the shipping change) — this IS the consolidated
     end-of-branch Gate 0 for a multi-task UI branch; don't run it twice
   - Dark mode compliance (semantic utilities, no hardcoded colors)
   - API route validation (auth guards, Zod validation)
   - DB migration validation (no breaking queries)
3. Review the QA report:
   - **PASS** → proceed
   - **PASS WITH WARNINGS** → proceed, warnings documented
   - **FAIL** → fix issues and re-run QA before merging
4. Hand over to user for final verification and test. When approved, proceed to merge.

### When to skip

QA may be skipped for branches that involve **only**:

- Documentation changes
- Memory file updates

---

## Merge protocol

### Version bump (required on every code merge to `main`)

Every merge to `main` that changes **code** MUST bump the semver version
(docs-only merges are exempt — see below). **Default to a patch bump**
(`0.3.0` → `0.3.1`) unless the user explicitly states the change is a **minor**
(`0.3.0` → `0.4.0`, new backward-compatible capability) or **major** (`0.3.0` →
`1.0.0`, breaking change) release.

Bump both version fields together so they never drift:

- [`package.json`](../../package.json)
- [`plugin.json`](../../plugin.json)

(Do **not** touch `CORTEX_INDEXER_VERSION` in `src/indexer/version.ts` — that
pins the external indexer binary, not the plugin.)

There used to be a third, in `.claude-plugin/marketplace.json`. It is gone: a
marketplace entry's `version` is optional and resolves from the plugin's own
`plugin.json`, so the copy bought nothing and could only drift. The published
`ruevu/plugins` catalog omits it for the same reason, and the in-repo manifest
is now the *development* marketplace (`cortex-dev`) rather than the published
one. If a version is ever re-added there, CI requires it to agree.

### This is enforced, not remembered

`.github/workflows/ci.yml` runs
[`scripts/check-release-consistency.mjs`](../../scripts/check-release-consistency.mjs)
on every PR, and **"CI gate" fails** when: the version fields disagree; a
non-docs diff carries no bump; a bumped version is **not strictly ahead of the
base's**; or a release has no CHANGELOG section and link reference. Run it
yourself before opening the PR:

```bash
node scripts/check-release-consistency.mjs main
```

The prose below is the explanation; the script is the gate. Both of this rule's
past failures were invisible to prose — 1.1.1–1.2.1 merged untagged (GitHub
advertised v1.1.0 while `main` was five versions ahead), and a branch was once
authored at 2.1.1 while 2.2.0 landed on `main` beneath it, leaving it proposing
a version *behind* its own base. The "not strictly ahead" check exists for the
second; the tag step below is still the author's to run.

**Also add a [`CHANGELOG.md`](../../CHANGELOG.md) entry** for the new version —
**every** release deserves one, patches included. Follow the existing
[Keep a Changelog](https://keepachangelog.com/) format (`## [x.y.z] — DATE` with
`Added` / `Changed` / `Fixed` / `Removed` sections as applicable) and add the
version link reference at the bottom. Commit the bump + changelog as part of the
merge, e.g. `chore(release): 0.3.1`.

### Exception — documentation-only merges skip the bump

A merge whose diff touches **only** documentation or memory files — anything
under `docs/`, root docs like [`HANDOFF.md`](../../HANDOFF.md) / `README.md`,
the `.claude/` rules, or other `*.md` — and **no** source, test, config, or
shipped asset, does **not** bump the version and does **not** add a CHANGELOG
entry. (Same spirit as the QA and code-review skips above: a stale-section trim
or a status-doc refresh isn't a release.) Merge it `--no-ff` with a plain
`docs(...)` message and no `chore(release)` commit.

The moment a merge **also** touches code / tests / config / a shipped asset, it
is a release: bump + add the CHANGELOG entry as normal, and let the docs changes
ride along in that release. When in doubt (mixed diff), bump.

### Pull-request requirement (every release / semver bump)

Every merge to `main` that bumps the semver — i.e. **any release** — MUST go
through a GitHub **pull request**, not a direct local `git merge` into `main`.
Open the PR from the feature branch, let the required **"CI gate"** check run
and **pass on the PR**, then merge via the PR. This guarantees CI gates every
release and leaves a reviewable record. **Do not** use the branch-protection
bypass to push a release straight to `main`.

Docs-only / no-bump merges (which skip the version bump, per the exception
above) may still be merged locally `--no-ff` as before — though routing them
through a PR is encouraged.

### Tag + GitHub Release (required on every release)

**A merge is not a release until it is tagged and published.** After the release
PR merges to `main`, create a lightweight `vX.Y.Z` git tag **on the merge
commit**, push the tag, and cut a GitHub Release whose notes are that version's
[`CHANGELOG.md`](../../CHANGELOG.md) section. Mark the newest as **Latest**, and
title it `vX.Y.Z — <short summary>` to match the existing releases.

Skipping this silently desyncs the repo's Releases page (and anything keying off
the latest tag/release — the "latest" badge, version checks) from the source
version. This actually happened: `1.1.1`–`1.2.1` all merged to `main` and bumped
`package.json`, but none were tagged, so GitHub showed `v1.1.0` as the latest
release while the code was five versions ahead, until they were backfilled.

### Steps — release (semver bump) via PR

```bash
# On the feature worktree's branch: bump all three version fields + CHANGELOG.
git commit -am "chore(release): <new-version>"
git push -u origin <branch-name>
gh pr create --base main --title "<summary>" --body "<what + why>"
# Wait for the "CI gate" check to pass on the PR, then:
gh pr merge <branch-name> --merge   # --no-ff merge; preserves branch history

# Tag the merge commit on main and publish the release — DO NOT skip this:
git fetch origin
git tag v<new-version> origin/main          # lightweight tag on the merge commit
git push origin v<new-version>
gh release create v<new-version> \
  --title "v<new-version> — <short summary>" \
  --notes "<this version's CHANGELOG.md section>" --latest

git worktree remove ../cortex-wt-<desc> && git worktree prune
```

### Steps — docs-only / no-bump merge (local, no PR required)

```bash
git checkout main
git merge --no-ff <branch-name>     # preserves branch history
git branch -d <branch-name>         # clean up local branch
```

Push to remote only when explicitly requested by the user (docs-only merges);
release PRs are pushed as part of the PR flow above.

---

## Session start checklist

At the start of every session:

1. **State the session scope:** feature, bug, or area of work + expected outputs
2. **Branch check:** verify or create the correct branch per naming convention
3. **Sync:** pull latest `main` if remote has changes
4. **Review todos:** check if there are pending tasks from a previous session
