/*
 * test_hash_table.c — RED phase tests for foundation/hash_table.
 */
#include "test_framework.h"
#include "../src/foundation/hash_table.h"

TEST(ht_create_free) {
    CtxHashTable *ht = ctx_ht_create(16);
    ASSERT_NOT_NULL(ht);
    ASSERT_EQ(ctx_ht_count(ht), 0);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_set_get) {
    CtxHashTable *ht = ctx_ht_create(8);
    int val = 42;
    void *prev = ctx_ht_set(ht, "hello", &val);
    ASSERT_NULL(prev); /* first insert */
    void *got = ctx_ht_get(ht, "hello");
    ASSERT_EQ(got, &val);
    ASSERT_EQ(*(int *)got, 42);
    ASSERT_EQ(ctx_ht_count(ht), 1);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_set_overwrite) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v1 = 1, v2 = 2;
    ctx_ht_set(ht, "key", &v1);
    void *prev = ctx_ht_set(ht, "key", &v2);
    ASSERT_EQ(prev, &v1); /* returns old value */
    ASSERT_EQ(*(int *)ctx_ht_get(ht, "key"), 2);
    ASSERT_EQ(ctx_ht_count(ht), 1); /* still 1 entry */
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_get_missing) {
    CtxHashTable *ht = ctx_ht_create(8);
    ASSERT_NULL(ctx_ht_get(ht, "nope"));
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_has) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v = 1;
    ctx_ht_set(ht, "exists", &v);
    ASSERT_TRUE(ctx_ht_has(ht, "exists"));
    ASSERT_FALSE(ctx_ht_has(ht, "missing"));
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_delete) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v = 99;
    ctx_ht_set(ht, "delete_me", &v);
    ASSERT_EQ(ctx_ht_count(ht), 1);

    void *removed = ctx_ht_delete(ht, "delete_me");
    ASSERT_EQ(removed, &v);
    ASSERT_EQ(ctx_ht_count(ht), 0);
    ASSERT_NULL(ctx_ht_get(ht, "delete_me"));
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_delete_missing) {
    CtxHashTable *ht = ctx_ht_create(8);
    void *removed = ctx_ht_delete(ht, "nope");
    ASSERT_NULL(removed);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_many_entries) {
    CtxHashTable *ht = ctx_ht_create(4); /* tiny initial, force resize */
    char keys[200][32];
    int vals[200];
    for (int i = 0; i < 200; i++) {
        snprintf(keys[i], sizeof(keys[i]), "key_%03d", i);
        vals[i] = i * 10;
        ctx_ht_set(ht, keys[i], &vals[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 200);
    /* Verify all entries survive resize */
    for (int i = 0; i < 200; i++) {
        void *got = ctx_ht_get(ht, keys[i]);
        ASSERT_NOT_NULL(got);
        ASSERT_EQ(*(int *)got, i * 10);
    }
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_delete_then_reinsert) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v1 = 1, v2 = 2;
    ctx_ht_set(ht, "key", &v1);
    ctx_ht_delete(ht, "key");
    ctx_ht_set(ht, "key", &v2);
    ASSERT_EQ(*(int *)ctx_ht_get(ht, "key"), 2);
    ASSERT_EQ(ctx_ht_count(ht), 1);
    ctx_ht_free(ht);
    PASS();
}

static int foreach_sum;
static void sum_values(const char *key, void *value, void *userdata) {
    (void)key;
    (void)userdata;
    foreach_sum += *(int *)value;
}

TEST(ht_foreach) {
    CtxHashTable *ht = ctx_ht_create(8);
    int vals[] = {10, 20, 30};
    ctx_ht_set(ht, "a", &vals[0]);
    ctx_ht_set(ht, "b", &vals[1]);
    ctx_ht_set(ht, "c", &vals[2]);

    foreach_sum = 0;
    ctx_ht_foreach(ht, sum_values, NULL);
    ASSERT_EQ(foreach_sum, 60);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_clear) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v = 1;
    ctx_ht_set(ht, "a", &v);
    ctx_ht_set(ht, "b", &v);
    ctx_ht_clear(ht);
    ASSERT_EQ(ctx_ht_count(ht), 0);
    ASSERT_NULL(ctx_ht_get(ht, "a"));
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_empty_string_key) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v = 42;
    ctx_ht_set(ht, "", &v);
    ASSERT_EQ(*(int *)ctx_ht_get(ht, ""), 42);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_long_key) {
    CtxHashTable *ht = ctx_ht_create(8);
    /* 200-char key */
    char long_key[201];
    memset(long_key, 'x', 200);
    long_key[200] = '\0';
    int v = 99;
    ctx_ht_set(ht, long_key, &v);
    ASSERT_EQ(*(int *)ctx_ht_get(ht, long_key), 99);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_power_of_two_capacity) {
    /* Capacity 7 should be rounded up to 8 */
    CtxHashTable *ht = ctx_ht_create(7);
    ASSERT_NOT_NULL(ht);
    /* capacity should be >= 8 and power of 2 */
    ASSERT_GTE(ht->capacity, 8);
    ASSERT_EQ(ht->capacity & (ht->capacity - 1), 0); /* power of 2 check */
    ctx_ht_free(ht);
    PASS();
}

/* ── Edge case tests ───────────────────────────────────────────── */

TEST(ht_get_key_returns_stored_pointer) {
    CtxHashTable *ht = ctx_ht_create(8);
    /* Use a heap key so we can verify the stored pointer differs from lookup */
    char stored_key[] = "mykey";
    int v = 1;
    ctx_ht_set(ht, stored_key, &v);
    /* Look up with a different buffer containing same string */
    char lookup[] = "mykey";
    const char *got = ctx_ht_get_key(ht, lookup);
    ASSERT_NOT_NULL(got);
    ASSERT_STR_EQ(got, "mykey");
    /* Should return the pointer we inserted with, not the lookup buffer */
    ASSERT_EQ((uintptr_t)got, (uintptr_t)stored_key);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_get_key_missing) {
    CtxHashTable *ht = ctx_ht_create(8);
    const char *got = ctx_ht_get_key(ht, "nonexistent");
    ASSERT_NULL(got);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_get_key_null_ht) {
    const char *got = ctx_ht_get_key(NULL, "key");
    ASSERT_NULL(got);
    PASS();
}

TEST(ht_get_key_null_key) {
    CtxHashTable *ht = ctx_ht_create(8);
    const char *got = ctx_ht_get_key(ht, NULL);
    ASSERT_NULL(got);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_count_null) {
    ASSERT_EQ(ctx_ht_count(NULL), 0);
    PASS();
}

TEST(ht_free_null) {
    /* Should not crash */
    ctx_ht_free(NULL);
    PASS();
}

TEST(ht_clear_null) {
    /* Should not crash */
    ctx_ht_clear(NULL);
    PASS();
}

TEST(ht_foreach_null_ht) {
    /* Should not crash */
    ctx_ht_foreach(NULL, sum_values, NULL);
    PASS();
}

TEST(ht_foreach_null_fn) {
    CtxHashTable *ht = ctx_ht_create(8);
    int v = 1;
    ctx_ht_set(ht, "a", &v);
    /* Should not crash with NULL function pointer */
    ctx_ht_foreach(ht, NULL, NULL);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_delete_readd_stress) {
    /* Stress backward-shift deletion: add 100, delete all, re-add all */
    CtxHashTable *ht = ctx_ht_create(8);
    char keys[100][16];
    int vals[100];
    for (int i = 0; i < 100; i++) {
        snprintf(keys[i], sizeof(keys[i]), "key_%03d", i);
        vals[i] = i;
        ctx_ht_set(ht, keys[i], &vals[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 100);

    /* Delete all */
    for (int i = 0; i < 100; i++) {
        void *removed = ctx_ht_delete(ht, keys[i]);
        ASSERT_EQ(removed, &vals[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 0);

    /* Re-add all — exercises slots freed by backward shift */
    for (int i = 0; i < 100; i++) {
        ctx_ht_set(ht, keys[i], &vals[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 100);
    for (int i = 0; i < 100; i++) {
        ASSERT_EQ(*(int *)ctx_ht_get(ht, keys[i]), i);
    }
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_interleaved_insert_delete) {
    /* Insert 100, delete odd-indexed, verify even-indexed survive */
    CtxHashTable *ht = ctx_ht_create(8);
    char keys[100][16];
    int vals[100];
    for (int i = 0; i < 100; i++) {
        snprintf(keys[i], sizeof(keys[i]), "entry_%03d", i);
        vals[i] = i * 7;
        ctx_ht_set(ht, keys[i], &vals[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 100);

    /* Delete all odd-indexed entries */
    for (int i = 1; i < 100; i += 2) {
        ctx_ht_delete(ht, keys[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 50);

    /* Verify even entries intact, odd entries gone */
    for (int i = 0; i < 100; i++) {
        void *got = ctx_ht_get(ht, keys[i]);
        if (i % 2 == 0) {
            ASSERT_NOT_NULL(got);
            ASSERT_EQ(*(int *)got, i * 7);
        } else {
            ASSERT_NULL(got);
        }
    }
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_create_capacity_zero) {
    /* Capacity 0 should be rounded up to minimum (8) */
    CtxHashTable *ht = ctx_ht_create(0);
    ASSERT_NOT_NULL(ht);
    ASSERT_GTE(ht->capacity, 8);
    ASSERT_EQ(ht->capacity & (ht->capacity - 1), 0);
    /* Should be usable */
    int v = 42;
    ctx_ht_set(ht, "test", &v);
    ASSERT_EQ(*(int *)ctx_ht_get(ht, "test"), 42);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_create_capacity_one) {
    /* Capacity 1 should be rounded up to minimum (8) */
    CtxHashTable *ht = ctx_ht_create(1);
    ASSERT_NOT_NULL(ht);
    ASSERT_GTE(ht->capacity, 8);
    int v = 99;
    ctx_ht_set(ht, "k", &v);
    ASSERT_EQ(*(int *)ctx_ht_get(ht, "k"), 99);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_stress_10000) {
    CtxHashTable *ht = ctx_ht_create(16);
    char keys[10000][24];
    int vals[10000];
    for (int i = 0; i < 10000; i++) {
        snprintf(keys[i], sizeof(keys[i]), "stress_key_%06d", i);
        vals[i] = i;
        ctx_ht_set(ht, keys[i], &vals[i]);
    }
    ASSERT_EQ(ctx_ht_count(ht), 10000);
    /* Verify all */
    for (int i = 0; i < 10000; i++) {
        void *got = ctx_ht_get(ht, keys[i]);
        ASSERT_NOT_NULL(got);
        ASSERT_EQ(*(int *)got, i);
    }
    /* Capacity should still be power of 2 */
    ASSERT_EQ(ht->capacity & (ht->capacity - 1), 0);
    ctx_ht_free(ht);
    PASS();
}

TEST(ht_robin_hood_bounded_psl) {
    /* Max PSL should be bounded — Robin Hood keeps probes short.
     * With 10000 entries and power-of-2 sizing, max PSL should be < 32. */
    CtxHashTable *ht = ctx_ht_create(16);
    char key[24];
    int val = 0;
    for (int i = 0; i < 10000; i++) {
        snprintf(key, sizeof(key), "rh_%06d", i);
        ctx_ht_set(ht, key, &val);
    }
    /* Scan entries, find max PSL */
    uint32_t max_psl = 0;
    for (uint32_t i = 0; i < ht->capacity; i++) {
        if (ht->entries[i].psl > max_psl) {
            max_psl = ht->entries[i].psl;
        }
    }
    /* Robin Hood guarantees bounded PSL — should be well under 32 */
    ASSERT_LT(max_psl, 32);
    ctx_ht_free(ht);
    PASS();
}

SUITE(hash_table) {
    RUN_TEST(ht_create_free);
    RUN_TEST(ht_set_get);
    RUN_TEST(ht_set_overwrite);
    RUN_TEST(ht_get_missing);
    RUN_TEST(ht_has);
    RUN_TEST(ht_delete);
    RUN_TEST(ht_delete_missing);
    RUN_TEST(ht_many_entries);
    RUN_TEST(ht_delete_then_reinsert);
    RUN_TEST(ht_foreach);
    RUN_TEST(ht_clear);
    RUN_TEST(ht_empty_string_key);
    RUN_TEST(ht_long_key);
    RUN_TEST(ht_power_of_two_capacity);
    /* Edge cases */
    RUN_TEST(ht_get_key_returns_stored_pointer);
    RUN_TEST(ht_get_key_missing);
    RUN_TEST(ht_get_key_null_ht);
    RUN_TEST(ht_get_key_null_key);
    RUN_TEST(ht_count_null);
    RUN_TEST(ht_free_null);
    RUN_TEST(ht_clear_null);
    RUN_TEST(ht_foreach_null_ht);
    RUN_TEST(ht_foreach_null_fn);
    RUN_TEST(ht_delete_readd_stress);
    RUN_TEST(ht_interleaved_insert_delete);
    RUN_TEST(ht_create_capacity_zero);
    RUN_TEST(ht_create_capacity_one);
    RUN_TEST(ht_stress_10000);
    RUN_TEST(ht_robin_hood_bounded_psl);
}
