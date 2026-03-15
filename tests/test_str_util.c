/*
 * test_str_util.c — RED phase tests for foundation/str_util.
 */
#include "test_framework.h"
#include "../src/foundation/str_util.h"

static CBMArena a;

static void setup(void) { cbm_arena_init(&a); }
static void teardown(void) { cbm_arena_destroy(&a); }

TEST(path_join_basic) {
    setup();
    ASSERT_STR_EQ(cbm_path_join(&a, "src", "main.c"), "src/main.c");
    teardown();
    PASS();
}

TEST(path_join_trailing_slash) {
    setup();
    ASSERT_STR_EQ(cbm_path_join(&a, "src/", "main.c"), "src/main.c");
    teardown();
    PASS();
}

TEST(path_join_leading_slash) {
    setup();
    ASSERT_STR_EQ(cbm_path_join(&a, "src", "/main.c"), "src/main.c");
    teardown();
    PASS();
}

TEST(path_join_empty_base) {
    setup();
    ASSERT_STR_EQ(cbm_path_join(&a, "", "main.c"), "main.c");
    teardown();
    PASS();
}

TEST(path_join_empty_name) {
    setup();
    ASSERT_STR_EQ(cbm_path_join(&a, "src", ""), "src");
    teardown();
    PASS();
}

TEST(path_join_n) {
    setup();
    const char *parts[] = {"a", "b", "c", "d.txt"};
    ASSERT_STR_EQ(cbm_path_join_n(&a, parts, 4), "a/b/c/d.txt");
    teardown();
    PASS();
}

TEST(path_ext) {
    ASSERT_STR_EQ(cbm_path_ext("foo.go"), "go");
    ASSERT_STR_EQ(cbm_path_ext("foo.tar.gz"), "gz");
    ASSERT_STR_EQ(cbm_path_ext("Makefile"), "");
    ASSERT_STR_EQ(cbm_path_ext(".gitignore"), "gitignore");
    PASS();
}

TEST(path_base) {
    ASSERT_STR_EQ(cbm_path_base("src/main.c"), "main.c");
    ASSERT_STR_EQ(cbm_path_base("main.c"), "main.c");
    ASSERT_STR_EQ(cbm_path_base("/a/b/c"), "c");
    PASS();
}

TEST(path_dir) {
    setup();
    ASSERT_STR_EQ(cbm_path_dir(&a, "src/main.c"), "src");
    ASSERT_STR_EQ(cbm_path_dir(&a, "main.c"), ".");
    ASSERT_STR_EQ(cbm_path_dir(&a, "/a/b/c"), "/a/b");
    teardown();
    PASS();
}

TEST(str_starts_with) {
    ASSERT_TRUE(cbm_str_starts_with("hello world", "hello"));
    ASSERT_FALSE(cbm_str_starts_with("hello", "hello world"));
    ASSERT_TRUE(cbm_str_starts_with("hello", ""));
    ASSERT_TRUE(cbm_str_starts_with("hello", "hello"));
    PASS();
}

TEST(str_ends_with) {
    ASSERT_TRUE(cbm_str_ends_with("hello world", "world"));
    ASSERT_FALSE(cbm_str_ends_with("hello", "hello world"));
    ASSERT_TRUE(cbm_str_ends_with("hello", ""));
    ASSERT_TRUE(cbm_str_ends_with("hello", "hello"));
    PASS();
}

TEST(str_contains) {
    ASSERT_TRUE(cbm_str_contains("hello world", "lo wo"));
    ASSERT_FALSE(cbm_str_contains("hello", "xyz"));
    ASSERT_TRUE(cbm_str_contains("hello", ""));
    PASS();
}

TEST(str_tolower) {
    setup();
    ASSERT_STR_EQ(cbm_str_tolower(&a, "Hello World"), "hello world");
    ASSERT_STR_EQ(cbm_str_tolower(&a, "already"), "already");
    ASSERT_STR_EQ(cbm_str_tolower(&a, ""), "");
    teardown();
    PASS();
}

TEST(str_replace_char) {
    setup();
    ASSERT_STR_EQ(cbm_str_replace_char(&a, "a/b/c", '/', '.'), "a.b.c");
    ASSERT_STR_EQ(cbm_str_replace_char(&a, "no-change", '/', '.'), "no-change");
    teardown();
    PASS();
}

TEST(str_strip_ext) {
    setup();
    ASSERT_STR_EQ(cbm_str_strip_ext(&a, "foo.go"), "foo");
    ASSERT_STR_EQ(cbm_str_strip_ext(&a, "foo.tar.gz"), "foo.tar");
    ASSERT_STR_EQ(cbm_str_strip_ext(&a, "Makefile"), "Makefile");
    teardown();
    PASS();
}

TEST(str_split) {
    setup();
    int count = 0;
    char **parts = cbm_str_split(&a, "a/b/c/d", '/', &count);
    ASSERT_EQ(count, 4);
    ASSERT_STR_EQ(parts[0], "a");
    ASSERT_STR_EQ(parts[1], "b");
    ASSERT_STR_EQ(parts[2], "c");
    ASSERT_STR_EQ(parts[3], "d");
    teardown();
    PASS();
}

TEST(str_split_empty) {
    setup();
    int count = 0;
    char **parts = cbm_str_split(&a, "", '/', &count);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(parts[0], "");
    teardown();
    PASS();
}

TEST(str_split_no_delim) {
    setup();
    int count = 0;
    char **parts = cbm_str_split(&a, "hello", '/', &count);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(parts[0], "hello");
    teardown();
    PASS();
}

SUITE(str_util) {
    RUN_TEST(path_join_basic);
    RUN_TEST(path_join_trailing_slash);
    RUN_TEST(path_join_leading_slash);
    RUN_TEST(path_join_empty_base);
    RUN_TEST(path_join_empty_name);
    RUN_TEST(path_join_n);
    RUN_TEST(path_ext);
    RUN_TEST(path_base);
    RUN_TEST(path_dir);
    RUN_TEST(str_starts_with);
    RUN_TEST(str_ends_with);
    RUN_TEST(str_contains);
    RUN_TEST(str_tolower);
    RUN_TEST(str_replace_char);
    RUN_TEST(str_strip_ext);
    RUN_TEST(str_split);
    RUN_TEST(str_split_empty);
    RUN_TEST(str_split_no_delim);
}
