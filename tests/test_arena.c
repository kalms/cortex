/*
 * test_arena.c — RED phase tests for foundation/arena.
 */
#include "test_framework.h"
#include "../src/foundation/arena.h"

TEST(arena_init_default) {
    CBMArena a;
    cbm_arena_init(&a);
    ASSERT_EQ(a.nblocks, 1);
    ASSERT_EQ(a.block_size, CBM_ARENA_DEFAULT_BLOCK_SIZE);
    ASSERT_EQ(a.used, 0);
    ASSERT_EQ(a.total_alloc, 0);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_init_sized) {
    CBMArena a;
    cbm_arena_init_sized(&a, 256);
    ASSERT_EQ(a.nblocks, 1);
    ASSERT_EQ(a.block_size, 256);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_alloc_basic) {
    CBMArena a;
    cbm_arena_init(&a);
    void *p = cbm_arena_alloc(&a, 100);
    ASSERT_NOT_NULL(p);
    ASSERT_GT(a.used, 0);
    ASSERT_GT(a.total_alloc, 0);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_alloc_zero) {
    CBMArena a;
    cbm_arena_init(&a);
    void *p = cbm_arena_alloc(&a, 0);
    ASSERT_NULL(p);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_alloc_alignment) {
    CBMArena a;
    cbm_arena_init(&a);
    /* Allocate 1 byte — should be padded to 8 */
    void *p1 = cbm_arena_alloc(&a, 1);
    void *p2 = cbm_arena_alloc(&a, 1);
    ASSERT_NOT_NULL(p1);
    ASSERT_NOT_NULL(p2);
    /* Both should be 8-byte aligned */
    ASSERT_EQ((uintptr_t)p1 % 8, 0);
    ASSERT_EQ((uintptr_t)p2 % 8, 0);
    /* And 8 bytes apart */
    ASSERT_EQ((char*)p2 - (char*)p1, 8);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_alloc_grows_blocks) {
    CBMArena a;
    cbm_arena_init_sized(&a, 64); /* tiny block to force growth */
    /* Allocate more than one block's worth */
    void *p1 = cbm_arena_alloc(&a, 48);
    ASSERT_NOT_NULL(p1);
    ASSERT_EQ(a.nblocks, 1);
    void *p2 = cbm_arena_alloc(&a, 48);
    ASSERT_NOT_NULL(p2);
    ASSERT_EQ(a.nblocks, 2); /* should have grown */
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_alloc_large_single) {
    CBMArena a;
    cbm_arena_init_sized(&a, 64);
    /* Allocate something larger than block_size */
    void *p = cbm_arena_alloc(&a, 256);
    ASSERT_NOT_NULL(p);
    ASSERT_GTE(a.block_size, 256);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_calloc) {
    CBMArena a;
    cbm_arena_init(&a);
    unsigned char *p = (unsigned char *)cbm_arena_calloc(&a, 64);
    ASSERT_NOT_NULL(p);
    /* All bytes should be zero */
    for (int i = 0; i < 64; i++) {
        ASSERT_EQ(p[i], 0);
    }
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_strdup) {
    CBMArena a;
    cbm_arena_init(&a);
    char *s = cbm_arena_strdup(&a, "hello world");
    ASSERT_NOT_NULL(s);
    ASSERT_STR_EQ(s, "hello world");
    /* Original string modification shouldn't affect copy */
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_strdup_null) {
    CBMArena a;
    cbm_arena_init(&a);
    char *s = cbm_arena_strdup(&a, NULL);
    ASSERT_NULL(s);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_strndup) {
    CBMArena a;
    cbm_arena_init(&a);
    char *s = cbm_arena_strndup(&a, "hello world", 5);
    ASSERT_NOT_NULL(s);
    ASSERT_STR_EQ(s, "hello");
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_sprintf) {
    CBMArena a;
    cbm_arena_init(&a);
    char *s = cbm_arena_sprintf(&a, "%s.%s.%s", "project", "path", "name");
    ASSERT_NOT_NULL(s);
    ASSERT_STR_EQ(s, "project.path.name");
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_sprintf_int) {
    CBMArena a;
    cbm_arena_init(&a);
    char *s = cbm_arena_sprintf(&a, "count=%d", 42);
    ASSERT_NOT_NULL(s);
    ASSERT_STR_EQ(s, "count=42");
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_reset) {
    CBMArena a;
    cbm_arena_init_sized(&a, 128);
    /* Allocate enough to create multiple blocks */
    cbm_arena_alloc(&a, 100);
    cbm_arena_alloc(&a, 100);
    ASSERT_GTE(a.nblocks, 2);
    /* Reset should keep first block, free rest */
    cbm_arena_reset(&a);
    ASSERT_EQ(a.nblocks, 1);
    ASSERT_EQ(a.used, 0);
    /* Should still be usable */
    void *p = cbm_arena_alloc(&a, 16);
    ASSERT_NOT_NULL(p);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_total) {
    CBMArena a;
    cbm_arena_init(&a);
    ASSERT_EQ(cbm_arena_total(&a), 0);
    cbm_arena_alloc(&a, 100);
    ASSERT_GTE(cbm_arena_total(&a), 100); /* at least 100 (may be aligned) */
    cbm_arena_alloc(&a, 200);
    ASSERT_GTE(cbm_arena_total(&a), 300);
    cbm_arena_destroy(&a);
    PASS();
}

TEST(arena_many_small_allocs) {
    CBMArena a;
    cbm_arena_init(&a);
    /* 10K small allocations — shouldn't exhaust MAX_BLOCKS */
    for (int i = 0; i < 10000; i++) {
        void *p = cbm_arena_alloc(&a, 16);
        ASSERT_NOT_NULL(p);
    }
    cbm_arena_destroy(&a);
    PASS();
}

SUITE(arena) {
    RUN_TEST(arena_init_default);
    RUN_TEST(arena_init_sized);
    RUN_TEST(arena_alloc_basic);
    RUN_TEST(arena_alloc_zero);
    RUN_TEST(arena_alloc_alignment);
    RUN_TEST(arena_alloc_grows_blocks);
    RUN_TEST(arena_alloc_large_single);
    RUN_TEST(arena_calloc);
    RUN_TEST(arena_strdup);
    RUN_TEST(arena_strdup_null);
    RUN_TEST(arena_strndup);
    RUN_TEST(arena_sprintf);
    RUN_TEST(arena_sprintf_int);
    RUN_TEST(arena_reset);
    RUN_TEST(arena_total);
    RUN_TEST(arena_many_small_allocs);
}
