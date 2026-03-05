//go:build linux

package pipeline

import (
	"os"
	"syscall"
)

func advisePrefetch(f *os.File) {
	fi, err := f.Stat()
	if err != nil || fi.Size() == 0 {
		return
	}
	// POSIX_FADV_WILLNEED = 3: advise kernel to read file into page cache
	_ = syscall.Fadvise(int(f.Fd()), 0, fi.Size(), 3)
}
