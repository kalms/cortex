package cbm

import "runtime"

// #include <stdlib.h>
// typedef struct CBMAutomaton CBMAutomaton;
// typedef struct { int name_index; int pattern_id; } CBMMatchResult;
// typedef struct { const char *data; int compressed_len; int original_len; } CBMLz4Entry;
// typedef struct { int file_index; unsigned long long bitmask; } CBMLz4Match;
//
// CBMAutomaton *cbm_ac_build(const char **patterns, const int *lengths, int count,
//                            const unsigned char *alpha_map, int alpha_size);
// void          cbm_ac_free(CBMAutomaton *ac);
// unsigned long long cbm_ac_scan_bitmask(const CBMAutomaton *ac, const char *text, int text_len);
// unsigned long long cbm_ac_scan_lz4_bitmask(const CBMAutomaton *ac,
//                    const char *compressed, int compressed_len, int original_len);
// int cbm_ac_scan_lz4_batch(const CBMAutomaton *ac, const CBMLz4Entry *entries,
//                           int num_entries, CBMLz4Match *out_matches, int max_matches);
// int cbm_ac_scan_batch(const CBMAutomaton *ac, const char *names_buf,
//                       const int *name_offsets, const int *name_lengths,
//                       int num_names, CBMMatchResult *out_matches, int max_matches);
// int cbm_ac_num_states(const CBMAutomaton *ac);
// int cbm_ac_num_patterns(const CBMAutomaton *ac);
// int cbm_ac_table_bytes(const CBMAutomaton *ac);
import "C"
import "unsafe"

// ACAutomaton wraps a C-side Aho-Corasick automaton.
type ACAutomaton struct {
	ac *C.CBMAutomaton
}

// ACBuild creates an Aho-Corasick automaton from the given patterns.
// Uses full 256-byte alphabet (suitable for scanning source code).
// Caller must call Free() when done.
func ACBuild(patterns []string) *ACAutomaton {
	if len(patterns) == 0 {
		return nil
	}

	cPtrs := make([]*C.char, len(patterns))
	cLens := make([]C.int, len(patterns))
	for i, p := range patterns {
		cPtrs[i] = C.CString(p)
		cLens[i] = C.int(len(p))
	}
	defer func() {
		for _, p := range cPtrs {
			C.free(unsafe.Pointer(p))
		}
	}()

	ac := C.cbm_ac_build(
		(**C.char)(unsafe.Pointer(&cPtrs[0])),
		(*C.int)(unsafe.Pointer(&cLens[0])),
		C.int(len(patterns)),
		nil, // identity alphabet
		256,
	)
	if ac == nil {
		return nil
	}
	return &ACAutomaton{ac: ac}
}

// ACBuildCompact creates an automaton with a compact alphabet mapping.
// alphaMap[byte] = mapped_index (0 = "other"). alphaSize = max mapped index + 1.
// This reduces the goto table from states*256 to states*alphaSize.
func ACBuildCompact(patterns []string, alphaMap [256]byte, alphaSize int) *ACAutomaton {
	if len(patterns) == 0 {
		return nil
	}

	cPtrs := make([]*C.char, len(patterns))
	cLens := make([]C.int, len(patterns))
	for i, p := range patterns {
		cPtrs[i] = C.CString(p)
		cLens[i] = C.int(len(p))
	}
	defer func() {
		for _, p := range cPtrs {
			C.free(unsafe.Pointer(p))
		}
	}()

	ac := C.cbm_ac_build(
		(**C.char)(unsafe.Pointer(&cPtrs[0])),
		(*C.int)(unsafe.Pointer(&cLens[0])),
		C.int(len(patterns)),
		(*C.uchar)(unsafe.Pointer(&alphaMap[0])),
		C.int(alphaSize),
	)
	if ac == nil {
		return nil
	}
	return &ACAutomaton{ac: ac}
}

// Free releases the C-side automaton memory.
func (a *ACAutomaton) Free() {
	if a != nil && a.ac != nil {
		C.cbm_ac_free(a.ac)
		a.ac = nil
	}
}

// ScanBitmask scans text and returns a bitmask of matched pattern indices (0..63).
func (a *ACAutomaton) ScanBitmask(text []byte) uint64 {
	if a == nil || a.ac == nil || len(text) == 0 {
		return 0
	}
	return uint64(C.cbm_ac_scan_bitmask(
		a.ac,
		(*C.char)(unsafe.Pointer(&text[0])),
		C.int(len(text)),
	))
}

// ScanString scans a string and returns a bitmask of matched pattern indices.
func (a *ACAutomaton) ScanString(s string) uint64 {
	if a == nil || a.ac == nil || len(s) == 0 {
		return 0
	}
	// Use unsafe.Pointer to avoid copying the string to []byte.
	return uint64(C.cbm_ac_scan_bitmask(
		a.ac,
		(*C.char)(unsafe.Pointer(unsafe.StringData(s))),
		C.int(len(s)),
	))
}

// ScanLZ4Bitmask decompresses LZ4 data in a C-side thread-local buffer and
// scans it through the automaton. Returns bitmask of matched patterns.
// Zero Go heap allocation for non-matching files.
func (a *ACAutomaton) ScanLZ4Bitmask(compressed []byte, originalLen int) uint64 {
	if a == nil || a.ac == nil || len(compressed) == 0 || originalLen <= 0 {
		return 0
	}
	return uint64(C.cbm_ac_scan_lz4_bitmask(
		a.ac,
		(*C.char)(unsafe.Pointer(&compressed[0])),
		C.int(len(compressed)),
		C.int(originalLen),
	))
}

// LZ4Entry describes one compressed file for batch scanning.
type LZ4Entry struct {
	Data        []byte
	OriginalLen int
}

// LZ4Match holds a batch scan result: file index and bitmask of matched patterns.
type LZ4Match struct {
	FileIndex int
	Bitmask   uint64
}

// ScanLZ4Batch decompresses and scans multiple LZ4-compressed files in a single
// CGo call. Returns only files that matched at least one pattern. One C-side
// decompression buffer is reused across all files — zero Go heap allocation.
func (a *ACAutomaton) ScanLZ4Batch(entries []LZ4Entry) []LZ4Match {
	if a == nil || a.ac == nil || len(entries) == 0 {
		return nil
	}

	// Pin all Go slice backing arrays so CGo can hold pointers to them.
	var pinner runtime.Pinner
	defer pinner.Unpin()

	cEntries := make([]C.CBMLz4Entry, len(entries))
	for i, e := range entries {
		if len(e.Data) > 0 {
			pinner.Pin(&e.Data[0])
			cEntries[i].data = (*C.char)(unsafe.Pointer(&e.Data[0]))
			cEntries[i].compressed_len = C.int(len(e.Data))
			cEntries[i].original_len = C.int(e.OriginalLen)
		}
	}

	// Output buffer — at most len(entries) matches.
	outBuf := make([]C.CBMLz4Match, len(entries))

	n := int(C.cbm_ac_scan_lz4_batch(
		a.ac,
		(*C.CBMLz4Entry)(unsafe.Pointer(&cEntries[0])),
		C.int(len(entries)),
		(*C.CBMLz4Match)(unsafe.Pointer(&outBuf[0])),
		C.int(len(entries)),
	))

	if n <= 0 {
		return nil
	}

	result := make([]LZ4Match, n)
	for i := 0; i < n; i++ {
		result[i] = LZ4Match{
			FileIndex: int(outBuf[i].file_index),
			Bitmask:   uint64(outBuf[i].bitmask),
		}
	}
	return result
}

// ACBatchMatch represents a single match from ScanBatch.
type ACBatchMatch struct {
	NameIndex int
	PatternID int
}

// ScanBatch scans multiple names through the automaton in a single CGo call.
// Returns (nameIndex, patternID) pairs for all substring matches found.
func (a *ACAutomaton) ScanBatch(names []string) []ACBatchMatch {
	if a == nil || a.ac == nil || len(names) == 0 {
		return nil
	}

	// Build contiguous buffer + offset/length arrays.
	totalLen := 0
	for _, n := range names {
		totalLen += len(n)
	}

	buf := make([]byte, totalLen)
	offsets := make([]C.int, len(names))
	lengths := make([]C.int, len(names))
	pos := 0
	for i, n := range names {
		offsets[i] = C.int(pos)
		lengths[i] = C.int(len(n))
		copy(buf[pos:], n)
		pos += len(n)
	}

	// Allocate output buffer. Worst case: every name matches every pattern.
	// In practice, matches are sparse. Start with len(names) as a reasonable cap.
	maxMatches := len(names)
	if maxMatches < 1024 {
		maxMatches = 1024
	}
	outBuf := make([]C.CBMMatchResult, maxMatches)

	var bufPtr *C.char
	if len(buf) > 0 {
		bufPtr = (*C.char)(unsafe.Pointer(&buf[0]))
	}

	n := int(C.cbm_ac_scan_batch(
		a.ac,
		bufPtr,
		(*C.int)(unsafe.Pointer(&offsets[0])),
		(*C.int)(unsafe.Pointer(&lengths[0])),
		C.int(len(names)),
		(*C.CBMMatchResult)(unsafe.Pointer(&outBuf[0])),
		C.int(maxMatches),
	))

	if n <= 0 {
		return nil
	}

	result := make([]ACBatchMatch, n)
	for i := 0; i < n; i++ {
		result[i] = ACBatchMatch{
			NameIndex: int(outBuf[i].name_index),
			PatternID: int(outBuf[i].pattern_id),
		}
	}
	return result
}

// NumStates returns the number of states in the automaton.
func (a *ACAutomaton) NumStates() int {
	if a == nil || a.ac == nil {
		return 0
	}
	return int(C.cbm_ac_num_states(a.ac))
}

// NumPatterns returns the number of patterns in the automaton.
func (a *ACAutomaton) NumPatterns() int {
	if a == nil || a.ac == nil {
		return 0
	}
	return int(C.cbm_ac_num_patterns(a.ac))
}

// TableBytes returns the approximate memory used by the goto table.
func (a *ACAutomaton) TableBytes() int {
	if a == nil || a.ac == nil {
		return 0
	}
	return int(C.cbm_ac_table_bytes(a.ac))
}
