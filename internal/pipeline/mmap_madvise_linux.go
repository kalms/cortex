//go:build linux

package pipeline

import "syscall"

func madviseSequential(b []byte) {
	_ = syscall.Madvise(b, syscall.MADV_SEQUENTIAL)
}
