/*
 * ast_profile.h — Extraction-time AST structural signals.
 *
 * Computed during the existing AST walk (alongside MinHash) with near-zero
 * marginal cost.  Captures control flow shape, expression types, data flow
 * approximations, and Halstead-lite metrics.
 *
 * Stored as a compact comma-separated string in properties_json ("sp" key)
 * and decoded in the semantic post-pass for combined similarity scoring.
 */
#ifndef CTX_AST_PROFILE_H
#define CTX_AST_PROFILE_H

#include <stdbool.h>
#include <stdint.h>

/* Forward declare tree-sitter types to avoid pulling in api.h everywhere. */
typedef struct TSNode TSNode;

/* ── Structural profile: ~27 dimensions ──────────────────────────── */

typedef struct {
    /* Signal 8: Control flow counts */
    uint16_t if_count;
    uint16_t for_count;
    uint16_t while_count;
    uint16_t switch_count;
    uint16_t try_count;
    uint16_t return_count;
    uint16_t max_nesting_depth;
    uint16_t avg_nesting_depth_x10; /* ×10 for fixed-point */

    /* Signal 8: Expression type distribution (counts) */
    uint16_t comparison_ops;
    uint16_t arithmetic_ops;
    uint16_t logical_ops;
    uint16_t assignment_count;

    /* Signal 8: Literal type distribution */
    uint16_t string_literals;
    uint16_t number_literals;
    uint16_t bool_literals;

    /* Signal 9: Approximate data flow */
    uint16_t param_count;
    uint16_t params_in_returns;    /* params referenced in return statements */
    uint16_t params_in_conditions; /* params referenced in if conditions */
    uint16_t variable_reassigns;   /* same-name assignments */

    /* Signal 11: Halstead-lite */
    uint16_t unique_operators;
    uint16_t unique_operands;
    uint16_t total_operators;
    uint16_t total_operands;

    /* Body metrics */
    uint16_t body_lines;
    uint16_t body_tokens; /* leaf AST node count */
} ctx_ast_profile_t;

/* Number of dimensions when serialized as a float vector. */
enum { CTX_AST_PROFILE_DIMS = 25 };

/* Compute AST structural profile from a function body node.
 * Pure function — thread-safe, no shared state.
 * Returns true if the profile was computed (function was large enough). */
bool ctx_ast_profile_compute(TSNode func_body, const char *source, const char **param_names,
                             int param_count, ctx_ast_profile_t *out);

/* Encode profile to a compact comma-separated string.
 * buf must be at least CTX_AST_PROFILE_BUF bytes. */
enum { CTX_AST_PROFILE_BUF = 200 };
void ctx_ast_profile_to_str(const ctx_ast_profile_t *p, char *buf, int bufsize);

/* Decode profile from comma-separated string. Returns true on success. */
bool ctx_ast_profile_from_str(const char *str, ctx_ast_profile_t *out);

/* Convert profile to a normalized float vector for cosine similarity.
 * out must have CTX_AST_PROFILE_DIMS elements. */
void ctx_ast_profile_to_vector(const ctx_ast_profile_t *p, float *out);

#endif /* CTX_AST_PROFILE_H */
