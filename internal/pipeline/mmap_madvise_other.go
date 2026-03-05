//go:build !linux && !windows

package pipeline

// madviseSequential is a no-op on platforms without syscall.Madvise (e.g. macOS).
// The prefetcher and kernel default readahead provide sufficient coverage.
func madviseSequential(_ []byte) {}
