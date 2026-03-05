package pipeline

import (
	"log/slog"
	"runtime"

	"golang.org/x/sync/errgroup"
)

// passReadsWrites creates READS and WRITES edges from functions to Variable nodes.
func (p *Pipeline) passReadsWrites() {
	slog.Info("pass.readwrite")

	type fileEntry struct {
		relPath string
		ext     *cachedExtraction
	}
	var files []fileEntry
	for relPath, ext := range p.extractionCache {
		if len(ext.Result.ReadWrites) > 0 {
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

	g := new(errgroup.Group)
	g.SetLimit(numWorkers)
	for i, fe := range files {
		g.Go(func() error {
			results[i] = p.resolveFileReadsWritesCBM(fe.relPath, fe.ext)
			return nil
		})
	}
	_ = g.Wait()

	p.flushResolvedEdges(results)

	total := 0
	for _, r := range results {
		total += len(r)
	}
	slog.Info("pass.readwrite.done", "edges", total)
}
