// lz4_store.c — Thin C wrappers around LZ4 HC for the sourceStore.
// Linked via CGo from lz4.go.

// Include the vendored LZ4 source directly so CGo compiles everything
// in a single translation unit (avoids separate .c file compilation issues).
#include "vendored/lz4/lz4.c"
#include "vendored/lz4/lz4hc.c"

// cbm_lz4_compress_hc compresses src into dst using LZ4 HC at level 9.
// Returns the number of bytes written to dst, or 0 on failure.
int cbm_lz4_compress_hc(const char *src, int srcLen, char *dst, int dstCap) {
    return LZ4_compress_HC(src, dst, srcLen, dstCap, 9);
}

// cbm_lz4_decompress decompresses src into dst.
// originalLen is the known uncompressed size.
// Returns the number of bytes decompressed, or negative on error.
int cbm_lz4_decompress(const char *src, int srcLen, char *dst, int originalLen) {
    return LZ4_decompress_safe(src, dst, srcLen, originalLen);
}

// cbm_lz4_bound returns the maximum compressed size for a given input size.
int cbm_lz4_bound(int inputSize) {
    return LZ4_compressBound(inputSize);
}
