/*
 * dyn_array.h — Type-safe growable arrays via macros (header-only).
 *
 * Usage:
 *   CTX_DYN_ARRAY(int) nums = {0};    // zero-init
 *   ctx_da_push(&nums, 42);
 *   ctx_da_push(&nums, 99);
 *   for (int i = 0; i < nums.count; i++)
 *       printf("%d\n", nums.items[i]);
 *   ctx_da_free(&nums);
 *
 * Design:
 *   - Items are contiguous in memory (cache-friendly)
 *   - Grows by 2x (amortized O(1) push)
 *   - Uses realloc — NOT arena-compatible (use CtxDefArray etc. for arena)
 *   - Header-only: no .c file needed
 */
#ifndef CTX_DYN_ARRAY_H
#define CTX_DYN_ARRAY_H

#include <stdlib.h>
#include <string.h>

/* Declare a dynamic array type for a given element type. */
#define CTX_DYN_ARRAY(T) \
    struct {             \
        T *items;        \
        int count;       \
        int cap;         \
    }

/* Push an element. Grows by 2x when full. */
#define ctx_da_push(da, item)                                                           \
    do {                                                                                \
        if ((da)->count >= (da)->cap) {                                                 \
            int _new_cap = (da)->cap ? (da)->cap * 2 : 8;                               \
            void *_new = realloc((da)->items, (size_t)_new_cap * sizeof(*(da)->items)); \
            if (!_new)                                                                  \
                break;                                                                  \
            (da)->items = _new;                                                         \
            (da)->cap = _new_cap;                                                       \
        }                                                                               \
        (da)->items[(da)->count++] = (item);                                            \
    } while (0)

/* Push an element with a pointer return (for in-place init). */
#define ctx_da_push_ptr(da)                                                                        \
    (((da)->count >= (da)->cap                                                                     \
          ? ((void)((da)->cap = (da)->cap ? (da)->cap * 2 : 8),                                    \
             (void)((da)->items = realloc((da)->items, (size_t)(da)->cap * sizeof(*(da)->items)))) \
          : (void)0),                                                                              \
     &(da)->items[(da)->count++])

/* Pop last element. Returns the element. Undefined if empty. */
#define ctx_da_pop(da) ((da)->items[--(da)->count])

/* Get last element without removing. Undefined if empty. */
#define ctx_da_last(da) ((da)->items[(da)->count - 1])

/* Clear without freeing (reset count to 0). */
#define ctx_da_clear(da) ((da)->count = 0)

/* Free all memory. */
#define ctx_da_free(da)     \
    do {                    \
        free((da)->items);  \
        (da)->items = NULL; \
        (da)->count = 0;    \
        (da)->cap = 0;      \
    } while (0)

/* Reserve capacity (grow if needed, never shrink). */
#define ctx_da_reserve(da, n)                                                      \
    do {                                                                           \
        if ((n) > (da)->cap) {                                                     \
            void *_new = realloc((da)->items, (size_t)(n) * sizeof(*(da)->items)); \
            if (_new) {                                                            \
                (da)->items = _new;                                                \
                (da)->cap = (n);                                                   \
            }                                                                      \
        }                                                                          \
    } while (0)

/* Insert at index, shifting elements right. */
#define ctx_da_insert(da, idx, item)                                           \
    do {                                                                       \
        ctx_da_push(da, item); /* ensure space */                              \
        if ((idx) < (da)->count - 1) {                                         \
            memmove(&(da)->items[(idx) + 1], &(da)->items[(idx)],              \
                    (size_t)((da)->count - 1 - (idx)) * sizeof(*(da)->items)); \
            (da)->items[(idx)] = (item);                                       \
        }                                                                      \
    } while (0)

/* Remove at index, shifting elements left. */
#define ctx_da_remove(da, idx)                                                 \
    do {                                                                       \
        if ((idx) < (da)->count - 1) {                                         \
            memmove(&(da)->items[(idx)], &(da)->items[(idx) + 1],              \
                    (size_t)((da)->count - 1 - (idx)) * sizeof(*(da)->items)); \
        }                                                                      \
        (da)->count--;                                                         \
    } while (0)

#endif /* CTX_DYN_ARRAY_H */
