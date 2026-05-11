/*
 * test_gitignore.c — Tests for gitignore-style pattern matching.
 *
 * RED phase: These tests define the expected pattern matching behavior.
 */
#include "../src/foundation/compat.h"
#include "test_framework.h"
#include "discover/discover.h"

/* ── Basic pattern matching ────────────────────────────────────── */

TEST(gi_empty_pattern) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("");
    ASSERT_NOT_NULL(gi);
    ASSERT_FALSE(ctx_gitignore_matches(gi, "foo.txt", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_exact_file) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("secret.key\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "secret.key", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "other.key", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_wildcard_star) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("*.log\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "error.log", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "access.log", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "error.txt", false));
    /* Non-rooted pattern matches basename at any depth */
    ASSERT_TRUE(ctx_gitignore_matches(gi, "logs/error.log", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_double_star_prefix) {
    /* ** matches any number of directories */
    ctx_gitignore_t *gi = ctx_gitignore_parse("**/build\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "build", true));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "src/build", true));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "a/b/c/build", true));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_double_star_suffix) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("logs/**\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "logs/debug.log", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "logs/sub/trace.log", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "src/logs", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_double_star_middle) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("a/**/b\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "a/b", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "a/x/b", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "a/x/y/z/b", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "c/a/b", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_directory_only) {
    /* Trailing slash means match directories only */
    ctx_gitignore_t *gi = ctx_gitignore_parse("build/\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "build", true));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "build", false)); /* not a directory */
    /* Should match anywhere in tree */
    ASSERT_TRUE(ctx_gitignore_matches(gi, "src/build", true));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_negation) {
    /* ! prefix negates a pattern */
    ctx_gitignore_t *gi = ctx_gitignore_parse("*.log\n!important.log\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "error.log", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "important.log", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_comment_and_blank) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("# This is a comment\n\n*.tmp\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "data.tmp", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "data.txt", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_rooted_pattern) {
    /* Pattern with slash is anchored to the root */
    ctx_gitignore_t *gi = ctx_gitignore_parse("/build\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "build", true));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "src/build", true));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_path_with_slash) {
    /* Pattern containing / (not just leading) is rooted */
    ctx_gitignore_t *gi = ctx_gitignore_parse("doc/frotz\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "doc/frotz", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "src/doc/frotz", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_question_mark) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("file?.txt\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "file1.txt", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "fileA.txt", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "file12.txt", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_bracket_range) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("file[0-9].txt\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "file3.txt", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "fileA.txt", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_multiple_patterns) {
    ctx_gitignore_t *gi = ctx_gitignore_parse("*.pyc\n"
                                              "__pycache__/\n"
                                              ".env\n"
                                              "*.log\n");
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "module.pyc", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "__pycache__", true));
    ASSERT_TRUE(ctx_gitignore_matches(gi, ".env", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "app.log", false));
    ASSERT_FALSE(ctx_gitignore_matches(gi, "main.py", false));
    ctx_gitignore_free(gi);
    PASS();
}

TEST(gi_null_safe_free) {
    ctx_gitignore_free(NULL); /* should not crash */
    PASS();
}

/* ── Load from file ────────────────────────────────────────────── */

TEST(gi_load_file) {
    char path[256]; snprintf(path, sizeof(path), "%s/test_gitignore_file", ctx_tmpdir());
    FILE *f = fopen(path, "w");
    ASSERT_NOT_NULL(f);
    fprintf(f, "*.o\nbuild/\n");
    fclose(f);

    ctx_gitignore_t *gi = ctx_gitignore_load(path);
    ASSERT_NOT_NULL(gi);
    ASSERT_TRUE(ctx_gitignore_matches(gi, "main.o", false));
    ASSERT_TRUE(ctx_gitignore_matches(gi, "build", true));
    ctx_gitignore_free(gi);
    remove(path);
    PASS();
}

TEST(gi_load_nonexistent) {
    char np[256];
    snprintf(np, sizeof(np), "%s/nonexistent_gitignore_12345", ctx_tmpdir());
    ctx_gitignore_t *gi = ctx_gitignore_load(np);
    ASSERT_NULL(gi);
    PASS();
}

/* ── Suite ─────────────────────────────────────────────────────── */

SUITE(gitignore) {
    RUN_TEST(gi_empty_pattern);
    RUN_TEST(gi_exact_file);
    RUN_TEST(gi_wildcard_star);
    RUN_TEST(gi_double_star_prefix);
    RUN_TEST(gi_double_star_suffix);
    RUN_TEST(gi_double_star_middle);
    RUN_TEST(gi_directory_only);
    RUN_TEST(gi_negation);
    RUN_TEST(gi_comment_and_blank);
    RUN_TEST(gi_rooted_pattern);
    RUN_TEST(gi_path_with_slash);
    RUN_TEST(gi_question_mark);
    RUN_TEST(gi_bracket_range);
    RUN_TEST(gi_multiple_patterns);
    RUN_TEST(gi_null_safe_free);
    RUN_TEST(gi_load_file);
    RUN_TEST(gi_load_nonexistent);
}
