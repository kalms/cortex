//go:build darwin

package pipeline

import (
	"os"
	"syscall"
	"unsafe"
)

// F_RDADVISE tells the kernel to start reading the file into the page cache.
const fRDADVISE = 44

type radvisory struct {
	offset int64
	count  int32
	_      [4]byte // padding
}

func advisePrefetch(f *os.File) {
	fi, err := f.Stat()
	if err != nil || fi.Size() == 0 {
		return
	}
	ra := radvisory{offset: 0, count: int32(fi.Size())}
	// Best-effort; ignore errors (unsupported FS, etc.)
	_, _, _ = syscall.Syscall(syscall.SYS_FCNTL, f.Fd(), uintptr(fRDADVISE), uintptr(unsafe.Pointer(&ra)))
}
