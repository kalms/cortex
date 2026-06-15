# Design — `context_pack` composite + target-repo-aware sibling auto-index

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation
**Items:** Agentic-experience field report §5 — **P1** (`context_pack`) and **P3**
(target-repo-aware grep hook), from
[field-report-2026-06-12-mesh-m1-platform-consumer.md](../../field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md).

These are two independent units that ship on separate branches with separate
gated merges and version bumps. They share this doc because they are sibling
P-items from the same report and both small. Each gets its own implementation
plan.

---

## P1 — `context_pack(repo_path, qualified_name)`

### Why

The dominant symbol-exploration loop today is four separate MCP calls:
`get_code_snippet` → `trace_path(callers)` → `trace_path(calls)` →
`why_was_this_built`. Each is a full agent roundtrip (emit → wait → read →
reason about the next call) and re-injects its own tool schema (the fixed token
tax). The same `qualified_name` is re-resolved by each tool, so an ambiguous
symbol forces disambiguation three times.

`context_pack` collapses that loop into **one call, one turn**. It is the
natural "what is this thing?" first call on any unfamiliar symbol — the field
report predicts it becomes the most-used tool.

It is **pure composition of existing reads** — no new query capability — so
implementation risk lives in caps and formatting, not in the queries.

### Shape

```
context_pack(repo_path: string, qualified_name: string)
```

Returns one text response of labeled sections (consistent with every other
Cortex tool; text is more token-efficient for the agent consumer than JSON and
keeps the contract-test pattern uniform):

```
## SNIPPET  src/foo.ts::bar (12-40)
<source>

## CALLERS (showing 10 of 23)
- baz()  src/a.ts:9
- …

## CALLEES (2)
- log()  src/log.ts:3
- …

## GOVERNING DECISIONS (1)
- D-fq9g: search_graph ranking

## RECENT COMMITS (3)
- a43f12 fix(layout): draw edges behind frames (2026-06-14)
- …
```

### Behavior

1. `project = projectFromCtx(ctx)`; if none → `project_not_found` error
   ("Repository not indexed. Run index_repository first.").
2. **Resolve `qualified_name` once**, mirroring `get_code_snippet`:
   - Contains `::` → `normalize` + `searchGraph` by qn directly.
   - Otherwise `resolveInput(qn, project, ctx.graphDbPath)`:
     - `none` → `empty("context_pack(<qn>)")`
     - `multi` → `ambiguous_input` with the candidate list (**one place**, not
       once per sub-query)
     - `single` → proceed with the resolved node.
   - Yields the `IndexerNode` (for the snippet), the bare symbol name (for
     `trace_path`), and the `file_path` (for decisions + commits).
3. Assemble five sections. **Each is best-effort**: a failure in one degrades
   to a marker line for that section and never sinks the whole pack. The pack
   succeeds as long as the symbol resolved.
   - `## SNIPPET` — `readSnippet(ctx, project, node)`.
   - `## CALLERS` — `tracePath(store, project, {function_name: bareName,
     mode: "callers", max_depth: 1})`, cap **10**.
   - `## CALLEES` — same with `mode: "calls"`, cap **10**.
   - `## GOVERNING DECISIONS` — `searchFor(ctx).findGoverning(file_path || qn)`,
     cap **5**.
   - `## RECENT COMMITS` — `git log -n 5 --format='%h %s (%ad)' --date=short --
     <file_path>` via `execFile`, `cwd = ctx.repoPath`, cap **5**. Git missing /
     not a repo / non-zero exit → render `(unavailable)`, do not error.
4. Each capped list shows `(showing N of M)` when truncated; otherwise `(M)`.
5. `freshnessAware: true` (composes freshness-aware reads).

`max_depth: 1` is deliberate — direct neighbors only. An agent that needs the
deeper chain still has `trace_path` for that; `context_pack` is the orientation
primitive, not a replacement.

### Code organization

- New module [src/mcp-server/tools/context-pack.ts](../../../src/mcp-server/tools/context-pack.ts)
  exporting `registerContextPackTool(server, resolver)` and a testable
  `buildContextPack(ctx, qualified_name)` core. Keeps the already-936-line
  `code-tools.ts` from growing.
- Small refactor: lift `readSnippet` and `projectFromCtx` out of `code-tools.ts`
  into a shared helper (e.g. `code-tools-shared.ts`) imported by both. Targeted
  improvement of code we're working in; no behavior change to existing tools.
- Register from `server.ts` alongside `registerCodeTools`.

### Docs + decision

- Add `context_pack` to [docs/mcp-tools.md](../../mcp-tools.md), the CLAUDE.md
  routing table ("get full context for a symbol → `context_pack`"), and the
  README tool list/count.
- Capture a decision: new public MCP tool / API contract. Rationale = the
  roundtrip-collapse argument above; alternatives = JSON output (rejected:
  token cost, convention divergence), keeping the 4-call pattern (rejected: the
  cost it imposes). `governs: ["src/mcp-server/tools/context-pack.ts"]`.

### Tests

`tests/mcp-contract/context-pack.test.ts` (fixture-backed, mirroring existing
contract tests):
- happy path: all five sections present, correct caps + truncation note.
- `ambiguous_input` returned once for a multi-match bare name.
- `empty` for an unresolvable name.
- `project_not_found` on an unindexed repo.
- best-effort degradation: a section whose sub-query throws renders its marker,
  pack still returns the others.
- commits `(unavailable)` path when git log is unavailable.

---

## P3 — Background-index unindexed siblings, then allow

### The bug

[prefer-cortex.sh](../../../hooks/prefer-cortex.sh) decides "is this repo
indexed?" from `$CWD` (lines 49-58). When the shell cwd is an indexed repo
(e.g. `cortex`) and the agent greps an **unindexed sibling** repo, the hook
sees cortex's index and wrongly denies — even though Cortex cannot answer for
the sibling. The index gate must key on the **search target**, not the cwd.

### Behavior

Resolve the search **target**, then act on the target's index state.

Target resolution (conservative — fall back to cwd whenever unsure, preserving
current behavior):

| Tool | Target |
|---|---|
| `Grep` | `tool_input.path` if present → its git root; else cwd |
| `Glob` | `tool_input.path` if present → its git root; else cwd |
| `Bash` | first path-like token in the command (starts with `/`, `./`, `../`, `~`, or contains `/`; not a `-flag`; after the existing quoted-literal strip) → its git root; none → cwd |

Then, for a **code-targeted** search (existing code-vs-non-code scope detection
is unchanged):

- **Target indexed** → existing redirect-to-Cortex behavior (unchanged). This
  includes a *second* indexed repo, not just the cwd — correct, since the
  redirect message already instructs passing `repo_path`.
- **Target unindexed AND a high-certainty git repo** → **allow the grep
  immediately**, and **best-effort fire a detached index** for that repo (see
  below).
- **Anything else** (non-git dir, tmp/denylisted path, CLI unresolvable, recent
  attempt already made) → **plain allow** (the core bug fix), no index.

Non-code searches and the escape hatches (`cortex:grep-ok`, non-code scoping)
are unchanged throughout.

### High-certainty gate

Auto-index only when **all** hold:
- `git -C <target> rev-parse --show-toplevel` resolves to a real root,
- the root exists on disk,
- the root is **not** under a denylist fragment: `.tmp/` (cortex's eval-clone
  convention), `node_modules`, `vendor`, `dist`, `build`, `.cache`.

(Bare system `/tmp` was dropped from the denylist in 0.3.18: it wrongly excluded
every Linux `os.tmpdir()` repo, and a git repo a user actively greps under
`/tmp` is a legitimate index target. The `.tmp` eval-clone guard remains.)

Otherwise → plain allow, no spawn.

### Detached index — guards

The hook never indexes synchronously (latency, timeout, degrade-safety). It
spawns a detached process and returns immediately.

| Risk | Mitigation |
|---|---|
| Duplicate / concurrent indexes from repeated greps | Hook-side sentinel `<root>/.cortex/.auto-index-attempted` with a TTL (~1h): skip spawn if present and fresh. The CLI's existing `withIndexLock(repoPath)` is the correctness backstop if two ever race. |
| Silent writes into junk/vendored trees | The high-certainty gate above. |
| Failures vanish | Detached process redirects stdout+stderr to `<root>/.cortex/auto-index.log`. |
| CLI not on hook's PATH | Resolve `cortex` via `CORTEX_BIN` env → `command -v cortex` → known plugin path. Unresolvable → plain allow, no spawn. |
| Child killed when hook process exits | `nohup <cortex> index repository --path=<root> >"<log>" 2>&1 </dev/null & disown` (macOS has no `setsid`). **Survival across hook exit is the one genuinely uncertain piece — proven in Gate 0 before relying on it** (see below). |

Spawn order: write the sentinel, then spawn, then `exit 0` (allow). All wrapped
so any failure in the spawn path still allows the grep — the hook's degrade-safe
invariant is preserved.

### Gate 0 verification (required before merge)

Detachment survival on macOS is not assumable. Verify empirically: trigger the
hook against a fresh unindexed git fixture, let the hook process exit, and
confirm (a) the index process keeps running and (b) `<root>/.cortex/db` appears.
If `nohup … & disown` does not survive, fall back to a double-fork
(`( <cmd> & )`) and re-verify. Document the working recipe in the hook comment.

### Tests

Extend [tests/hooks/prefer-cortex.test.ts](../../../tests/hooks/prefer-cortex.test.ts).
Stub `cortex` via `CORTEX_BIN` pointing at a script that writes a marker file:
- code grep into an **unindexed high-certainty git sibling** → allow + marker
  written + sentinel written.
- code grep into an **indexed** second repo → deny/redirect (no spawn).
- **no spawn** when: non-git dir, tmp/denylisted path, sentinel already fresh,
  `CORTEX_BIN`/`cortex` unresolvable.
- bare-pattern grep in the indexed cwd → deny (unchanged); relative `../`
  target resolves correctly; a `-flag` is not mistaken for a path.
- degrade-safety: every failure path still allows the grep.

### Docs + decision

- Update the `prefer-cortex` section of CLAUDE.md to describe the
  target-aware gate and the sibling auto-index behavior.
- Capture a decision: the hook is now **side-effecting** (it spawns indexing) —
  a notable departure from a pure allow/deny gate. Rationale = compounding
  index coverage at the point of need; alternatives = passive allow + nudge
  (rejected: wastes the moment), synchronous in-hook index (rejected: latency /
  timeout / degrade-safety), deny-and-instruct-agent (rejected by product
  owner in favor of zero-friction background indexing).
  `governs: ["hooks/prefer-cortex.sh"]`.

---

## Rollout

**Single release.** P1 and P3 ship together in **one** version bump + **one**
CHANGELOG entry, per the user's instruction. The implementation may be split
(the two touch disjoint files — `src/mcp-server/**` for P1, `hooks/` +
`tests/hooks/` for P3 — so they can be built in parallel without conflict), but
they integrate before a single `chore(release)` commit.

Mechanics: build both on one feature branch (`feature/agentic-experience/p1-p3`)
with atomic commits per item, or build on two topic branches and merge both
into main `--no-ff` followed by a single combined bump + CHANGELOG. Either way:
**one release covering both items.**

Each item still passes its own Gate 0 → Gate 1 before integration: P3's Gate 0
is the detachment-survival check above; P1's is unit + contract tests (no UI
surface). Two decisions are still captured (one per item) regardless of the
single-release packaging.
