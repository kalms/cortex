/*
 * test_dyn_array.c — RED phase tests for foundation/dyn_array.
 */
#include "test_framework.h"
#include "../src/foundation/dyn_array.h"

TEST(da_push_pop) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_push(&arr, 10);
    cbm_da_push(&arr, 20);
    cbm_da_push(&arr, 30);
    ASSERT_EQ(arr.count, 3);
    ASSERT_EQ(arr.items[0], 10);
    ASSERT_EQ(arr.items[1], 20);
    ASSERT_EQ(arr.items[2], 30);

    int v = cbm_da_pop(&arr);
    ASSERT_EQ(v, 30);
    ASSERT_EQ(arr.count, 2);
    cbm_da_free(&arr);
    PASS();
}

TEST(da_last) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_push(&arr, 1);
    cbm_da_push(&arr, 2);
    ASSERT_EQ(cbm_da_last(&arr), 2);
    cbm_da_free(&arr);
    PASS();
}

TEST(da_clear) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_push(&arr, 1);
    cbm_da_push(&arr, 2);
    cbm_da_clear(&arr);
    ASSERT_EQ(arr.count, 0);
    /* cap should still be > 0 (memory retained) */
    ASSERT_GT(arr.cap, 0);
    cbm_da_free(&arr);
    PASS();
}

TEST(da_free) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_push(&arr, 1);
    cbm_da_free(&arr);
    ASSERT_NULL(arr.items);
    ASSERT_EQ(arr.count, 0);
    ASSERT_EQ(arr.cap, 0);
    PASS();
}

TEST(da_growth) {
    CBM_DYN_ARRAY(int) arr = {0};
    /* Push 1000 items — verify capacity grows */
    for (int i = 0; i < 1000; i++) {
        cbm_da_push(&arr, i);
    }
    ASSERT_EQ(arr.count, 1000);
    ASSERT_GTE(arr.cap, 1000);
    /* Verify all values */
    for (int i = 0; i < 1000; i++) {
        ASSERT_EQ(arr.items[i], i);
    }
    cbm_da_free(&arr);
    PASS();
}

TEST(da_reserve) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_reserve(&arr, 100);
    ASSERT_GTE(arr.cap, 100);
    ASSERT_EQ(arr.count, 0);
    cbm_da_free(&arr);
    PASS();
}

TEST(da_struct_type) {
    typedef struct {
        int x;
        float y;
    } Point;
    CBM_DYN_ARRAY(Point) pts = {0};
    cbm_da_push(&pts, ((Point){.x = 1, .y = 2.5f}));
    cbm_da_push(&pts, ((Point){.x = 3, .y = 4.5f}));
    ASSERT_EQ(pts.count, 2);
    ASSERT_EQ(pts.items[0].x, 1);
    ASSERT_EQ(pts.items[1].x, 3);
    cbm_da_free(&pts);
    PASS();
}

TEST(da_string_ptrs) {
    CBM_DYN_ARRAY(const char *) strs = {0};
    cbm_da_push(&strs, "hello");
    cbm_da_push(&strs, "world");
    ASSERT_EQ(strs.count, 2);
    ASSERT_STR_EQ(strs.items[0], "hello");
    ASSERT_STR_EQ(strs.items[1], "world");
    cbm_da_free(&strs);
    PASS();
}

TEST(da_remove) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_push(&arr, 10);
    cbm_da_push(&arr, 20);
    cbm_da_push(&arr, 30);
    cbm_da_remove(&arr, 1); /* remove 20 */
    ASSERT_EQ(arr.count, 2);
    ASSERT_EQ(arr.items[0], 10);
    ASSERT_EQ(arr.items[1], 30);
    cbm_da_free(&arr);
    PASS();
}

TEST(da_insert) {
    CBM_DYN_ARRAY(int) arr = {0};
    cbm_da_push(&arr, 10);
    cbm_da_push(&arr, 30);
    cbm_da_insert(&arr, 1, 20); /* insert 20 at index 1 */
    ASSERT_EQ(arr.count, 3);
    ASSERT_EQ(arr.items[0], 10);
    ASSERT_EQ(arr.items[1], 20);
    ASSERT_EQ(arr.items[2], 30);
    cbm_da_free(&arr);
    PASS();
}

SUITE(dyn_array) {
    RUN_TEST(da_push_pop);
    RUN_TEST(da_last);
    RUN_TEST(da_clear);
    RUN_TEST(da_free);
    RUN_TEST(da_growth);
    RUN_TEST(da_reserve);
    RUN_TEST(da_struct_type);
    RUN_TEST(da_string_ptrs);
    RUN_TEST(da_remove);
    RUN_TEST(da_insert);
}
