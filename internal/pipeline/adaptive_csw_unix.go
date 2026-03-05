//go:build !windows

package pipeline

import "syscall"

// getContentionSignal returns process-level contention metrics via getrusage(2).
// On Unix (Linux + macOS), a single syscall provides both involuntary context
// switches (Nivcsw) and cumulative CPU time (Utime + Stime).
func getContentionSignal() contentionSignal {
	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	cpuSec := float64(usage.Utime.Sec) + float64(usage.Utime.Usec)/1e6 +
		float64(usage.Stime.Sec) + float64(usage.Stime.Usec)/1e6
	return contentionSignal{Nivcsw: usage.Nivcsw, CPUTimeSec: cpuSec}
}
