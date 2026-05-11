#ifndef CTX_AC_H
#define CTX_AC_H

#include <stdint.h>

// Forward declaration — full struct in ac.c
typedef struct CtxAutomaton CtxAutomaton;

// Input for batch LZ4 scanning.
typedef struct {
    const char *data;
    int compressed_len;
    int original_len;
} CtxLz4Entry;

// Output for batch LZ4 scanning.
typedef struct {
    int file_index;
    uint64_t bitmask;
} CtxLz4Match;

// Output for batch name scanning.
typedef struct {
    int name_index;
    int pattern_id;
} CtxMatchResult;

// Build an Aho-Corasick automaton from patterns.
CtxAutomaton *ctx_ac_build(const char **patterns, const int *lengths, int count,
                           const uint8_t *alpha_map, int alpha_size);
void ctx_ac_free(CtxAutomaton *ac);

// Single-text scanning (returns bitmask of matched pattern IDs).
uint64_t ctx_ac_scan_bitmask(const CtxAutomaton *ac, const char *text, int text_len);

// LZ4-compressed scanning.
uint64_t ctx_ac_scan_lz4_bitmask(const CtxAutomaton *ac, const char *compressed, int compressed_len,
                                 int original_len);
int ctx_ac_scan_lz4_batch(const CtxAutomaton *ac, const CtxLz4Entry *entries, int num_entries,
                          CtxLz4Match *out_matches, int max_matches);

// Batch name scanning.
int ctx_ac_scan_batch(const CtxAutomaton *ac, const char *names_buf, const int *name_offsets,
                      const int *name_lengths, int num_names, CtxMatchResult *out_matches,
                      int max_matches);

// Introspection.
int ctx_ac_num_states(const CtxAutomaton *ac);
int ctx_ac_num_patterns(const CtxAutomaton *ac);
int ctx_ac_table_bytes(const CtxAutomaton *ac);

#endif // CTX_AC_H
