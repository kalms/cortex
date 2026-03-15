/*
 * test_hash_table.c — RED phase tests for foundation/hash_table.
 */
#include "test_framework.h"
#include "../src/foundation/hash_table.h"

TEST(ht_create_free) {
    CBMHashTable *ht = cbm_ht_create(16);
    ASSERT_NOT_NULL(ht);
    ASSERT_EQ(cbm_ht_count(ht), 0);
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_set_get) {
    CBMHashTable *ht = cbm_ht_create(8);
    int val = 42;
    void *prev = cbm_ht_set(ht, "hello", &val);
    ASSERT_NULL(prev); /* first insert */
    void *got = cbm_ht_get(ht, "hello");
    ASSERT_EQ(got, &val);
    ASSERT_EQ(*(int*)got, 42);
    ASSERT_EQ(cbm_ht_count(ht), 1);
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_set_overwrite) {
    CBMHashTable *ht = cbm_ht_create(8);
    int v1 = 1, v2 = 2;
    cbm_ht_set(ht, "key", &v1);
    void *prev = cbm_ht_set(ht, "key", &v2);
    ASSERT_EQ(prev, &v1); /* returns old value */
    ASSERT_EQ(*(int*)cbm_ht_get(ht, "key"), 2);
    ASSERT_EQ(cbm_ht_count(ht), 1); /* still 1 entry */
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_get_missing) {
    CBMHashTable *ht = cbm_ht_create(8);
    ASSERT_NULL(cbm_ht_get(ht, "nope"));
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_has) {
    CBMHashTable *ht = cbm_ht_create(8);
    int v = 1;
    cbm_ht_set(ht, "exists", &v);
    ASSERT_TRUE(cbm_ht_has(ht, "exists"));
    ASSERT_FALSE(cbm_ht_has(ht, "missing"));
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_delete) {
    CBMHashTable *ht = cbm_ht_create(8);
    int v = 99;
    cbm_ht_set(ht, "delete_me", &v);
    ASSERT_EQ(cbm_ht_count(ht), 1);

    void *removed = cbm_ht_delete(ht, "delete_me");
    ASSERT_EQ(removed, &v);
    ASSERT_EQ(cbm_ht_count(ht), 0);
    ASSERT_NULL(cbm_ht_get(ht, "delete_me"));
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_delete_missing) {
    CBMHashTable *ht = cbm_ht_create(8);
    void *removed = cbm_ht_delete(ht, "nope");
    ASSERT_NULL(removed);
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_many_entries) {
    CBMHashTable *ht = cbm_ht_create(4); /* tiny initial, force resize */
    char keys[200][32];
    int vals[200];
    for (int i = 0; i < 200; i++) {
        snprintf(keys[i], sizeof(keys[i]), "key_%03d", i);
        vals[i] = i * 10;
        cbm_ht_set(ht, keys[i], &vals[i]);
    }
    ASSERT_EQ(cbm_ht_count(ht), 200);
    /* Verify all entries survive resize */
    for (int i = 0; i < 200; i++) {
        void *got = cbm_ht_get(ht, keys[i]);
        ASSERT_NOT_NULL(got);
        ASSERT_EQ(*(int*)got, i * 10);
    }
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_delete_then_reinsert) {
    CBMHashTable *ht = cbm_ht_create(8);
    int v1 = 1, v2 = 2;
    cbm_ht_set(ht, "key", &v1);
    cbm_ht_delete(ht, "key");
    cbm_ht_set(ht, "key", &v2);
    ASSERT_EQ(*(int*)cbm_ht_get(ht, "key"), 2);
    ASSERT_EQ(cbm_ht_count(ht), 1);
    cbm_ht_free(ht);
    PASS();
}

static int foreach_sum;
static void sum_values(const char *key, void *value, void *userdata) {
    (void)key; (void)userdata;
    foreach_sum += *(int*)value;
}

TEST(ht_foreach) {
    CBMHashTable *ht = cbm_ht_create(8);
    int vals[] = {10, 20, 30};
    cbm_ht_set(ht, "a", &vals[0]);
    cbm_ht_set(ht, "b", &vals[1]);
    cbm_ht_set(ht, "c", &vals[2]);

    foreach_sum = 0;
    cbm_ht_foreach(ht, sum_values, NULL);
    ASSERT_EQ(foreach_sum, 60);
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_clear) {
    CBMHashTable *ht = cbm_ht_create(8);
    int v = 1;
    cbm_ht_set(ht, "a", &v);
    cbm_ht_set(ht, "b", &v);
    cbm_ht_clear(ht);
    ASSERT_EQ(cbm_ht_count(ht), 0);
    ASSERT_NULL(cbm_ht_get(ht, "a"));
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_empty_string_key) {
    CBMHashTable *ht = cbm_ht_create(8);
    int v = 42;
    cbm_ht_set(ht, "", &v);
    ASSERT_EQ(*(int*)cbm_ht_get(ht, ""), 42);
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_long_key) {
    CBMHashTable *ht = cbm_ht_create(8);
    /* 200-char key */
    char long_key[201];
    memset(long_key, 'x', 200);
    long_key[200] = '\0';
    int v = 99;
    cbm_ht_set(ht, long_key, &v);
    ASSERT_EQ(*(int*)cbm_ht_get(ht, long_key), 99);
    cbm_ht_free(ht);
    PASS();
}

TEST(ht_power_of_two_capacity) {
    /* Capacity 7 should be rounded up to 8 */
    CBMHashTable *ht = cbm_ht_create(7);
    ASSERT_NOT_NULL(ht);
    /* capacity should be >= 8 and power of 2 */
    ASSERT_GTE(ht->capacity, 8);
    ASSERT_EQ(ht->capacity & (ht->capacity - 1), 0); /* power of 2 check */
    cbm_ht_free(ht);
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
}
