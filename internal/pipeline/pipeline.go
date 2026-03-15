package pipeline

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/zeebo/xxh3"
	"golang.org/x/sync/errgroup"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/httplink"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// Pipeline orchestrates the 3-pass indexing of a repository.
type Pipeline struct {
	ctx         context.Context
	Store       store.StoreBackend // graph ops (buffer or SQLite)
	diskStore   *store.Store       // SQLite-specific: project mgmt, file hashes, backup
	RepoPath    string
	ProjectName string
	Mode        discover.IndexMode
	// buf holds typed reference to GraphBuffer for FlushTo during dump.
	// During full index, p.Store points to the same object.
	buf *GraphBuffer
	// extractionCache maps file rel_path -> CBM extraction result for all post-definition passes
	extractionCache map[string]*cachedExtraction
	// registry indexes all Function/Method/Class nodes for call resolution
	registry *FunctionRegistry
	// importMaps stores per-module import maps: moduleQN -> localName -> resolvedQN
	importMaps map[string]map[string]string
	// returnTypes maps function QN -> return type QN for return-type-based type inference
	returnTypes ReturnTypeMap
	// goLSPIdx indexes Go cross-file definitions for LSP resolution in pass3
	goLSPIdx *goLSPDefIndex
	// cLSPIdx indexes C/C++/CUDA cross-file definitions for LSP resolution in pass3
	cLSPIdx *cLSPDefIndex
	// compileFlags holds per-file compile flags from compile_commands.json (C/C++ only)
	compileFlags CompileFlagsMap
	// sourceStore holds LZ4-compressed file bytes loaded during bulk load.
	// All post-parse passes decompress from here instead of re-reading from disk.
	// Nil'd after all passes complete.
	sourceStore map[string]*compressedSource
}

// compressedSource holds an LZ4 HC compressed file with pre-computed hash.
type compressedSource struct {
	data        []byte // LZ4 HC compressed
	originalLen int    // for decompressor
	hash        string // xxh3 hex, pre-computed during bulk load
	mtimeNs     int64  // file mtime from stat during bulk load
	size        int64  // file size from stat during bulk load
}

// New creates a new Pipeline.
func New(ctx context.Context, s *store.Store, repoPath string, mode discover.IndexMode) *Pipeline {
	if mode == "" {
		mode = discover.ModeFull
	}
	projectName := ProjectNameFromPath(repoPath)
	return &Pipeline{
		ctx:             ctx,
		Store:           s, // StoreBackend interface — initially the disk store
		diskStore:       s, // always the disk store
		RepoPath:        repoPath,
		ProjectName:     projectName,
		Mode:            mode,
		extractionCache: make(map[string]*cachedExtraction),
		registry:        NewFunctionRegistry(),
		importMaps:      make(map[string]map[string]string),
	}
}

// ProjectNameFromPath derives a unique project name from an absolute path
// by replacing path separators with dashes and trimming the leading dash.
func ProjectNameFromPath(absPath string) string {
	// Clean and normalize separators (backslash is not a separator on non-Windows)
	cleaned := filepath.ToSlash(filepath.Clean(absPath))
	cleaned = strings.ReplaceAll(cleaned, "\\", "/")
	// Normalize Windows drive letter casing: "D:/foo" → "d:/foo"
	// Prevents duplicate DBs for same path with different drive letter case.
	if len(cleaned) >= 2 && cleaned[1] == ':' {
		cleaned = strings.ToLower(cleaned[:1]) + cleaned[1:]
	}
	// Replace slashes and colons with dashes
	name := strings.ReplaceAll(cleaned, "/", "-")
	name = strings.ReplaceAll(name, ":", "-")
	// Collapse consecutive dashes (e.g. C:/ → C--)
	for strings.Contains(name, "--") {
		name = strings.ReplaceAll(name, "--", "-")
	}
	// Trim leading dash (from leading /)
	name = strings.TrimLeft(name, "-")
	if name == "" {
		return "root"
	}
	return name
}

// checkCancel returns ctx.Err() if the pipeline's context has been cancelled.
func (p *Pipeline) checkCancel() error {
	return p.ctx.Err()
}

// Run executes the full 3-pass pipeline within a single transaction.
// If file hashes from a previous run exist, only changed files are re-processed.
func (p *Pipeline) Run() error {
	runStart := time.Now()
	slog.Info("pipeline.start", "project", p.ProjectName, "path", p.RepoPath, "mode", string(p.Mode))

	if err := p.checkCancel(); err != nil {
		return err
	}

	// Load compile_commands.json for C/C++ include paths and defines
	p.compileFlags = loadCompileCommands(p.RepoPath)

	// Discover source files (filesystem, no DB — runs outside transaction)
	discoverOpts := &discover.Options{Mode: p.Mode}
	if p.Mode == discover.ModeFast {
		discoverOpts.MaxFileSize = 512 * 1024 // 512KB cutoff in fast mode
	}
	files, err := discover.Discover(p.ctx, p.RepoPath, discoverOpts)
	if err != nil {
		return fmt.Errorf("discover: %w", err)
	}
	slog.Info("pipeline.discovered", "files", len(files))
	logHeapStats("pre_index")

	// Classify files (read-only) to decide full vs incremental path
	changed, unchanged := p.classifyFiles(files)
	isFullIndex := len(unchanged) == 0

	if isFullIndex {
		// Full index: use in-memory SQLite for zero disk I/O during passes.
		// All data is built in RAM and restored to the disk store at the end.
		if err := p.runFullIndex(files, runStart); err != nil {
			return err
		}
	} else {
		// Incremental: use existing disk-backed store with transaction
		if err := p.runIncrementalIndex(files, changed, unchanged, runStart); err != nil {
			return err
		}
	}

	nc, _ := p.Store.CountNodes(p.ProjectName)
	ec, _ := p.Store.CountEdges(p.ProjectName)
	logHeapStats("post_index")
	slog.Info("pipeline.done", "nodes", nc, "edges", ec, "total_elapsed", time.Since(runStart))

	// Final cleanup: release remaining heavy fields and return memory to OS.
	// Pipeline is a local var in callers, but explicit nil + FreeOSMemory
	// ensures RSS drops immediately rather than waiting for next GC cycle.
	p.compileFlags = nil
	p.buf = nil
	p.sourceStore = nil
	debug.FreeOSMemory()

	return nil
}

// runSemanticEdgePasses runs the semantic edge passes (USES_TYPE, THROWS, READS/WRITES, CONFIGURES).
func (p *Pipeline) runSemanticEdgePasses() {
	t := time.Now()
	p.passUsesType()
	slog.Info("pass.timing", "pass", "usestype", "elapsed", time.Since(t))

	t = time.Now()
	p.passThrows()
	slog.Info("pass.timing", "pass", "throws", "elapsed", time.Since(t))

	t = time.Now()
	p.passReadsWrites()
	slog.Info("pass.timing", "pass", "readwrite", "elapsed", time.Since(t))

	t = time.Now()
	p.passConfigures()
	slog.Info("pass.timing", "pass", "configures", "elapsed", time.Since(t))
}

// logEdgeCounts logs the count of each edge type for observability.
func (p *Pipeline) logEdgeCounts() {
	edgeTypes := []string{
		"CALLS", "USAGE", "IMPORTS", "DEFINES", "DEFINES_METHOD",
		"TESTS", "TESTS_FILE", "INHERITS", "DECORATES", "USES_TYPE",
		"THROWS", "RAISES", "READS", "WRITES", "CONFIGURES", "MEMBER_OF",
		"HTTP_CALLS", "HANDLES", "ASYNC_CALLS", "IMPLEMENTS", "OVERRIDE",
		"FILE_CHANGES_WITH", "CONTAINS_FILE", "CONTAINS_FOLDER", "CONTAINS_PACKAGE",
	}
	for _, edgeType := range edgeTypes {
		count, err := p.Store.CountEdgesByType(p.ProjectName, edgeType)
		if err == nil && count > 0 {
			slog.Info("pipeline.edges", "type", edgeType, "count", count)
		}
	}
}

// fieldGroup identifies which FileResult fields to release after a pass.
type fieldGroup int

const (
	fieldsPostCalls    fieldGroup = iota // Definitions, Calls, ResolvedCalls, TypeAssigns, Imports
	fieldsPostUsages                     // Usages
	fieldsPostSemantic                   // TypeRefs, Throws, ReadWrites, EnvAccesses
)

// releaseExtractionFields nils out consumed FileResult slices to reduce peak memory.
// Each FileResult field is used by specific passes; once a pass completes, its fields
// can be released. For a 100K-file repo, Definitions+Calls alone hold ~10 GB.
func (p *Pipeline) releaseExtractionFields(group fieldGroup) {
	for _, ext := range p.extractionCache {
		if ext.Result == nil {
			continue
		}
		switch group {
		case fieldsPostCalls:
			ext.Result.Definitions = nil
			ext.Result.Calls = nil
			ext.Result.ResolvedCalls = nil
			ext.Result.TypeAssigns = nil
			ext.Result.Imports = nil
		case fieldsPostUsages:
			ext.Result.Usages = nil
		case fieldsPostSemantic:
			ext.Result.TypeRefs = nil
			ext.Result.Throws = nil
			ext.Result.ReadWrites = nil
			ext.Result.EnvAccesses = nil
		}
	}
}

func (p *Pipeline) cleanupASTCache() {
	// Free C-allocated TSTree handles before dropping Go references.
	// Without this, the Go GC reclaims FileResult structs but the C trees
	// (allocated via ts_parser_parse_string, held as unsafe.Pointer) leak.
	for _, ext := range p.extractionCache {
		if ext.Result != nil {
			ext.Result.FreeTree()
		}
	}
	p.extractionCache = nil
	// Prompt the Go runtime to return freed pages to the OS.
	// Especially useful under GOMEMLIMIT to keep RSS closer to actual usage.
	debug.FreeOSMemory()
}

// getSource returns the raw source bytes for a file from the in-memory sourceStore.
// Decompresses LZ4 on-the-fly (~3μs per 17KB file at 5.7 GB/s).
// Returns nil if the file is not in the store (e.g., infra files not parsed by CBM).
func (p *Pipeline) getSource(relPath string) []byte {
	if p.sourceStore == nil {
		return nil
	}
	cs := p.sourceStore[relPath]
	if cs == nil {
		return nil
	}
	return cbm.LZ4Decompress(cs.data, cs.originalLen)
}

// getHash returns the pre-computed xxh3 hash for a file. O(1), no disk I/O.
func (p *Pipeline) getHash(relPath string) (hash string, mtimeNs, size int64, ok bool) {
	if p.sourceStore == nil {
		return "", 0, 0, false
	}
	cs := p.sourceStore[relPath]
	if cs == nil {
		return "", 0, 0, false
	}
	return cs.hash, cs.mtimeNs, cs.size, true
}

// bulkLoadSources reads all files, computes xxh3 hashes, and LZ4 HC compresses
// them into the sourceStore. This is the ONLY bulk disk read for full indexing.
func (p *Pipeline) bulkLoadSources(files []discover.FileInfo) {
	t := time.Now()
	p.sourceStore = make(map[string]*compressedSource, len(files))

	type loadResult struct {
		relPath string
		cs      *compressedSource
		err     error
	}

	results := make([]loadResult, len(files))
	numWorkers := runtime.NumCPU()
	if numWorkers > len(files) {
		numWorkers = len(files)
	}

	g := new(errgroup.Group)
	g.SetLimit(numWorkers)
	for i, f := range files {
		g.Go(func() error {
			if err := p.ctx.Err(); err != nil {
				return err //nolint:wrapcheck // context cancellation
			}
			source, cleanup, err := mmapFile(f.Path)
			if err != nil {
				results[i] = loadResult{relPath: f.RelPath, err: err}
				if cleanup != nil {
					cleanup()
				}
				return nil
			}

			// Compute xxh3 hash from raw source
			h := xxh3.New()
			_, _ = h.Write(source)
			hashHex := hex.EncodeToString(h.Sum(nil))

			// Get stat info
			var mtimeNs, size int64
			if fi, statErr := os.Stat(f.Path); statErr == nil {
				mtimeNs = fi.ModTime().UnixNano()
				size = fi.Size()
			}

			// LZ4 HC compress
			compressed := cbm.LZ4CompressHC(source)
			originalLen := len(source)

			// Unmap before storing (we have the compressed copy)
			if cleanup != nil {
				cleanup()
			}

			results[i] = loadResult{
				relPath: f.RelPath,
				cs: &compressedSource{
					data:        compressed,
					originalLen: originalLen,
					hash:        hashHex,
					mtimeNs:     mtimeNs,
					size:        size,
				},
			}
			return nil
		})
	}
	_ = g.Wait()

	// Collect results (sequential, no lock needed)
	var totalRaw, totalCompressed int64
	var loaded int
	for _, r := range results {
		if r.cs == nil {
			continue
		}
		p.sourceStore[r.relPath] = r.cs
		totalRaw += int64(r.cs.originalLen)
		totalCompressed += int64(len(r.cs.data))
		loaded++
	}

	ratio := float64(0)
	if totalCompressed > 0 {
		ratio = float64(totalRaw) / float64(totalCompressed)
	}
	slog.Info("bulk_load.done",
		"files", loaded,
		"raw_mb", totalRaw/(1<<20),
		"compressed_mb", totalCompressed/(1<<20),
		"ratio", fmt.Sprintf("%.1fx", ratio),
		"elapsed", time.Since(t),
	)
}

// getSourceLines returns a line range from the in-memory sourceStore.
// Equivalent to readSourceLines but without disk I/O.
func (p *Pipeline) getSourceLines(relPath string, startLine, endLine int) string {
	src := p.getSource(relPath)
	if len(src) == 0 {
		return ""
	}
	return extractLines(src, startLine, endLine)
}

// extractLines extracts lines [startLine, endLine] (1-based) from source bytes.
func extractLines(src []byte, startLine, endLine int) string {
	var lines []string
	lineNum := 0
	start := 0
	for i := 0; i <= len(src); i++ {
		if i == len(src) || src[i] == '\n' {
			lineNum++
			if lineNum >= startLine && lineNum <= endLine {
				end := i
				if end > start && end > 0 && src[end-1] == '\r' {
					end--
				}
				lines = append(lines, string(src[start:end]))
			}
			if lineNum > endLine {
				break
			}
			start = i + 1
		}
	}
	return strings.Join(lines, "\n")
}

// logHeapStats logs current Go heap metrics for memory diagnostics.
func logHeapStats(stage string) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	slog.Info("mem.stats",
		"stage", stage,
		"heap_inuse_mb", m.HeapInuse/(1<<20),
		"heap_alloc_mb", m.HeapAlloc/(1<<20),
		"sys_mb", m.Sys/(1<<20),
	)
}

// passStructure creates Project, Folder, Package, File nodes and containment edges.
// Collects all nodes/edges in memory first, then batch-writes to DB.
func (p *Pipeline) passStructure(files []discover.FileInfo) error {
	slog.Info("pass1.structure")

	dirSet, dirIsPackage := p.classifyDirectories(files)

	nodes := make([]*store.Node, 0, len(files)*2)
	edges := make([]pendingEdge, 0, len(files)*2)

	projectQN := p.ProjectName
	nodes = append(nodes, &store.Node{
		Project:       p.ProjectName,
		Label:         "Project",
		Name:          p.ProjectName,
		QualifiedName: projectQN,
	})

	dirNodes, dirEdges := p.buildDirNodesEdges(dirSet, dirIsPackage, projectQN)
	nodes = append(nodes, dirNodes...)
	edges = append(edges, dirEdges...)

	fileNodes, fileEdges := p.buildFileNodesEdges(files)
	nodes = append(nodes, fileNodes...)
	edges = append(edges, fileEdges...)

	return p.batchWriteStructure(nodes, edges)
}

// classifyDirectories collects all directories and determines which are packages.
func (p *Pipeline) classifyDirectories(files []discover.FileInfo) (allDirs, packageDirs map[string]bool) {
	packageIndicators := make(map[string]bool)
	for _, l := range lang.AllLanguages() {
		spec := lang.ForLanguage(l)
		if spec != nil {
			for _, pi := range spec.PackageIndicators {
				packageIndicators[pi] = true
			}
		}
	}

	allDirs = make(map[string]bool)
	for _, f := range files {
		dir := filepath.Dir(f.RelPath)
		for dir != "." && dir != "" && !allDirs[dir] {
			allDirs[dir] = true
			dir = filepath.Dir(dir)
		}
	}

	packageDirs = make(map[string]bool, len(allDirs))
	for dir := range allDirs {
		absDir := filepath.Join(p.RepoPath, dir)
		for indicator := range packageIndicators {
			if _, err := os.Stat(filepath.Join(absDir, indicator)); err == nil {
				packageDirs[dir] = true
				break
			}
		}
	}
	return
}

func (p *Pipeline) buildDirNodesEdges(dirSet, dirIsPackage map[string]bool, projectQN string) ([]*store.Node, []pendingEdge) {
	nodes := make([]*store.Node, 0, len(dirSet))
	edges := make([]pendingEdge, 0, len(dirSet))

	for dir := range dirSet {
		label := "Folder"
		edgeType := "CONTAINS_FOLDER"
		if dirIsPackage[dir] {
			label = "Package"
			edgeType = "CONTAINS_PACKAGE"
		}
		qn := fqn.FolderQN(p.ProjectName, dir)
		nodes = append(nodes, &store.Node{
			Project:       p.ProjectName,
			Label:         label,
			Name:          filepath.Base(dir),
			QualifiedName: qn,
			FilePath:      dir,
		})

		parent := filepath.Dir(dir)
		parentQN := projectQN
		if parent != "." && parent != "" {
			parentQN = fqn.FolderQN(p.ProjectName, parent)
		}
		edges = append(edges, pendingEdge{SourceQN: parentQN, TargetQN: qn, Type: edgeType})
	}
	return nodes, edges
}

func (p *Pipeline) buildFileNodesEdges(files []discover.FileInfo) ([]*store.Node, []pendingEdge) {
	nodes := make([]*store.Node, 0, len(files))
	edges := make([]pendingEdge, 0, len(files))

	for _, f := range files {
		fileQN := fqn.Compute(p.ProjectName, f.RelPath, "") + ".__file__"
		fileProps := map[string]any{
			"extension": filepath.Ext(f.RelPath),
			"is_test":   isTestFile(f.RelPath, f.Language),
		}
		if f.Language != "" {
			fileProps["language"] = string(f.Language)
		}
		nodes = append(nodes, &store.Node{
			Project:       p.ProjectName,
			Label:         "File",
			Name:          filepath.Base(f.RelPath),
			QualifiedName: fileQN,
			FilePath:      f.RelPath,
			Properties:    fileProps,
		})

		parentQN := p.dirQN(filepath.Dir(f.RelPath))
		edges = append(edges, pendingEdge{SourceQN: parentQN, TargetQN: fileQN, Type: "CONTAINS_FILE"})
	}
	return nodes, edges
}

func (p *Pipeline) batchWriteStructure(nodes []*store.Node, edges []pendingEdge) error {
	idMap, err := p.Store.UpsertNodeBatch(nodes)
	if err != nil {
		return fmt.Errorf("pass1 batch upsert: %w", err)
	}

	realEdges := make([]*store.Edge, 0, len(edges))
	for _, pe := range edges {
		srcID, srcOK := idMap[pe.SourceQN]
		tgtID, tgtOK := idMap[pe.TargetQN]
		if srcOK && tgtOK {
			realEdges = append(realEdges, &store.Edge{
				Project:    p.ProjectName,
				SourceID:   srcID,
				TargetID:   tgtID,
				Type:       pe.Type,
				Properties: pe.Properties,
			})
		}
	}

	if err := p.Store.InsertEdgeBatch(realEdges); err != nil {
		return fmt.Errorf("pass1 batch edges: %w", err)
	}
	return nil
}

func (p *Pipeline) dirQN(relDir string) string {
	if relDir == "." || relDir == "" {
		return p.ProjectName
	}
	return fqn.FolderQN(p.ProjectName, relDir)
}

// pendingEdge represents an edge to be created after batch node insertion,
// using qualified names that will be resolved to IDs.
type pendingEdge struct {
	SourceQN   string
	TargetQN   string
	Type       string
	Properties map[string]any
}

// parseResult holds the output of a pure file parse (no DB access).
type parseResult struct {
	File         discover.FileInfo
	Nodes        []*store.Node
	PendingEdges []pendingEdge
	ImportMap    map[string]string
	CBMResult    *cbm.FileResult // CBM extraction result (nil when using legacy AST path)
	Source       []byte          // raw file bytes, kept for post-parse passes (sourceStore)
	Err          error
}

// passDefinitions extracts definitions from each file via CBM (C extraction library).
// Uses parallel extraction (Stage 1) followed by sequential batch DB writes (Stage 2).
func (p *Pipeline) passDefinitions(files []discover.FileInfo) { //nolint:gocognit,cyclop,funlen // two-stage parallel extraction + sequential DB write
	slog.Info("pass2.definitions")

	// Enrich JSON files with URL constants (for HTTP linking), then include
	// them in normal CBM extraction so they also get Variable/Class nodes.
	parseableFiles := make([]discover.FileInfo, 0, len(files))
	for _, f := range files {
		if f.Language == lang.JSON {
			if p.ctx.Err() != nil {
				return
			}
			if err := p.processJSONFile(f); err != nil {
				slog.Warn("pass2.json.err", "path", f.RelPath, "err", err)
			}
		}
		parseableFiles = append(parseableFiles, f)
	}

	if len(parseableFiles) == 0 {
		return
	}

	// Stage 1: Parallel CBM extraction (CPU-only when sourceStore is populated)
	t1 := time.Now()
	results := make([]*parseResult, len(parseableFiles))
	hasBulkLoaded := p.sourceStore != nil

	if hasBulkLoaded {
		// RAM path: decompress from sourceStore, no disk I/O
		pool := newAdaptivePool(runtime.NumCPU())
		go pool.monitor(p.ctx)
		var wg sync.WaitGroup
		for i, f := range parseableFiles {
			pool.acquire()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer pool.releaseBytes(f.Size)
				if p.ctx.Err() != nil {
					return
				}
				source := p.getSource(f.RelPath)
				var readErr error
				if source == nil {
					readErr = fmt.Errorf("not in sourceStore: %s", f.RelPath)
				}
				results[i] = cbmParseFileFromSource(p.ProjectName, f, source, readErr, p.getCompileFlags(f.RelPath))
			}()
		}
		wg.Wait()
		pool.stop()
	} else {
		// Disk path (incremental): mmap from disk as before
		pf := newPrefetcher(parseableFiles, 100)
		go pf.run(p.ctx)
		defer pf.stop()

		pool := newAdaptivePool(runtime.NumCPU())
		go pool.monitor(p.ctx)
		var wg sync.WaitGroup
		for i, f := range parseableFiles {
			pool.acquire()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer pool.releaseBytes(f.Size)
				if p.ctx.Err() != nil {
					return
				}
				results[i] = cbmParseFile(p.ProjectName, f, p.getCompileFlags(f.RelPath))
				pf.advance(i + 1)
			}()
		}
		wg.Wait()
		pool.stop()
	}
	slog.Info("pass2.stage1.extract", "files", len(parseableFiles), "from_ram", hasBulkLoaded, "elapsed", time.Since(t1))

	// Log C-side parse vs extraction breakdown
	profile := cbm.GetProfile()
	if profile.Files > 0 {
		slog.Info("pass2.stage1.profile",
			"files", profile.Files,
			"parse_total", time.Duration(profile.ParseNs),
			"extract_total", time.Duration(profile.ExtractNs),
			"parse_avg_us", profile.ParseNs/profile.Files/1000,
			"extract_avg_us", profile.ExtractNs/profile.Files/1000,
			"preprocess_total", time.Duration(profile.PreprocessNs),
			"files_preprocessed", profile.FilesPreprocessed,
		)
	}

	// Stage 2: Sequential cache population + batch DB writes + inline registry build
	t2 := time.Now()
	var allNodes []*store.Node
	var allPendingEdges []pendingEdge

	// Initialize sourceStore for incremental path (bulk load already did this for full)
	if p.sourceStore == nil {
		p.sourceStore = make(map[string]*compressedSource, len(results))
	}

	for _, r := range results {
		if r == nil {
			continue
		}
		if r.Err != nil {
			slog.Warn("pass2.file.err", "path", r.File.RelPath, "err", r.Err)
			continue
		}
		// Populate extraction cache for use by later passes
		if r.CBMResult != nil {
			p.extractionCache[r.File.RelPath] = &cachedExtraction{
				Result:   r.CBMResult,
				Language: r.File.Language,
			}
		}
		// Store raw source bytes for incremental path (full path already has them in sourceStore)
		if !hasBulkLoaded && len(r.Source) > 0 {
			compressed := cbm.LZ4CompressHC(r.Source)
			p.sourceStore[r.File.RelPath] = &compressedSource{
				data:        compressed,
				originalLen: len(r.Source),
			}
			r.Source = nil
		}
		// Store import map
		moduleQN := fqn.ModuleQN(p.ProjectName, r.File.RelPath)
		if len(r.ImportMap) > 0 {
			p.importMaps[moduleQN] = r.ImportMap
		}
		// Inline registry build: register each callable node as it's collected,
		// eliminating the separate buildRegistry() scan over the entire store.
		for _, n := range r.Nodes {
			if isRegistrableLabel(n.Label) {
				p.registry.Register(n.Name, n.QualifiedName, n.Label)
			}
		}
		allNodes = append(allNodes, r.Nodes...)
		allPendingEdges = append(allPendingEdges, r.PendingEdges...)
	}

	slog.Info("pass2.stage2.collect", "nodes", len(allNodes), "edges", len(allPendingEdges), "elapsed", time.Since(t2))

	// Batch insert all nodes
	t3 := time.Now()
	idMap, err := p.Store.UpsertNodeBatch(allNodes)
	if err != nil {
		slog.Warn("pass2.batch_upsert.err", "err", err)
		return
	}
	slog.Info("pass2.stage3.upsert_nodes", "nodes", len(allNodes), "elapsed", time.Since(t3))

	// Resolve pending edges to real edges using the ID map
	t4 := time.Now()
	edges := make([]*store.Edge, 0, len(allPendingEdges))
	for _, pe := range allPendingEdges {
		srcID, srcOK := idMap[pe.SourceQN]
		tgtID, tgtOK := idMap[pe.TargetQN]
		if srcOK && tgtOK {
			edges = append(edges, &store.Edge{
				Project:    p.ProjectName,
				SourceID:   srcID,
				TargetID:   tgtID,
				Type:       pe.Type,
				Properties: pe.Properties,
			})
		}
	}

	if err := p.Store.InsertEdgeBatch(edges); err != nil {
		slog.Warn("pass2.batch_edges.err", "err", err)
	}
	slog.Info("pass2.stage4.insert_edges", "edges", len(edges), "elapsed", time.Since(t4))
}

// isRegistrableLabel returns true if nodes with this label should be registered
// in the FunctionRegistry for call resolution.
func isRegistrableLabel(label string) bool {
	switch label {
	case "Function", "Method", "Class", "Type", "Interface", "Enum", "Macro", "Variable":
		return true
	}
	return false
}

// buildRegistry populates the FunctionRegistry from all Function, Method,
// and Class nodes in the store. Used by the incremental path where inline
// registration during passDefinitions isn't available for existing nodes.
func (p *Pipeline) buildRegistry() {
	for _, label := range []string{"Function", "Method", "Class", "Type", "Interface", "Enum", "Macro", "Variable"} {
		nodes, err := p.Store.FindNodesByLabel(p.ProjectName, label)
		if err != nil {
			continue
		}
		for _, n := range nodes {
			p.registry.Register(n.Name, n.QualifiedName, n.Label)
		}
	}
	slog.Info("registry.built", "entries", p.registry.Size())
}

// buildReturnTypeMap builds a map from function QN to its return type QN.
// Uses the "return_types" property stored on Function/Method nodes during pass2.
func (p *Pipeline) buildReturnTypeMap() {
	p.returnTypes = make(ReturnTypeMap)
	for _, label := range []string{"Function", "Method"} {
		nodes, err := p.Store.FindNodesByLabel(p.ProjectName, label)
		if err != nil {
			continue
		}
		for _, n := range nodes {
			retTypes, ok := n.Properties["return_types"]
			if !ok {
				continue
			}
			// return_types is stored as []any (JSON round-trip) containing type name strings
			typeList, ok := retTypes.([]any)
			if !ok || len(typeList) == 0 {
				continue
			}
			// Use the first return type — most functions return a single type
			firstType, ok := typeList[0].(string)
			if !ok || firstType == "" {
				continue
			}
			// Resolve the type name to a class QN
			classQN := resolveAsClass(firstType, p.registry, "", nil)
			if classQN != "" {
				p.returnTypes[n.QualifiedName] = classQN
			}
		}
	}
	if len(p.returnTypes) > 0 {
		slog.Info("return_types.built", "entries", len(p.returnTypes))
	}
}

// resolvedEdge represents an edge resolved during parallel call/usage resolution,
// stored as QN pairs to be converted to ID-based edges in the batch write stage.
type resolvedEdge struct {
	CallerQN   string
	TargetQN   string
	Type       string // "CALLS" or "USAGE"
	Properties map[string]any
}

// passCalls resolves call targets and creates CALLS edges.
// Phase 1: Batch cross-file LSP (Go + C/C++) — one CGo call per language family.
// Phase 2: Parallel per-file registry + fuzzy resolution (pure Go, no CGo).
// Phase 3: Batch QN→ID resolution + edge insert.
func (p *Pipeline) passCalls() {
	slog.Info("pass3.calls")

	// Collect files to process from extraction cache
	var files []fileEntry
	for relPath, ext := range p.extractionCache {
		if lang.ForLanguage(ext.Language) != nil {
			files = append(files, fileEntry{relPath, ext})
		}
	}

	if len(files) == 0 {
		return
	}

	// Phase 1: Batch cross-file LSP — partitioned for parallel CGo calls
	p.batchGoLSPCrossFileResolution(files)
	p.batchCLSPCrossFileResolution(files)

	// Free cached trees — no longer needed after cross-file LSP
	for _, fe := range files {
		if fe.ext.Result != nil {
			fe.ext.Result.FreeTree()
		}
	}

	// Release Definitions + Imports — only needed for cross-file LSP
	for _, fe := range files {
		if fe.ext.Result != nil {
			fe.ext.Result.Definitions = nil
			fe.ext.Result.Imports = nil
		}
	}

	// Phase 2: Parallel per-file call resolution (registry + fuzzy, no CGo)
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
			results[i] = p.resolveFileCallsCBM(fe.relPath, fe.ext)
			return nil
		})
	}
	_ = g.Wait()

	// Stage 2: Batch QN→ID resolution + batch edge insert
	p.flushResolvedEdges(results)
}

// flushResolvedEdges converts QN-based resolved edges to ID-based edges and batch-inserts them.
func (p *Pipeline) flushResolvedEdges(results [][]resolvedEdge) {
	qnSet, totalEdges := collectEdgeQNs(results)
	if totalEdges == 0 {
		return
	}

	// Batch resolve all QNs to IDs
	qns := make([]string, 0, len(qnSet))
	for qn := range qnSet {
		qns = append(qns, qn)
	}
	qnToID, err := p.Store.FindNodeIDsByQNs(p.ProjectName, qns)
	if err != nil {
		slog.Warn("pass3.resolve_ids.err", "err", err)
		return
	}

	// Create stub nodes for LSP-resolved targets that don't exist in the graph.
	p.createLSPStubNodes(results, qnToID)

	// Build and insert edges
	edges := buildEdgesFromResults(results, qnToID, p.ProjectName, totalEdges)
	if err := p.Store.InsertEdgeBatch(edges); err != nil {
		slog.Warn("pass3.batch_edges.err", "err", err)
	}
}

// collectEdgeQNs collects all unique qualified names and counts total edges from results.
func collectEdgeQNs(results [][]resolvedEdge) (qnSet map[string]struct{}, totalEdges int) {
	qnSet = make(map[string]struct{})
	for _, fileEdges := range results {
		for _, re := range fileEdges {
			qnSet[re.CallerQN] = struct{}{}
			qnSet[re.TargetQN] = struct{}{}
			totalEdges++
		}
	}
	return qnSet, totalEdges
}

// createLSPStubNodes creates stub nodes for LSP-resolved targets that don't exist in the graph.
// This happens for stdlib/external methods (e.g., context.Context.Done) that
// the LSP resolver correctly identifies but aren't indexed as nodes.
func (p *Pipeline) createLSPStubNodes(results [][]resolvedEdge, qnToID map[string]int64) {
	var stubs []*store.Node
	stubQNs := make(map[string]bool)
	for _, fileEdges := range results {
		for _, re := range fileEdges {
			if _, ok := qnToID[re.TargetQN]; ok {
				continue
			}
			if stubQNs[re.TargetQN] {
				continue
			}
			strategy, _ := re.Properties["resolution_strategy"].(string)
			if !strings.HasPrefix(strategy, "lsp_") {
				continue
			}
			stubQNs[re.TargetQN] = true
			name := re.TargetQN
			if idx := strings.LastIndex(name, "."); idx >= 0 {
				name = name[idx+1:]
			}
			label := "Function"
			if strings.Count(re.TargetQN, ".") >= 2 {
				label = "Method"
			}
			stubs = append(stubs, &store.Node{
				Project:       p.ProjectName,
				Label:         label,
				Name:          name,
				QualifiedName: re.TargetQN,
				Properties:    map[string]any{"stub": true, "source": "lsp_resolution"},
			})
		}
	}
	if len(stubs) > 0 {
		stubIDs, err := p.Store.UpsertNodeBatch(stubs)
		if err != nil {
			slog.Warn("pass3.stub_nodes.err", "err", err)
		} else {
			for qn, id := range stubIDs {
				qnToID[qn] = id
			}
			slog.Info("pass3.stub_nodes", "count", len(stubs))
		}
	}
}

// buildEdgesFromResults converts QN-based resolved edges to store.Edge using the QN-to-ID map.
func buildEdgesFromResults(results [][]resolvedEdge, qnToID map[string]int64, project string, totalEdges int) []*store.Edge {
	edges := make([]*store.Edge, 0, totalEdges)
	for _, fileEdges := range results {
		for _, re := range fileEdges {
			srcID, srcOK := qnToID[re.CallerQN]
			tgtID, tgtOK := qnToID[re.TargetQN]
			if srcOK && tgtOK {
				edges = append(edges, &store.Edge{
					Project:    project,
					SourceID:   srcID,
					TargetID:   tgtID,
					Type:       re.Type,
					Properties: re.Properties,
				})
			}
		}
	}
	return edges
}

// resolveCallWithTypes resolves a callee name using the registry, import maps,
// and type inference for method dispatch.
func (p *Pipeline) resolveCallWithTypes(
	calleeName, moduleQN string,
	importMap map[string]string,
	typeMap TypeMap,
) ResolutionResult {
	// First, try type-based method dispatch for qualified calls like obj.method()
	if strings.Contains(calleeName, ".") {
		parts := strings.SplitN(calleeName, ".", 2)
		objName := parts[0]
		methodName := parts[1]

		// Check if the object has a known type from type inference
		if classQN, ok := typeMap[objName]; ok {
			candidate := classQN + "." + methodName
			if p.registry.Exists(candidate) {
				return ResolutionResult{QualifiedName: candidate, Strategy: "type_dispatch", Confidence: 0.90, CandidateCount: 1}
			}
		}
	}

	// Delegate to the registry's resolution strategy
	return p.registry.Resolve(calleeName, moduleQN, importMap)
}

// frameworkDecoratorPrefixes are decorator prefixes that indicate a function
// is registered as an entry point by a framework (not dead code).
var frameworkDecoratorPrefixes = []string{
	// Python web frameworks (route handlers)
	"@app.get", "@app.post", "@app.put", "@app.delete", "@app.patch",
	"@app.route", "@app.websocket",
	"@router.get", "@router.post", "@router.put", "@router.delete", "@router.patch",
	"@router.route", "@router.websocket",
	"@blueprint.", "@api.", "@ns.",
	// Python middleware and exception handlers (framework-registered)
	"@app.middleware", "@app.exception_handler", "@app.on_event",
	// Testing frameworks
	"@pytest.fixture", "@pytest.mark",
	// CLI frameworks
	"@click.command", "@click.group",
	// Task/worker frameworks
	"@celery.task", "@shared_task", "@task",
	// Signal handlers
	"@receiver",
	// Rust Actix/Axum/Rocket route macros (#[get("/path")] → extracted as get("/path"))
	"get(", "post(", "put(", "delete(", "patch(", "head(", "options(",
	"route(", "connect(", "trace(",
}

// hasFrameworkDecorator returns true if any decorator matches a framework pattern.
func hasFrameworkDecorator(decorators []string) bool {
	for _, dec := range decorators {
		for _, prefix := range frameworkDecoratorPrefixes {
			if strings.HasPrefix(dec, prefix) {
				return true
			}
		}
	}
	return false
}

// passImports creates IMPORTS edges from the import maps built during pass 2.
func (p *Pipeline) passImports() {
	slog.Info("pass2b.imports")
	count := 0
	for moduleQN, importMap := range p.importMaps {
		moduleNode, _ := p.Store.FindNodeByQN(p.ProjectName, moduleQN)
		if moduleNode == nil {
			continue
		}
		for localName, targetQN := range importMap {
			// Try to find the target as a Module node first
			targetNode, _ := p.Store.FindNodeByQN(p.ProjectName, targetQN)
			if targetNode == nil {
				// Try treating import path as a relative file path (e.g. "utils.mag", "lib/helpers.h")
				resolvedQN := fqn.ModuleQN(p.ProjectName, targetQN)
				if resolvedQN != targetQN {
					targetNode, _ = p.Store.FindNodeByQN(p.ProjectName, resolvedQN)
				}
			}
			if targetNode == nil {
				logImportDrop(moduleQN, localName, targetQN)
				continue
			}
			_, _ = p.Store.InsertEdge(&store.Edge{
				Project:  p.ProjectName,
				SourceID: moduleNode.ID,
				TargetID: targetNode.ID,
				Type:     "IMPORTS",
				Properties: map[string]any{
					"alias": localName,
				},
			})
			count++
		}
	}
	slog.Info("pass2b.imports.done", "edges", count)
}

// passHTTPLinks runs the HTTP linker to discover cross-service HTTP calls.
func (p *Pipeline) passHTTPLinks() error {
	// Clean up stale Route/InfraFile nodes and HTTP_CALLS/HANDLES/ASYNC_CALLS edges before re-running
	_ = p.Store.DeleteNodesByLabel(p.ProjectName, "Route")
	_ = p.Store.DeleteNodesByLabel(p.ProjectName, "InfraFile")
	_ = p.Store.DeleteEdgesByType(p.ProjectName, "HTTP_CALLS")
	_ = p.Store.DeleteEdgesByType(p.ProjectName, "HANDLES")
	_ = p.Store.DeleteEdgesByType(p.ProjectName, "ASYNC_CALLS")

	// Index infrastructure files (Dockerfiles, compose, cloudbuild, .env)
	p.passInfraFiles()

	// Scan config files for env var URLs and create synthetic Module nodes
	var envBindings []EnvBinding
	if p.sourceStore != nil {
		envBindings = p.scanEnvURLsFromStore()
	} else {
		envBindings = ScanProjectEnvURLs(p.RepoPath)
	}
	if len(envBindings) > 0 {
		p.injectEnvBindings(envBindings)
	}

	linker := httplink.New(p.Store, p.ProjectName)

	// Set RAM source readers when sourceStore is available (full index)
	if p.sourceStore != nil {
		linker.SetSourceReader(
			func(relPath string) []byte { return p.getSource(relPath) },
			func(relPath string, start, end int) string { return p.getSourceLines(relPath, start, end) },
		)

		// AC pre-screen: single CGo call scans all files for HTTP/async + route keywords.
		acCallFiles, acRouteFiles := p.acScreenHTTPFiles()
		if acCallFiles != nil {
			linker.SetHTTPKeywordFiles(acCallFiles)
		}
		if acRouteFiles != nil {
			linker.SetRouteKeywordFiles(acRouteFiles)
		}
	}

	// Feed InfraFile environment URLs into the HTTP linker
	infraSites := p.extractInfraCallSites()
	if len(infraSites) > 0 {
		linker.AddCallSites(infraSites)
		slog.Info("pass4.infra_callsites", "count", len(infraSites))
	}

	links, err := linker.Run()
	if err != nil {
		return err
	}
	slog.Info("pass4.httplinks", "links", len(links))
	return nil
}

// acScreenHTTPFiles uses a single Aho-Corasick automaton to pre-screen all
// sourceStore files for HTTP client, async dispatch, AND route registration
// keywords. One CGo call scans all files — zero per-file overhead.
// Returns two maps: callFiles (HTTP/async keywords) and routeFiles (route keywords).
func (p *Pipeline) acScreenHTTPFiles() (callFiles, routeFiles map[string]uint64) {
	httpKW := httplink.HTTPClientKeywords()
	asyncKW := httplink.AsyncDispatchKeywords()
	routeKW := httplink.RouteKeywords()

	// Layout: [httpClient...][asyncDispatch...][route...]
	// Deduplicate to fit in 64-bit bitmask.
	all := make([]string, 0, len(httpKW)+len(asyncKW)+len(routeKW))
	all = append(all, httpKW...)
	all = append(all, asyncKW...)
	all = append(all, routeKW...)
	seen := make(map[string]bool, len(all))
	patterns := all[:0]
	for _, p := range all {
		if !seen[p] {
			seen[p] = true
			patterns = append(patterns, p)
		}
	}

	ac := cbm.ACBuild(patterns)
	if ac == nil {
		return nil, nil
	}
	defer ac.Free()

	// Bitmask boundaries — computed from deduplicated positions.
	// Re-map: find which bits correspond to each category.
	var callBits, asyncBits, routeBits uint64
	pidOf := make(map[string]int, len(patterns))
	for i, p := range patterns {
		pidOf[p] = i
	}
	for _, kw := range httpKW {
		if pid, ok := pidOf[kw]; ok && pid < 64 {
			callBits |= 1 << pid
		}
	}
	for _, kw := range asyncKW {
		if pid, ok := pidOf[kw]; ok && pid < 64 {
			asyncBits |= 1 << pid
		}
	}
	for _, kw := range routeKW {
		if pid, ok := pidOf[kw]; ok && pid < 64 {
			routeBits |= 1 << pid
		}
	}
	callAndAsyncBits := callBits | asyncBits

	// Build LZ4 entry array + path index for single CGo call.
	t := time.Now()
	entries := make([]cbm.LZ4Entry, 0, len(p.sourceStore))
	paths := make([]string, 0, len(p.sourceStore))
	for relPath, cs := range p.sourceStore {
		entries = append(entries, cbm.LZ4Entry{Data: cs.data, OriginalLen: cs.originalLen})
		paths = append(paths, relPath)
	}

	matches := ac.ScanLZ4Batch(entries)

	callFiles = make(map[string]uint64)
	routeFiles = make(map[string]uint64)
	for _, m := range matches {
		relPath := paths[m.FileIndex]
		if m.Bitmask&callAndAsyncBits != 0 {
			callFiles[relPath] = m.Bitmask & callAndAsyncBits
		}
		if m.Bitmask&routeBits != 0 {
			routeFiles[relPath] = m.Bitmask & routeBits
		}
	}

	slog.Info("httplink.ac_screen",
		"files_total", len(entries),
		"call_files", len(callFiles),
		"route_files", len(routeFiles),
		"patterns", len(patterns),
		"states", ac.NumStates(),
		"table_kb", ac.TableBytes()/1024,
		"elapsed", time.Since(t))

	return callFiles, routeFiles
}

// extractInfraCallSites extracts URL values from InfraFile environment properties
// and converts them to HTTPCallSite entries for the HTTP linker.
func (p *Pipeline) extractInfraCallSites() []httplink.HTTPCallSite {
	infraNodes, err := p.Store.FindNodesByLabel(p.ProjectName, "InfraFile")
	if err != nil {
		return nil
	}

	var sites []httplink.HTTPCallSite
	for _, node := range infraNodes {
		// InfraFile nodes use different property keys depending on source:
		// compose files: "environment", Dockerfiles/shell/.env: "env_vars",
		// cloudbuild: "deploy_env_vars"
		for _, envKey := range []string{"environment", "env_vars", "deploy_env_vars"} {
			sites = append(sites, extractEnvURLSites(node, envKey)...)
		}
	}
	return sites
}

// extractEnvURLSites extracts HTTP call sites from a single env property of an InfraFile node.
func extractEnvURLSites(node *store.Node, propKey string) []httplink.HTTPCallSite {
	env, ok := node.Properties[propKey]
	if !ok {
		return nil
	}

	// env_vars are stored as map[string]string (from Go), but after JSON round-trip
	// through SQLite they come back as map[string]any.
	var sites []httplink.HTTPCallSite
	switch envMap := env.(type) {
	case map[string]any:
		for _, val := range envMap {
			valStr, ok := val.(string)
			if !ok {
				continue
			}
			sites = append(sites, urlSitesFromValue(node, valStr)...)
		}
	case map[string]string:
		for _, valStr := range envMap {
			sites = append(sites, urlSitesFromValue(node, valStr)...)
		}
	}
	return sites
}

// urlSitesFromValue extracts URL paths from a string value and creates HTTPCallSite entries.
func urlSitesFromValue(node *store.Node, val string) []httplink.HTTPCallSite {
	if !strings.Contains(val, "http://") && !strings.Contains(val, "https://") && !strings.HasPrefix(val, "/") {
		return nil
	}

	paths := httplink.ExtractURLPaths(val)
	sites := make([]httplink.HTTPCallSite, 0, len(paths))
	for _, path := range paths {
		sites = append(sites, httplink.HTTPCallSite{
			Path:                path,
			SourceName:          node.Name,
			SourceQualifiedName: node.QualifiedName,
			SourceLabel:         "InfraFile",
		})
	}
	return sites
}

// injectEnvBindings creates or updates Module nodes for config files that contain
// environment variable URL bindings. These synthetic constants feed into the
// HTTP linker's call site discovery.
func (p *Pipeline) injectEnvBindings(bindings []EnvBinding) {
	byFile := make(map[string][]EnvBinding)
	for _, b := range bindings {
		byFile[b.FilePath] = append(byFile[b.FilePath], b)
	}

	count := 0
	for filePath, fileBindings := range byFile {
		moduleQN := fqn.ModuleQN(p.ProjectName, filePath)
		constants := buildConstantsList(fileBindings)

		if p.mergeWithExistingModule(moduleQN, constants) {
			count += len(fileBindings)
			continue
		}

		_, _ = p.Store.UpsertNode(&store.Node{
			Project:       p.ProjectName,
			Label:         "Module",
			Name:          filepath.Base(filePath),
			QualifiedName: moduleQN,
			FilePath:      filePath,
			Properties:    map[string]any{"constants": constants},
		})
		count += len(fileBindings)
	}

	if count > 0 {
		slog.Info("envscan.injected", "bindings", count, "files", len(byFile))
	}
}

// buildConstantsList converts env bindings to "KEY = VALUE" constant strings, capped at 50.
func buildConstantsList(bindings []EnvBinding) []string {
	constants := make([]string, 0, len(bindings))
	for _, b := range bindings {
		constants = append(constants, b.Key+" = "+b.Value)
	}
	if len(constants) > 50 {
		constants = constants[:50]
	}
	return constants
}

// mergeWithExistingModule merges new constants into an existing Module node's constant list.
// Returns true if the module existed and was updated.
func (p *Pipeline) mergeWithExistingModule(moduleQN string, constants []string) bool {
	existing, _ := p.Store.FindNodeByQN(p.ProjectName, moduleQN)
	if existing == nil {
		return false
	}
	existConsts, ok := existing.Properties["constants"].([]any)
	if !ok {
		return false
	}
	seen := make(map[string]bool, len(existConsts))
	for _, c := range existConsts {
		if s, ok := c.(string); ok {
			seen[s] = true
		}
	}
	for _, c := range constants {
		if !seen[c] {
			existConsts = append(existConsts, c)
		}
	}
	if existing.Properties == nil {
		existing.Properties = map[string]any{}
	}
	existing.Properties["constants"] = existConsts
	_, _ = p.Store.UpsertNode(existing)
	return true
}

// jsonURLKeyPattern matches JSON keys that likely contain URL/endpoint values.
var jsonURLKeyPattern = regexp.MustCompile(`(?i)(url|endpoint|base_url|host|api_url|service_url|target_url|callback_url|webhook|href|uri|address|server|origin|proxy|redirect|forward|destination)`)

// processJSONFile extracts URL-related string values from JSON config files.
// Uses a key-pattern allowlist to avoid flooding constants with noise.
func (p *Pipeline) processJSONFile(f discover.FileInfo) error {
	// Use sourceStore if available (RAM path), fall back to disk
	data := p.getSource(f.RelPath)
	if data == nil {
		var err error
		data, err = os.ReadFile(f.Path)
		if err != nil {
			return err
		}
	}

	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("json parse: %w", err)
	}

	var constants []string
	extractJSONURLValues(parsed, "", &constants, 0)

	if len(constants) == 0 {
		return nil
	}

	// Cap at 20 constants per JSON file
	if len(constants) > 20 {
		constants = constants[:20]
	}

	moduleQN := fqn.ModuleQN(p.ProjectName, f.RelPath)
	_, err := p.Store.UpsertNode(&store.Node{
		Project:       p.ProjectName,
		Label:         "Module",
		Name:          filepath.Base(f.RelPath),
		QualifiedName: moduleQN,
		FilePath:      f.RelPath,
		Properties:    map[string]any{"constants": constants},
	})
	return err
}

// extractJSONURLValues recursively extracts key=value pairs from JSON where
// the key matches the URL key pattern or the value looks like a URL/path.
func extractJSONURLValues(v any, key string, out *[]string, depth int) {
	if depth > 20 {
		return
	}

	switch val := v.(type) {
	case map[string]any:
		for k, child := range val {
			extractJSONURLValues(child, k, out, depth+1)
		}
	case []any:
		for _, child := range val {
			extractJSONURLValues(child, key, out, depth+1)
		}
	case string:
		if key == "" || val == "" {
			return
		}
		// Include if key matches URL pattern
		if jsonURLKeyPattern.MatchString(key) {
			*out = append(*out, key+" = "+val)
			return
		}
		// Include if value looks like a URL or API path
		if looksLikeURL(val) {
			*out = append(*out, key+" = "+val)
		}
	}
}

// looksLikeURL returns true if s appears to be a URL or API path.
func looksLikeURL(s string) bool {
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		return true
	}
	// Path starting with /api/ or containing at least 2 segments
	if strings.HasPrefix(s, "/") && strings.Count(s, "/") >= 2 {
		// Skip version-like paths: /1.0.0, /v2, /en
		seg := strings.TrimPrefix(s, "/")
		return len(seg) > 3
	}
	return false
}

// safeRowToLine converts a tree-sitter row (uint) to a 1-based line number (int).
// Returns math.MaxInt if the value would overflow.
// stripBOM removes a UTF-8 BOM (0xEF 0xBB 0xBF) from the start of source.
// Common in C# and Windows-generated files; tree-sitter may choke on BOM bytes.
func stripBOM(source []byte) []byte {
	if len(source) >= 3 && source[0] == 0xEF && source[1] == 0xBB && source[2] == 0xBF {
		return source[3:]
	}
	return source
}
