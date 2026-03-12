package pipeline

import (
	"context"
	"os"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
)

// prefetcher warms the OS page cache ahead of worker consumption.
// A goroutine opens files and issues platform-specific fadvise/fcntl hints
// so that by the time workers mmap a file, pages are already resident.
type prefetcher struct {
	files     []discover.FileInfo
	lookahead int
	cursor    atomic.Int64 // workers report progress here
	done      chan struct{}
}

func newPrefetcher(files []discover.FileInfo, lookahead int) *prefetcher {
	if lookahead <= 0 {
		lookahead = 100
	}
	return &prefetcher{
		files:     files,
		lookahead: lookahead,
		done:      make(chan struct{}),
	}
}

// run prefetches files from the current cursor position up to lookahead ahead.
// Call in a goroutine. Exits when ctx is cancelled or all files are prefetched.
func (pf *prefetcher) run(ctx context.Context) {
	defer close(pf.done)

	prefetched := int64(0)
	n := int64(len(pf.files))

	for {
		if ctx.Err() != nil {
			return
		}

		workerPos := pf.cursor.Load()
		target := workerPos + int64(pf.lookahead)
		if target > n {
			target = n
		}

		if prefetched >= target {
			if prefetched >= n {
				return // all done
			}
			// Wait for workers to advance before prefetching more.
			select {
			case <-ctx.Done():
				return
			default:
				runtime.Gosched()
				time.Sleep(500 * time.Microsecond)
			}
			continue
		}

		// Prefetch the next file
		f, err := os.Open(pf.files[prefetched].Path)
		if err == nil {
			advisePrefetch(f)
			f.Close()
		}
		prefetched++
	}
}

// advance reports that workers have completed up to idx (exclusive).
func (pf *prefetcher) advance(idx int) {
	for {
		cur := pf.cursor.Load()
		if int64(idx) <= cur {
			return
		}
		if pf.cursor.CompareAndSwap(cur, int64(idx)) {
			return
		}
	}
}

// stop waits for the prefetcher goroutine to finish.
func (pf *prefetcher) stop() {
	<-pf.done
}
