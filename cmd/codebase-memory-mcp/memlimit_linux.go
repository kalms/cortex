//go:build linux

package main

import "syscall"

// totalSystemMemory returns total physical memory in bytes via Sysinfo.
func totalSystemMemory() int64 {
	var si syscall.Sysinfo_t
	if err := syscall.Sysinfo(&si); err != nil {
		return 0
	}
	return int64(si.Totalram) * int64(si.Unit)
}
