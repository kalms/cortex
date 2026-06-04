/*
 * extract_nuxt_routes.c — Derive route path + HTTP method from a Nuxt
 * file-based API route file path.
 *
 * Algorithm (per spec):
 *  1. Find "server/api/" in rel_path. If absent → return false.
 *  2. tail = everything from "api/" onward (include "api" segment). Prepend "/".
 *  3. Split basename on ".".
 *     - Recognized method tokens: get post put patch delete head options.
 *     - If second-to-last dot-segment is a method token → out_method = uppercase(it);
 *       stem = everything before that token.
 *     - Else out_method = "ANY"; stem = basename without ".ts" extension.
 *  4. Drop trailing "index" stem segment.
 *  5. Translate dynamic segments: [...x] → *   ;  [x] → :x.
 *  6. No trailing slash except root "/".
 */
#include "extract_nuxt_routes.h"
#include <string.h>
#include <ctype.h>

enum { NUXT_ROUTE_BUF_SIZE = 1024 };

static const char *HTTP_METHODS[] = {
    "get", "post", "put", "patch", "delete", "head", "options", NULL
};

/* Return the token if seg is a recognized HTTP method name, else NULL. */
static const char *method_token(const char *seg) {
    for (const char **m = HTTP_METHODS; *m; m++) {
        if (strcmp(seg, *m) == 0) return *m;
    }
    return NULL;
}

/*
 * Translate a single path segment:
 *   [...x] → "*"   (catch-all; returned as string literal — no arena needed)
 *   [x]    → ":x"  (named param; arena-allocated)
 *   other  → seg   (returned as-is)
 */
static const char *translate_segment(CtxArena *a, const char *seg) {
    size_t n = strlen(seg);
    if (n >= 2 && seg[0] == '[' && seg[n - 1] == ']') {
        /* catch-all: [...x] */
        if (n >= 5 && strncmp(seg + 1, "...", 3) == 0) return "*";
        /* named param: [x] → ":x" — need ':' + (n-2) inner chars + NUL = n bytes */
        /* Guard against degenerate "[]" (n==2) which would produce a bare ":". */
        if (n > 2) {
            char *out = (char *)ctx_arena_alloc(a, n);
            if (!out) return seg; /* OOM fallback — shouldn't happen in practice */
            out[0] = ':';
            memcpy(out + 1, seg + 1, n - 2);
            out[n - 1] = '\0';
            return out;
        }
        return seg; /* degenerate "[]" passes through unchanged */
    }
    return seg;
}

bool ctx_nuxt_route_from_path(CtxArena *a, const char *rel_path,
                              const char **out_path, const char **out_method) {
    if (!rel_path) return false;

    /* Step 1: locate "server/api/" */
    const char *api = strstr(rel_path, "server/api/");
    if (!api) return false;

    /* Step 2: tail = "api/..." (skip "server/") */
    const char *tail = api + strlen("server/"); /* points to "api/..." */
    size_t tn = strlen(tail);

    /* Work on a mutable copy of the tail */
    char *work = (char *)ctx_arena_alloc(a, tn + 1);
    if (!work) return false;
    memcpy(work, tail, tn + 1);

    /* Split into dir (everything before last '/') and base (after last '/') */
    char *last_slash = strrchr(work, '/');
    char *dir;
    char *base;
    if (last_slash) {
        *last_slash = '\0';
        dir = work;
        base = last_slash + 1;
    } else {
        dir = (char *)"";
        base = work;
    }

    /* Step 3: strip trailing ".ts" suffix and detect method suffix.
     * Use a trailing-suffix check rather than strstr to avoid mis-parsing
     * stems that contain ".ts" internally (e.g. "list.ts.get.ts"). */
    char *method = (char *)"ANY";
    {
        size_t bl = strlen(base);
        if (bl >= 3 && memcmp(base + bl - 3, ".ts", 3) == 0)
            base[bl - 3] = '\0';
    }

    char *meth_dot = strrchr(base, '.');
    if (meth_dot) {
        const char *mt = method_token(meth_dot + 1);
        if (mt) {
            *meth_dot = '\0';
            size_t ml = strlen(mt);
            char *mu = (char *)ctx_arena_alloc(a, ml + 1);
            if (!mu) return false;
            for (size_t i = 0; i < ml; i++) {
                mu[i] = (char)toupper((unsigned char)mt[i]);
            }
            mu[ml] = '\0';
            method = mu;
        }
    }

    /* Step 4: check whether stem is "index" (drop it later) */
    bool stem_is_index = (strcmp(base, "index") == 0);

    /* Step 5 + 6: build output path in a local buffer */
    char buf[NUXT_ROUTE_BUF_SIZE];
    size_t pos = 0;
    buf[pos++] = '/';

    /* Walk directory segments */
    char *seg = (*dir != '\0') ? dir : NULL;
    while (seg && *seg) {
        char *slash = strchr(seg, '/');
        if (slash) *slash = '\0';

        const char *t = translate_segment(a, seg);
        size_t tl = strlen(t);
        if (pos + tl + 1 >= sizeof(buf)) return false;
        memcpy(buf + pos, t, tl);
        pos += tl;
        buf[pos++] = '/';

        seg = slash ? slash + 1 : NULL;
    }

    /* Append the stem unless it's "index" */
    if (!stem_is_index && base[0] != '\0') {
        const char *t = translate_segment(a, base);
        size_t tl = strlen(t);
        if (pos + tl >= sizeof(buf)) return false;
        memcpy(buf + pos, t, tl);
        pos += tl;
    } else if (pos > 1 && buf[pos - 1] == '/') {
        /* Strip trailing slash left by directory walk */
        pos--;
    }

    buf[pos] = '\0';

    /* Copy result to arena */
    char *out = (char *)ctx_arena_alloc(a, pos + 1);
    if (!out) return false;
    memcpy(out, buf, pos + 1);

    *out_path = out;
    *out_method = method;
    return true;
}
