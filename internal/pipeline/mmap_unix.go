//go:build !windows

package pipeline

import (
	"os"
	"syscall"
)

// mmapMinSize is the minimum file size worth mmap'ing.
// Below this, mmap syscall overhead exceeds the copy savings.
const mmapMinSize = 4096

// mmapFile memory-maps a file for reading. Returns the mapped data and a
// cleanup function that must be called when done (typically via defer).
// For small files (<4KB) or on mmap failure, falls back to os.ReadFile.
func mmapFile(path string) (data []byte, cleanup func(), err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}

	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}

	size := fi.Size()

	// Small files: mmap overhead not worth it
	if size < mmapMinSize || size == 0 {
		f.Close()
		d, err := os.ReadFile(path)
		return d, nil, err
	}

	mapped, err := syscall.Mmap(int(f.Fd()), 0, int(size), syscall.PROT_READ, syscall.MAP_PRIVATE)
	if err != nil {
		// mmap failed (NFS, FUSE, etc.) — fall back
		f.Close()
		d, readErr := os.ReadFile(path)
		return d, nil, readErr
	}

	// Hint sequential access for readahead (best-effort, not on all platforms)
	madviseSequential(mapped)

	// Close fd — mmap keeps a kernel reference; fd is no longer needed
	f.Close()

	return mapped, func() { _ = syscall.Munmap(mapped) }, nil
}
