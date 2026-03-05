//go:build windows

package pipeline

import "os"

func advisePrefetch(_ *os.File) {
	// No-op on Windows
}
