package pipeline

import (
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// cLSPDefIndex indexes cross-file definitions by header/source path for C/C++ LSP resolution.
type cLSPDefIndex struct {
	// byRelPath maps file relative path → []CrossFileDef (for #include "local/path.h")
	byRelPath map[string][]cbm.CrossFileDef
	// byDir maps directory relative path → []CrossFileDef (for collecting all defs in a dir)
	byDir map[string][]cbm.CrossFileDef
	// includeGraph maps file relative path → resolved paths of directly included files
	includeGraph map[string][]string
}

// isCOrCPP returns true if the language is C, C++, or CUDA.
func isCOrCPP(l lang.Language) bool {
	return l == lang.C || l == lang.CPP || l == lang.CUDA
}

// resolveFileIncludes builds the list of resolved include paths for a file's imports.
func (p *Pipeline) resolveFileIncludes(imports []cbm.Import, currentDir string, incDirs []string) []string {
	var includes []string
	for _, imp := range imports {
		if imp.ModulePath == "" {
			continue
		}
		for _, candidate := range resolveIncludePath(imp.ModulePath, currentDir, incDirs) {
			if _, exists := p.extractionCache[candidate]; exists {
				includes = append(includes, candidate)
				break
			}
		}
	}
	return includes
}

// indexFileDefs adds a file's definitions to the index by path and directory.
func (idx *cLSPDefIndex) indexFileDefs(relPath string, defs []cbm.CrossFileDef) {
	idx.byRelPath[relPath] = append(idx.byRelPath[relPath], defs...)
	dir := filepath.Dir(relPath)
	if dir == "." {
		dir = ""
	}
	idx.byDir[dir] = append(idx.byDir[dir], defs...)
}

// buildCLSPDefIndex builds the cross-file definition index for C/C++ LSP resolution.
// Scans all C/C++/CUDA files in extractionCache, indexes defs by file path and directory.
func (p *Pipeline) buildCLSPDefIndex() *cLSPDefIndex {
	idx := &cLSPDefIndex{
		byRelPath:    make(map[string][]cbm.CrossFileDef),
		byDir:        make(map[string][]cbm.CrossFileDef),
		includeGraph: make(map[string][]string),
	}

	allIncDirs := p.getAllRelativeIncludeDirs()

	hasCFiles := false
	for relPath, ext := range p.extractionCache {
		if !isCOrCPP(ext.Language) || ext.Result == nil {
			continue
		}
		hasCFiles = true

		// Build include graph from imports
		if len(ext.Result.Imports) > 0 {
			incDirs := p.getRelativeIncludeDirs(relPath)
			if incDirs == nil {
				incDirs = allIncDirs
			}
			includes := p.resolveFileIncludes(ext.Result.Imports, filepath.Dir(relPath), incDirs)
			if len(includes) > 0 {
				idx.includeGraph[relPath] = includes
			}
		}

		if len(ext.Result.Definitions) == 0 {
			continue
		}

		defs := cbm.DefsToLSPDefs(ext.Result.Definitions, fqn.ModuleQN(p.ProjectName, relPath))
		if len(defs) > 0 {
			idx.indexFileDefs(relPath, defs)
		}
	}

	if !hasCFiles {
		return nil
	}

	totalDefs := 0
	for _, defs := range idx.byRelPath {
		totalDefs += len(defs)
	}
	if totalDefs > 0 {
		slog.Info("c_lsp.cross_file.index",
			"files", len(idx.byRelPath),
			"defs", totalDefs,
			"include_edges", len(idx.includeGraph),
		)
	}

	return idx
}

type bfsEntry struct {
	path  string
	depth int
}

// collectDefsForFile adds defs from a file and its corresponding source file.
func (idx *cLSPDefIndex) collectDefsForFile(filePath string, seen map[string]bool) []cbm.CrossFileDef {
	var result []cbm.CrossFileDef
	if defs, ok := idx.byRelPath[filePath]; ok {
		result = append(result, defs...)
	}
	for _, srcExt := range correspondingSourceExts(filePath) {
		srcPath := swapExtension(filePath, srcExt)
		if seen[srcPath] {
			continue
		}
		seen[srcPath] = true
		if defs, ok := idx.byRelPath[srcPath]; ok {
			result = append(result, defs...)
		}
	}
	return result
}

// seedDirectIncludes resolves direct imports and returns the initial BFS queue.
func (idx *cLSPDefIndex) seedDirectIncludes(imports []cbm.Import, currentDir string,
	extraIncDirs []string, seen map[string]bool) ([]cbm.CrossFileDef, []bfsEntry) {

	var result []cbm.CrossFileDef
	var queue []bfsEntry

	for _, imp := range imports {
		if imp.ModulePath == "" {
			continue
		}
		for _, candidate := range resolveIncludePath(imp.ModulePath, currentDir, extraIncDirs) {
			if seen[candidate] {
				continue
			}
			seen[candidate] = true
			result = append(result, idx.collectDefsForFile(candidate, seen)...)
			queue = append(queue, bfsEntry{candidate, 1})
		}
	}
	return result, queue
}

// collectCrossFileDefs returns cross-file definitions for all transitively included files.
// Uses BFS on the include graph (max depth 8) to follow #include chains.
// Also includes defs from corresponding source files and same-directory files.
// extraIncDirs are additional include directories from compile_commands.json.
func (idx *cLSPDefIndex) collectCrossFileDefs(imports []cbm.Import, currentRelPath string, extraIncDirs []string) []cbm.CrossFileDef {
	if idx == nil || len(imports) == 0 {
		return nil
	}

	seen := make(map[string]bool)
	currentDir := filepath.Dir(currentRelPath)

	// Seed BFS queue with direct includes
	result, queue := idx.seedDirectIncludes(imports, currentDir, extraIncDirs, seen)

	// BFS: follow transitive includes up to depth 8
	const maxDepth = 8
	for i := 0; i < len(queue); i++ {
		entry := queue[i]
		if entry.depth >= maxDepth {
			continue
		}
		for _, child := range idx.includeGraph[entry.path] {
			if seen[child] {
				continue
			}
			seen[child] = true
			result = append(result, idx.collectDefsForFile(child, seen)...)
			queue = append(queue, bfsEntry{child, entry.depth + 1})
		}
	}

	// Same-directory defs (common C/C++ pattern)
	if !seen["__dir__"+currentDir] {
		seen["__dir__"+currentDir] = true
		if defs, ok := idx.byDir[currentDir]; ok {
			for i := range defs {
				if !seen["__def__"+defs[i].QualifiedName] {
					seen["__def__"+defs[i].QualifiedName] = true
					result = append(result, defs[i])
				}
			}
		}
	}

	return result
}

// resolveIncludePath returns candidate relative paths for a #include path.
// For #include "foo/bar.h", tries: relative to current dir, compile_commands include dirs,
// then as-is from repo root.
func resolveIncludePath(includePath, currentDir string, extraIncDirs []string) []string {
	includePath = strings.Trim(includePath, "\"<>")
	var candidates []string

	// Relative to current file's directory
	if currentDir != "" && currentDir != "." {
		candidates = append(candidates, filepath.Join(currentDir, includePath))
	}

	// Compile_commands.json include directories (already relative to repo root)
	for _, dir := range extraIncDirs {
		candidates = append(candidates, filepath.Join(dir, includePath))
	}

	// As-is from repo root
	candidates = append(candidates, includePath)

	return candidates
}

// correspondingSourceExts returns source file extensions to check for a header file.
func correspondingSourceExts(path string) []string {
	ext := filepath.Ext(path)
	switch ext {
	case ".h":
		return []string{".c", ".cpp", ".cc", ".cxx"}
	case ".hpp", ".hxx", ".hh":
		return []string{".cpp", ".cc", ".cxx"}
	case ".cuh": // CUDA header
		return []string{".cu"}
	default:
		return nil
	}
}

// swapExtension replaces the file extension.
func swapExtension(path, newExt string) string {
	ext := filepath.Ext(path)
	return path[:len(path)-len(ext)] + newExt
}
