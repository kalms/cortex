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
#include <stdlib.h>
#include <string.h>

// ---------------------------------------------------------------------------
// HTML tag allowlist — standard HTML and SVG elements (sorted for bsearch)
// ---------------------------------------------------------------------------

static const char *html_tags[] = {
    "a",          "abbr",        "address",       "area",
    "article",    "aside",       "audio",         "b",
    "base",       "bdi",         "bdo",           "blockquote",
    "body",       "br",          "button",        "canvas",
    "caption",    "circle",      "cite",          "clipPath",
    "code",       "col",         "colgroup",      "data",
    "datalist",   "dd",          "defs",          "del",
    "details",    "dfn",         "dialog",        "div",
    "dl",         "dt",          "ellipse",       "em",
    "embed",      "fieldset",    "figcaption",    "figure",
    "filter",     "footer",      "foreignObject", "form",
    "g",          "h1",          "h2",            "h3",
    "h4",         "h5",          "h6",            "head",
    "header",     "hgroup",      "hr",            "html",
    "i",          "iframe",      "image",         "img",
    "input",      "ins",         "kbd",           "label",
    "legend",     "li",          "line",          "linearGradient",
    "link",       "main",        "map",           "mark",
    "marker",     "mask",        "menu",          "meta",
    "meter",      "nav",         "noscript",      "object",
    "ol",         "optgroup",    "option",        "output",
    "p",          "param",       "path",          "pattern",
    "picture",    "polygon",     "polyline",      "pre",
    "progress",   "q",           "radialGradient","rect",
    "rp",         "rt",          "ruby",          "s",
    "samp",       "script",      "search",        "section",
    "select",     "slot",        "small",         "source",
    "span",       "stop",        "strong",        "style",
    "sub",        "summary",     "sup",           "svg",
    "switch",     "symbol",      "table",         "tbody",
    "td",         "template",    "text",          "textPath",
    "textarea",   "tfoot",       "th",            "thead",
    "time",       "title",       "tr",            "track",
    "tspan",      "u",           "ul",            "use",
    "var",        "video",       "wbr",
};

enum { HTML_TAG_COUNT = sizeof(html_tags) / sizeof(html_tags[0]) };

static int cmp_str(const void *a, const void *b) {
    return strcmp(*(const char **)a, *(const char **)b);
}

static bool is_html_tag(const char *name) {
    return bsearch(&name, html_tags, HTML_TAG_COUNT, sizeof(const char *), cmp_str) != NULL;
}

// ---------------------------------------------------------------------------
// JS literal check
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Leading identifier extraction
// ---------------------------------------------------------------------------

static const char *extract_leading_ident(CBMArena *a, const char *expr, int len) {
    int start = 0;
    while (start < len && (expr[start] == ' ' || expr[start] == '\t' ||
                           expr[start] == '\n' || expr[start] == '\r')) {
        start++;
    }
    if (start >= len) {
        return NULL;
    }
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

// Extract collection identifier from v-for: "item in items" -> "items"
static const char *extract_vfor_collection(CBMArena *a, const char *expr, int len) {
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
// Script extraction — re-parse <script> blocks with TS/JS grammar
// ---------------------------------------------------------------------------

static bool script_has_lang_ts(TSNode start_tag, const char *source) {
    uint32_t count = ts_node_named_child_count(start_tag);
    for (uint32_t i = 0; i < count; i++) {
        TSNode attr = ts_node_named_child(start_tag, i);
        if (strcmp(ts_node_type(attr), "attribute") != 0) {
            continue;
        }
        TSNode attr_name = ts_node_named_child(attr, 0);
        if (ts_node_is_null(attr_name)) {
            continue;
        }
        uint32_t ns = ts_node_start_byte(attr_name);
        uint32_t ne = ts_node_end_byte(attr_name);
        if (ne - ns != 4 || memcmp(source + ns, "lang", 4) != 0) {
            continue;
        }
        TSNode attr_val = ts_node_named_child(attr, 1);
        if (ts_node_is_null(attr_val)) {
            continue;
        }
        uint32_t vs = ts_node_start_byte(attr_val);
        uint32_t ve = ts_node_end_byte(attr_val);
        const char *val = source + vs;
        uint32_t vlen = ve - vs;
        if (vlen >= 4 && (memmem(val, vlen, "\"ts\"", 4) || memmem(val, vlen, "'ts'", 4))) {
            return true;
        }
        if (vlen >= 12 && memmem(val, vlen, "typescript", 10)) {
            return true;
        }
    }
    return false;
}

static void adjust_def_line_offsets(CBMFileResult *result, int defs_before, uint32_t offset) {
    for (int i = defs_before; i < result->defs.count; i++) {
        result->defs.items[i].start_line += offset;
        result->defs.items[i].end_line += offset;
    }
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

        TSNode start_tag = (TSNode){0};
        TSNode raw_text = (TSNode){0};
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
            continue;
        }

        bool is_ts = false;
        if (!ts_node_is_null(start_tag)) {
            is_ts = script_has_lang_ts(start_tag, ctx->source);
        }

        CBMLanguage inner_lang = is_ts ? CBM_LANG_TYPESCRIPT : CBM_LANG_JAVASCRIPT;

        uint32_t rt_start = ts_node_start_byte(raw_text);
        uint32_t rt_end = ts_node_end_byte(raw_text);
        uint32_t rt_line = ts_node_start_point(raw_text).row;
        const char *script_source = ctx->source + rt_start;
        int script_len = (int)(rt_end - rt_start);

        if (script_len <= 0) {
            continue;
        }

        TSTree *inner_tree = cbm_parse_string(script_source, script_len, inner_lang);
        if (!inner_tree) {
            continue;
        }

        TSNode inner_root = ts_tree_root_node(inner_tree);

        int defs_before = result->defs.count;

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

        cbm_extract_definitions(&inner_ctx);
        cbm_extract_imports(&inner_ctx);
        cbm_extract_unified(&inner_ctx);

        adjust_def_line_offsets(result, defs_before, rt_line);

        ts_tree_delete(inner_tree);
    }
}

// ---------------------------------------------------------------------------
// Template extraction — component tags and directive attributes
// ---------------------------------------------------------------------------

static bool is_component_tag(const char *name, int len) {
    if (len <= 0) {
        return false;
    }
    if (name[0] >= 'A' && name[0] <= 'Z') {
        return true;
    }
    for (int i = 0; i < len; i++) {
        if (name[i] == '-') {
            return true;
        }
    }
    char buf[128];
    if (len >= (int)sizeof(buf)) {
        return false;
    }
    memcpy(buf, name, (size_t)len);
    buf[len] = '\0';
    return !is_html_tag(buf);
}

static void sfc_scan_attributes(CBMExtractCtx *ctx, TSNode tag_node, bool is_vue) {
    CBMArena *a = ctx->arena;
    CBMFileResult *result = ctx->result;
    uint32_t count = ts_node_named_child_count(tag_node);

    for (uint32_t i = 0; i < count; i++) {
        TSNode attr = ts_node_named_child(tag_node, i);
        const char *attr_type = ts_node_type(attr);

        if (strcmp(attr_type, "attribute") != 0 &&
            strcmp(attr_type, "directive_attribute") != 0) {
            continue;
        }

        TSNode attr_name_node = ts_node_named_child(attr, 0);
        if (ts_node_is_null(attr_name_node)) {
            continue;
        }
        uint32_t ans = ts_node_start_byte(attr_name_node);
        uint32_t ane = ts_node_end_byte(attr_name_node);
        const char *attr_name = ctx->source + ans;
        int attr_name_len = (int)(ane - ans);

        TSNode attr_val_node = (TSNode){0};
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

        // Strip surrounding quotes
        if (val_len >= 2 && (val_raw[0] == '"' || val_raw[0] == '\'')) {
            val_raw++;
            val_len -= 2;
        }

        if (val_len <= 0) {
            continue;
        }

        if (is_vue) {
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
            bool is_event = (attr_name_len >= 3 && memcmp(attr_name, "on:", 3) == 0);
            if (is_event) {
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

static void walk_template_elements(CBMExtractCtx *ctx, TSNode node);

static void check_element_tag(CBMExtractCtx *ctx, TSNode node) {
    bool is_vue = (ctx->language == CBM_LANG_VUE);
    uint32_t count = ts_node_named_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        TSNode child = ts_node_named_child(node, i);
        const char *type = ts_node_type(child);

        if (strcmp(type, "start_tag") == 0 || strcmp(type, "self_closing_tag") == 0) {
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

            sfc_scan_attributes(ctx, child, is_vue);
        }
    }
}

static void walk_template_elements(CBMExtractCtx *ctx, TSNode node) {
    const char *type = ts_node_type(node);

    if (strcmp(type, "element") == 0 || strcmp(type, "self_closing_tag") == 0) {
        check_element_tag(ctx, node);
    }

    uint32_t count = ts_node_named_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        walk_template_elements(ctx, ts_node_named_child(node, i));
    }
}

static void sfc_extract_template(CBMExtractCtx *ctx, TSNode root) {
    bool is_vue = (ctx->language == CBM_LANG_VUE);

    if (is_vue) {
        uint32_t count = ts_node_named_child_count(root);
        for (uint32_t i = 0; i < count; i++) {
            TSNode child = ts_node_named_child(root, i);
            if (strcmp(ts_node_type(child), "element") != 0) {
                continue;
            }
            TSNode start_tag = ts_node_named_child(child, 0);
            if (ts_node_is_null(start_tag) ||
                strcmp(ts_node_type(start_tag), "start_tag") != 0) {
                continue;
            }
            TSNode tag_name = ts_node_named_child(start_tag, 0);
            if (ts_node_is_null(tag_name)) {
                continue;
            }
            uint32_t ns = ts_node_start_byte(tag_name);
            uint32_t ne = ts_node_end_byte(tag_name);
            if (ne - ns == 8 && memcmp(ctx->source + ns, "template", 8) == 0) {
                walk_template_elements(ctx, child);
                break;
            }
        }
    } else {
        // Svelte: template content is at document root
        walk_template_elements(ctx, root);
    }
}
