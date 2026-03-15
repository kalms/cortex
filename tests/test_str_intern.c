/*
 * test_str_intern.c — RED phase tests for foundation/str_intern.
 */
#include "test_framework.h"
#include "../src/foundation/str_intern.h"

TEST(intern_create_free) {
    CBMInternPool *pool = cbm_intern_create();
    ASSERT_NOT_NULL(pool);
    ASSERT_EQ(cbm_intern_count(pool), 0);
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_basic) {
    CBMInternPool *pool = cbm_intern_create();
    const char *s1 = cbm_intern(pool, "hello");
    ASSERT_NOT_NULL(s1);
    ASSERT_STR_EQ(s1, "hello");
    ASSERT_EQ(cbm_intern_count(pool), 1);
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_dedup) {
    CBMInternPool *pool = cbm_intern_create();
    const char *s1 = cbm_intern(pool, "hello");
    const char *s2 = cbm_intern(pool, "hello");
    /* Must return same pointer */
    ASSERT_EQ((uintptr_t)s1, (uintptr_t)s2);
    ASSERT_EQ(cbm_intern_count(pool), 1); /* still 1 */
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_different_strings) {
    CBMInternPool *pool = cbm_intern_create();
    const char *s1 = cbm_intern(pool, "hello");
    const char *s2 = cbm_intern(pool, "world");
    ASSERT_NEQ((uintptr_t)s1, (uintptr_t)s2);
    ASSERT_STR_EQ(s1, "hello");
    ASSERT_STR_EQ(s2, "world");
    ASSERT_EQ(cbm_intern_count(pool), 2);
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_n_with_length) {
    CBMInternPool *pool = cbm_intern_create();
    const char *s1 = cbm_intern_n(pool, "hello world", 5);
    ASSERT_STR_EQ(s1, "hello");
    /* Should dedup with full "hello" */
    const char *s2 = cbm_intern(pool, "hello");
    ASSERT_EQ((uintptr_t)s1, (uintptr_t)s2);
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_empty_string) {
    CBMInternPool *pool = cbm_intern_create();
    const char *s = cbm_intern(pool, "");
    ASSERT_NOT_NULL(s);
    ASSERT_STR_EQ(s, "");
    ASSERT_EQ(cbm_intern_count(pool), 1);
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_many_strings) {
    CBMInternPool *pool = cbm_intern_create();
    char buf[64];
    for (int i = 0; i < 1000; i++) {
        snprintf(buf, sizeof(buf), "string_%04d", i);
        const char *s = cbm_intern(pool, buf);
        ASSERT_NOT_NULL(s);
    }
    ASSERT_EQ(cbm_intern_count(pool), 1000);

    /* Verify dedup — intern same strings again */
    for (int i = 0; i < 1000; i++) {
        snprintf(buf, sizeof(buf), "string_%04d", i);
        cbm_intern(pool, buf);
    }
    ASSERT_EQ(cbm_intern_count(pool), 1000); /* still 1000 */
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_bytes) {
    CBMInternPool *pool = cbm_intern_create();
    cbm_intern(pool, "abc");   /* 3 bytes + NUL */
    cbm_intern(pool, "defgh"); /* 5 bytes + NUL */
    /* bytes should be at least 8 (3+5 for the content) */
    ASSERT_GTE(cbm_intern_bytes(pool), 8);
    cbm_intern_free(pool);
    PASS();
}

TEST(intern_survives_stack_buffer) {
    CBMInternPool *pool = cbm_intern_create();
    const char *interned;
    {
        char buf[32];
        strcpy(buf, "stack_string");
        interned = cbm_intern(pool, buf);
    }
    /* buf is out of scope, but interned should still be valid */
    ASSERT_STR_EQ(interned, "stack_string");
    cbm_intern_free(pool);
    PASS();
}

SUITE(str_intern) {
    RUN_TEST(intern_create_free);
    RUN_TEST(intern_basic);
    RUN_TEST(intern_dedup);
    RUN_TEST(intern_different_strings);
    RUN_TEST(intern_n_with_length);
    RUN_TEST(intern_empty_string);
    RUN_TEST(intern_many_strings);
    RUN_TEST(intern_bytes);
    RUN_TEST(intern_survives_stack_buffer);
}
