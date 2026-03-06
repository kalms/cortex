package pipeline

import (
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
	"golang.org/x/sync/errgroup"
)

// passConfigures creates CONFIGURES edges using pre-extracted CBM env access data.
func (p *Pipeline) passConfigures() {
	slog.Info("pass.configures")

	// Stage 1: Build env key → module QN index from Module constants
	envIndex := p.buildEnvIndex()
	if len(envIndex) == 0 {
		slog.Info("pass.configures.skip", "reason", "no_env_bindings")
		return
	}

	// Stage 2: Parallel per-file env access resolution using CBM data
	type fileEntry struct {
		relPath string
		ext     *cachedExtraction
	}
	var files []fileEntry
	for relPath, ext := range p.extractionCache {
		if len(ext.Result.EnvAccesses) > 0 {
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
			results[i] = p.resolveFileConfiguresCBM(fe.relPath, fe.ext, envIndex)
			return nil
		})
	}
	_ = g.Wait()

	// Stage 3: Batch write
	p.flushResolvedEdges(results)

	total := 0
	for _, r := range results {
		total += len(r)
	}
	slog.Info("pass.configures.done", "edges", total)
}

// extractModuleConstants scans Module node constants for KEY = VALUE patterns
// and adds env-var-like keys to the index.
func extractModuleConstants(modules []*store.Node, index map[string]string) {
	for _, m := range modules {
		constants, ok := m.Properties["constants"]
		if !ok {
			continue
		}
		constList, ok := constants.([]any)
		if !ok {
			continue
		}
		for _, c := range constList {
			constStr, ok := c.(string)
			if !ok {
				continue
			}
			parts := strings.SplitN(constStr, " = ", 2)
			if len(parts) == 2 {
				key := strings.TrimSpace(parts[0])
				if key != "" && isEnvVarName(key) {
					index[key] = m.QualifiedName
				}
			}
		}
	}
}

// buildEnvIndex creates a mapping from env var key → module QN
// by scanning Module node constants and config Variable nodes.
func (p *Pipeline) buildEnvIndex() map[string]string {
	modules, err := p.findNodesByLabel(p.ProjectName, "Module")
	if err != nil {
		return nil
	}

	index := make(map[string]string)
	extractModuleConstants(modules, index)

	// Also scan config Variable nodes for env-var-like names.
	// Only add if key not already in index — existing Module constants
	// (which carry URL values for HTTP linking) always take priority.
	variables, err := p.findNodesByLabel(p.ProjectName, "Variable")
	if err == nil {
		added := 0
		for _, v := range variables {
			ext := filepath.Ext(v.FilePath)
			if !configExtensions[ext] {
				continue
			}
			if isEnvVarName(v.Name) && index[v.Name] == "" {
				moduleQN := fqn.ModuleQN(p.ProjectName, v.FilePath)
				index[v.Name] = moduleQN
				added++
			}
		}
		if added > 0 {
			slog.Info("pass.configures.env_vars_from_config", "added", added)
		}
	}

	return index
}

// isEnvVarName checks if a string looks like an environment variable name
// (uppercase with underscores).
func isEnvVarName(s string) bool {
	if len(s) < 2 {
		return false
	}
	hasUpper := false
	for _, c := range s {
		switch {
		case c >= 'A' && c <= 'Z':
			hasUpper = true
		case c == '_', c >= '0' && c <= '9':
			// ok
		default:
			return false
		}
	}
	return hasUpper
}
