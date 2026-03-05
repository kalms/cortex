package pipeline

import (
	"log/slog"
	"runtime"

	"golang.org/x/sync/errgroup"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// passUsesType creates USES_TYPE edges using pre-extracted CBM data.
func (p *Pipeline) passUsesType() {
	slog.Info("pass.usestype")

	type fileEntry struct {
		relPath string
		ext     *cachedExtraction
	}
	var files []fileEntry
	for relPath, ext := range p.extractionCache {
		if lang.ForLanguage(ext.Language) != nil && len(ext.Result.TypeRefs) > 0 {
			files = append(files, fileEntry{relPath, ext})
		}
	}

	if len(files) == 0 {
		return
	}

	// Stage 1: Parallel per-file type reference resolution using CBM data
	results := make([][]resolvedEdge, len(files))
	numWorkers := runtime.NumCPU()
	if numWorkers > len(files) {
		numWorkers = len(files)
	}

	g := new(errgroup.Group)
	g.SetLimit(numWorkers)
	for i, fe := range files {
		g.Go(func() error {
			results[i] = p.resolveFileTypeRefsCBM(fe.relPath, fe.ext)
			return nil
		})
	}
	_ = g.Wait()

	// Stage 2: Batch write
	p.flushResolvedEdges(results)

	total := 0
	for _, r := range results {
		total += len(r)
	}
	slog.Info("pass.usestype.done", "edges", total)
}
