package pipeline

import (
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/zeebo/xxh3"
	"golang.org/x/sync/errgroup"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// runIncrementalIndex runs the incremental pipeline on the disk-backed store.
// All SQLite-specific operations (transactions, WAL, file hashes) go through
// p.diskStore — never through the StoreBackend interface.
func (p *Pipeline) runIncrementalIndex(files, changed, unchanged []discover.FileInfo, _ time.Time) error {
	slog.Info("incremental.classify", "changed", len(changed), "unchanged", len(unchanged), "total", len(files))

	// Fast path: nothing changed → skip all heavy passes
	if len(changed) == 0 {
		slog.Info("incremental.noop", "reason", "no_changes")
		return nil
	}

	// Use MEMORY journal mode during incremental writes
	p.diskStore.BeginBulkWrite(p.ctx)

	if err := p.diskStore.WithTransaction(p.ctx, func(txStore *store.Store) error {
		origStore := p.Store
		p.Store = txStore
		defer func() { p.Store = origStore }()

		if err := txStore.UpsertProject(p.ProjectName, p.RepoPath); err != nil {
			return fmt.Errorf("upsert project: %w", err)
		}
		return p.runIncrementalPasses(files, changed, unchanged)
	}); err != nil {
		p.diskStore.EndBulkWrite(p.ctx)
		return err
	}

	p.diskStore.EndBulkWrite(p.ctx)

	walBefore := p.diskStore.WALSize()
	p.diskStore.Checkpoint(p.ctx)
	walAfter := p.diskStore.WALSize()
	slog.Info("wal.checkpoint", "before_mb", walBefore/(1<<20), "after_mb", walAfter/(1<<20))
	return nil
}

// runIncrementalPasses re-indexes only changed files + their dependents.
// Runs inside a SQLite transaction — p.Store is the txStore.
func (p *Pipeline) runIncrementalPasses(
	allFiles []discover.FileInfo,
	changed, unchanged []discover.FileInfo,
) error {
	// Pass 1: Structure always runs on all files (fast, idempotent upserts)
	if err := p.passStructure(allFiles); err != nil {
		return fmt.Errorf("pass1 structure: %w", err)
	}
	if err := p.checkCancel(); err != nil {
		return err
	}

	// Remove stale nodes/edges for deleted files
	p.removeDeletedFiles(allFiles)

	// Delete nodes for changed files (will be re-created in pass 2)
	for _, f := range changed {
		_ = p.diskStore.DeleteNodesByFile(p.ProjectName, f.RelPath)
	}

	// Pass 2: Parse changed files only
	p.passDefinitions(changed)
	if err := p.checkCancel(); err != nil {
		return err
	}

	// Re-compute decorator tags globally (threshold is across all nodes)
	p.passDecoratorTags()

	// Build full registry: includes nodes from unchanged files (already in DB)
	// plus newly parsed nodes from changed files
	p.buildRegistry()
	if err := p.checkCancel(); err != nil {
		return err
	}

	p.passImports()
	if err := p.checkCancel(); err != nil {
		return err
	}

	// Determine which files need call re-resolution:
	// changed files + files that import any changed module
	dependents := p.findDependentFiles(changed, unchanged)
	filesToResolve := mergeFiles(changed, dependents)
	slog.Info("incremental.resolve", "changed", len(changed), "dependents", len(dependents))

	// Delete edges for files being re-resolved (all AST-derived edge types)
	for _, f := range filesToResolve {
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "CALLS")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "USAGE")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "USES_TYPE")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "THROWS")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "RAISES")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "READS")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "WRITES")
		_ = p.diskStore.DeleteEdgesBySourceFile(p.ProjectName, f.RelPath, "CONFIGURES")
	}

	// Re-resolve calls + usages for changed + dependent files
	p.buildReturnTypeMap()
	p.goLSPIdx = p.buildGoLSPDefIndex()
	if p.goLSPIdx != nil {
		p.goLSPIdx.integrateThirdPartyDeps(p.RepoPath, p.importMaps)
	}
	p.cLSPIdx = p.buildCLSPDefIndex()
	p.passCallsForFiles(filesToResolve)
	p.releaseExtractionFields(fieldsPostCalls)
	p.goLSPIdx = nil
	p.cLSPIdx = nil
	p.passUsagesForFiles(filesToResolve)
	p.releaseExtractionFields(fieldsPostUsages)
	if err := p.checkCancel(); err != nil {
		return err
	}

	// AST-dependent passes (run on cached files before cleanup)
	p.passUsesType()
	p.passThrows()
	p.passReadsWrites()
	p.passConfigures()
	p.releaseExtractionFields(fieldsPostSemantic)
	if err := p.checkCancel(); err != nil {
		return err
	}

	p.cleanupASTCache()
	p.registry = nil
	p.importMaps = nil
	p.returnTypes = nil

	// DB-derived edge types: delete all and re-run (cheap)
	_ = p.Store.DeleteEdgesByType(p.ProjectName, "TESTS")
	_ = p.Store.DeleteEdgesByType(p.ProjectName, "TESTS_FILE")
	p.passTests()

	_ = p.Store.DeleteEdgesByType(p.ProjectName, "INHERITS")
	p.passInherits()

	_ = p.Store.DeleteEdgesByType(p.ProjectName, "DECORATES")
	p.passDecorates()

	// Community detection: delete old communities and MEMBER_OF, re-run
	_ = p.Store.DeleteEdgesByType(p.ProjectName, "MEMBER_OF")
	_ = p.Store.DeleteNodesByLabel(p.ProjectName, "Community")
	p.passCommunities()
	if err := p.checkCancel(); err != nil {
		return err
	}

	// HTTP linking, config linking, and implements always run fully (they clean up first)
	if err := p.passHTTPLinks(); err != nil {
		slog.Warn("pass.httplink.err", "err", err)
	}
	p.passConfigLinker()
	p.passImplements()
	p.passGitHistory()

	p.updateFileHashes(allFiles)

	// Observability
	p.logEdgeCounts()

	return nil
}

// classifyFiles splits files into changed and unchanged based on stored hashes.
// Uses stat (mtime+size) as a fast pre-filter: files whose mtime and size match
// the stored values are assumed unchanged without reading/hashing. Only files
// with changed stat (or missing from the store) are hashed.
func (p *Pipeline) classifyFiles(files []discover.FileInfo) (changed, unchanged []discover.FileInfo) {
	storedHashes, err := p.diskStore.GetFileHashes(p.ProjectName)
	if err != nil || len(storedHashes) == 0 {
		return files, nil // no hashes → full index
	}

	// Stage 1: stat pre-filter — separate files into "stat-unchanged" and "needs-hash"
	var needsHash []discover.FileInfo
	for _, f := range files {
		stored, ok := storedHashes[f.RelPath]
		if !ok {
			needsHash = append(needsHash, f) // new file
			continue
		}
		fi, statErr := os.Stat(f.Path)
		if statErr != nil {
			needsHash = append(needsHash, f) // stat failed → hash it
			continue
		}
		if fi.ModTime().UnixNano() == stored.MtimeNs && fi.Size() == stored.Size && stored.MtimeNs != 0 {
			// Stat matches — trust the stored hash
			unchanged = append(unchanged, f)
		} else {
			needsHash = append(needsHash, f)
		}
	}

	if len(needsHash) == 0 {
		return changed, unchanged // nothing to hash
	}

	// Stage 2: hash only files that need it
	type hashResult struct {
		Hash string
		Err  error
	}

	results := make([]hashResult, len(needsHash))
	numWorkers := runtime.NumCPU()
	if numWorkers > len(needsHash) {
		numWorkers = len(needsHash)
	}

	g := new(errgroup.Group)
	g.SetLimit(numWorkers)
	for i, f := range needsHash {
		g.Go(func() error {
			hash, hashErr := fileHash(f.Path)
			results[i] = hashResult{Hash: hash, Err: hashErr}
			return nil
		})
	}
	_ = g.Wait()

	for i, f := range needsHash {
		r := results[i]
		if r.Err != nil {
			changed = append(changed, f)
			continue
		}
		if stored, ok := storedHashes[f.RelPath]; ok && stored.SHA256 == r.Hash {
			unchanged = append(unchanged, f)
		} else {
			changed = append(changed, f)
		}
	}
	return changed, unchanged
}

// updateFileHashes persists file hashes to the disk store.
// Uses pre-computed hashes from sourceStore (full index) or hashes from disk (incremental).
func (p *Pipeline) updateFileHashes(files []discover.FileInfo) {
	// Fast path: use pre-computed hashes from sourceStore (bulk load)
	if p.sourceStore != nil {
		batch := make([]store.FileHash, 0, len(files))
		for _, f := range files {
			if hash, mtimeNs, size, ok := p.getHash(f.RelPath); ok {
				batch = append(batch, store.FileHash{
					Project: p.ProjectName,
					RelPath: f.RelPath,
					SHA256:  hash,
					MtimeNs: mtimeNs,
					Size:    size,
				})
			}
		}
		_ = p.diskStore.UpsertFileHashBatch(batch)
		return
	}

	// Slow path: read from disk (incremental mode)
	type hashResult struct {
		Hash    string
		MtimeNs int64
		Size    int64
		Err     error
	}

	results := make([]hashResult, len(files))
	numWorkers := runtime.NumCPU()
	if numWorkers > len(files) {
		numWorkers = len(files)
	}

	g := new(errgroup.Group)
	g.SetLimit(numWorkers)
	for i, f := range files {
		g.Go(func() error {
			hash, hashErr := fileHash(f.Path)
			r := hashResult{Hash: hash, Err: hashErr}
			if hashErr == nil {
				if fi, statErr := os.Stat(f.Path); statErr == nil {
					r.MtimeNs = fi.ModTime().UnixNano()
					r.Size = fi.Size()
				}
			}
			results[i] = r
			return nil
		})
	}
	_ = g.Wait()

	// Collect successful hashes for batch upsert
	batch := make([]store.FileHash, 0, len(files))
	for i, f := range files {
		if results[i].Err == nil {
			batch = append(batch, store.FileHash{
				Project: p.ProjectName,
				RelPath: f.RelPath,
				SHA256:  results[i].Hash,
				MtimeNs: results[i].MtimeNs,
				Size:    results[i].Size,
			})
		}
	}
	_ = p.diskStore.UpsertFileHashBatch(batch)
}

// removeDeletedFiles removes nodes/edges for files that no longer exist on disk.
func (p *Pipeline) removeDeletedFiles(currentFiles []discover.FileInfo) {
	currentSet := make(map[string]bool, len(currentFiles))
	for _, f := range currentFiles {
		currentSet[f.RelPath] = true
	}
	indexed, err := p.diskStore.ListFilesForProject(p.ProjectName)
	if err != nil {
		return
	}
	for _, filePath := range indexed {
		if !currentSet[filePath] {
			_ = p.diskStore.DeleteNodesByFile(p.ProjectName, filePath)
			_ = p.diskStore.DeleteFileHash(p.ProjectName, filePath)
			slog.Info("incremental.removed", "file", filePath)
		}
	}
}

// findDependentFiles finds unchanged files that import any changed file's module.
func (p *Pipeline) findDependentFiles(changed, unchanged []discover.FileInfo) []discover.FileInfo {
	// Build set of module QNs for changed files
	changedModules := make(map[string]bool, len(changed))
	for _, f := range changed {
		mqn := fqn.ModuleQN(p.ProjectName, f.RelPath)
		changedModules[mqn] = true
		// Also add folder QN (for Go package-level imports)
		dir := filepath.Dir(f.RelPath)
		if dir != "." {
			changedModules[fqn.FolderQN(p.ProjectName, dir)] = true
		}
	}

	var dependents []discover.FileInfo
	for _, f := range unchanged {
		mqn := fqn.ModuleQN(p.ProjectName, f.RelPath)
		importMap := p.importMaps[mqn]
		// If no cached import map, check the store for IMPORTS edges
		if len(importMap) == 0 {
			importMap = p.loadImportMapFromDB(mqn)
		}
		for _, targetQN := range importMap {
			if changedModules[targetQN] {
				dependents = append(dependents, f)
				break
			}
		}
	}
	return dependents
}

// loadImportMapFromDB reconstructs an import map from stored IMPORTS edges.
func (p *Pipeline) loadImportMapFromDB(moduleQN string) map[string]string {
	moduleNode, err := p.Store.FindNodeByQN(p.ProjectName, moduleQN)
	if err != nil || moduleNode == nil {
		return nil
	}
	edges, err := p.Store.FindEdgesBySourceAndType(moduleNode.ID, "IMPORTS")
	if err != nil {
		return nil
	}
	result := make(map[string]string, len(edges))
	for _, e := range edges {
		target, tErr := p.Store.FindNodeByID(e.TargetID)
		if tErr != nil || target == nil {
			continue
		}
		alias := ""
		if a, ok := e.Properties["alias"].(string); ok {
			alias = a
		}
		if alias != "" {
			result[alias] = target.QualifiedName
		}
	}
	return result
}

// passCallsForFiles resolves calls only for the specified files (incremental).
func (p *Pipeline) passCallsForFiles(files []discover.FileInfo) {
	slog.Info("pass3.calls.incremental", "files", len(files))
	for _, f := range files {
		if p.ctx.Err() != nil {
			return
		}
		ext, ok := p.extractionCache[f.RelPath]
		if !ok {
			// File not in extraction cache — need to extract it
			source, err := os.ReadFile(f.Path)
			if err != nil {
				continue
			}
			source = stripBOM(source)
			cbmResult, err := cbm.ExtractFile(source, f.Language, p.ProjectName, f.RelPath)
			if err != nil {
				continue
			}
			ext = &cachedExtraction{Result: cbmResult, Language: f.Language}
			p.extractionCache[f.RelPath] = ext
		}
		edges := p.resolveFileCallsCBM(f.RelPath, ext)
		// Release Definitions/Imports per-file after call resolution
		if ext.Result != nil {
			ext.Result.Definitions = nil
			ext.Result.Imports = nil
		}
		for _, re := range edges {
			callerNode, _ := p.Store.FindNodeByQN(p.ProjectName, re.CallerQN)
			targetNode, _ := p.Store.FindNodeByQN(p.ProjectName, re.TargetQN)
			if callerNode != nil && targetNode != nil {
				_, _ = p.Store.InsertEdge(&store.Edge{
					Project:    p.ProjectName,
					SourceID:   callerNode.ID,
					TargetID:   targetNode.ID,
					Type:       re.Type,
					Properties: re.Properties,
				})
			}
		}
	}
}

// mergeFiles returns the union of two file slices (deduped by RelPath).
func mergeFiles(a, b []discover.FileInfo) []discover.FileInfo {
	seen := make(map[string]bool, len(a))
	result := make([]discover.FileInfo, 0, len(a)+len(b))
	for _, f := range a {
		seen[f.RelPath] = true
		result = append(result, f)
	}
	for _, f := range b {
		if !seen[f.RelPath] {
			result = append(result, f)
		}
	}
	return result
}

// fileHash computes an xxh3 hash of a file.
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := xxh3.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
