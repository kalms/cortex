package pipeline

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// TestGracefulShutdownLargeRepo indexes a real repo with a short timeout to
// verify context cancellation propagates correctly through the pipeline.
// Skipped if /tmp/bench/erlang does not exist.
func TestGracefulShutdownLargeRepo(t *testing.T) {
	repoPath := "/tmp/bench/erlang"
	if _, err := os.Stat(repoPath); os.IsNotExist(err) {
		t.Skip("skipping: /tmp/bench/erlang not found")
	}

	st, err := store.OpenMemory()
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()

	// 50ms fires during the definitions pass (which takes ~60ms for this repo),
	// ensuring cancellation is tested without depending on repo size.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	p := New(ctx, st, repoPath, discover.ModeFull)
	err = p.Run()
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("expected cancellation error, but index completed in %v", elapsed)
	}
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context error, got: %v (after %v)", err, elapsed)
	}

	t.Logf("PASS: cancelled after %v with %v", elapsed, err)

	// Ensure it stopped reasonably fast (within 2s of the 50ms deadline)
	if elapsed > 2*time.Second {
		t.Errorf("cancellation took too long: %v (expected <2s)", elapsed)
	}
}
