# Vue & Svelte SFC Extraction Support

**Date:** 2026-04-07
**Status:** Proposed
**Scope:** `internal/cbm/extract_sfc.c`, `tests/test_extraction.c`, minor changes to `cbm.c` and `Makefile.cbm`

---

## Problem

Vue (`.vue`) and Svelte (`.svelte`) Single File Components are registered in the indexer but produce nearly empty graph nodes. The tree-sitter-vue and tree-sitter-svelte grammars parse the outer SFC structure, but `<script>` content appears as opaque `raw_text` nodes — never re-parsed with JS/TS grammars. `<template>` component usage is not detected at all.

**Result:** Vue/Svelte files get a File node and a Module node with zero edges. No functions, imports, calls, or component relationships are captured. Tracing tools like `trace_path()` and `search_graph()` return empty results for these files.

**Concrete example:** In a Nuxt app, `ds.vue` renders `<ADSTopbar>` in its template. `search_graph(name_pattern="ADSTopbar")` returns 0 edges. `trace_path("ADSTopbar")` returns "function not found". A plain `grep` finds the usage instantly.

---

## Solution

Add a new SFC extractor (`extract_sfc.c`) following the `extract_k8s.c` pattern. Called from `cbm_extract_file()` for Vue and Svelte files, it:

1. **Re-parses `<script>` blocks** with the TS/JS grammar to extract functions, imports, calls, and composable usage
2. **Walks `<template>` elements** to detect component tag references (CALLS edges) and directive attribute identifiers (usages/calls)
3. **Skips `<style>` blocks** — they don't contribute meaningfully to the code knowledge graph

---

## Architecture

```
cbm_extract_file()
  ├── parse with tree-sitter-vue/svelte  (existing)
  ├── cbm_extract_definitions()          (existing — gets "document" module)
  ├── cbm_extract_imports()              (existing — gets nothing for Vue/Svelte)
  ├── cbm_extract_unified()              (existing — gets nothing for Vue/Svelte)
  │
  ├── if Vue or Svelte:
  │     cbm_extract_sfc(&ctx)            ◄── NEW
  │       ├── sfc_extract_scripts()
  │       │     └── for each <script> / <script setup>:
  │       │           - extract raw_text content
  │       │           - detect lang="ts"
  │       │           - re-parse with TS/JS grammar
  │       │           - run cbm_extract_definitions()
  │       │           - run cbm_extract_imports()
  │       │           - run cbm_extract_unified()
  │       │           - adjust line offsets
  │       └── sfc_extract_template()
  │             └── walk element tree:
  │                   - custom tags → CALLS edges
  │                   - directives → usage/call edges
  ...
```

The call site in `cbm.c`:

```c
// SFC extraction (Vue / Svelte) — re-parse <script>, scan <template>
if (language == CBM_LANG_VUE || language == CBM_LANG_SVELTE) {
    cbm_extract_sfc(&ctx);
}
```

Placed after the standard extractors, before profiling counters (analogous to the K8s block at line 348).

---

## Script Block Extraction

### Finding script blocks

Walk the SFC AST for `script_element` nodes. Both tree-sitter-vue and tree-sitter-svelte produce this node type. The content lives in a `raw_text` child node.

Vue files can have two script blocks — `<script>` and `<script setup>`. Both are extracted.

### Detecting language

Check `<script>` tag attributes for `lang="ts"` or `lang="typescript"`:
- Present → re-parse with `tree_sitter_typescript()`
- Absent → re-parse with `tree_sitter_javascript()`

### Re-parsing

```c
for each script_element in SFC AST:
    raw_text_node = child of type "raw_text"
    script_source = source text of raw_text_node
    script_offset = start line of raw_text_node

    ts_lang = has_lang_ts ? tree_sitter_typescript() : tree_sitter_javascript()
    inner_language = has_lang_ts ? CBM_LANG_TYPESCRIPT : CBM_LANG_JAVASCRIPT

    // Re-parse with JS/TS grammar
    parser = get_thread_parser(ts_lang, inner_language)
    tree = ts_parser_parse(parser, script_source)

    // Build context for inner extraction
    script_ctx = {
        .arena = ctx->arena,
        .result = ctx->result,      // append to same result
        .source = script_source,
        .language = inner_language,  // use JS/TS lang spec
        .project = ctx->project,
        .rel_path = ctx->rel_path,
        .module_qn = ctx->module_qn,
        .root = tree_root,
    }

    // Record counts before extraction (for offset adjustment)
    defs_before = result->defs.count
    imports_before = result->imports.count
    calls_before = result->calls.count

    // Run standard extractors
    cbm_extract_definitions(&script_ctx)
    cbm_extract_imports(&script_ctx)
    cbm_extract_unified(&script_ctx)

    // Adjust line numbers for all newly added items
    adjust_line_offsets(result, defs_before, imports_before, calls_before, script_offset)

    ts_tree_delete(tree)
```

### Line offset adjustment

All extracted items have line numbers relative to the `<script>` block start (line 0). The adjustment adds the `raw_text` node's start line to every `start_line` and `end_line` of items added during this extraction pass.

### Vue-specific patterns

`defineProps()`, `defineEmits()`, `defineExpose()` in `<script setup>` are compiler macros that look like function calls. The JS/TS extractor naturally captures them as CALLS edges, which is the correct behavior — they become traceable in the graph.

---

## Template Extraction

### Finding the template block

Walk the SFC AST for the `<template>` element. In Vue this is an `element` node with tag_name `"template"`. In Svelte, template content is at the document root (no wrapper element).

### Component tag detection

Recursively walk all `element` and `self_closing_tag` nodes. For each `tag_name`, determine if it's a custom component:

**Detection rules:**
1. **PascalCase** — starts with uppercase, e.g. `ADSTopbar`, `MyComponent` → component
2. **Contains a hyphen** — e.g. `my-component`, `v-btn` → component (standard HTML elements never contain hyphens)
3. **Not in HTML allowlist** — a sorted static array of ~120 standard HTML/SVG tag names with binary search lookup

For each detected component, emit a CALLS edge:

```c
cbm_calls_push(&result->calls, arena, (CBMCall){
    .caller_qn = module_qn,
    .callee_name = component_tag_name,
    .start_line = adjusted_line,
    .end_line = adjusted_line,
});
```

### Directive attribute extraction

Scan element attributes for framework-specific directives and extract the **leading identifier** from the attribute value.

| Attribute pattern | Framework | Emit as |
|---|---|---|
| `v-if="expr"` | Vue | usage |
| `v-for="item in expr"` | Vue | usage (of collection — extract identifier after `in`/`of` keyword) |
| `v-model="expr"` | Vue | usage |
| `:prop="expr"` / `v-bind:prop="expr"` | Vue | usage |
| `@event="handler"` / `v-on:event="handler"` | Vue | call |
| `on:event={handler}` | Svelte | call |
| `bind:prop={value}` | Svelte | usage |

**Leading identifier extraction:** Scan the attribute value string, extract the first `[a-zA-Z_$][a-zA-Z0-9_$]*` token. Skip known literals (`true`, `false`, `null`, `undefined`). This captures the top-level reference without full JS expression parsing.

For event attributes (`@click`, `on:click`) → emit as CALLS.
For all other directives → emit as usages.

### Svelte block expressions

Svelte `{#if condition}` and `{#each items as item}` blocks are already recognized as branch types in the lang spec (`svelte_branch_types`). The template walker extracts the leading identifier from these block expressions as usages.

### Vue vs Svelte differences

| Concern | Vue | Svelte |
|---|---|---|
| Template root | `<template>` wrapper element | Document root (no wrapper) |
| Component tags | Same detection rules | Same detection rules |
| Event binding | `@click` / `v-on:click` | `on:click={handler}` |
| Prop binding | `:prop` / `v-bind:prop` | `bind:prop={value}` |
| Conditionals | `v-if` attribute | `{#if}` block node |
| Iteration | `v-for` attribute | `{#each}` block node |

A framework flag (`is_vue` derived from `ctx->language == CBM_LANG_VUE`) controls which attribute prefixes to scan.

---

## Auto-Import Handling

Modern frameworks (Nuxt, SvelteKit) resolve components by filename convention without explicit imports. For example, `<ADSTopbar>` in a Nuxt app has no `import` statement — the framework resolves it from `components/ui/ADSTopbar.vue`.

**Strategy:** The extractor emits only what it can observe in the source:
- Template component tags → CALLS edges (always)
- Explicit `import` statements in `<script>` → IMPORTS edges (when present)
- No synthetic IMPORTS for auto-resolved components

Framework-convention resolution (matching `ADSTopbar` to `ADSTopbar.vue` in a components directory) is a pipeline concern, not an extractor concern. The existing pipeline call resolution pass can match CALLS edges to Module nodes by name.

---

## File Changes

### New files

| File | Purpose | Est. lines |
|---|---|---|
| `internal/cbm/extract_sfc.c` | SFC extraction: script re-parse, template walk, directive scanning | ~300-400 |
| `internal/cbm/extract_sfc.h` | Public API: `void cbm_extract_sfc(CBMExtractCtx *ctx);` | ~10 |

### Modified files

| File | Change | Est. lines |
|---|---|---|
| `internal/cbm/cbm.c` | `#include "extract_sfc.h"` + conditional call for Vue/Svelte | ~5 |
| `tests/test_extraction.c` | Replace 2 weak tests with 15 comprehensive test cases | ~200 |
| `Makefile.cbm` | Add `extract_sfc.c` to object list | ~1 |

### Unchanged files

- **`lang_specs.c`** — Vue/Svelte specs remain minimal. The real extraction happens via re-parsing with JS/TS specs.
- **`src/pipeline/pass_*.c`** — No pipeline changes. Extracted CALLS/IMPORTS edges feed into existing resolution.
- **No new dependencies** — reuses vendored tree-sitter-typescript, tree-sitter-javascript, tree-sitter-vue, tree-sitter-svelte grammars.

---

## Test Plan

### Unit tests (test_extraction.c)

**Vue script extraction:**
1. `<script>` Options API — functions, `data()`, methods extracted as definitions
2. `<script setup>` — imports, `defineProps`, `defineEmits`, `ref()`/`computed()` calls
3. `<script lang="ts">` — parsed as TypeScript, type annotations preserved
4. Both `<script>` and `<script setup>` in same file — both blocks extracted
5. Line offsets — extracted items reference correct lines in the `.vue` file

**Vue template extraction:**
6. PascalCase component tags emit CALLS edges
7. Kebab-case component tags emit CALLS edges
8. Native HTML tags (`div`, `span`, `input`) do NOT emit CALLS edges
9. `v-if`, `:bind` attributes emit usages
10. `@click`, `@submit` attributes emit calls

**Svelte extraction:**
11. `<script>` with `let`/`function` — definitions extracted
12. `<script>` imports captured
13. `<script lang="ts">` — TypeScript parsing
14. Template component tags — CALLS edges
15. `on:click`, `bind:value` — calls and usages

**Edge cases:**
16. No `<script>` block — only template extraction, no crash
17. No `<template>` block — only script extraction, no crash
18. Empty file / malformed SFC — graceful no-op, `has_error` remains false

### Integration verification

After implementation, re-index a real Vue project (anthill-design-system) and verify:
- `search_graph(name_pattern="ADSTopbar")` returns nodes with non-zero edges
- `trace_path("ADSTopbar")` finds callers (e.g., `ds.vue`)
- Component definitions show functions, imports, and composable calls

---

## Contribution Process

Per the project's CONTRIBUTING.md:

1. **Open a GitHub issue** describing the feature before submitting code
2. Keep the PR under 500 lines — this design targets ~400-500 lines total
3. One issue per PR — this is a single focused feature
4. Run `scripts/test.sh` and `scripts/lint.sh` before submitting
5. New indexing algorithms require maintainer approval — the issue should be opened first and wait for feedback
