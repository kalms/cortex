/*
 * cypher.c — Cypher query engine: lexer, parser, planner, executor.
 *
 * Translates a subset of Cypher into SQL queries against cbm_store.
 * Supports MATCH patterns with relationships, WHERE filters,
 * RETURN with COUNT/ORDER BY/LIMIT/DISTINCT.
 */
#include "cypher/cypher.h"
#include "store/store.h"
#include "foundation/platform.h"

#include <ctype.h>
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Helpers ────────────────────────────────────────────────────── */

static char *heap_strdup(const char *s) {
    if (!s)
        return NULL;
    size_t len = strlen(s);
    char *d = malloc(len + 1);
    if (d)
        memcpy(d, s, len + 1);
    return d;
}

static char *heap_strndup(const char *s, size_t n) {
    char *d = malloc(n + 1);
    if (d) {
        memcpy(d, s, n);
        d[n] = '\0';
    }
    return d;
}

/* ══════════════════════════════════════════════════════════════════
 *  LEXER
 * ══════════════════════════════════════════════════════════════════ */

static void lex_push(cbm_lex_result_t *r, cbm_token_type_t type, const char *text, int pos) {
    if (r->count >= r->capacity) {
        r->capacity = r->capacity ? r->capacity * 2 : 32;
        r->tokens = safe_realloc(r->tokens, r->capacity * sizeof(cbm_token_t));
    }
    r->tokens[r->count++] = (cbm_token_t){.type = type, .text = heap_strdup(text), .pos = pos};
}

static void lex_push_n(cbm_lex_result_t *r, cbm_token_type_t type, const char *start, size_t len,
                       int pos) {
    if (r->count >= r->capacity) {
        r->capacity = r->capacity ? r->capacity * 2 : 32;
        r->tokens = safe_realloc(r->tokens, r->capacity * sizeof(cbm_token_t));
    }
    r->tokens[r->count++] =
        (cbm_token_t){.type = type, .text = heap_strndup(start, len), .pos = pos};
}

/* Keyword table (case-insensitive lookup) */
typedef struct {
    const char *name;
    cbm_token_type_t type;
} kw_entry_t;
static const kw_entry_t keywords[] = {
    {"MATCH", TOK_MATCH},       {"WHERE", TOK_WHERE}, {"RETURN", TOK_RETURN},
    {"ORDER", TOK_ORDER},       {"BY", TOK_BY},       {"LIMIT", TOK_LIMIT},
    {"AND", TOK_AND},           {"OR", TOK_OR},       {"AS", TOK_AS},
    {"DISTINCT", TOK_DISTINCT}, {"COUNT", TOK_COUNT}, {"CONTAINS", TOK_CONTAINS},
    {"STARTS", TOK_STARTS},     {"WITH", TOK_WITH},   {"NOT", TOK_NOT},
    {"ASC", TOK_ASC},           {"DESC", TOK_DESC},   {NULL, 0}};

static cbm_token_type_t keyword_lookup(const char *word) {
    /* Case-insensitive compare */
    for (const kw_entry_t *kw = keywords; kw->name; kw++) {
        if (strcasecmp(word, kw->name) == 0)
            return kw->type;
    }
    return TOK_IDENT;
}

int cbm_lex(const char *input, cbm_lex_result_t *out) {
    memset(out, 0, sizeof(*out));
    if (!input)
        return -1;

    int len = (int)strlen(input);
    int i = 0;

    while (i < len) {
        /* Skip whitespace */
        if (isspace((unsigned char)input[i])) {
            i++;
            continue;
        }

        /* Skip // line comments */
        if (i + 1 < len && input[i] == '/' && input[i + 1] == '/') {
            while (i < len && input[i] != '\n')
                i++;
            continue;
        }
        /* Skip block comments */
        if (i + 1 < len && input[i] == '/' && input[i + 1] == '*') {
            i += 2;
            while (i + 1 < len && !(input[i] == '*' && input[i + 1] == '/'))
                i++;
            if (i + 1 < len)
                i += 2;
            continue;
        }

        char c = input[i];

        /* String literals */
        if (c == '"' || c == '\'') {
            char quote = c;
            i++;
            int start = i;
            /* Build string handling escapes */
            char buf[4096];
            int blen = 0;
            while (i < len && input[i] != quote) {
                if (input[i] == '\\' && i + 1 < len) {
                    i++;
                    switch (input[i]) {
                    case 'n':
                        buf[blen++] = '\n';
                        break;
                    case 't':
                        buf[blen++] = '\t';
                        break;
                    case '\\':
                        buf[blen++] = '\\';
                        break;
                    default:
                        buf[blen++] = input[i];
                        break;
                    }
                } else {
                    buf[blen++] = input[i];
                }
                i++;
            }
            buf[blen] = '\0';
            if (i < len)
                i++; /* skip closing quote */
            lex_push(out, TOK_STRING, buf, start - 1);
            continue;
        }

        /* Numbers — stop before ".." (DOTDOT operator) */
        if (isdigit((unsigned char)c) ||
            (c == '.' && i + 1 < len && isdigit((unsigned char)input[i + 1]))) {
            int start = i;
            while (i < len && (isdigit((unsigned char)input[i]) ||
                               (input[i] == '.' && i + 1 < len && input[i + 1] != '.')))
                i++;
            lex_push_n(out, TOK_NUMBER, input + start, i - start, start);
            continue;
        }

        /* Identifiers / keywords */
        if (isalpha((unsigned char)c) || c == '_') {
            int start = i;
            while (i < len && (isalnum((unsigned char)input[i]) || input[i] == '_'))
                i++;
            char word[256];
            int wlen = i - start;
            if (wlen >= (int)sizeof(word))
                wlen = (int)sizeof(word) - 1;
            memcpy(word, input + start, wlen);
            word[wlen] = '\0';
            cbm_token_type_t type = keyword_lookup(word);
            lex_push_n(out, type, input + start, i - start, start);
            continue;
        }

        /* Two-character tokens */
        if (c == '=' && i + 1 < len && input[i + 1] == '~') {
            lex_push(out, TOK_EQTILDE, "=~", i);
            i += 2;
            continue;
        }
        if (c == '>' && i + 1 < len && input[i + 1] == '=') {
            lex_push(out, TOK_GTE, ">=", i);
            i += 2;
            continue;
        }
        if (c == '<' && i + 1 < len && input[i + 1] == '=') {
            lex_push(out, TOK_LTE, "<=", i);
            i += 2;
            continue;
        }
        if (c == '.' && i + 1 < len && input[i + 1] == '.') {
            lex_push(out, TOK_DOTDOT, "..", i);
            i += 2;
            continue;
        }

        /* Single-character tokens */
        cbm_token_type_t stype = TOK_EOF;
        switch (c) {
        case '(':
            stype = TOK_LPAREN;
            break;
        case ')':
            stype = TOK_RPAREN;
            break;
        case '[':
            stype = TOK_LBRACKET;
            break;
        case ']':
            stype = TOK_RBRACKET;
            break;
        case '-':
            stype = TOK_DASH;
            break;
        case '>':
            stype = TOK_GT;
            break;
        case '<':
            stype = TOK_LT;
            break;
        case ':':
            stype = TOK_COLON;
            break;
        case '.':
            stype = TOK_DOT;
            break;
        case '{':
            stype = TOK_LBRACE;
            break;
        case '}':
            stype = TOK_RBRACE;
            break;
        case '*':
            stype = TOK_STAR;
            break;
        case ',':
            stype = TOK_COMMA;
            break;
        case '=':
            stype = TOK_EQ;
            break;
        case '|':
            stype = TOK_PIPE;
            break;
        default:
            break;
        }

        if (stype != TOK_EOF) {
            char buf[2] = {c, '\0'};
            lex_push(out, stype, buf, i);
            i++;
            continue;
        }

        /* Unknown character — skip */
        i++;
    }

    /* Add EOF */
    lex_push(out, TOK_EOF, "", i);
    return 0;
}

void cbm_lex_free(cbm_lex_result_t *r) {
    if (!r)
        return;
    for (int i = 0; i < r->count; i++) {
        free((void *)r->tokens[i].text);
    }
    free(r->tokens);
    free(r->error);
    memset(r, 0, sizeof(*r));
}

/* ══════════════════════════════════════════════════════════════════
 *  PARSER
 * ══════════════════════════════════════════════════════════════════ */

typedef struct {
    const cbm_token_t *tokens;
    int count;
    int pos;
    char error[512];
} parser_t;

static const cbm_token_t *peek(parser_t *p) {
    if (p->pos >= p->count)
        return &p->tokens[p->count - 1]; /* EOF */
    return &p->tokens[p->pos];
}

static const cbm_token_t *advance(parser_t *p) {
    if (p->pos >= p->count)
        return &p->tokens[p->count - 1];
    return &p->tokens[p->pos++];
}

static bool check(parser_t *p, cbm_token_type_t type) {
    return peek(p)->type == type;
}

static bool match(parser_t *p, cbm_token_type_t type) {
    if (check(p, type)) {
        advance(p);
        return true;
    }
    return false;
}

static const cbm_token_t *expect(parser_t *p, cbm_token_type_t type) {
    if (check(p, type))
        return advance(p);
    snprintf(p->error, sizeof(p->error), "expected token type %d, got %d at pos %d", type,
             peek(p)->type, peek(p)->pos);
    return NULL;
}

/* Parse inline properties: {key: "value", ...} */
static int parse_props(parser_t *p, cbm_prop_filter_t **out, int *count) {
    *out = NULL;
    *count = 0;
    if (!match(p, TOK_LBRACE))
        return 0;

    int cap = 4, n = 0;
    cbm_prop_filter_t *arr = malloc(cap * sizeof(cbm_prop_filter_t));

    while (!check(p, TOK_RBRACE) && !check(p, TOK_EOF)) {
        const cbm_token_t *key = expect(p, TOK_IDENT);
        if (!key) {
            free(arr);
            return -1;
        }
        if (!expect(p, TOK_COLON)) {
            free(arr);
            return -1;
        }
        const cbm_token_t *val = expect(p, TOK_STRING);
        if (!val) {
            free(arr);
            return -1;
        }

        if (n >= cap) {
            cap *= 2;
            arr = safe_realloc(arr, cap * sizeof(cbm_prop_filter_t));
        }
        arr[n].key = heap_strdup(key->text);
        arr[n].value = heap_strdup(val->text);
        n++;

        match(p, TOK_COMMA); /* optional comma */
    }
    expect(p, TOK_RBRACE);

    *out = arr;
    *count = n;
    return 0;
}

/* Parse node: (variable:Label {props}) */
static int parse_node(parser_t *p, cbm_node_pattern_t *out) {
    memset(out, 0, sizeof(*out));
    if (!expect(p, TOK_LPAREN))
        return -1;

    /* Optional variable */
    if (check(p, TOK_IDENT)) {
        /* Lookahead: if next is COLON, this is a variable */
        /* Or if next is RPAREN/LBRACE, this is a variable without label */
        out->variable = heap_strdup(advance(p)->text);
    }

    /* Optional :Label */
    if (match(p, TOK_COLON)) {
        const cbm_token_t *label = expect(p, TOK_IDENT);
        if (!label)
            return -1;
        out->label = heap_strdup(label->text);
    }

    /* Optional {props} */
    if (check(p, TOK_LBRACE)) {
        if (parse_props(p, &out->props, &out->prop_count) < 0)
            return -1;
    }

    if (!expect(p, TOK_RPAREN))
        return -1;
    return 0;
}

/* Parse relationship: -[:TYPE|TYPE2*min..max]-> or <-[...]-  */
static int parse_rel(parser_t *p, cbm_rel_pattern_t *out) {
    memset(out, 0, sizeof(*out));
    out->min_hops = 1;
    out->max_hops = 1;

    /* Check for leading < (inbound) */
    bool leading_lt = match(p, TOK_LT);
    if (!expect(p, TOK_DASH))
        return -1;

    /* Optional bracket content */
    if (match(p, TOK_LBRACKET)) {
        /* Optional variable */
        if (check(p, TOK_IDENT) && !check(p, TOK_COLON)) {
            /* Peek ahead: variable if followed by : or ] or * */
            /* Actually, check if next-next is colon */
            out->variable = heap_strdup(advance(p)->text);
        }

        /* Optional :Types */
        if (match(p, TOK_COLON)) {
            int cap = 4, n = 0;
            const char **types = malloc(cap * sizeof(const char *));

            const cbm_token_t *t = expect(p, TOK_IDENT);
            if (!t) {
                free(types);
                return -1;
            }
            types[n++] = heap_strdup(t->text);

            while (match(p, TOK_PIPE)) {
                t = expect(p, TOK_IDENT);
                if (!t) {
                    for (int i = 0; i < n; i++)
                        free((void *)types[i]);
                    free(types);
                    return -1;
                }
                if (n >= cap) {
                    cap *= 2;
                    types = safe_realloc(types, cap * sizeof(const char *));
                }
                types[n++] = heap_strdup(t->text);
            }

            out->types = types;
            out->type_count = n;
        }

        /* Optional *hop_range */
        if (match(p, TOK_STAR)) {
            /* Parse hop range */
            if (check(p, TOK_NUMBER)) {
                int val = (int)strtol(peek(p)->text, NULL, 10);
                advance(p);
                if (match(p, TOK_DOTDOT)) {
                    out->min_hops = val;
                    if (check(p, TOK_NUMBER)) {
                        out->max_hops = (int)strtol(advance(p)->text, NULL, 10);
                    } else {
                        out->max_hops = 0; /* unbounded */
                    }
                } else {
                    /* *N means 1..N */
                    out->min_hops = 1;
                    out->max_hops = val;
                }
            } else if (match(p, TOK_DOTDOT)) {
                out->min_hops = 1;
                if (check(p, TOK_NUMBER)) {
                    out->max_hops = (int)strtol(advance(p)->text, NULL, 10);
                } else {
                    out->max_hops = 0;
                }
            } else {
                /* * alone = unbounded */
                out->min_hops = 1;
                out->max_hops = 0;
            }
        }

        if (!expect(p, TOK_RBRACKET))
            return -1;
    }

    if (!expect(p, TOK_DASH))
        return -1;

    /* Check for trailing > (outbound) */
    bool trailing_gt = match(p, TOK_GT);

    /* Determine direction */
    if (leading_lt && !trailing_gt) {
        out->direction = heap_strdup("inbound");
    } else if (!leading_lt && trailing_gt) {
        out->direction = heap_strdup("outbound");
    } else {
        out->direction = heap_strdup("any");
    }

    return 0;
}

/* Parse WHERE clause */
static int parse_where(parser_t *p, cbm_where_clause_t **out) {
    if (!match(p, TOK_WHERE)) {
        *out = NULL;
        return 0;
    }

    cbm_where_clause_t *w = calloc(1, sizeof(cbm_where_clause_t));
    int cap = 4;
    w->conditions = malloc(cap * sizeof(cbm_condition_t));
    w->op = heap_strdup("AND"); /* default */

    do {
        if (w->count > 0) {
            if (match(p, TOK_AND)) {
                /* already AND */
            } else if (match(p, TOK_OR)) {
                free((void *)w->op);
                w->op = heap_strdup("OR");
            } else {
                break;
            }
        }

        cbm_condition_t c = {0};
        const cbm_token_t *var = expect(p, TOK_IDENT);
        if (!var) {
            free(w->conditions);
            free(w);
            return -1;
        }
        c.variable = heap_strdup(var->text);

        if (!expect(p, TOK_DOT)) {
            free(w->conditions);
            free(w);
            return -1;
        }
        const cbm_token_t *prop = expect(p, TOK_IDENT);
        if (!prop) {
            free(w->conditions);
            free(w);
            return -1;
        }
        c.property = heap_strdup(prop->text);

        /* Operator */
        if (match(p, TOK_EQ)) {
            c.op = heap_strdup("=");
        } else if (match(p, TOK_EQTILDE)) {
            c.op = heap_strdup("=~");
        } else if (match(p, TOK_GTE)) {
            c.op = heap_strdup(">=");
        } else if (match(p, TOK_LTE)) {
            c.op = heap_strdup("<=");
        } else if (match(p, TOK_GT)) {
            c.op = heap_strdup(">");
        } else if (match(p, TOK_LT)) {
            c.op = heap_strdup("<");
        } else if (check(p, TOK_CONTAINS)) {
            advance(p);
            c.op = heap_strdup("CONTAINS");
        } else if (check(p, TOK_STARTS)) {
            advance(p);
            expect(p, TOK_WITH); /* STARTS WITH */
            c.op = heap_strdup("STARTS WITH");
        } else {
            snprintf(p->error, sizeof(p->error), "unexpected operator at pos %d", peek(p)->pos);
            free(w->conditions);
            free(w);
            return -1;
        }

        /* Value */
        if (check(p, TOK_STRING) || check(p, TOK_NUMBER)) {
            c.value = heap_strdup(advance(p)->text);
        } else {
            snprintf(p->error, sizeof(p->error), "expected value at pos %d", peek(p)->pos);
            free(w->conditions);
            free(w);
            return -1;
        }

        if (w->count >= cap) {
            cap *= 2;
            w->conditions = safe_realloc(w->conditions, cap * sizeof(cbm_condition_t));
        }
        w->conditions[w->count++] = c;

    } while (check(p, TOK_AND) || check(p, TOK_OR));

    *out = w;
    return 0;
}

/* Parse RETURN clause */
static int parse_return(parser_t *p, cbm_return_clause_t **out) {
    if (!match(p, TOK_RETURN)) {
        *out = NULL;
        return 0;
    }

    cbm_return_clause_t *r = calloc(1, sizeof(cbm_return_clause_t));
    int cap = 4;
    r->items = malloc(cap * sizeof(cbm_return_item_t));

    r->distinct = match(p, TOK_DISTINCT);

    do {
        if (r->count > 0 && !match(p, TOK_COMMA))
            break;

        cbm_return_item_t item = {0};

        /* Check for COUNT(var) */
        if (check(p, TOK_COUNT)) {
            advance(p);
            expect(p, TOK_LPAREN);
            const cbm_token_t *var = expect(p, TOK_IDENT);
            if (!var) {
                free(r->items);
                free(r);
                return -1;
            }
            item.variable = heap_strdup(var->text);
            /* Optional .property inside COUNT */
            if (match(p, TOK_DOT)) {
                const cbm_token_t *prop = expect(p, TOK_IDENT);
                if (prop)
                    item.property = heap_strdup(prop->text);
            }
            expect(p, TOK_RPAREN);
            item.func = heap_strdup("COUNT");
        } else {
            const cbm_token_t *var = expect(p, TOK_IDENT);
            if (!var) {
                free(r->items);
                free(r);
                return -1;
            }
            item.variable = heap_strdup(var->text);

            if (match(p, TOK_DOT)) {
                const cbm_token_t *prop = expect(p, TOK_IDENT);
                if (prop)
                    item.property = heap_strdup(prop->text);
            }
        }

        /* Optional AS alias */
        if (match(p, TOK_AS)) {
            const cbm_token_t *alias = expect(p, TOK_IDENT);
            if (alias)
                item.alias = heap_strdup(alias->text);
        }

        if (r->count >= cap) {
            cap *= 2;
            r->items = safe_realloc(r->items, cap * sizeof(cbm_return_item_t));
        }
        r->items[r->count++] = item;

    } while (check(p, TOK_COMMA));

    /* Optional ORDER BY */
    if (match(p, TOK_ORDER)) {
        expect(p, TOK_BY);
        /* ORDER BY can be: var.prop, alias, or COUNT(var) */
        char order_buf[256] = "";
        if (check(p, TOK_COUNT)) {
            advance(p);
            expect(p, TOK_LPAREN);
            const cbm_token_t *var = expect(p, TOK_IDENT);
            snprintf(order_buf, sizeof(order_buf), "COUNT(%s)", var ? var->text : "");
            expect(p, TOK_RPAREN);
        } else {
            const cbm_token_t *var = expect(p, TOK_IDENT);
            if (var) {
                snprintf(order_buf, sizeof(order_buf), "%s", var->text);
                if (match(p, TOK_DOT)) {
                    const cbm_token_t *prop = expect(p, TOK_IDENT);
                    if (prop) {
                        char tmp[256];
                        snprintf(tmp, sizeof(tmp), "%s.%s", var->text, prop->text);
                        snprintf(order_buf, sizeof(order_buf), "%s", tmp);
                    }
                }
            }
        }
        r->order_by = heap_strdup(order_buf);

        if (match(p, TOK_ASC)) {
            r->order_dir = heap_strdup("ASC");
        } else if (match(p, TOK_DESC)) {
            r->order_dir = heap_strdup("DESC");
        }
    }

    /* Optional LIMIT */
    if (match(p, TOK_LIMIT)) {
        const cbm_token_t *num = expect(p, TOK_NUMBER);
        if (num)
            r->limit = (int)strtol(num->text, NULL, 10);
    }

    *out = r;
    return 0;
}

int cbm_parse(const cbm_token_t *tokens, int token_count, cbm_parse_result_t *out) {
    memset(out, 0, sizeof(*out));

    parser_t p = {.tokens = tokens, .count = token_count, .pos = 0};

    /* Expect MATCH */
    if (!expect(&p, TOK_MATCH)) {
        out->error = heap_strdup(p.error[0] ? p.error : "expected MATCH");
        return -1;
    }

    cbm_query_t *q = calloc(1, sizeof(cbm_query_t));

    /* Parse pattern: node (rel node)* */
    int node_cap = 4, rel_cap = 4;
    q->pattern.nodes = malloc(node_cap * sizeof(cbm_node_pattern_t));
    q->pattern.rels = malloc(rel_cap * sizeof(cbm_rel_pattern_t));

    /* First node */
    if (parse_node(&p, &q->pattern.nodes[0]) < 0) {
        out->error = heap_strdup(p.error[0] ? p.error : "failed to parse node");
        free(q->pattern.nodes);
        free(q->pattern.rels);
        free(q);
        return -1;
    }
    q->pattern.node_count = 1;

    /* Alternating rel-node pairs */
    while (check(&p, TOK_DASH) || check(&p, TOK_LT)) {
        if (q->pattern.rel_count >= rel_cap) {
            rel_cap *= 2;
            q->pattern.rels = safe_realloc(q->pattern.rels, rel_cap * sizeof(cbm_rel_pattern_t));
        }
        if (parse_rel(&p, &q->pattern.rels[q->pattern.rel_count]) < 0) {
            out->error = heap_strdup(p.error[0] ? p.error : "failed to parse relationship");
            cbm_query_free(q);
            return -1;
        }
        q->pattern.rel_count++;

        if (q->pattern.node_count >= node_cap) {
            node_cap *= 2;
            q->pattern.nodes =
                safe_realloc(q->pattern.nodes, node_cap * sizeof(cbm_node_pattern_t));
        }
        if (parse_node(&p, &q->pattern.nodes[q->pattern.node_count]) < 0) {
            out->error = heap_strdup(p.error[0] ? p.error : "failed to parse target node");
            cbm_query_free(q);
            return -1;
        }
        q->pattern.node_count++;
    }

    /* Optional WHERE */
    if (parse_where(&p, &q->where) < 0) {
        out->error = heap_strdup(p.error[0] ? p.error : "failed to parse WHERE");
        cbm_query_free(q);
        return -1;
    }

    /* Optional RETURN */
    if (parse_return(&p, &q->ret) < 0) {
        out->error = heap_strdup(p.error[0] ? p.error : "failed to parse RETURN");
        cbm_query_free(q);
        return -1;
    }

    out->query = q;
    return 0;
}

void cbm_parse_free(cbm_parse_result_t *r) {
    if (!r)
        return;
    cbm_query_free(r->query);
    free(r->error);
    memset(r, 0, sizeof(*r));
}

/* ── Query free ─────────────────────────────────────────────────── */

void cbm_query_free(cbm_query_t *q) {
    if (!q)
        return;

    /* Free nodes */
    for (int i = 0; i < q->pattern.node_count; i++) {
        cbm_node_pattern_t *n = &q->pattern.nodes[i];
        free((void *)n->variable);
        free((void *)n->label);
        for (int j = 0; j < n->prop_count; j++) {
            free((void *)n->props[j].key);
            free((void *)n->props[j].value);
        }
        free(n->props);
    }
    free(q->pattern.nodes);

    /* Free rels */
    for (int i = 0; i < q->pattern.rel_count; i++) {
        cbm_rel_pattern_t *r = &q->pattern.rels[i];
        free((void *)r->variable);
        for (int j = 0; j < r->type_count; j++) {
            free((void *)r->types[j]);
        }
        free(r->types);
        free((void *)r->direction);
    }
    free(q->pattern.rels);

    /* Free where */
    if (q->where) {
        for (int i = 0; i < q->where->count; i++) {
            free((void *)q->where->conditions[i].variable);
            free((void *)q->where->conditions[i].property);
            free((void *)q->where->conditions[i].op);
            free((void *)q->where->conditions[i].value);
        }
        free(q->where->conditions);
        free((void *)q->where->op);
        free(q->where);
    }

    /* Free return */
    if (q->ret) {
        for (int i = 0; i < q->ret->count; i++) {
            free((void *)q->ret->items[i].variable);
            free((void *)q->ret->items[i].property);
            free((void *)q->ret->items[i].alias);
            free((void *)q->ret->items[i].func);
        }
        free(q->ret->items);
        free((void *)q->ret->order_by);
        free((void *)q->ret->order_dir);
        free(q->ret);
    }

    free(q);
}

/* ── Convenience: lex + parse ───────────────────────────────────── */

int cbm_cypher_parse(const char *query, cbm_query_t **out, char **error) {
    *out = NULL;
    *error = NULL;

    cbm_lex_result_t lr = {0};
    if (cbm_lex(query, &lr) < 0 || lr.error) {
        *error = heap_strdup(lr.error ? lr.error : "lex error");
        cbm_lex_free(&lr);
        return -1;
    }

    cbm_parse_result_t pr = {0};
    if (cbm_parse(lr.tokens, lr.count, &pr) < 0) {
        *error = heap_strdup(pr.error ? pr.error : "parse error");
        cbm_parse_free(&pr);
        cbm_lex_free(&lr);
        return -1;
    }

    *out = pr.query;
    pr.query = NULL;
    cbm_parse_free(&pr);
    cbm_lex_free(&lr);
    return 0;
}

/* ══════════════════════════════════════════════════════════════════
 *  EXECUTOR
 * ══════════════════════════════════════════════════════════════════ */

/* A binding: maps variable names to nodes and/or edges */
typedef struct {
    const char *var_names[16]; /* variable names (nodes) */
    cbm_node_t var_nodes[16];  /* node data */
    int var_count;
    const char *edge_var_names[8]; /* variable names (edges) */
    cbm_edge_t edge_vars[8];       /* edge data */
    int edge_var_count;
} binding_t;

/* Get node property by name */
static const char *node_prop(const cbm_node_t *n, const char *prop) {
    if (!n || !prop)
        return "";
    if (strcmp(prop, "name") == 0)
        return n->name ? n->name : "";
    if (strcmp(prop, "qualified_name") == 0)
        return n->qualified_name ? n->qualified_name : "";
    if (strcmp(prop, "label") == 0)
        return n->label ? n->label : "";
    if (strcmp(prop, "file_path") == 0)
        return n->file_path ? n->file_path : "";
    if (strcmp(prop, "start_line") == 0) {
        /* Return as string */
        static char buf[32];
        snprintf(buf, sizeof(buf), "%d", n->start_line);
        return buf;
    }
    if (strcmp(prop, "end_line") == 0) {
        static char buf[32];
        snprintf(buf, sizeof(buf), "%d", n->end_line);
        return buf;
    }
    return "";
}

/* Extract a string value from JSON properties_json by key.
 * Writes result to buf (up to buf_sz). Returns buf if found, "" otherwise.
 * Handles both string values ("key":"value") and numeric values ("key":1.5). */
static const char *json_extract_prop(const char *json, const char *key, char *buf, size_t buf_sz) {
    if (!json || !key) {
        buf[0] = '\0';
        return buf;
    }
    /* Build search pattern: "key": */
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char *p = strstr(json, pattern);
    if (!p) {
        buf[0] = '\0';
        return buf;
    }
    p += strlen(pattern);
    /* Skip whitespace */
    while (*p == ' ' || *p == '\t')
        p++;
    if (*p == '"') {
        /* String value */
        p++;
        size_t i = 0;
        while (*p && *p != '"' && i < buf_sz - 1) {
            buf[i++] = *p++;
        }
        buf[i] = '\0';
    } else {
        /* Numeric or other value */
        size_t i = 0;
        while (*p && *p != ',' && *p != '}' && *p != ' ' && i < buf_sz - 1) {
            buf[i++] = *p++;
        }
        buf[i] = '\0';
    }
    return buf;
}

/* Get edge property by name. Uses rotating static buffers to allow
 * multiple concurrent calls (e.g. projecting r.url_path, r.confidence
 * in the same row). */
static const char *edge_prop(const cbm_edge_t *e, const char *prop) {
    if (!e || !prop)
        return "";
    if (strcmp(prop, "type") == 0)
        return e->type ? e->type : "";
    /* Rotate through 8 static buffers so multiple props can be accessed per row */
    static char ebufs[8][512];
    static int ebuf_idx = 0;
    char *buf = ebufs[ebuf_idx++ & 7];
    json_extract_prop(e->properties_json, prop, buf, 512);
    return buf;
}

/* Find an edge variable in a binding */
static cbm_edge_t *binding_get_edge(binding_t *b, const char *var) {
    for (int i = 0; i < b->edge_var_count; i++) {
        if (strcmp(b->edge_var_names[i], var) == 0)
            return &b->edge_vars[i];
    }
    return NULL;
}

/* Find a variable's node in a binding */
static cbm_node_t *binding_get(binding_t *b, const char *var) {
    for (int i = 0; i < b->var_count; i++) {
        if (strcmp(b->var_names[i], var) == 0)
            return &b->var_nodes[i];
    }
    return NULL;
}

/* Deep copy a node: heap-dup all string fields so the binding owns them */
static void node_deep_copy(cbm_node_t *dst, const cbm_node_t *src) {
    *dst = *src;
    dst->project = heap_strdup(src->project);
    dst->label = heap_strdup(src->label);
    dst->name = heap_strdup(src->name);
    dst->qualified_name = heap_strdup(src->qualified_name);
    dst->file_path = heap_strdup(src->file_path);
    dst->properties_json = heap_strdup(src->properties_json);
}

static void node_fields_free(cbm_node_t *n) {
    free((void *)n->project);
    free((void *)n->label);
    free((void *)n->name);
    free((void *)n->qualified_name);
    free((void *)n->file_path);
    free((void *)n->properties_json);
}

/* Deep copy an edge (binding owns the strings) */
static void edge_deep_copy(cbm_edge_t *dst, const cbm_edge_t *src) {
    *dst = *src;
    dst->project = heap_strdup(src->project);
    dst->type = heap_strdup(src->type);
    dst->properties_json = heap_strdup(src->properties_json);
}

static void edge_fields_free(cbm_edge_t *e) {
    free((void *)e->project);
    free((void *)e->type);
    free((void *)e->properties_json);
}

/* Set an edge variable in a binding */
static void binding_set_edge(binding_t *b, const char *var, const cbm_edge_t *edge) {
    /* Check existing — free old fields first */
    for (int i = 0; i < b->edge_var_count; i++) {
        if (strcmp(b->edge_var_names[i], var) == 0) {
            edge_fields_free(&b->edge_vars[i]);
            edge_deep_copy(&b->edge_vars[i], edge);
            return;
        }
    }
    if (b->edge_var_count >= 8)
        return;
    b->edge_var_names[b->edge_var_count] = var; /* not owned — points to AST string */
    edge_deep_copy(&b->edge_vars[b->edge_var_count], edge);
    b->edge_var_count++;
}

/* Free all deep-copied nodes and edges in a binding */
static void binding_free(binding_t *b) {
    for (int i = 0; i < b->var_count; i++) {
        node_fields_free(&b->var_nodes[i]);
    }
    for (int i = 0; i < b->edge_var_count; i++) {
        edge_fields_free(&b->edge_vars[i]);
    }
}

/* Deep-copy a binding (so source and dest own separate string copies) */
static void binding_copy(binding_t *dst, const binding_t *src) {
    dst->var_count = src->var_count;
    for (int i = 0; i < src->var_count; i++) {
        dst->var_names[i] = src->var_names[i]; /* AST-owned, not freed */
        node_deep_copy(&dst->var_nodes[i], &src->var_nodes[i]);
    }
    dst->edge_var_count = src->edge_var_count;
    for (int i = 0; i < src->edge_var_count; i++) {
        dst->edge_var_names[i] = src->edge_var_names[i]; /* AST-owned */
        edge_deep_copy(&dst->edge_vars[i], &src->edge_vars[i]);
    }
}

/* Deep-copy a node into a binding (binding owns the strings) */
static void binding_set(binding_t *b, const char *var, const cbm_node_t *node) {
    /* Check existing — free old fields first */
    for (int i = 0; i < b->var_count; i++) {
        if (strcmp(b->var_names[i], var) == 0) {
            node_fields_free(&b->var_nodes[i]);
            node_deep_copy(&b->var_nodes[i], node);
            return;
        }
    }
    if (b->var_count >= 16)
        return;
    b->var_names[b->var_count] = var; /* not owned — points to AST string */
    node_deep_copy(&b->var_nodes[b->var_count], node);
    b->var_count++;
}

/* Evaluate a WHERE condition against a binding */
static bool eval_condition(const cbm_condition_t *c, binding_t *b) {
    const char *actual;

    /* Check if variable is an edge binding */
    cbm_edge_t *e = binding_get_edge(b, c->variable);
    if (e) {
        actual = edge_prop(e, c->property);
    } else {
        cbm_node_t *n = binding_get(b, c->variable);
        if (!n)
            return false;
        actual = node_prop(n, c->property);
    }

    const char *expected = c->value;

    if (strcmp(c->op, "=") == 0) {
        return strcmp(actual, expected) == 0;
    }
    if (strcmp(c->op, "=~") == 0) {
        regex_t re;
        if (regcomp(&re, expected, REG_EXTENDED | REG_NOSUB) != 0)
            return false;
        int rc = regexec(&re, actual, 0, NULL, 0);
        regfree(&re);
        return rc == 0;
    }
    if (strcmp(c->op, "CONTAINS") == 0) {
        return strstr(actual, expected) != NULL;
    }
    if (strcmp(c->op, "STARTS WITH") == 0) {
        return strncmp(actual, expected, strlen(expected)) == 0;
    }
    /* Numeric comparisons */
    if (strcmp(c->op, ">") == 0 || strcmp(c->op, "<") == 0 || strcmp(c->op, ">=") == 0 ||
        strcmp(c->op, "<=") == 0) {
        double a = strtod(actual, NULL);
        double exp_val = strtod(expected, NULL);
        if (strcmp(c->op, ">") == 0)
            return a > exp_val;
        if (strcmp(c->op, "<") == 0)
            return a < exp_val;
        if (strcmp(c->op, ">=") == 0)
            return a >= exp_val;
        if (strcmp(c->op, "<=") == 0)
            return a <= exp_val;
    }
    return false;
}

/* Evaluate all WHERE conditions */
static bool eval_where(const cbm_where_clause_t *w, binding_t *b) {
    if (!w || w->count == 0)
        return true;

    bool is_and = (strcmp(w->op, "AND") == 0);

    for (int i = 0; i < w->count; i++) {
        bool r = eval_condition(&w->conditions[i], b);
        if (is_and && !r)
            return false;
        if (!is_and && r)
            return true;
    }
    return is_and; /* AND: all passed → true; OR: none passed → false */
}

/* Check inline property filters */
static bool check_inline_props(const cbm_node_t *n, const cbm_prop_filter_t *props, int count) {
    for (int i = 0; i < count; i++) {
        const char *actual = node_prop(n, props[i].key);
        if (strcmp(actual, props[i].value) != 0)
            return false;
    }
    return true;
}

/* ── Result building helpers ────────────────────────────────────── */

typedef struct {
    const char ***rows;
    int row_count;
    int row_cap;
    const char **columns;
    int col_count;
} result_builder_t;

static void rb_init(result_builder_t *rb) {
    memset(rb, 0, sizeof(*rb));
    rb->row_cap = 32;
    rb->rows = malloc(rb->row_cap * sizeof(const char **));
}

static void rb_set_columns(result_builder_t *rb, const char **cols, int count) {
    rb->columns = malloc(count * sizeof(const char *));
    for (int i = 0; i < count; i++) {
        rb->columns[i] = heap_strdup(cols[i]);
    }
    rb->col_count = count;
}

static void rb_add_row(result_builder_t *rb, const char **values) {
    if (rb->row_count >= rb->row_cap) {
        rb->row_cap *= 2;
        rb->rows = safe_realloc(rb->rows, rb->row_cap * sizeof(const char **));
    }
    const char **row = malloc(rb->col_count * sizeof(const char *));
    for (int i = 0; i < rb->col_count; i++) {
        row[i] = heap_strdup(values[i]);
    }
    rb->rows[rb->row_count++] = row;
}

/* ── Main execution ─────────────────────────────────────────────── */

int cbm_cypher_execute(cbm_store_t *store, const char *query, const char *project, int max_rows,
                       cbm_cypher_result_t *out) {
    memset(out, 0, sizeof(*out));
    if (max_rows <= 0)
        max_rows = 200;

    /* Parse */
    cbm_query_t *q = NULL;
    char *err = NULL;
    if (cbm_cypher_parse(query, &q, &err) < 0) {
        free(err);
        return -1;
    }

    /* Step 1: Scan initial nodes */
    cbm_node_pattern_t *first = &q->pattern.nodes[0];
    cbm_node_t *scanned = NULL;
    int scan_count = 0;

    if (first->label) {
        cbm_store_find_nodes_by_label(store, project, first->label, &scanned, &scan_count);
    } else {
        /* No label — need all nodes. Use search. */
        cbm_search_params_t params = {
            .project = project, .min_degree = -1, .max_degree = -1, .limit = max_rows * 10};
        cbm_search_output_t sout = {0};
        cbm_store_search(store, &params, &sout);
        /* Convert search results to node array */
        scan_count = sout.count;
        scanned = malloc(scan_count * sizeof(cbm_node_t));
        for (int i = 0; i < scan_count; i++) {
            scanned[i] = sout.results[i].node;
            /* Null out so search_free doesn't free them */
            sout.results[i].node.name = NULL;
            sout.results[i].node.project = NULL;
            sout.results[i].node.label = NULL;
            sout.results[i].node.qualified_name = NULL;
            sout.results[i].node.file_path = NULL;
            sout.results[i].node.properties_json = NULL;
        }
        cbm_store_search_free(&sout);
    }

    /* Apply inline property filters to scanned nodes */
    if (first->prop_count > 0) {
        int kept = 0;
        for (int i = 0; i < scan_count; i++) {
            if (check_inline_props(&scanned[i], first->props, first->prop_count)) {
                if (kept != i)
                    scanned[kept] = scanned[i];
                kept++;
            }
        }
        scan_count = kept;
    }

    /* Build initial bindings */
    int bind_cap = scan_count > 1000 ? 1000 : scan_count;
    binding_t *bindings = malloc((bind_cap + 1) * sizeof(binding_t));
    int bind_count = 0;

    const char *var_name = first->variable ? first->variable : "_n0";

    /* Apply early WHERE filter (conditions on first variable only) */
    for (int i = 0; i < scan_count && bind_count < bind_cap; i++) {
        binding_t b = {0};
        binding_set(&b, var_name, &scanned[i]);

        /* Early WHERE: check conditions on this variable */
        bool pass = true;
        if (q->where && q->pattern.rel_count > 0) {
            for (int c = 0; c < q->where->count; c++) {
                if (strcmp(q->where->conditions[c].variable, var_name) == 0) {
                    if (!eval_condition(&q->where->conditions[c], &b)) {
                        pass = false;
                        break;
                    }
                }
            }
        } else if (q->where && q->pattern.rel_count == 0) {
            /* No relationships — apply full WHERE */
            pass = eval_where(q->where, &b);
        }

        if (pass) {
            bindings[bind_count++] = b;
        } else {
            binding_free(&b);
        }
    }

    /* Step 2: Expand relationships */
    for (int ri = 0; ri < q->pattern.rel_count; ri++) {
        cbm_rel_pattern_t *rel = &q->pattern.rels[ri];
        cbm_node_pattern_t *target_node = &q->pattern.nodes[ri + 1];
        const char *to_var = target_node->variable ? target_node->variable : "_n_t";

        bool is_variable_length = (rel->min_hops != 1 || rel->max_hops != 1);

        binding_t *new_bindings = malloc((bind_cap * 10 + 1) * sizeof(binding_t));
        int new_count = 0;

        for (int bi = 0; bi < bind_count; bi++) {
            binding_t *b = &bindings[bi];
            cbm_node_t *src = binding_get(b, var_name);
            if (!src)
                continue;

            if (is_variable_length) {
                /* Variable-length: use BFS */
                int max_depth = rel->max_hops > 0 ? rel->max_hops : 10;
                cbm_traverse_result_t tr = {0};
                const char *dir = rel->direction ? rel->direction : "outbound";
                cbm_store_bfs(store, src->id, dir, rel->types, rel->type_count, max_depth, 100,
                              &tr);

                for (int v = 0; v < tr.visited_count && new_count < bind_cap * 10; v++) {
                    cbm_node_hop_t *hop = &tr.visited[v];
                    if (hop->hop < rel->min_hops)
                        continue;

                    /* Check target label */
                    if (target_node->label && strcmp(hop->node.label, target_node->label) != 0)
                        continue;
                    /* Check inline props */
                    if (!check_inline_props(&hop->node, target_node->props,
                                            target_node->prop_count))
                        continue;

                    binding_t nb = {0};
                    binding_copy(&nb, b);
                    binding_set(&nb, to_var, &hop->node);
                    new_bindings[new_count++] = nb;
                }
                cbm_store_traverse_free(&tr);
            } else {
                /* Fixed-length (1 hop): query edges directly */
                bool is_inbound = rel->direction && strcmp(rel->direction, "inbound") == 0;
                bool is_any = rel->direction && strcmp(rel->direction, "any") == 0;
                const char *rel_var = rel->variable; /* edge variable name, may be NULL */

/* Helper: process a batch of edges for one direction */
#define PROCESS_EDGES(edges_arr, edge_count_val, get_target_id)                         \
    for (int ei = 0; ei < (edge_count_val) && new_count < bind_cap * 10; ei++) {        \
        int64_t tid = (get_target_id);                                                  \
        cbm_node_t found = {0};                                                         \
        if (cbm_store_find_node_by_id(store, tid, &found) != CBM_STORE_OK)              \
            continue;                                                                   \
        if (target_node->label && strcmp(found.label, target_node->label) != 0) {       \
            node_fields_free(&found);                                                   \
            continue;                                                                   \
        }                                                                               \
        if (!check_inline_props(&found, target_node->props, target_node->prop_count)) { \
            node_fields_free(&found);                                                   \
            continue;                                                                   \
        }                                                                               \
        binding_t nb = {0};                                                             \
        binding_copy(&nb, b);                                                           \
        binding_set(&nb, to_var, &found);                                               \
        if (rel_var)                                                                    \
            binding_set_edge(&nb, rel_var, &(edges_arr)[ei]);                           \
        node_fields_free(&found);                                                       \
        new_bindings[new_count++] = nb;                                                 \
    }

                if (rel->type_count > 0) {
                    /* Typed relationship: iterate each type */
                    for (int ti = 0; ti < rel->type_count; ti++) {
                        cbm_edge_t *edges = NULL;
                        int edge_count = 0;
                        if (is_inbound) {
                            cbm_store_find_edges_by_target_type(store, src->id, rel->types[ti],
                                                                &edges, &edge_count);
                        } else {
                            cbm_store_find_edges_by_source_type(store, src->id, rel->types[ti],
                                                                &edges, &edge_count);
                        }
                        PROCESS_EDGES(edges, edge_count,
                                      is_inbound ? edges[ei].source_id : edges[ei].target_id);
                        cbm_store_free_edges(edges, edge_count);
                    }

                    /* Handle "any" direction: also check reverse */
                    if (is_any) {
                        for (int ti = 0; ti < rel->type_count; ti++) {
                            cbm_edge_t *edges = NULL;
                            int edge_count = 0;
                            cbm_store_find_edges_by_target_type(store, src->id, rel->types[ti],
                                                                &edges, &edge_count);
                            PROCESS_EDGES(edges, edge_count, edges[ei].source_id);
                            cbm_store_free_edges(edges, edge_count);
                        }
                    }
                } else {
                    /* Untyped relationship: fetch ALL edges from/to source */
                    cbm_edge_t *edges = NULL;
                    int edge_count = 0;
                    if (is_inbound) {
                        cbm_store_find_edges_by_target(store, src->id, &edges, &edge_count);
                    } else {
                        cbm_store_find_edges_by_source(store, src->id, &edges, &edge_count);
                    }
                    PROCESS_EDGES(edges, edge_count,
                                  is_inbound ? edges[ei].source_id : edges[ei].target_id);
                    cbm_store_free_edges(edges, edge_count);

                    if (is_any) {
                        edges = NULL;
                        edge_count = 0;
                        cbm_store_find_edges_by_target(store, src->id, &edges, &edge_count);
                        PROCESS_EDGES(edges, edge_count, edges[ei].source_id);
                        cbm_store_free_edges(edges, edge_count);
                    }
                }

#undef PROCESS_EDGES
            }
        }

        for (int bi = 0; bi < bind_count; bi++)
            binding_free(&bindings[bi]);
        free(bindings);
        bindings = new_bindings;
        bind_count = new_count;

        /* Update var_name for next relationship */
        var_name = to_var;
    }

    /* Step 3: Apply late WHERE filters (conditions on non-first variables) */
    if (q->where && q->pattern.rel_count > 0) {
        int kept = 0;
        for (int i = 0; i < bind_count; i++) {
            if (eval_where(q->where, &bindings[i])) {
                if (kept != i)
                    bindings[kept] = bindings[i];
                kept++;
            } else {
                binding_free(&bindings[i]);
            }
        }
        bind_count = kept;
    }

    /* Step 4: Project results */
    result_builder_t rb;
    rb_init(&rb);

    if (q->ret) {
        /* Check for COUNT aggregation */
        bool has_count = false;
        for (int i = 0; i < q->ret->count; i++) {
            if (q->ret->items[i].func && strcmp(q->ret->items[i].func, "COUNT") == 0) {
                has_count = true;
                break;
            }
        }

        /* Build column names */
        const char *col_names[32];
        for (int i = 0; i < q->ret->count && i < 32; i++) {
            cbm_return_item_t *item = &q->ret->items[i];
            if (item->alias) {
                col_names[i] = item->alias;
            } else if (item->func) {
                char buf[128];
                snprintf(buf, sizeof(buf), "COUNT(%s)", item->variable);
                col_names[i] = heap_strdup(buf);
            } else if (item->property) {
                char buf[128];
                snprintf(buf, sizeof(buf), "%s.%s", item->variable, item->property);
                col_names[i] = heap_strdup(buf);
            } else {
                col_names[i] = item->variable;
            }
        }
        rb_set_columns(&rb, col_names, q->ret->count);

        if (has_count) {
            /* Aggregation: group by non-COUNT items, count */
            typedef struct {
                char group_key[1024];
                const char **group_vals;
                int count;
            } agg_entry_t;

            int agg_cap = 256;
            agg_entry_t *aggs = calloc(agg_cap, sizeof(agg_entry_t));
            int agg_count = 0;

            for (int bi = 0; bi < bind_count; bi++) {
                /* Build group key from non-COUNT items */
                char key[1024] = "";
                int klen = 0;
                const char *vals[32];

                for (int ci = 0; ci < q->ret->count; ci++) {
                    cbm_return_item_t *item = &q->ret->items[ci];
                    if (item->func) {
                        vals[ci] = "0"; /* placeholder for count */
                        continue;
                    }
                    const char *v;
                    cbm_edge_t *edge = binding_get_edge(&bindings[bi], item->variable);
                    if (edge) {
                        v = edge_prop(edge, item->property);
                    } else {
                        cbm_node_t *n = binding_get(&bindings[bi], item->variable);
                        v = n ? node_prop(n, item->property) : "";
                    }
                    vals[ci] = v;
                    klen += snprintf(key + klen, sizeof(key) - klen, "%s|", v);
                }

                /* Find or create group */
                int found = -1;
                for (int a = 0; a < agg_count; a++) {
                    if (strcmp(aggs[a].group_key, key) == 0) {
                        found = a;
                        break;
                    }
                }
                if (found >= 0) {
                    aggs[found].count++;
                } else {
                    if (agg_count >= agg_cap) {
                        agg_cap *= 2;
                        aggs = safe_realloc(aggs, agg_cap * sizeof(agg_entry_t));
                    }
                    snprintf(aggs[agg_count].group_key, sizeof(aggs[agg_count].group_key), "%s",
                             key);
                    aggs[agg_count].group_vals = malloc(q->ret->count * sizeof(const char *));
                    for (int ci = 0; ci < q->ret->count; ci++) {
                        aggs[agg_count].group_vals[ci] = heap_strdup(vals[ci]);
                    }
                    aggs[agg_count].count = 1;
                    agg_count++;
                }
            }

            /* Emit aggregated rows */
            for (int a = 0; a < agg_count; a++) {
                const char *row[32];
                char count_bufs[32][32]; /* one per column, avoids use-after-scope */
                for (int ci = 0; ci < q->ret->count; ci++) {
                    cbm_return_item_t *item = &q->ret->items[ci];
                    if (item->func) {
                        snprintf(count_bufs[ci], sizeof(count_bufs[ci]), "%d", aggs[a].count);
                        row[ci] = count_bufs[ci];
                    } else {
                        row[ci] = aggs[a].group_vals[ci];
                    }
                }
                rb_add_row(&rb, row);
            }

            /* Free agg data */
            for (int a = 0; a < agg_count; a++) {
                for (int ci = 0; ci < q->ret->count; ci++) {
                    free((void *)aggs[a].group_vals[ci]);
                }
                free(aggs[a].group_vals);
            }
            free(aggs);
        } else {
            /* Simple projection — explicit LIMIT overrides max_rows */
            int proj_cap =
                (q->ret->limit > 0 && q->ret->limit > max_rows) ? q->ret->limit : max_rows;
            for (int bi = 0; bi < bind_count && rb.row_count < proj_cap; bi++) {
                const char *vals[32];
                for (int ci = 0; ci < q->ret->count; ci++) {
                    cbm_return_item_t *item = &q->ret->items[ci];
                    /* Check edge variable first */
                    cbm_edge_t *edge = binding_get_edge(&bindings[bi], item->variable);
                    if (edge) {
                        vals[ci] = item->property ? edge_prop(edge, item->property) : "";
                    } else {
                        cbm_node_t *n = binding_get(&bindings[bi], item->variable);
                        if (item->property) {
                            vals[ci] = n ? node_prop(n, item->property) : "";
                        } else {
                            vals[ci] = n ? (n->name ? n->name : "") : "";
                        }
                    }
                }
                rb_add_row(&rb, vals);
            }
        }

        /* Apply ORDER BY */
        if (q->ret->order_by) {
            /* Find column index for order_by */
            int order_col = -1;
            for (int ci = 0; ci < rb.col_count; ci++) {
                if (strcmp(rb.columns[ci], q->ret->order_by) == 0) {
                    order_col = ci;
                    break;
                }
            }
            /* Also check aliases */
            if (order_col < 0) {
                for (int ci = 0; ci < q->ret->count; ci++) {
                    if (q->ret->items[ci].alias &&
                        strcmp(q->ret->items[ci].alias, q->ret->order_by) == 0) {
                        order_col = ci;
                        break;
                    }
                }
            }

            if (order_col >= 0) {
                bool desc = q->ret->order_dir && strcmp(q->ret->order_dir, "DESC") == 0;
                /* Simple bubble sort (adequate for result sets) */
                for (int i = 0; i < rb.row_count - 1; i++) {
                    for (int j = 0; j < rb.row_count - i - 1; j++) {
                        int cmp = strcmp(rb.rows[j][order_col], rb.rows[j + 1][order_col]);
                        if (desc ? cmp < 0 : cmp > 0) {
                            const char **tmp = rb.rows[j];
                            rb.rows[j] = rb.rows[j + 1];
                            rb.rows[j + 1] = tmp;
                        }
                    }
                }
            }
        }

        /* Apply LIMIT */
        int limit = q->ret->limit > 0 ? q->ret->limit : max_rows;
        if (rb.row_count > limit) {
            for (int i = limit; i < rb.row_count; i++) {
                for (int c = 0; c < rb.col_count; c++)
                    free((void *)rb.rows[i][c]);
                free(rb.rows[i]);
            }
            rb.row_count = limit;
        }

        /* Apply DISTINCT */
        if (q->ret->distinct && rb.row_count > 1) {
            /* Remove duplicate rows */
            int kept = 1;
            for (int i = 1; i < rb.row_count; i++) {
                bool dup = false;
                for (int j = 0; j < kept && !dup; j++) {
                    bool same = true;
                    for (int c = 0; c < rb.col_count && same; c++) {
                        if (strcmp(rb.rows[i][c], rb.rows[j][c]) != 0)
                            same = false;
                    }
                    if (same)
                        dup = true;
                }
                if (!dup) {
                    if (kept != i)
                        rb.rows[kept] = rb.rows[i];
                    kept++;
                } else {
                    for (int c = 0; c < rb.col_count; c++)
                        free((void *)rb.rows[i][c]);
                    free(rb.rows[i]);
                }
            }
            rb.row_count = kept;
        }
    } else {
        /* Default projection: var.name, var.qualified_name, var.label for each variable */
        /* Collect variable names from pattern */
        const char *vars[16];
        int var_count = 0;
        for (int i = 0; i < q->pattern.node_count && var_count < 16; i++) {
            if (q->pattern.nodes[i].variable) {
                vars[var_count++] = q->pattern.nodes[i].variable;
            }
        }

        int col_n = var_count * 3;
        const char *col_names[48];
        for (int v = 0; v < var_count; v++) {
            char buf[128];
            snprintf(buf, sizeof(buf), "%s.name", vars[v]);
            col_names[(size_t)v * 3] = heap_strdup(buf);
            snprintf(buf, sizeof(buf), "%s.qualified_name", vars[v]);
            col_names[(size_t)v * 3 + 1] = heap_strdup(buf);
            snprintf(buf, sizeof(buf), "%s.label", vars[v]);
            col_names[(size_t)v * 3 + 2] = heap_strdup(buf);
        }
        rb_set_columns(&rb, col_names, col_n);
        for (int i = 0; i < col_n; i++)
            free((void *)col_names[i]);

        for (int bi = 0; bi < bind_count && rb.row_count < max_rows; bi++) {
            const char *vals[48];
            for (int v = 0; v < var_count; v++) {
                cbm_node_t *n = binding_get(&bindings[bi], vars[v]);
                vals[(size_t)v * 3] = n && n->name ? n->name : "";
                vals[(size_t)v * 3 + 1] = n && n->qualified_name ? n->qualified_name : "";
                vals[(size_t)v * 3 + 2] = n && n->label ? n->label : "";
            }
            rb_add_row(&rb, vals);
        }
    }

    /* Write output */
    out->columns = rb.columns;
    out->col_count = rb.col_count;
    out->rows = rb.rows;
    out->row_count = rb.row_count;

    /* Cleanup */
    for (int bi = 0; bi < bind_count; bi++)
        binding_free(&bindings[bi]);
    free(bindings);
    cbm_store_free_nodes(scanned, scan_count);
    cbm_query_free(q);

    return 0;
}

void cbm_cypher_result_free(cbm_cypher_result_t *r) {
    if (!r)
        return;
    for (int i = 0; i < r->col_count; i++) {
        free((void *)r->columns[i]);
    }
    free(r->columns);
    for (int i = 0; i < r->row_count; i++) {
        for (int j = 0; j < r->col_count; j++) {
            free((void *)r->rows[i][j]);
        }
        free(r->rows[i]);
    }
    free(r->rows);
    memset(r, 0, sizeof(*r));
}
