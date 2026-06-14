# Shared `code_search` Engine + CLI Ripgrep Swap — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorming)
**Origin:** User report — `cortex code search 'extract' --kind=function` returns only `.md` files.

## Problem

`cortex code search` calls the **indexer binary's** `search_code`, which caps
results at ~10 and orders them doc-first: for a common term (`extract` — 91 code
files, 79 md files) the cap fills entirely with `.md` module nodes before any
code hit, so the user sees only markdown. The flag `--kind` is also silently
ignored (and the help wrongly advertises it).

Meanwhile the **MCP `search_code` tool** ([code-tools.ts:1041](../../../src/mcp-server/tools/code-tools.ts#L1041))
runs its **own ripgrep** over the repo and annotates each hit with its enclosing
symbol — no cap-induced doc bias. The two backends have diverged and the CLI is
on the inferior one.

## Goal

Route `cortex code search` through the same ripgrep + graph-annotation engine
the MCP tool uses, by extracting that engine into a shared module both callers
invoke. Fold in "Option A": redirect `--kind` on `search` to `find`, and correct
the `search` help. The MCP tool's output must remain byte-identical (its tests
are the contract).

## Architecture

```
src/graph/code-search.ts   (NEW — the shared engine)
  ├─ rg helpers (moved from code-tools.ts, re-exported there for compat)
  └─ runCodeSearch({pattern, repoRoot, store?, project?, maxHits?}) → SearchOutcome

src/mcp-server/tools/code-tools.ts   (search_code handler → thin wrapper)
  └─ runCodeSearch({..., maxHits: 50}) → format as current MCP text (UNCHANGED output)

src/cli/commands/code.ts   (cmdSearch → ripgrep-backed)
  └─ runCodeSearch({..., maxHits: 500}) → rank by enclosing kind → rows via writeRows
```

## Component 1 — `src/graph/code-search.ts`

**Moved from `code-tools.ts`** (lines 221-342): `execFileAsync`, `RG_MAX_BUFFER`,
`buildRgArgs`, `buildGrepFallbackArgs`, `resolveRgBinary`, `SearchExecError`,
`SearchExecOutcome`, `classifySearchExec`. To avoid breaking existing importers
and the tests `tests/mcp-contract/search-code-args.test.ts` /
`search-code-errors.test.ts` (which import from `code-tools.js`), **`code-tools.ts`
re-exports them** from the new module:

```ts
export { buildRgArgs, buildGrepFallbackArgs, resolveRgBinary, classifySearchExec } from "../../graph/code-search.js";
export type { SearchExecError } from "../../graph/code-search.js";
```

**Types:**

```ts
export type SearchHit = {
  file: string;
  line: number;
  text: string;
  enclosing?: { kind: string; qualified_name: string; file_path: string };
};
export type SearchOutcome =
  | { kind: "hits"; hits: SearchHit[] }
  | { kind: "empty" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };
```

**API:**

```ts
export async function runCodeSearch(opts: {
  pattern: string;
  repoRoot: string;        // rg/grep cwd (the addressed repo)
  store?: GraphStore;      // when present (+project), annotate enclosing symbol
  project?: string;
  maxHits?: number;        // cap parsed hits BEFORE enrichment (default 50)
}): Promise<SearchOutcome>;
```

Behavior (lifted verbatim from the MCP handler so semantics match):
1. Run `resolveRgBinary()` with `buildRgArgs(pattern)`, `cwd: repoRoot`,
   `maxBuffer: RG_MAX_BUFFER`, `timeout: 10_000`.
2. On rg failure, `classifySearchExec`: `output` → use stdout; `empty` →
   `{kind:"empty"}`; `invalid_pattern` → `{kind:"invalid_pattern", detail}`;
   `missing` → fall back to `grep` with `buildGrepFallbackArgs` (same
   classification; `missing` again → `{kind:"error", detail:"Neither rg nor grep…"}`);
   else → `{kind:"error", detail}`.
3. Empty stdout → `{kind:"empty"}`.
4. Parse lines matching `^\.\/(.+?):(\d+):(.*)$` into `{file, line, text}`
   (text = the remainder after the second colon). Non-matching lines are
   skipped. Cap to `maxHits`.
5. If `store`+`project`: for each hit, run the existing enclosing-node query
   (`SELECT * FROM nodes WHERE project=? AND file_path=? AND start_line<=? AND
   end_line>=? AND kind NOT IN ('decision','pr','todo') ORDER BY (end_line-start_line)
   ASC LIMIT 1`) and attach `enclosing` when found. No store/project → hits have
   no `enclosing`.
6. Return `{kind:"hits", hits}`.

Note the one behavioral refinement vs. today's MCP handler: the MCP handler
currently keeps the **whole rg line** (`./file:line:text`) as the unit and
appends the annotation. Here we parse out `file`/`line`/`text` so callers can
format freely; the MCP wrapper reassembles the identical string (below).

## Component 2 — MCP `search_code` wrapper (output UNCHANGED)

The handler becomes:

```ts
const outcome = await runCodeSearch({ pattern, repoRoot: ctx.repoPath, store: ctx.store, project: projectFromCtx(ctx) ?? undefined, maxHits: 50 });
switch (outcome.kind) {
  case "empty": return empty(`search_code(${pattern})`);
  case "invalid_pattern": return errorResponse("invalid_pattern", `Pattern rejected by ripgrep: ${outcome.detail}\n` + "search_code uses ripgrep regex syntax — escape regex metacharacters (e.g. \\( \\[ \\. \\*) to match them literally.");
  case "error": return errorResponse("internal_error", outcome.detail);
  case "hits": {
    const text = outcome.hits.map((h) => {
      const base = `./${h.file}:${h.line}:${h.text}`;
      return h.enclosing ? `${base}  // in ${h.enclosing.kind} ${denormalize(h.enclosing.qualified_name, h.enclosing.file_path)}` : base;
    }).join("\n");
    return ok(text);
  }
}
```

This reproduces the current strings exactly: `./file:line:text` and the
`  // in kind qn` suffix, capped at 50, anchored to `ctx.repoPath`. The
no-project path (no enclosing on any hit) yields the raw `./file:line:text`
lines, matching today's "surface raw grep output" fallback. **Existing
`tests/mcp-contract/code-tools.test.ts` search_code assertions must stay green
unchanged** — they are the contract.

## Component 3 — CLI `cmdSearch` (ripgrep-backed, ranked rows)

```ts
async function cmdSearch(cmd, ctx) {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <pattern>", "Usage: cortex code search <pattern>");

  if (cmd.flags.kind !== undefined || cmd.flags.kinds !== undefined) {
    process.stderr.write(`note: --kind has no effect on 'search' (full-text). Use: cortex code find ${pattern} --kind=…  (symbol search)\n`);
  }

  const store = new GraphStore(ctx.graphDbPath);
  const outcome = await runCodeSearch({ pattern, repoRoot: ctx.gitRoot ?? ctx.cwd, store, project: ctx.projectName, maxHits: 500 });

  if (outcome.kind === "invalid_pattern") throw new DomainError(`pattern rejected: ${outcome.detail}`, "Escape regex metacharacters (e.g. \\( \\[ \\. \\*) to match them literally.");
  if (outcome.kind === "error") throw new DomainError(outcome.detail);

  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  const hits = outcome.kind === "hits" ? outcome.hits : [];
  const ranked = rankSearchHits(hits);                 // code-first (pure, see below)
  const limit = clampLimit(...); const offset = clampOffset(...);
  const page = ranked.slice(offset, offset + limit);
  const rows = page.map((h) => ({ file: h.file, line: h.line, symbol: h.enclosing ? `${h.enclosing.kind} ${h.enclosing.qualified_name}` : "", text: h.text.trim() }));
  writeRows(rows, fmt, ranked.length === 0 ? `no matches for '${pattern}' in ${ctx.projectName}` : `offset ${offset} is past the ${ranked.length} match(es)`);
  if (page.length > 0) process.stderr.write(`# showing ${offset + 1}–${offset + page.length} of ${ranked.length}\n`);
}
```

**`rankSearchHits` (pure, in `code-search.ts` or `search-params.ts`):** sort by
`KIND_WEIGHT[h.enclosing?.kind ?? <none>]` descending, then `file` asc, then
`line` asc. Hits inside `function`/`class`/`method` (weight 0.9-0.95) float above
module-level hits (0.55) and unenclosed hits (lowest). **This is what fixes the
"only .md" report**: a `.md` match encloses to its `module` node (or nothing) and
sinks below real code hits — no doc-extension list needed, the existing
`KIND_WEIGHT` table does it. `maxHits: 500` is the safety bound on hits enriched
+ ranked; for the reported case (`extract`, ~170 total hits) it covers the whole
set so code reliably floats to the top. Result sets larger than 500 hits are
capped at 500 before ranking (a documented bound; rare for a single repo).

## Error / edge handling

| Outcome | MCP | CLI |
|---|---|---|
| `empty` | `empty(queryDesc)` | `writeRows([], …, "no matches…")` |
| `invalid_pattern` | `errorResponse("invalid_pattern", …)` | `DomainError` + escape hint |
| `error` | `errorResponse("internal_error", …)` | `DomainError` |
| no project | raw `./file:line:text` (no annotation) | hits with empty `symbol` column |

## Testing

**New unit tests `tests/graph/code-search.test.ts`** (real fixture graph + real
rg over a temp dir, mirroring `code-queries.test.ts` setup):
- parses `./file:line:text` into hits; skips non-matching lines.
- enriches enclosing symbol when store+project given; omits it otherwise.
- `maxHits` caps the hit count.
- empty pattern result → `{kind:"empty"}`.
- invalid regex (e.g. `(`) → `{kind:"invalid_pattern"}`.

**`rankSearchHits` unit test:** function-enclosed hit ranks above module-enclosed
above unenclosed; stable file/line tiebreak.

**CLI `tests/cli/commands/code.test.ts`:** add a `cmdSearch` case using the
hand-built graph — assert rows are code-first and `--kind` emits the stderr
redirect. (Search now runs rg in-process via `runCodeSearch`, so it is testable
without the indexer binary, unlike before.)

**Regression contract (must stay green, unchanged):**
`tests/mcp-contract/code-tools.test.ts` (search_code happy path),
`search-code-args.test.ts`, `search-code-errors.test.ts`.

## Files

- **Create:** `src/graph/code-search.ts`, `tests/graph/code-search.test.ts`.
- **Modify:** `src/mcp-server/tools/code-tools.ts` (move helpers + re-export;
  search_code handler → wrapper), `src/cli/commands/code.ts` (cmdSearch +
  `runCodeSearch` import), `src/cli/help.ts` (search entry), `tests/cli/commands/code.test.ts`.
- `rankSearchHits` lives in `src/graph/code-search.ts` alongside the engine.

## Out of scope (deliberate)

- **MCP-side ranking / doc-demotion.** The MCP tool keeps its current first-50
  behavior; adding code-first ranking there is a separate decision (regression
  surface + its own observe). This slice only re-points the CLI and shares the
  engine.
- Removing the indexer binary's `search_code` subcommand (other callers may use
  it; leave it).
