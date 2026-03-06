//go:build linux

package pipeline

import (
	"os"

	"golang.org/x/sys/unix"
)

func advisePrefetch(f *os.File) {
	fi, err := f.Stat()
	if err != nil || fi.Size() == 0 {
		return
	}
	// POSIX_FADV_WILLNEED = 3: advise kernel to read file into page cache
	_ = unix.Fadvise(int(f.Fd()), 0, fi.Size(), unix.FADV_WILLNEED)
}
