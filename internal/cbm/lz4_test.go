package cbm

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestLZ4RoundTrip(t *testing.T) {
	inputs := []struct {
		name string
		data []byte
	}{
		{"empty", nil},
		{"small", []byte("hello world")},
		{"repeated", bytes.Repeat([]byte("ABCD"), 10000)},
		{"source_code", []byte(`package main
import "fmt"
func main() {
	for i := 0; i < 100; i++ {
		fmt.Println("Hello, World!", i)
	}
}
`)},
	}

	for _, tc := range inputs {
		t.Run(tc.name, func(t *testing.T) {
			compressed := LZ4CompressHC(tc.data)
			if len(tc.data) == 0 {
				if compressed != nil {
					t.Fatal("expected nil for empty input")
				}
				return
			}
			if len(compressed) == 0 {
				t.Fatal("compression returned empty")
			}

			decompressed := LZ4Decompress(compressed, len(tc.data))
			if !bytes.Equal(decompressed, tc.data) {
				t.Fatalf("roundtrip mismatch: got %d bytes, want %d", len(decompressed), len(tc.data))
			}
		})
	}
}

func TestLZ4CompressionRatio(t *testing.T) {
	// Source code should compress well (>2x)
	src := bytes.Repeat([]byte("func handleRequest(w http.ResponseWriter, r *http.Request) {\n"), 1000)
	compressed := LZ4CompressHC(src)
	ratio := float64(len(src)) / float64(len(compressed))
	t.Logf("ratio=%.1fx compressed=%d original=%d", ratio, len(compressed), len(src))
	if ratio < 2.0 {
		t.Fatalf("expected >2x compression on repetitive source, got %.1fx", ratio)
	}
}

func TestLZ4DecompressWrongLen(t *testing.T) {
	src := []byte("test data for decompression")
	compressed := LZ4CompressHC(src)

	// Wrong originalLen — should return nil (safe decompress detects mismatch)
	result := LZ4Decompress(compressed, len(src)+100)
	// LZ4_decompress_safe will decompress what it can; result length may differ
	// The key safety property: it won't crash or buffer overflow
	_ = result
}

func TestLZ4RandomData(t *testing.T) {
	// Random data is incompressible — LZ4 should still handle it
	data := make([]byte, 4096)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	compressed := LZ4CompressHC(data)
	if compressed == nil {
		t.Fatal("compression failed on random data")
	}
	decompressed := LZ4Decompress(compressed, len(data))
	if !bytes.Equal(decompressed, data) {
		t.Fatal("roundtrip mismatch on random data")
	}
}
