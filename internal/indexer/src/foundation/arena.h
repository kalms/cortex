/*
 * arena.h — Bump allocator with block-based growth.
 *
 * All memory is freed at once via ctx_arena_destroy(). Individual frees are
 * not supported — this is by design for per-file extraction where all data
 * has the same lifetime.
 *
 * Restructured from internal/cbm/arena.h for the pure C rewrite.
 * New additions: ctx_arena_reset() for reuse without realloc.
 */
#ifndef CTX_ARENA_H
#define CTX_ARENA_H

#include <stddef.h>
#include <stdarg.h>

#define CTX_ARENA_MAX_BLOCKS 256
#define CTX_ARENA_DEFAULT_BLOCK_SIZE ((size_t)64 * 1024) /* 64KB */

typedef struct {
    char *blocks[CTX_ARENA_MAX_BLOCKS];
    size_t block_sizes[CTX_ARENA_MAX_BLOCKS]; /* per-block sizes (for stats) */
    int nblocks;
    size_t block_size;  /* current block capacity */
    size_t used;        /* bytes used in current block */
    size_t total_alloc; /* cumulative bytes allocated (for stats) */
} CBMArena;

/* Initialize arena with default block size. */
void ctx_arena_init(CBMArena *a);

/* Initialize arena with a custom initial block size. */
void ctx_arena_init_sized(CBMArena *a, size_t block_size);

/* Allocate n bytes (8-byte aligned). Returns NULL on OOM. */
void *ctx_arena_alloc(CBMArena *a, size_t n);

/* Allocate n bytes, zero-initialized. */
void *ctx_arena_calloc(CBMArena *a, size_t n);

/* Duplicate a NUL-terminated string. */
char *ctx_arena_strdup(CBMArena *a, const char *s);

/* Duplicate a string of known length, NUL-terminate. */
char *ctx_arena_strndup(CBMArena *a, const char *s, size_t len);

/* sprintf into arena memory. */
char *ctx_arena_sprintf(CBMArena *a, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

/* Reset arena for reuse: keeps first block, frees the rest. */
void ctx_arena_reset(CBMArena *a);

/* Free all blocks. Arena is zeroed after this. */
void ctx_arena_destroy(CBMArena *a);

/* Return total bytes allocated (for diagnostics). */
size_t ctx_arena_total(const CBMArena *a);

#endif /* CTX_ARENA_H */
