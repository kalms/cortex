#ifndef CTX_SQLITE_WRITER_H
#define CTX_SQLITE_WRITER_H

#include <stdint.h>

// --- Input structs (flat, borrowed strings) ---

typedef struct {
    int64_t id; // sequential ID (1..N), assigned by Go
    const char *project;
    const char *label;
    const char *name;
    const char *qualified_name;
    const char *file_path;
    int start_line;
    int end_line;
    const char *properties; // JSON string
} CtxDumpNode;

typedef struct {
    int64_t id; // sequential ID (1..M), assigned by Go
    const char *project;
    int64_t source_id; // final sequential ID (1..N)
    int64_t target_id; // final sequential ID (1..N)
    const char *type;
    const char *properties; // JSON string
    const char *url_path;   // extracted from properties by Go (for idx_edges_url_path)
} CtxDumpEdge;

typedef struct {
    int64_t node_id; // final sequential ID (matches nodes.id)
    const char *project;
    const uint8_t *vector; // int8-quantized vector blob
    int vector_len;        // length in bytes (e.g. 256 for d=256)
} CtxDumpVector;

typedef struct {
    int64_t id; // sequential ID (1..T)
    const char *project;
    const char *token;     // the token string
    const uint8_t *vector; // int8-quantized enriched RI vector blob
    int vector_len;        // length in bytes (e.g. 256 for d=256)
    float idf;             // inverse document frequency weight
} CtxDumpTokenVec;

// --- Public API ---

// Write a complete SQLite .db file from sorted in-memory data.
// Constructs B-tree pages directly — no SQL parser, no INSERTs.
// Returns 0 on success, non-zero on error.
// vectors/vector_count and token_vecs/token_vec_count may be NULL/0.
int ctx_write_db(const char *path, const char *project, const char *root_path,
                 const char *indexed_at, CtxDumpNode *nodes, int node_count, CtxDumpEdge *edges,
                 int edge_count, CtxDumpVector *vectors, int vector_count,
                 CtxDumpTokenVec *token_vecs, int token_vec_count);

#endif // CTX_SQLITE_WRITER_H
