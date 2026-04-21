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

## Gate 0 — Visual QA before code review (for any UI-visible change)

**Rule:** Before running code review or marking a UI-visible task complete,
run a visual QA pass on the running application. Do not rely solely on unit
tests for rendered behavior — tests verify module logic, not that the viewer
actually starts, renders, transitions, or handles interaction without errors.

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

1. Ensure all tasks on the branch are complete (Gate 0 + Gate 1 passed for each)
2. Invoke the `qa` agent — it runs these verification areas:
   - Build health (`nuxt build` exit code 0 — adapt per project: `npm test`
     pass + clean dev server startup for Cortex/Node projects)
   - Visual verification (light + dark mode where applicable; full feature
     walkthrough for the shipping change)
   - Dark mode compliance (semantic utilities, no hardcoded colors)
   - API route validation (auth guards, Zod validation)
   - DB migration validation (no breaking queries)
3. Review the QA report:
   - **PASS** → proceed to merge
   - **PASS WITH WARNINGS** → proceed, warnings documented
   - **FAIL** → fix issues and re-run QA before merging
4. Only then execute the merge

### When to skip

QA may be skipped for branches that involve **only**:

- Documentation changes
- Memory file updates

---

## Merge protocol

```bash
git checkout main
git merge --no-ff <branch-name>    # preserves branch history
git branch -d <branch-name>        # clean up local branch
```

Push to remote only when explicitly requested by the user.

---

## Session start checklist

At the start of every session:

1. **State the session scope:** feature, bug, or area of work + expected outputs
2. **Branch check:** verify or create the correct branch per naming convention
3. **Sync:** pull latest `main` if remote has changes
4. **Review todos:** check if there are pending tasks from a previous session
