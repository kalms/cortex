package pipeline

import (
	"log/slog"
	"runtime"

	"golang.org/x/sync/errgroup"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// passUsages creates USAGE edges using pre-extracted CBM data.
// Uses parallel per-file resolution (Stage 1) followed by batch DB writes (Stage 2).
func (p *Pipeline) passUsages() {
	slog.Info("pass3b.usages")

	type fileEntry struct {
		relPath string
		ext     *cachedExtraction
	}
	var files []fileEntry
	for relPath, ext := range p.extractionCache {
		if lang.ForLanguage(ext.Language) != nil {
			files = append(files, fileEntry{relPath, ext})
		}
	}

	if len(files) == 0 {
		return
	}

	// Stage 1: Parallel per-file usage resolution using CBM data
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
			results[i] = p.resolveFileUsagesCBM(fe.relPath, fe.ext)
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
	slog.Info("pass3b.usages.done", "edges", total)
}

// passUsagesForFiles runs usage detection only for the specified files (incremental).
func (p *Pipeline) passUsagesForFiles(files []discover.FileInfo) {
	slog.Info("pass3b.usages.incremental", "files", len(files))
	count := 0
	for _, f := range files {
		if p.ctx.Err() != nil {
			return
		}
		ext, ok := p.extractionCache[f.RelPath]
		if !ok {
			continue
		}
		edges := p.resolveFileUsagesCBM(f.RelPath, ext)
		// Write edges directly for incremental (small count)
		for _, re := range edges {
			callerNode, _ := p.Store.FindNodeByQN(p.ProjectName, re.CallerQN)
			targetNode, _ := p.Store.FindNodeByQN(p.ProjectName, re.TargetQN)
			if callerNode != nil && targetNode != nil {
				_, _ = p.Store.InsertEdge(&store.Edge{
					Project:  p.ProjectName,
					SourceID: callerNode.ID,
					TargetID: targetNode.ID,
					Type:     re.Type,
				})
				count++
			}
		}
	}
	slog.Info("pass3b.usages.incremental.done", "edges", count)
}
