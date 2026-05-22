# MCP Tool Robustness — Design Spec

**Status:** Draft. Companion to
[2026-05-21 follow-up field report](../../architecture/field-report-2026-05-21-vue-graph-and-decision-input.md)
and the
[Nuxt-Impact Eval Harness design](2026-05-21-nuxt-impact-eval-harness-design.md).
User directive: "without it, Cortex is borderline useless."

## Goal

Close two MCP tool robustness gaps surfaced in the 2026-05-21 follow-up
field report. Both produce a failure mode worse than "broken" — they
produce **silently wrong behavior** that an agent has no signal to
detect.

- **Issue 1** — `create_decision` accepts any string in `rationale`,
  including the concatenated serialization of structured fields when
  caller-side marshalling fails. Bad rationale persists with no warning;
  `governs` is unrecoverable because the field is not settable on
  `update_decision`.
- **Issue 2** — `search_code` falls back to bare `grep -rn` with no path
  exclusions when `rg` is unavailable. The fallback times out or
  buffer-overflows on any common short pattern in any monorepo with
  `node_modules`, returning `internal_error` for what looks like a
  routine query.

## Scope

In scope:

1. Input-shape validation on `create_decision` (and the other write
   tools that share the same field schemas — `propose_decision`,
   `supersede_decision`, `update_decision`).
2. Adding `governs` to the `update_decision` schema, with corresponding
   service logic to upsert governance links.
3. Hardening `search_code`'s grep fallback with directory exclusions,
   and improving the primary `rg` path so it doesn't silently slip into
   the fallback when `rg` is on PATH but errors for unrelated reasons.

Out of scope:

- A comprehensive tool-input validation framework. Apply the same regex
  guard to the four decision-write tools; don't generalize until a
  third failure mode appears.
- Rewriting `search_code` to query the graph for matches. That's a
  larger change with its own design.
- Adding telemetry or observability for tool failures. Separate work.

## Non-goals

- Backward-compatibility shims for existing decisions with corrupted
  rationale. A one-off migration is reasonable but lives outside this
  spec — the regression guard
  (`decision_rationale_no_xml_leakage` in the harness) is what catches
  future regressions; existing corruption is the user's repair job.
- Cross-language input validation. The decision-tool entry points are
  TypeScript; the field validation lives there.

## Fix 1 — `create_decision` rationale shape check

**Where it lives:** [src/mcp-server/tools/decision-tools.ts](../../../src/mcp-server/tools/decision-tools.ts).
The four write tools (`create_decision`, `propose_decision`,
`supersede_decision`, `update_decision`) all accept the same string
fields. Add a shared input-shape validator before any of them call into
`DecisionService`.

**What it checks:** every string-valued field in the input is scanned
for substrings that unambiguously indicate caller-side marshalling
leakage. The chosen markers:

```
</rationale>
</description>
</problem>
</resolution>
</alternatives>
</governs>
</invoke>
<problem>
<resolution>
<alternatives>
<governs>
```

If any field contains any marker, the tool returns an
`errorResponse("invalid_input", …)` describing which field tripped and
which marker was matched. The decision is not persisted. The error
message names the marker so the caller can debug their serialization.

This is a regex check, not a parser. It will not catch all garbage
input, but it catches the exact failure mode the field report
documented — the literal text of a structured tool call leaked into a
string field — at near-zero cost.

**False-positive risk:** a legitimate rationale might quote XML.
Mitigation: the markers are specifically the closing tags of decision
fields plus `</invoke>`. A rationale that legitimately contains
`</invoke>` is improbable; if it happens, the caller can escape it
(`&lt;/invoke&gt;`) or the marker list can be tuned. We accept the
small risk of false positives in exchange for catching the bad-write
failure mode.

**Telemetry:** none in this spec. If false positives turn out to be
frequent, log counts in follow-up work.

## Fix 2 — `governs` on `update_decision`

**Where it lives:**
[src/mcp-server/tools/decision-tools.ts](../../../src/mcp-server/tools/decision-tools.ts)
(schema) and the relevant `DecisionService.update` method (logic).
Today, `update_decision` accepts `title`, `description`, `rationale`,
`alternatives`, `status`, `superseded_by`, `problem`, `resolution`. It
must additionally accept:

```ts
governs: z.array(z.string()).optional()
references: z.array(z.string()).optional()
```

**Semantics on update:** when `governs` is passed, treat it as a
**replacement** of the current governance set, not a merge. Specifically:

1. Compute `to_add = new − current` and `to_remove = current − new`.
2. Call `DecisionLinksRepository.add` for each addition and `.remove`
   for each removal.
3. Wrap in a transaction so partial failure does not corrupt state.

This matches the create-time semantics (governs is a full list) and
gives callers an explicit clearing path (`governs: []`).

**Why replacement, not merge:** the recovery scenario the field report
describes is "the governs list was set wrong, fix it." A merge
semantics requires a separate `remove_governs` call. Replacement
collapses the surface.

## Fix 3 — `search_code` fallback hardening

**Where it lives:**
[src/mcp-server/tools/code-tools.ts](../../../src/mcp-server/tools/code-tools.ts).
Today's logic: prefer `rg`, fall back to `grep -rn` on ENOENT. The fallback
has no path exclusions and runs against the indexed project root.

Two changes:

1. **`rg` invocation gets `--max-count` and a `maxBuffer` raise.** Today
   `RG_MAX_BUFFER` is the buffer used for both `rg` and `grep`. `rg`
   respects `.gitignore` by default so it's almost always fine, but on
   a vendored-heavy repo (Cortex itself, with `internal/indexer/vendored/`)
   even `rg` can produce large output. Cap `rg` output at 200 matches
   via `--max-count`, raise `maxBuffer` to a defensible ceiling (16 MiB
   is enough headroom for 200 lines).
2. **`grep` fallback gets exclusion flags.** Add
   `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.cache --exclude-dir=vendored`.
   These six directories cover the cases observed in the wild. The
   fallback is only reached when `rg` is genuinely unavailable, but
   when reached, it should not blow up on monorepo shapes.

**No third-party dependency.** We do not bundle `ripgrep`. The fallback
becomes usable; the primary path stays the same.

**Error surface stays the same.** Existing behavior on truly empty
results (`empty(...)`) is unchanged. We only change failure modes
caused by output volume.

## Implementation order

The three fixes are mutually independent and small. Suggested order:

1. **Fix 3 (search_code hardening).** Smallest, lowest risk. Two regex-like
   flag additions. No schema changes. Ship as one PR.
2. **Fix 1 (rationale shape check).** One shared validator + four call
   sites. Includes unit tests for each marker. Ships before Fix 2
   because the harness's
   `decision_rationale_no_xml_leakage` regression guard depends on it.
3. **Fix 2 (`governs` on update).** Slightly larger — schema + service
   + transaction + tests. Ships last because it is recovery-path
   functionality, not a silent-data-corruption fix.

Each lands as its own commit on a `feature/mcp/*` branch.

## Testing

- **Fix 1** — unit tests in `tests/mcp/decision-tool-validation.test.ts`,
  one per marker, asserting the tool returns `invalid_input` and the
  decisions table is unchanged.
- **Fix 2** — unit tests in `tests/mcp/decision-update-governs.test.ts`
  covering: add governance, remove governance, replace governance,
  clear governance (`governs: []`), transactional rollback on partial
  failure.
- **Fix 3** — integration test in
  `tests/mcp/search-code-fallback.test.ts` that injects a fake PATH
  hiding `rg`, runs `search_code("the")` against a fixture project
  containing a `node_modules/` directory, asserts the result is
  successful and does not include `node_modules` matches.

No new integration with the eval harness — the harness's tool-behavior
assertions already cover the user-visible behavior end-to-end.

## Cross-references

- The harness's
  [`decision_rationale_no_xml_leakage`](2026-05-21-nuxt-impact-eval-harness-design.md#fix-8--spec-docs-promoted-to-decisions)
  assertion is the regression guard for Fix 1.
- The harness's
  [`governs_link_to_vue_path_persists`](2026-05-21-nuxt-impact-eval-harness-design.md#fix-4--vue-sfc-functions-surface)
  assertion creates a decision via `create_decision` and reads back
  via `get_decision`. Fix 1's validator runs in that path; Fix 2 is
  unrelated to that assertion but uses the same code.

## Open questions

- Should the rationale validator also check `description`, `problem`,
  `resolution`, `alternatives[].rationale`? My current answer is yes
  (the spec lists the markers, not the field allowlist). Worth
  confirming during implementation.
- For `governs` on update, do we want a `governs_add` /
  `governs_remove` pair as a more surgical surface? My current answer
  is no (replacement is simpler; the marshalling-safety story is the
  same). Worth a brief revisit when writing the plan.
