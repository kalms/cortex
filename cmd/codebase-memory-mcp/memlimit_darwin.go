//go:build darwin

package main

import "golang.org/x/sys/unix"

// totalSystemMemory returns total physical memory in bytes via sysctl hw.memsize.
func totalSystemMemory() int64 {
	mem, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return int64(mem)
}
