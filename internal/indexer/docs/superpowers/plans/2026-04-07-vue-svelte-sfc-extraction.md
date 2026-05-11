# Vue & Svelte SFC Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract functions, imports, calls, component references, and directive usages from Vue/Svelte Single File Components so they produce meaningful knowledge graph nodes and edges.

**Architecture:** New `extract_sfc.c` extractor (following `extract_k8s.c` pattern) called from `cbm_extract_file()` for Vue/Svelte files. It splits the SFC into blocks, re-parses `<script>` with TS/JS grammar using the standard extractors, and walks `<template>` for component tags and directive attributes.

**Tech Stack:** C, tree-sitter (vue, svelte, typescript, javascript grammars — all already vendored)

**Spec:** `docs/superpowers/specs/2026-04-07-vue-svelte-sfc-extraction-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `internal/cbm/extract_sfc.h` | Create | Public API: `cbm_extract_sfc()` |
| `internal/cbm/extract_sfc.c` | Create | SFC extraction: script re-parse, template walk, directive scanning |
| `internal/cbm/cbm.c` | Modify (lines ~210, ~348) | Expose `cbm_parse_string()` helper; call `cbm_extract_sfc()` for Vue/Svelte |
| `internal/cbm/cbm.h` | Modify | Declare `cbm_parse_string()` |
| `tests/test_extraction.c` | Modify (lines ~1145-1157) | Replace 2 weak tests with 18 comprehensive ones |
| `Makefile.cbm` | Modify (line ~126) | Add `extract_sfc.c` to object list |

---

### Task 1: Expose a parsing helper from cbm.c

`get_thread_parser`, `CBMStringInput`, and `cbm_string_read` are static in `cbm.c`. The SFC extractor needs to re-parse script blocks with TS/JS grammars. Rather than duplicating the thread-local parser logic, expose a thin wrapper.

**Files:**
- Modify: `internal/cbm/cbm.h`
- Modify: `internal/cbm/cbm.c`

- [ ] **Step 1: Add `cbm_parse_string` declaration to cbm.h**

Add after the `cbm_free_tree` declaration (around line 405):

```c
// Parse a source string with the given language grammar.
// Returns a TSTree* (caller must ts_tree_delete). Returns NULL on failure.
// Uses the thread-local parser pool for efficiency.
TSTree *cbm_parse_string(const char *source, int source_len, CBMLanguage language);
```

- [ ] **Step 2: Implement `cbm_parse_string` in cbm.c**

Add after `cbm_free_tree` (around line 455):

```c
TSTree *cbm_parse_string(const char *source, int source_len, CBMLanguage language) {
    const TSLanguage *ts_lang = cbm_ts_language(language);
    if (!ts_lang) {
        return NULL;
    }
    TSParser *parser = get_thread_parser(ts_lang, language);
    if (!parser) {
        return NULL;
    }
    ts_parser_reset(parser);
    CBMStringInput str_input = {source, (uint32_t)source_len};
    TSInput ts_input = {
        &str_input,
        cbm_string_read,
        TSInputEncodingUTF8,
        NULL,
    };
    TSParseOptions opts = {0};
    return ts_parser_parse_with_options(parser, NULL, ts_input, opts);
}
```

- [ ] **Step 3: Verify build**

Run: `make -f Makefile.cbm clean && make -f Makefile.cbm`
Expected: Builds successfully with no warnings.

- [ ] **Step 4: Commit**

```bash
git add internal/cbm/cbm.h internal/cbm/cbm.c
git commit -m "refactor(cbm): expose cbm_parse_string helper for sub-extractors"
```

---

### Task 2: Create extract_sfc.h and skeleton extract_sfc.c

**Files:**
- Create: `internal/cbm/extract_sfc.h`
- Create: `internal/cbm/extract_sfc.c`
- Modify: `Makefile.cbm`

- [ ] **Step 1: Create extract_sfc.h**

```c
#ifndef CBM_EXTRACT_SFC_H
#define CBM_EXTRACT_SFC_H

#include "cbm.h"

// Extract definitions, imports, calls, and usages from Vue/Svelte SFCs.
// Re-parses <script> blocks with TS/JS grammar and walks <template> for
// component references and directive attributes.
// Called from cbm_extract_file() when language is CBM_LANG_VUE or CBM_LANG_SVELTE.
void cbm_extract_sfc(CBMExtractCtx *ctx);

#endif // CBM_EXTRACT_SFC_H
```

- [ ] **Step 2: Create extract_sfc.c skeleton**

```c
// extract_sfc.c — Vue and Svelte Single File Component extractor.
//
// Re-parses <script> blocks with the TypeScript/JavaScript grammar to extract
// functions, imports, calls, and composable usage. Walks <template> elements
// to detect component references (CALLS) and directive attributes (usages/calls).
// Follows the extract_k8s.c pattern: domain-specific extractor called from
// cbm_extract_file().

#include "extract_sfc.h"
#include "arena.h"
#include "helpers.h"
#include "lang_specs.h"
#include "tree_sitter/api.h"
#include <ctype.h>
#include <string.h>

// ---------------------------------------------------------------------------
// HTML tag allowlist — standard HTML and SVG elements (sorted for bsearch)
// ---------------------------------------------------------------------------

static const char *html_tags[] = {
    "a", "abbr", "address", "area", "article", "aside", "audio",
    "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button",
    "canvas", "caption", "cite", "code", "col", "colgroup",
    "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
    "em", "embed",
    "fieldset", "figcaption", "figure", "footer", "form",
    "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
    "i", "iframe", "img", "input", "ins",
    "kbd",
    "label", "legend", "li", "link",
    "main", "map", "mark", "menu", "meta", "meter",
    "nav", "noscript",
    "object", "ol", "optgroup", "option", "output",
    "p", "param", "picture", "pre", "progress",
    "q",
    "rp", "rt", "ruby",
    "s", "samp", "script", "search", "section", "select", "slot", "small",
    "source", "span", "strong", "style", "sub", "summary", "sup",
    "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead",
    "time", "title", "tr", "track",
    "u", "ul",
    "var", "video",
    "wbr",
    // SVG elements
    "circle", "clipPath", "defs", "ellipse", "feBlend", "feColorMatrix",
    "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
    "feDisplacementMap", "feDistantLight", "feFlood", "feFuncA", "feFuncB",
    "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode",
    "feMorphology", "feOffset", "fePointLight", "feSpecularLighting",
    "feSpotLight", "feTile", "feTurbulence", "filter", "foreignObject",
    "g", "image", "line", "linearGradient", "marker", "mask",
    "path", "pattern", "polygon", "polyline", "radialGradient", "rect",
    "stop", "svg", "switch", "symbol", "text", "textPath", "tspan", "use",
};

enum { HTML_TAG_COUNT = sizeof(html_tags) / sizeof(html_tags[0]) };

static int cmp_str(const void *a, const void *b) {
    return strcmp(*(const char **)a, *(const char **)b);
}

static bool is_html_tag(const char *name) {
    return bsearch(&name, html_tags, HTML_TAG_COUNT, sizeof(const char *), cmp_str) != NULL;
}

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------

static void sfc_extract_scripts(CBMExtractCtx *ctx, TSNode root);
static void sfc_extract_template(CBMExtractCtx *ctx, TSNode root);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

void cbm_extract_sfc(CBMExtractCtx *ctx) {
    TSNode root = ctx->root;
    sfc_extract_scripts(ctx, root);
    sfc_extract_template(ctx, root);
}

// ---------------------------------------------------------------------------
// Script extraction (stub — implemented in Task 3)
// ---------------------------------------------------------------------------

static void sfc_extract_scripts(CBMExtractCtx *ctx, TSNode root) {
    (void)ctx;
    (void)root;
}

// ---------------------------------------------------------------------------
// Template extraction (stub — implemented in Task 4)
// ---------------------------------------------------------------------------

static void sfc_extract_template(CBMExtractCtx *ctx, TSNode root) {
    (void)ctx;
    (void)root;
}
```

- [ ] **Step 3: Add extract_sfc.c to Makefile.cbm**

In `Makefile.cbm`, after the `extract_k8s.c \` line (around line 126), add:

```makefile
    $(CBM_DIR)/extract_sfc.c \
```

- [ ] **Step 4: Wire cbm_extract_sfc into cbm.c**

In `internal/cbm/cbm.c`, add the include at the top (after `#include "extract_unified.h"`):

```c
#include "extract_sfc.h"
```

In `cbm_extract_file()`, after the K8s block (after line 350), add:

```c
    // SFC extraction (Vue / Svelte) — re-parse <script>, scan <template>.
    if (language == CBM_LANG_VUE || language == CBM_LANG_SVELTE) {
        cbm_extract_sfc(&ctx);
    }
```

- [ ] **Step 5: Verify build**

Run: `make -f Makefile.cbm clean && make -f Makefile.cbm`
Expected: Builds successfully. Existing tests still pass (the stubs are no-ops).

- [ ] **Step 6: Run existing tests**

Run: `scripts/test.sh`
Expected: All tests pass, including existing `vue_component` and `svelte_component`.

- [ ] **Step 7: Commit**

```bash
git add internal/cbm/extract_sfc.h internal/cbm/extract_sfc.c internal/cbm/cbm.c Makefile.cbm
git commit -m "feat(sfc): add extract_sfc skeleton wired into cbm_extract_file"
```

---

### Task 3: Implement script block extraction

**Files:**
- Modify: `internal/cbm/extract_sfc.c`
- Modify: `tests/test_extraction.c`

- [ ] **Step 1: Write failing tests for Vue script extraction**

In `tests/test_extraction.c`, replace the existing `vue_component` test (lines ~1146-1157) with:

```c
/* --- Vue SFC: script extraction --- */

TEST(vue_script_options_api) {
    CBMFileResult *r = extract(
        "<template><div>hello</div></template>\n"
        "<script>\n"
        "export default {\n"
        "  name: 'App',\n"
        "  data() { return { message: 'Hello' }; },\n"
        "  methods: { greet() { return this.message; } }\n"
        "};\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "App.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "data"));
    ASSERT_TRUE(has_def_any(r, "greet"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_script_setup) {
    CBMFileResult *r = extract(
        "<template><div>{{ count }}</div></template>\n"
        "<script setup>\n"
        "import { ref, computed } from 'vue';\n"
        "const count = ref(0);\n"
        "const doubled = computed(() => count.value * 2);\n"
        "function increment() { count.value++; }\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "Counter.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "vue"));
    ASSERT_TRUE(has_call(r, "ref"));
    ASSERT_TRUE(has_call(r, "computed"));
    ASSERT_TRUE(has_def_any(r, "increment"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_script_lang_ts) {
    CBMFileResult *r = extract(
        "<template><div>typed</div></template>\n"
        "<script lang=\"ts\">\n"
        "interface Props { title: string; }\n"
        "export default {\n"
        "  props: {} as Props,\n"
        "  setup() { return {}; }\n"
        "};\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "Typed.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* TypeScript parsed — should extract setup as a definition */
    ASSERT_TRUE(has_def_any(r, "setup"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_dual_script_blocks) {
    CBMFileResult *r = extract(
        "<script>\n"
        "export const meta = { title: 'Page' };\n"
        "</script>\n"
        "<script setup>\n"
        "import { ref } from 'vue';\n"
        "const name = ref('world');\n"
        "</script>\n"
        "<template><div>{{ name }}</div></template>\n",
        CBM_LANG_VUE, "t", "Dual.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "vue"));
    ASSERT_TRUE(has_call(r, "ref"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_script_line_offsets) {
    CBMFileResult *r = extract(
        "<template>\n"              /* line 0 */
        "  <div>hello</div>\n"      /* line 1 */
        "</template>\n"             /* line 2 */
        "<script>\n"                /* line 3 */
        "function myFunc() {}\n"    /* line 4 */
        "</script>\n",              /* line 5 */
        CBM_LANG_VUE, "t", "Offset.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "myFunc"));
    /* myFunc should be on line 4, not line 0 */
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].name, "myFunc") == 0) {
            ASSERT_GTE(r->defs.items[i].start_line, 4);
            break;
        }
    }
    cbm_free_result(r);
    PASS();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `scripts/test.sh 2>&1 | grep -E "FAIL|vue_script"`
Expected: All 5 new tests FAIL (the stub `sfc_extract_scripts` is a no-op).

- [ ] **Step 3: Implement sfc_extract_scripts**

Replace the stub in `extract_sfc.c` with:

```c
// ---------------------------------------------------------------------------
// Script extraction — re-parse <script> blocks with TS/JS grammar
// ---------------------------------------------------------------------------

// Check if a <script> tag has lang="ts" or lang="typescript" attribute.
static bool script_has_lang_ts(TSNode start_tag, const char *source) {
    uint32_t count = ts_node_named_child_count(start_tag);
    for (uint32_t i = 0; i < count; i++) {
        TSNode attr = ts_node_named_child(start_tag, i);
        if (strcmp(ts_node_type(attr), "attribute") != 0) {
            continue;
        }
        // Check attribute_name == "lang"
        TSNode attr_name = ts_node_named_child(attr, 0);
        if (ts_node_is_null(attr_name)) {
            continue;
        }
        uint32_t ns = ts_node_start_byte(attr_name);
        uint32_t ne = ts_node_end_byte(attr_name);
        if (ne - ns != 4 || memcmp(source + ns, "lang", 4) != 0) {
            continue;
        }
        // Check attribute value contains "ts" or "typescript"
        TSNode attr_val = ts_node_named_child(attr, 1);
        if (ts_node_is_null(attr_val)) {
            continue;
        }
        uint32_t vs = ts_node_start_byte(attr_val);
        uint32_t ve = ts_node_end_byte(attr_val);
        // Quoted values include quotes — check inner content
        const char *val = source + vs;
        uint32_t vlen = ve - vs;
        if (vlen >= 4 && (memmem(val, vlen, "\"ts\"", 4) || memmem(val, vlen, "'ts'", 4))) {
            return true;
        }
        if (vlen >= 12 && (memmem(val, vlen, "typescript", 10))) {
            return true;
        }
    }
    return false;
}

// Adjust line offsets for all result items added after the "before" counts.
static void adjust_line_offsets(CBMFileResult *result, int defs_before, int imports_before,
                                int calls_before, int usages_before, uint32_t offset) {
    for (int i = defs_before; i < result->defs.count; i++) {
        result->defs.items[i].start_line += offset;
        result->defs.items[i].end_line += offset;
    }
    // Imports don't have line numbers in the struct — skip
    (void)imports_before;
    for (int i = calls_before; i < result->calls.count; i++) {
        // CBMCall doesn't have line numbers in the struct — the pipeline
        // resolves call locations from the caller function's range.
        // No adjustment needed.
    }
    (void)calls_before;
    for (int i = usages_before; i < result->usages.count; i++) {
        // CBMUsage doesn't have line numbers — skip
    }
    (void)usages_before;
}

static void sfc_extract_scripts(CBMExtractCtx *ctx, TSNode root) {
    CBMArena *a = ctx->arena;
    CBMFileResult *result = ctx->result;
    uint32_t child_count = ts_node_named_child_count(root);

    for (uint32_t i = 0; i < child_count; i++) {
        TSNode child = ts_node_named_child(root, i);
        const char *type = ts_node_type(child);

        if (strcmp(type, "script_element") != 0) {
            continue;
        }

        // Find the start_tag and raw_text children
        TSNode start_tag = {0};
        TSNode raw_text = {0};
        uint32_t sc_count = ts_node_named_child_count(child);
        for (uint32_t j = 0; j < sc_count; j++) {
            TSNode sc = ts_node_named_child(child, j);
            const char *sc_type = ts_node_type(sc);
            if (strcmp(sc_type, "start_tag") == 0) {
                start_tag = sc;
            } else if (strcmp(sc_type, "raw_text") == 0) {
                raw_text = sc;
            }
        }

        if (ts_node_is_null(raw_text)) {
            continue; // empty <script></script>
        }

        // Detect lang="ts"
        bool is_ts = false;
        if (!ts_node_is_null(start_tag)) {
            is_ts = script_has_lang_ts(start_tag, ctx->source);
        }

        CBMLanguage inner_lang = is_ts ? CBM_LANG_TYPESCRIPT : CBM_LANG_JAVASCRIPT;

        // Extract raw_text source and offset
        uint32_t rt_start = ts_node_start_byte(raw_text);
        uint32_t rt_end = ts_node_end_byte(raw_text);
        uint32_t rt_line = ts_node_start_point(raw_text).row;
        const char *script_source = ctx->source + rt_start;
        int script_len = (int)(rt_end - rt_start);

        if (script_len <= 0) {
            continue;
        }

        // Re-parse with TS/JS grammar
        TSTree *inner_tree = cbm_parse_string(script_source, script_len, inner_lang);
        if (!inner_tree) {
            continue;
        }

        TSNode inner_root = ts_tree_root_node(inner_tree);

        // Record counts before extraction
        int defs_before = result->defs.count;
        int imports_before = result->imports.count;
        int calls_before = result->calls.count;
        int usages_before = result->usages.count;

        // Build inner context
        CBMExtractCtx inner_ctx = {
            .arena = a,
            .result = result,
            .source = script_source,
            .source_len = script_len,
            .language = inner_lang,
            .project = ctx->project,
            .rel_path = ctx->rel_path,
            .module_qn = ctx->module_qn,
            .root = inner_root,
        };

        // Run standard extractors
        cbm_extract_definitions(&inner_ctx);
        cbm_extract_imports(&inner_ctx);
        cbm_extract_unified(&inner_ctx);

        // Adjust line offsets
        adjust_line_offsets(result, defs_before, imports_before,
                           calls_before, usages_before, rt_line);

        ts_tree_delete(inner_tree);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `scripts/test.sh 2>&1 | grep -E "PASS|FAIL|vue_script"`
Expected: All 5 `vue_script_*` tests PASS. All existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add internal/cbm/extract_sfc.c tests/test_extraction.c
git commit -m "feat(sfc): implement script block extraction with TS/JS re-parsing"
```

---

### Task 4: Implement template component tag extraction

**Files:**
- Modify: `internal/cbm/extract_sfc.c`
- Modify: `tests/test_extraction.c`

- [ ] **Step 1: Write failing tests for template component detection**

Add to `tests/test_extraction.c` after the Vue script tests:

```c
/* --- Vue SFC: template component extraction --- */

TEST(vue_template_pascal_component) {
    CBMFileResult *r = extract(
        "<template>\n"
        "  <div>\n"
        "    <MyHeader />\n"
        "    <ADSTopbar title=\"hello\" />\n"
        "    <ContentBox><span>hi</span></ContentBox>\n"
        "  </div>\n"
        "</template>\n"
        "<script setup>\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "Page.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "MyHeader"));
    ASSERT_TRUE(has_call(r, "ADSTopbar"));
    ASSERT_TRUE(has_call(r, "ContentBox"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_template_kebab_component) {
    CBMFileResult *r = extract(
        "<template>\n"
        "  <my-component />\n"
        "  <v-btn>Click</v-btn>\n"
        "</template>\n",
        CBM_LANG_VUE, "t", "Kebab.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "my-component"));
    ASSERT_TRUE(has_call(r, "v-btn"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_template_html_not_component) {
    CBMFileResult *r = extract(
        "<template>\n"
        "  <div><span>text</span><input /><a href=\"#\">link</a></div>\n"
        "</template>\n",
        CBM_LANG_VUE, "t", "Native.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* Native HTML tags should NOT produce calls */
    ASSERT_FALSE(has_call(r, "div"));
    ASSERT_FALSE(has_call(r, "span"));
    ASSERT_FALSE(has_call(r, "input"));
    ASSERT_FALSE(has_call(r, "a"));
    cbm_free_result(r);
    PASS();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `scripts/test.sh 2>&1 | grep -E "FAIL|vue_template"`
Expected: All 3 new tests FAIL.

- [ ] **Step 3: Implement template component tag walking**

Replace the `sfc_extract_template` stub in `extract_sfc.c` with:

```c
// ---------------------------------------------------------------------------
// Template extraction — component tags and directive attributes
// ---------------------------------------------------------------------------

// Check if a tag name is a custom component (not native HTML).
static bool is_component_tag(const char *name, int len) {
    if (len <= 0) {
        return false;
    }
    // PascalCase: starts with uppercase
    if (name[0] >= 'A' && name[0] <= 'Z') {
        return true;
    }
    // Contains hyphen: custom element (HTML elements don't have hyphens)
    for (int i = 0; i < len; i++) {
        if (name[i] == '-') {
            return true;
        }
    }
    // Check allowlist
    // Need null-terminated copy for bsearch
    char buf[128];
    if (len >= (int)sizeof(buf)) {
        return false;
    }
    memcpy(buf, name, (size_t)len);
    buf[len] = '\0';
    return !is_html_tag(buf);
}

// Recursively walk template nodes, emitting CALLS for component tags.
static void walk_template_elements(CBMExtractCtx *ctx, TSNode node);

// Extract the tag_name from an element or self_closing_tag, emit CALLS if component.
static void check_element_tag(CBMExtractCtx *ctx, TSNode node) {
    uint32_t count = ts_node_named_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        TSNode child = ts_node_named_child(node, i);
        const char *type = ts_node_type(child);

        if (strcmp(type, "start_tag") == 0 || strcmp(type, "self_closing_tag") == 0) {
            // First named child of start_tag/self_closing_tag is tag_name
            TSNode tag_name_node = ts_node_named_child(child, 0);
            if (ts_node_is_null(tag_name_node)) {
                continue;
            }
            if (strcmp(ts_node_type(tag_name_node), "tag_name") != 0) {
                continue;
            }
            uint32_t ns = ts_node_start_byte(tag_name_node);
            uint32_t ne = ts_node_end_byte(tag_name_node);
            int len = (int)(ne - ns);
            const char *name_raw = ctx->source + ns;

            if (is_component_tag(name_raw, len)) {
                char *name = cbm_arena_strndup(ctx->arena, name_raw, (size_t)len);
                if (name) {
                    CBMCall call = {0};
                    call.callee_name = name;
                    call.enclosing_func_qn = ctx->module_qn;
                    cbm_calls_push(&ctx->result->calls, ctx->arena, call);
                }
            }

            // Also scan attributes on this tag for directives (Task 5)
            // sfc_scan_attributes(ctx, child);
        }
    }
}

static void walk_template_elements(CBMExtractCtx *ctx, TSNode node) {
    const char *type = ts_node_type(node);

    if (strcmp(type, "element") == 0 || strcmp(type, "self_closing_tag") == 0) {
        check_element_tag(ctx, node);
    }

    // Recurse into children
    uint32_t count = ts_node_named_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        walk_template_elements(ctx, ts_node_named_child(node, i));
    }
}

static void sfc_extract_template(CBMExtractCtx *ctx, TSNode root) {
    bool is_vue = (ctx->language == CBM_LANG_VUE);

    if (is_vue) {
        // Vue: find the <template> element wrapper
        uint32_t count = ts_node_named_child_count(root);
        for (uint32_t i = 0; i < count; i++) {
            TSNode child = ts_node_named_child(root, i);
            if (strcmp(ts_node_type(child), "element") != 0) {
                continue;
            }
            // Check if this element's tag_name is "template"
            TSNode start_tag = ts_node_named_child(child, 0);
            if (ts_node_is_null(start_tag)) {
                continue;
            }
            if (strcmp(ts_node_type(start_tag), "start_tag") != 0) {
                continue;
            }
            TSNode tag_name = ts_node_named_child(start_tag, 0);
            if (ts_node_is_null(tag_name)) {
                continue;
            }
            uint32_t ns = ts_node_start_byte(tag_name);
            uint32_t ne = ts_node_end_byte(tag_name);
            if (ne - ns == 8 && memcmp(ctx->source + ns, "template", 8) == 0) {
                // Walk inside the <template> element
                walk_template_elements(ctx, child);
                break;
            }
        }
    } else {
        // Svelte: template content is at document root (no wrapper)
        walk_template_elements(ctx, root);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `scripts/test.sh 2>&1 | grep -E "PASS|FAIL|vue_template"`
Expected: All 3 `vue_template_*` tests PASS. All previous tests still pass.

- [ ] **Step 5: Commit**

```bash
git add internal/cbm/extract_sfc.c tests/test_extraction.c
git commit -m "feat(sfc): extract component tag references from templates"
```

---

### Task 5: Implement directive attribute extraction

**Files:**
- Modify: `internal/cbm/extract_sfc.c`
- Modify: `tests/test_extraction.c`

- [ ] **Step 1: Write failing tests for directive extraction**

Add to `tests/test_extraction.c`:

```c
/* --- Vue SFC: directive attribute extraction --- */

TEST(vue_directives_usages) {
    CBMFileResult *r = extract(
        "<template>\n"
        "  <div v-if=\"isActive\" :class=\"computedClass\">\n"
        "    <span v-for=\"item in items\">{{ item }}</span>\n"
        "    <input v-model=\"formData\" />\n"
        "  </div>\n"
        "</template>\n"
        "<script setup>\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "Directives.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* v-if, :class, v-for collection, v-model should be usages */
    ASSERT_GTE(r->usages.count, 1);
    cbm_free_result(r);
    PASS();
}

TEST(vue_directives_events) {
    CBMFileResult *r = extract(
        "<template>\n"
        "  <button @click=\"handleClick\">Go</button>\n"
        "  <form @submit=\"onSubmit\">\n"
        "    <input @input=\"onChange\" />\n"
        "  </form>\n"
        "</template>\n"
        "<script setup>\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "Events.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "handleClick"));
    ASSERT_TRUE(has_call(r, "onSubmit"));
    ASSERT_TRUE(has_call(r, "onChange"));
    cbm_free_result(r);
    PASS();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `scripts/test.sh 2>&1 | grep -E "FAIL|vue_directive"`
Expected: Both tests FAIL.

- [ ] **Step 3: Implement directive attribute scanning**

Add to `extract_sfc.c`, before `walk_template_elements`:

```c
// ---------------------------------------------------------------------------
// Directive attribute scanning
// ---------------------------------------------------------------------------

// Known JS literals to skip when extracting leading identifier.
static bool is_js_literal(const char *s, int len) {
    if (len == 4 && (memcmp(s, "true", 4) == 0 || memcmp(s, "null", 4) == 0)) {
        return true;
    }
    if (len == 5 && memcmp(s, "false", 5) == 0) {
        return true;
    }
    if (len == 9 && memcmp(s, "undefined", 9) == 0) {
        return true;
    }
    return false;
}

// Extract leading identifier from an expression string.
// Returns arena-allocated string or NULL.
static const char *extract_leading_ident(CBMArena *a, const char *expr, int len) {
    // Skip whitespace
    int start = 0;
    while (start < len && (expr[start] == ' ' || expr[start] == '\t' ||
                           expr[start] == '\n' || expr[start] == '\r')) {
        start++;
    }
    if (start >= len) {
        return NULL;
    }
    // Must start with [a-zA-Z_$]
    char c = expr[start];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$')) {
        return NULL;
    }
    int end = start + 1;
    while (end < len) {
        c = expr[end];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '$') {
            end++;
        } else {
            break;
        }
    }
    int ident_len = end - start;
    if (is_js_literal(expr + start, ident_len)) {
        return NULL;
    }
    return cbm_arena_strndup(a, expr + start, (size_t)ident_len);
}

// Extract the identifier after "in" or "of" keyword for v-for expressions.
// e.g. "item in items" → "items", "(val, key) in obj" → "obj"
static const char *extract_vfor_collection(CBMArena *a, const char *expr, int len) {
    // Search for " in " or " of "
    for (int i = 0; i < len - 3; i++) {
        bool is_in = (i + 4 <= len && expr[i] == ' ' &&
                      expr[i + 1] == 'i' && expr[i + 2] == 'n' && expr[i + 3] == ' ');
        bool is_of = (i + 4 <= len && expr[i] == ' ' &&
                      expr[i + 1] == 'o' && expr[i + 2] == 'f' && expr[i + 3] == ' ');
        if (is_in || is_of) {
            return extract_leading_ident(a, expr + i + 4, len - i - 4);
        }
    }
    return NULL;
}

// Scan attributes on a start_tag or self_closing_tag node.
// Emits usages for v-if, :bind, v-model, v-for; calls for @event.
static void sfc_scan_attributes(CBMExtractCtx *ctx, TSNode tag_node, bool is_vue) {
    CBMArena *a = ctx->arena;
    CBMFileResult *result = ctx->result;
    uint32_t count = ts_node_named_child_count(tag_node);

    for (uint32_t i = 0; i < count; i++) {
        TSNode attr = ts_node_named_child(tag_node, i);
        const char *attr_type = ts_node_type(attr);

        // Vue: directive attributes appear as "directive_attribute" nodes
        // or regular "attribute" nodes with special prefixes
        // We check raw text for both cases
        if (strcmp(attr_type, "attribute") != 0 &&
            strcmp(attr_type, "directive_attribute") != 0) {
            continue;
        }

        // Get attribute name
        TSNode attr_name_node = ts_node_named_child(attr, 0);
        if (ts_node_is_null(attr_name_node)) {
            continue;
        }
        uint32_t ans = ts_node_start_byte(attr_name_node);
        uint32_t ane = ts_node_end_byte(attr_name_node);
        const char *attr_name = ctx->source + ans;
        int attr_name_len = (int)(ane - ans);

        // Get attribute value (may be in quoted_attribute_value or attribute_value)
        TSNode attr_val_node = {0};
        uint32_t ac = ts_node_named_child_count(attr);
        for (uint32_t j = 1; j < ac; j++) {
            TSNode candidate = ts_node_named_child(attr, j);
            const char *ct = ts_node_type(candidate);
            if (strcmp(ct, "quoted_attribute_value") == 0 ||
                strcmp(ct, "attribute_value") == 0) {
                attr_val_node = candidate;
                break;
            }
        }
        if (ts_node_is_null(attr_val_node)) {
            continue;
        }

        uint32_t vs = ts_node_start_byte(attr_val_node);
        uint32_t ve = ts_node_end_byte(attr_val_node);
        const char *val_raw = ctx->source + vs;
        int val_len = (int)(ve - vs);

        // Strip surrounding quotes if present
        if (val_len >= 2 && (val_raw[0] == '"' || val_raw[0] == '\'')) {
            val_raw++;
            val_len -= 2;
        }

        if (val_len <= 0) {
            continue;
        }

        if (is_vue) {
            // Vue event: @click or v-on:click → emit as call
            bool is_event = (attr_name_len >= 1 && attr_name[0] == '@') ||
                            (attr_name_len >= 5 && memcmp(attr_name, "v-on:", 5) == 0);
            if (is_event) {
                const char *ident = extract_leading_ident(a, val_raw, val_len);
                if (ident) {
                    CBMCall call = {0};
                    call.callee_name = ident;
                    call.enclosing_func_qn = ctx->module_qn;
                    cbm_calls_push(&result->calls, a, call);
                }
                continue;
            }

            // Vue v-for → extract collection identifier
            bool is_vfor = (attr_name_len == 5 && memcmp(attr_name, "v-for", 5) == 0);
            if (is_vfor) {
                const char *ident = extract_vfor_collection(a, val_raw, val_len);
                if (ident) {
                    CBMUsage usage = {0};
                    usage.ref_name = ident;
                    usage.enclosing_func_qn = ctx->module_qn;
                    cbm_usages_push(&result->usages, a, usage);
                }
                continue;
            }

            // Vue binding/directive: v-if, v-model, :prop, v-bind:prop → usage
            bool is_directive = (attr_name_len >= 2 && attr_name[0] == ':') ||
                                (attr_name_len >= 2 && memcmp(attr_name, "v-", 2) == 0);
            if (is_directive) {
                const char *ident = extract_leading_ident(a, val_raw, val_len);
                if (ident) {
                    CBMUsage usage = {0};
                    usage.ref_name = ident;
                    usage.enclosing_func_qn = ctx->module_qn;
                    cbm_usages_push(&result->usages, a, usage);
                }
                continue;
            }
        } else {
            // Svelte event: on:click={handler} → call
            bool is_event = (attr_name_len >= 3 && memcmp(attr_name, "on:", 3) == 0);
            if (is_event) {
                // Svelte uses {handler} — strip braces
                const char *v = val_raw;
                int vl = val_len;
                if (vl >= 2 && v[0] == '{') {
                    v++;
                    vl -= 2;
                }
                const char *ident = extract_leading_ident(a, v, vl);
                if (ident) {
                    CBMCall call = {0};
                    call.callee_name = ident;
                    call.enclosing_func_qn = ctx->module_qn;
                    cbm_calls_push(&result->calls, a, call);
                }
                continue;
            }

            // Svelte bind:prop={value} → usage
            bool is_bind = (attr_name_len >= 5 && memcmp(attr_name, "bind:", 5) == 0);
            if (is_bind) {
                const char *v = val_raw;
                int vl = val_len;
                if (vl >= 2 && v[0] == '{') {
                    v++;
                    vl -= 2;
                }
                const char *ident = extract_leading_ident(a, v, vl);
                if (ident) {
                    CBMUsage usage = {0};
                    usage.ref_name = ident;
                    usage.enclosing_func_qn = ctx->module_qn;
                    cbm_usages_push(&result->usages, a, usage);
                }
                continue;
            }
        }
    }
}
```

- [ ] **Step 4: Wire sfc_scan_attributes into check_element_tag**

In `check_element_tag`, uncomment the attribute scanning call. Replace the commented line `// sfc_scan_attributes(ctx, child);` with:

```c
            // Scan directive attributes
            bool is_vue = (ctx->language == CBM_LANG_VUE);
            sfc_scan_attributes(ctx, child, is_vue);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `scripts/test.sh 2>&1 | grep -E "PASS|FAIL|vue_directive"`
Expected: Both `vue_directives_*` tests PASS. All previous tests still pass.

- [ ] **Step 6: Commit**

```bash
git add internal/cbm/extract_sfc.c tests/test_extraction.c
git commit -m "feat(sfc): extract directive attributes from Vue templates"
```

---

### Task 6: Add Svelte-specific tests

**Files:**
- Modify: `tests/test_extraction.c`

- [ ] **Step 1: Write Svelte extraction tests**

Replace the existing `svelte_component` test (lines ~1134-1143) with:

```c
/* --- Svelte SFC extraction --- */

TEST(svelte_script_defs) {
    CBMFileResult *r = extract(
        "<script>\n"
        "  let name = 'World';\n"
        "  function greet() { return `Hello ${name}`; }\n"
        "</script>\n"
        "<h1>{greet()}</h1>\n",
        CBM_LANG_SVELTE, "t", "App.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "greet"));
    cbm_free_result(r);
    PASS();
}

TEST(svelte_script_imports) {
    CBMFileResult *r = extract(
        "<script>\n"
        "  import { onMount } from 'svelte';\n"
        "  import Button from './Button.svelte';\n"
        "  onMount(() => { console.log('mounted'); });\n"
        "</script>\n"
        "<Button />\n",
        CBM_LANG_SVELTE, "t", "Page.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "svelte"));
    ASSERT_TRUE(has_call(r, "onMount"));
    ASSERT_TRUE(has_call(r, "Button"));
    cbm_free_result(r);
    PASS();
}

TEST(svelte_script_lang_ts) {
    CBMFileResult *r = extract(
        "<script lang=\"ts\">\n"
        "  interface User { name: string; }\n"
        "  export function getUser(): User { return { name: 'test' }; }\n"
        "</script>\n"
        "<p>hello</p>\n",
        CBM_LANG_SVELTE, "t", "Typed.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "getUser"));
    cbm_free_result(r);
    PASS();
}

TEST(svelte_template_components) {
    CBMFileResult *r = extract(
        "<script>\n"
        "  import Header from './Header.svelte';\n"
        "</script>\n"
        "<Header />\n"
        "<my-widget>content</my-widget>\n"
        "<div><span>native</span></div>\n",
        CBM_LANG_SVELTE, "t", "Layout.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "Header"));
    ASSERT_TRUE(has_call(r, "my-widget"));
    ASSERT_FALSE(has_call(r, "div"));
    ASSERT_FALSE(has_call(r, "span"));
    cbm_free_result(r);
    PASS();
}

TEST(svelte_event_and_bind) {
    CBMFileResult *r = extract(
        "<script>\n"
        "  let value = '';\n"
        "  function handleClick() {}\n"
        "</script>\n"
        "<button on:click={handleClick}>Go</button>\n"
        "<input bind:value={value} />\n",
        CBM_LANG_SVELTE, "t", "Interactive.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "handleClick"));
    ASSERT_GTE(r->usages.count, 1);
    cbm_free_result(r);
    PASS();
}
```

- [ ] **Step 2: Update the RUN_TEST list**

In the `main` function of `test_extraction.c`, replace `RUN_TEST(svelte_component);` and `RUN_TEST(vue_component);` with:

```c
    /* Vue SFC */
    RUN_TEST(vue_script_options_api);
    RUN_TEST(vue_script_setup);
    RUN_TEST(vue_script_lang_ts);
    RUN_TEST(vue_dual_script_blocks);
    RUN_TEST(vue_script_line_offsets);
    RUN_TEST(vue_template_pascal_component);
    RUN_TEST(vue_template_kebab_component);
    RUN_TEST(vue_template_html_not_component);
    RUN_TEST(vue_directives_usages);
    RUN_TEST(vue_directives_events);
    /* Svelte SFC */
    RUN_TEST(svelte_script_defs);
    RUN_TEST(svelte_script_imports);
    RUN_TEST(svelte_script_lang_ts);
    RUN_TEST(svelte_template_components);
    RUN_TEST(svelte_event_and_bind);
```

- [ ] **Step 3: Run all tests**

Run: `scripts/test.sh 2>&1 | grep -E "PASS|FAIL|svelte_"`
Expected: All 5 Svelte tests PASS. All Vue tests still pass.

- [ ] **Step 4: Commit**

```bash
git add tests/test_extraction.c
git commit -m "test(sfc): add comprehensive Svelte extraction tests"
```

---

### Task 7: Add edge case tests

**Files:**
- Modify: `tests/test_extraction.c`

- [ ] **Step 1: Write edge case tests**

```c
/* --- SFC edge cases --- */

TEST(vue_no_script) {
    CBMFileResult *r = extract(
        "<template>\n"
        "  <MyComponent />\n"
        "  <div>static content</div>\n"
        "</template>\n",
        CBM_LANG_VUE, "t", "NoScript.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "MyComponent"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_no_template) {
    CBMFileResult *r = extract(
        "<script setup>\n"
        "import { ref } from 'vue';\n"
        "const x = ref(0);\n"
        "</script>\n",
        CBM_LANG_VUE, "t", "NoTemplate.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "vue"));
    ASSERT_TRUE(has_call(r, "ref"));
    cbm_free_result(r);
    PASS();
}

TEST(vue_empty_file) {
    CBMFileResult *r = extract("", CBM_LANG_VUE, "t", "Empty.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    cbm_free_result(r);
    PASS();
}
```

- [ ] **Step 2: Add to RUN_TEST list**

```c
    /* SFC edge cases */
    RUN_TEST(vue_no_script);
    RUN_TEST(vue_no_template);
    RUN_TEST(vue_empty_file);
```

- [ ] **Step 3: Run all tests**

Run: `scripts/test.sh`
Expected: All tests pass, including the 3 new edge cases.

- [ ] **Step 4: Commit**

```bash
git add tests/test_extraction.c
git commit -m "test(sfc): add edge case tests for missing blocks and empty files"
```

---

### Task 8: Run linter and fix issues

**Files:**
- Possibly modify: `internal/cbm/extract_sfc.c`, `internal/cbm/extract_sfc.h`

- [ ] **Step 1: Run linter**

Run: `scripts/lint.sh`
Expected: All checks pass (clang-tidy, cppcheck, clang-format).

- [ ] **Step 2: Fix any lint issues**

If clang-format reports formatting differences, apply them:

Run: `clang-format -i internal/cbm/extract_sfc.c internal/cbm/extract_sfc.h`

If clang-tidy or cppcheck reports warnings, fix them in the relevant files.

- [ ] **Step 3: Re-run tests after fixes**

Run: `scripts/test.sh`
Expected: All tests still pass.

- [ ] **Step 4: Commit fixes if any**

```bash
git add internal/cbm/extract_sfc.c internal/cbm/extract_sfc.h
git commit -m "style(sfc): fix lint issues"
```

---

### Task 9: Integration verification with real Vue project

**Files:** None (verification only)

- [ ] **Step 1: Build the updated binary**

Run: `make -f Makefile.cbm clean && make -f Makefile.cbm`
Expected: Clean build, no warnings.

- [ ] **Step 2: Install locally and re-index anthill-design-system**

Run the built binary to re-index the real Vue project. Use the MCP tools to verify the graph now has meaningful edges for Vue components.

Verify these pass:
- `search_graph(name_pattern="ADSTopbar")` returns nodes with non-zero in_degree or out_degree
- Vue component files show function definitions, import edges, and call edges
- `trace_path("ADSTopbar")` finds callers (e.g., `ds.vue`)

- [ ] **Step 3: Spot-check a Svelte file if available**

If any `.svelte` files exist in the test repos, verify they also produce meaningful graph nodes.

- [ ] **Step 4: Document results**

Note which verifications passed/failed. If any issues are found, create follow-up tasks.
