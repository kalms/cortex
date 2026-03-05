//go:build windows

package pipeline

import "syscall"

// getContentionSignal returns process-level CPU time via GetProcessTimes.
// Windows does not expose involuntary context switches, so Nivcsw is always 0
// (tier 2 only — CPU utilization based shrink).
func getContentionSignal() contentionSignal {
	var creation, exit, kernel, user syscall.Filetime
	h, _ := syscall.GetCurrentProcess()
	if err := syscall.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return contentionSignal{}
	}
	cpuSec := float64(kernel.Nanoseconds()+user.Nanoseconds()) / 1e9
	return contentionSignal{CPUTimeSec: cpuSec}
}
