#ifndef CTX_ARENA_H
#define CTX_ARENA_H

#include <stddef.h>

// CtxArena is a simple bump allocator that allocates from fixed-size blocks.
// All memory is freed at once via ctx_arena_destroy(). Individual frees are not
// supported — this is by design for per-file extraction where all data has the
// same lifetime.
#define CTX_ARENA_MAX_BLOCKS 256
#define CTX_ARENA_DEFAULT_BLOCK_SIZE (64 * 1024) // 64KB initial

typedef struct {
    char *blocks[CTX_ARENA_MAX_BLOCKS];
    size_t block_sizes[CTX_ARENA_MAX_BLOCKS]; // per-block sizes (for stats)
    int nblocks;
    size_t block_size;
    size_t used;        // bytes used in current block
    size_t total_alloc; // cumulative bytes allocated (for stats)
} CtxArena;

// Initialize an arena with the default block size.
void ctx_arena_init(CtxArena *a);

// Allocate n bytes from the arena. Returns NULL on OOM or block exhaustion.
// All returned pointers are 8-byte aligned.
void *ctx_arena_alloc(CtxArena *a, size_t n);

// Duplicate a string into arena memory. Returns arena-owned copy.
char *ctx_arena_strdup(CtxArena *a, const char *s);

// Duplicate a string of known length into arena memory. NUL-terminates.
char *ctx_arena_strndup(CtxArena *a, const char *s, size_t len);

// sprintf into arena memory. Returns arena-owned string.
char *ctx_arena_sprintf(CtxArena *a, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

// Free all blocks. Arena is invalid after this call.
void ctx_arena_destroy(CtxArena *a);

#endif // CTX_ARENA_H
