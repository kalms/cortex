//go:build windows

package pipeline

import "os"

// mmapFile on Windows falls back to os.ReadFile.
// Windows mmap (CreateFileMapping) requires different syscalls;
// for now the primary target is Linux/macOS.
func mmapFile(path string) (data []byte, cleanup func(), err error) {
	d, err := os.ReadFile(path)
	return d, nil, err
}
