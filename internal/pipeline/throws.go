package pipeline

import (
	"log/slog"
	"runtime"

	"golang.org/x/sync/errgroup"
)

// passThrows creates THROWS/RAISES edges using pre-extracted CBM data.
func (p *Pipeline) passThrows() {
	slog.Info("pass.throws")

	type fileEntry struct {
		relPath string
		ext     *cachedExtraction
	}
	var files []fileEntry
	for relPath, ext := range p.extractionCache {
		if len(ext.Result.Throws) > 0 {
			files = append(files, fileEntry{relPath, ext})
		}
	}

	if len(files) == 0 {
		return
	}

	results := make([][]resolvedEdge, len(files))
	numWorkers := runtime.NumCPU()
	if numWorkers > len(files) {
		numWorkers = len(files)
	}

	g, gctx := errgroup.WithContext(p.ctx)
	g.SetLimit(numWorkers)
	for i, fe := range files {
		g.Go(func() error {
			if gctx.Err() != nil {
				return gctx.Err()
			}
			results[i] = p.resolveFileThrowsCBM(fe.relPath, fe.ext)
			return nil
		})
	}
	_ = g.Wait()

	p.flushResolvedEdges(results)

	total := 0
	for _, r := range results {
		total += len(r)
	}
	slog.Info("pass.throws.done", "edges", total)
}
