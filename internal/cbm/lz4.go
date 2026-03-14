package cbm

// int cbm_lz4_compress_hc(const char *src, int srcLen, char *dst, int dstCap);
// int cbm_lz4_decompress(const char *src, int srcLen, char *dst, int originalLen);
// int cbm_lz4_bound(int inputSize);
import "C"
import "unsafe"

// LZ4CompressHC compresses src using LZ4 HC (level 9).
// Returns the compressed data. If the input is empty, returns nil.
func LZ4CompressHC(src []byte) []byte {
	n := len(src)
	if n == 0 {
		return nil
	}
	bound := int(C.cbm_lz4_bound(C.int(n)))
	dst := make([]byte, bound)
	written := int(C.cbm_lz4_compress_hc(
		(*C.char)(unsafe.Pointer(&src[0])),
		C.int(n),
		(*C.char)(unsafe.Pointer(&dst[0])),
		C.int(bound),
	))
	if written <= 0 {
		// Compression failed (shouldn't happen with valid input)
		return nil
	}
	return dst[:written]
}

// LZ4Decompress decompresses src into a buffer of originalLen bytes.
// Returns the decompressed data. Panics if originalLen is wrong.
func LZ4Decompress(src []byte, originalLen int) []byte {
	if len(src) == 0 || originalLen == 0 {
		return nil
	}
	dst := make([]byte, originalLen)
	result := int(C.cbm_lz4_decompress(
		(*C.char)(unsafe.Pointer(&src[0])),
		C.int(len(src)),
		(*C.char)(unsafe.Pointer(&dst[0])),
		C.int(originalLen),
	))
	if result < 0 {
		return nil
	}
	return dst[:result]
}
