package pipeline

import (
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"runtime/debug"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// runFullIndex builds the entire graph in RAM via GraphBuffer, then writes
// directly to a SQLite .db file via the C page writer. Zero SQL during
// passes — all node/edge ops go through the StoreBackend interface backed
// by GraphBuffer.
func (p *Pipeline) runFullIndex(files []discover.FileInfo, _ time.Time) error {
	// Cap Go heap to leave room for C allocations during final dump.
	// Without this, Go grabs ~30GB virtual memory during passes and
	// the C page writer OOMs on machines with ≤36GB RAM.
	prevLimit := debug.SetMemoryLimit(-1) // query current
	if prevLimit <= 0 || prevLimit > 24<<30 {
		debug.SetMemoryLimit(24 << 30) // 24GB
		defer debug.SetMemoryLimit(prevLimit)
	}

	// Create GraphBuffer and route all Store calls through it.
	p.buf = newGraphBuffer(p.ProjectName, p.RepoPath)
	p.Store = p.buf // ALL passes now use GraphBuffer — zero SQLite

	if err := p.runFullPasses(files); err != nil {
		return err
	}

	// Final dump: write GraphBuffer contents to SQLite.
	t := time.Now()
	dbPath := p.diskStore.DBPath()

	if err := p.dumpDB(dbPath); err != nil {
		return err
	}
	slog.Info("db.dump", "elapsed", time.Since(t))

	// Release GraphBuffer — all data already written to SQLite.
	p.buf = nil

	// File hashes + observability go to disk store.
	p.Store = p.diskStore
	p.updateFileHashes(files)

	// Release source store — all passes done.
	p.sourceStore = nil

	// Observability: per-edge-type counts.
	p.logEdgeCounts()

	return nil
}

// runFullPasses runs the complete pass pipeline. ALL passes run on GraphBuffer —
// no mid-pipeline flush, no post-flush distinction.
func (p *Pipeline) runFullPasses(files []discover.FileInfo) error {
	// Pass group 1: Structure + extraction
	t := time.Now()
	if err := p.passStructure(files); err != nil {
		return fmt.Errorf("pass1 structure: %w", err)
	}
	slog.Info("pass.timing", "pass", "structure", "elapsed", time.Since(t))
	if err := p.checkCancel(); err != nil {
		return err
	}

	// Bulk load: read all files, xxh3 hash, LZ4 HC compress → RAM.
	t = time.Now()
	p.bulkLoadSources(files)
	slog.Info("pass.timing", "pass", "bulk_load", "elapsed", time.Since(t))
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	p.passDefinitions(files)
	slog.Info("pass.timing", "pass", "definitions", "elapsed", time.Since(t))
	logHeapStats("post_definitions")
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	p.passDecoratorTags()
	slog.Info("pass.timing", "pass", "decorator_tags", "elapsed", time.Since(t))

	// Registry already built inline during passDefinitions (fused).
	slog.Info("registry.built", "entries", p.registry.Size())
	if err := p.checkCancel(); err != nil {
		return err
	}

	// Pass group 2-3: Cross-references + resolution
	if err := p.runCrossRefPasses(); err != nil {
		return err
	}

	// Pass group 4: post-resolution passes
	return p.runPostPasses()
}

// runCrossRefPasses runs cross-reference and call resolution passes.
func (p *Pipeline) runCrossRefPasses() error {
	t := time.Now()
	p.passInherits()
	slog.Info("pass.timing", "pass", "inherits", "elapsed", time.Since(t))

	t = time.Now()
	p.passDecorates()
	slog.Info("pass.timing", "pass", "decorates", "elapsed", time.Since(t))
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	p.passImports()
	slog.Info("pass.timing", "pass", "imports", "elapsed", time.Since(t))
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	p.buildReturnTypeMap()
	p.goLSPIdx = p.buildGoLSPDefIndex()
	if p.goLSPIdx != nil {
		p.goLSPIdx.integrateThirdPartyDeps(p.RepoPath, p.importMaps)
	}
	p.cLSPIdx = p.buildCLSPDefIndex()
	p.passCalls()
	slog.Info("pass.timing", "pass", "calls", "elapsed", time.Since(t))
	p.releaseExtractionFields(fieldsPostCalls)
	p.goLSPIdx = nil
	p.cLSPIdx = nil
	logHeapStats("post_calls")
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	p.passUsages()
	slog.Info("pass.timing", "pass", "usages", "elapsed", time.Since(t))
	p.releaseExtractionFields(fieldsPostUsages)
	if err := p.checkCancel(); err != nil {
		return err
	}

	p.runSemanticEdgePasses()
	p.releaseExtractionFields(fieldsPostSemantic)
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	p.passImplements()
	slog.Info("pass.timing", "pass", "implements", "elapsed", time.Since(t))

	p.cleanupASTCache()
	p.registry = nil
	p.importMaps = nil
	p.returnTypes = nil
	logHeapStats("post_cleanup")
	return nil
}

// runPostPasses runs post-resolution passes (tests, communities, httplinks, etc.).
func (p *Pipeline) runPostPasses() error {
	t := time.Now()
	p.passTests()
	slog.Info("pass.timing", "pass", "tests", "elapsed", time.Since(t))

	t = time.Now()
	p.passCommunities()
	slog.Info("pass.timing", "pass", "communities", "elapsed", time.Since(t))
	if err := p.checkCancel(); err != nil {
		return err
	}

	t = time.Now()
	if err := p.passHTTPLinks(); err != nil {
		slog.Warn("pass.httplink.err", "err", err)
	}
	slog.Info("pass.timing", "pass", "httplinks", "elapsed", time.Since(t))

	t = time.Now()
	p.passConfigLinker()
	slog.Info("pass.timing", "pass", "configlinker", "elapsed", time.Since(t))

	t = time.Now()
	p.passGitHistory()
	slog.Info("pass.timing", "pass", "githistory", "elapsed", time.Since(t))

	return nil
}

// dumpDB writes GraphBuffer contents to SQLite — in-memory or disk.
func (p *Pipeline) dumpDB(dbPath string) error {
	if dbPath == ":memory:" {
		if err := p.diskStore.UpsertProject(p.ProjectName, p.RepoPath); err != nil {
			return fmt.Errorf("upsert project: %w", err)
		}
		return p.buf.FlushTo(p.ctx, p.diskStore)
	}
	p.buf.releaseIndexes()
	runtime.GC()
	debug.FreeOSMemory()
	logHeapStats("pre_dump")
	tmpPath := dbPath + ".tmp"
	if err := p.buf.DumpToSQLite(tmpPath); err != nil {
		return fmt.Errorf("dump: %w", err)
	}
	p.diskStore.Close()
	_ = os.Remove(dbPath + "-wal")
	_ = os.Remove(dbPath + "-shm")
	if err := os.Rename(tmpPath, dbPath); err != nil {
		return fmt.Errorf("rename db: %w", err)
	}
	var err error
	p.diskStore, err = store.OpenPath(dbPath)
	if err != nil {
		return fmt.Errorf("reopen db: %w", err)
	}
	return nil
}
