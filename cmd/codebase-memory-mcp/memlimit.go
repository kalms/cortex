package main

import "log"

const (
	minMemLimit int64 = 2 << 30 // 2 GB
	maxMemLimit int64 = 8 << 30 // 8 GB
	memFraction int64 = 4       // use 1/4 of system memory
)

// autoMemLimit returns a GOMEMLIMIT value based on available system memory.
// Uses 25% of total physical RAM, clamped to [2GB, 8GB].
// Falls back to 4GB if detection fails.
func autoMemLimit() int64 {
	total := totalSystemMemory()
	if total <= 0 {
		log.Printf("mem_limit: auto-detect unavailable, default=4GB")
		return 4 << 30
	}

	limit := total / memFraction
	if limit < minMemLimit {
		limit = minMemLimit
	}
	if limit > maxMemLimit {
		limit = maxMemLimit
	}
	log.Printf("mem_limit: system=%dGB limit=%dGB", total>>30, limit>>30)
	return limit
}
