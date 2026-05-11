#ifndef CTX_LZ4_STORE_H
#define CTX_LZ4_STORE_H

// LZ4 HC compression (level 9).
int ctx_lz4_compress_hc(const char *src, int srcLen, char *dst, int dstCap);

// LZ4 decompression.
int ctx_lz4_decompress(const char *src, int srcLen, char *dst, int originalLen);

// Maximum compressed size bound.
int ctx_lz4_bound(int inputSize);

#endif // CTX_LZ4_STORE_H
