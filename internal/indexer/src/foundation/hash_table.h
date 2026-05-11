/*
 * hash_table.h — Robin Hood open-addressing hash table (string → void*).
 *
 * Design decisions:
 *   - Keys are interned or arena-allocated strings (NOT copied by the table)
 *   - Open addressing with Robin Hood insertion for bounded probe distance
 *   - Power-of-2 capacity with 75% load factor trigger for resize
 *   - Tombstone-free deletion via backward shift
 */
#ifndef CTX_HASH_TABLE_H
#define CTX_HASH_TABLE_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    const char *key; /* borrowed pointer — caller owns the string */
    void *value;
    uint32_t hash; /* cached hash */
    uint32_t psl;  /* probe sequence length (0 = empty slot) */
} CtxHTEntry;

typedef struct {
    CtxHTEntry *entries;
    uint32_t capacity; /* always power of 2 */
    uint32_t count;    /* number of live entries */
    uint32_t mask;     /* capacity - 1, for fast modulo */
} CtxHashTable;

/* Create a hash table with initial capacity (rounded up to power of 2). */
CtxHashTable *ctx_ht_create(uint32_t initial_capacity);

/* Free the hash table (does NOT free keys or values). */
void ctx_ht_free(CtxHashTable *ht);

/* Insert or update. Returns previous value (NULL if new key). */
void *ctx_ht_set(CtxHashTable *ht, const char *key, void *value);

/* Lookup. Returns NULL if not found. */
void *ctx_ht_get(const CtxHashTable *ht, const char *key);

/* Check if key exists. */
bool ctx_ht_has(const CtxHashTable *ht, const char *key);

/* Return the stored key pointer for a given lookup key, or NULL.
 * Useful when you need the canonical (heap-owned) key string
 * rather than your own local copy. */
const char *ctx_ht_get_key(const CtxHashTable *ht, const char *key);

/* Delete. Returns removed value (NULL if not found). */
void *ctx_ht_delete(CtxHashTable *ht, const char *key);

/* Number of entries. */
uint32_t ctx_ht_count(const CtxHashTable *ht);

/* Iteration: call fn(key, value, userdata) for each entry. */
typedef void (*ctx_ht_iter_fn)(const char *key, void *value, void *userdata);
void ctx_ht_foreach(const CtxHashTable *ht, ctx_ht_iter_fn fn, void *userdata);

/* Clear all entries (keeps allocated memory). */
void ctx_ht_clear(CtxHashTable *ht);

#endif /* CTX_HASH_TABLE_H */
