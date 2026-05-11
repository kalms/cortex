/*
 * hash_table.h — Robin Hood open-addressing hash table (string → void*).
 *
 * Design decisions:
 *   - Keys are interned or arena-allocated strings (NOT copied by the table)
 *   - Open addressing with Robin Hood insertion for bounded probe distance
 *   - Power-of-2 capacity with 75% load factor trigger for resize
 *   - Tombstone-free deletion via backward shift
 */
#ifndef CBM_HASH_TABLE_H
#define CBM_HASH_TABLE_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    const char *key; /* borrowed pointer — caller owns the string */
    void *value;
    uint32_t hash; /* cached hash */
    uint32_t psl;  /* probe sequence length (0 = empty slot) */
} CBMHTEntry;

typedef struct {
    CBMHTEntry *entries;
    uint32_t capacity; /* always power of 2 */
    uint32_t count;    /* number of live entries */
    uint32_t mask;     /* capacity - 1, for fast modulo */
} CBMHashTable;

/* Create a hash table with initial capacity (rounded up to power of 2). */
CBMHashTable *cbm_ht_create(uint32_t initial_capacity);

/* Free the hash table (does NOT free keys or values). */
void cbm_ht_free(CBMHashTable *ht);

/* Insert or update. Returns previous value (NULL if new key). */
void *cbm_ht_set(CBMHashTable *ht, const char *key, void *value);

/* Lookup. Returns NULL if not found. */
void *cbm_ht_get(const CBMHashTable *ht, const char *key);

/* Check if key exists. */
bool cbm_ht_has(const CBMHashTable *ht, const char *key);

/* Return the stored key pointer for a given lookup key, or NULL.
 * Useful when you need the canonical (heap-owned) key string
 * rather than your own local copy. */
const char *cbm_ht_get_key(const CBMHashTable *ht, const char *key);

/* Delete. Returns removed value (NULL if not found). */
void *cbm_ht_delete(CBMHashTable *ht, const char *key);

/* Number of entries. */
uint32_t cbm_ht_count(const CBMHashTable *ht);

/* Iteration: call fn(key, value, userdata) for each entry. */
typedef void (*cbm_ht_iter_fn)(const char *key, void *value, void *userdata);
void cbm_ht_foreach(const CBMHashTable *ht, cbm_ht_iter_fn fn, void *userdata);

/* Clear all entries (keeps allocated memory). */
void cbm_ht_clear(CBMHashTable *ht);

#endif /* CBM_HASH_TABLE_H */
