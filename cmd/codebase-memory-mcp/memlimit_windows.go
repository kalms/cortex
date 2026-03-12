//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// memoryStatusEx mirrors the Windows MEMORYSTATUSEX struct.
type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys            uint64
	availPhys            uint64
	totalPageFile        uint64
	availPageFile        uint64
	totalVirtual         uint64
	availVirtual         uint64
	availExtendedVirtual uint64
}

// totalSystemMemory returns total physical memory via GlobalMemoryStatusEx.
func totalSystemMemory() int64 {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("GlobalMemoryStatusEx")

	var ms memoryStatusEx
	ms.length = uint32(unsafe.Sizeof(ms)) //nolint:gosec // standard Windows API pattern
	r, _, _ := proc.Call(uintptr(unsafe.Pointer(&ms)))
	if r == 0 {
		return 0
	}
	return int64(ms.totalPhys)
}
