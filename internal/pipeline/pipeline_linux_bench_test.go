package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// TestLinuxKernelFullIndex indexes the Linux kernel source tree and reports
// per-phase timings, node/edge counts, and memory usage.
//
// Set LINUX_SRC to the kernel source path (e.g. ~/linux).
// The test is skipped if LINUX_SRC is unset or the directory doesn't exist.
//
// Usage:
//
//	LINUX_SRC=~/linux go test ./internal/pipeline/ -run TestLinuxKernelFullIndex -v -timeout 60m -count=1
func TestLinuxKernelFullIndex(t *testing.T) {
	srcDir := os.Getenv("LINUX_SRC")
	if srcDir == "" {
		t.Skip("LINUX_SRC not set — skipping Linux kernel benchmark")
	}
	srcDir, _ = filepath.Abs(srcDir)
	if _, err := os.Stat(srcDir); err != nil { //nolint:gosec // G703: srcDir from env, not user input
		t.Skipf("LINUX_SRC=%s not found: %v", srcDir, err)
	}

	mode := discover.ModeFull
	if os.Getenv("LINUX_MODE") == "fast" {
		mode = discover.ModeFast
	}

	// Capture structured log output for timing extraction.
	var logBuf bytes.Buffer
	handler := slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(handler))
	defer slog.SetDefault(slog.Default())

	// Use a temp directory for the SQLite db (disk-backed = exercises direct page writer).
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "linux.db")

	s, err := store.OpenPath(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer s.Close()

	t.Logf("src=%s mode=%s db=%s GOMAXPROCS=%d", srcDir, mode, dbPath, runtime.GOMAXPROCS(0))

	start := time.Now()
	p := New(context.Background(), s, srcDir, mode)
	if err := p.Run(); err != nil {
		t.Fatalf("pipeline.Run: %v", err)
	}
	totalElapsed := time.Since(start)

	// Reopen store to verify integrity.
	s.Close()
	s2, err := store.OpenPath(dbPath)
	if err != nil {
		t.Fatalf("reopen db: %v", err)
	}
	defer s2.Close()

	projectName := ProjectNameFromPath(srcDir)
	nc, _ := s2.CountNodes(projectName)
	ec, _ := s2.CountEdges(projectName)

	dbInfo, _ := os.Stat(dbPath) //nolint:gosec // G703: dbPath from tmpdir, not user input
	dbSizeMB := float64(0)
	if dbInfo != nil {
		dbSizeMB = float64(dbInfo.Size()) / (1 << 20)
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	// Parse slog JSON lines for phase timings.
	timings := parsePassTimings(logBuf.String())
	memSnapshots := parseMemStats(logBuf.String())
	edgeCounts := parseEdgeCounts(logBuf.String())
	discovered := parseDiscovered(logBuf.String())

	// Report.
	t.Logf("")
	t.Logf("═══════════════════════════════════════════════════")
	t.Logf("  LINUX KERNEL INDEX REPORT")
	t.Logf("═══════════════════════════════════════════════════")
	t.Logf("  Source:        %s", srcDir)
	t.Logf("  Mode:          %s", mode)
	t.Logf("  Files:         %d", discovered)
	t.Logf("  GOMAXPROCS:    %d", runtime.GOMAXPROCS(0))
	t.Logf("───────────────────────────────────────────────────")
	t.Logf("  PHASE TIMINGS")
	t.Logf("───────────────────────────────────────────────────")
	for _, pt := range timings {
		pct := float64(pt.Elapsed) / float64(totalElapsed) * 100
		t.Logf("  %-20s %10s  (%4.1f%%)", pt.Pass, pt.Elapsed.Round(time.Millisecond), pct)
	}
	t.Logf("───────────────────────────────────────────────────")
	t.Logf("  %-20s %10s", "TOTAL", totalElapsed.Round(time.Millisecond))
	t.Logf("───────────────────────────────────────────────────")
	t.Logf("  RESULTS")
	t.Logf("───────────────────────────────────────────────────")
	t.Logf("  Nodes:         %d", nc)
	t.Logf("  Edges:         %d", ec)
	t.Logf("  DB size:       %.1f MB", dbSizeMB)
	if len(edgeCounts) > 0 {
		t.Logf("───────────────────────────────────────────────────")
		t.Logf("  EDGE BREAKDOWN")
		t.Logf("───────────────────────────────────────────────────")
		for _, ec := range edgeCounts {
			t.Logf("  %-20s %10d", ec.Type, ec.Count)
		}
	}
	if len(memSnapshots) > 0 {
		t.Logf("───────────────────────────────────────────────────")
		t.Logf("  MEMORY SNAPSHOTS")
		t.Logf("───────────────────────────────────────────────────")
		for _, ms := range memSnapshots {
			t.Logf("  %-20s heap_inuse=%4dMB  heap_alloc=%4dMB  sys=%4dMB",
				ms.Stage, ms.HeapInuse, ms.HeapAlloc, ms.Sys)
		}
	}
	t.Logf("───────────────────────────────────────────────────")
	t.Logf("  Final heap:    %d MB (inuse), %d MB (sys)", m.HeapInuse/(1<<20), m.Sys/(1<<20))
	t.Logf("═══════════════════════════════════════════════════")
}

// --- slog JSON parsing helpers ---

type passTiming struct {
	Pass    string //nolint:gosec // G117 false positive: struct field name, not a secret
	Elapsed time.Duration
}

type memSnapshot struct {
	Stage     string
	HeapInuse int64
	HeapAlloc int64
	Sys       int64
}

type edgeCount struct {
	Type  string
	Count int64
}

func parsePassTimings(logOutput string) []passTiming {
	var timings []passTiming
	for _, line := range strings.Split(logOutput, "\n") {
		if !strings.Contains(line, "pass.timing") && !strings.Contains(line, "db.dump") {
			continue
		}
		var rec map[string]interface{}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		msg, _ := rec["msg"].(string)
		if msg != "pass.timing" && msg != "db.dump" {
			continue
		}
		pass, _ := rec["pass"].(string)
		if msg == "db.dump" {
			pass = "db.dump"
		}
		if pass == "" {
			continue
		}
		elapsed := parseDuration(rec["elapsed"])
		timings = append(timings, passTiming{Pass: pass, Elapsed: elapsed})
	}
	return timings
}

func parseMemStats(logOutput string) []memSnapshot {
	var snapshots []memSnapshot
	for _, line := range strings.Split(logOutput, "\n") {
		if !strings.Contains(line, "mem.stats") {
			continue
		}
		var rec map[string]interface{}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if msg, _ := rec["msg"].(string); msg != "mem.stats" {
			continue
		}
		stage, _ := rec["stage"].(string)
		hi, _ := rec["heap_inuse_mb"].(float64)
		ha, _ := rec["heap_alloc_mb"].(float64)
		sy, _ := rec["sys_mb"].(float64)
		snapshots = append(snapshots, memSnapshot{
			Stage: stage, HeapInuse: int64(hi), HeapAlloc: int64(ha), Sys: int64(sy),
		})
	}
	return snapshots
}

func parseEdgeCounts(logOutput string) []edgeCount {
	var counts []edgeCount
	for _, line := range strings.Split(logOutput, "\n") {
		if !strings.Contains(line, "pipeline.edges") {
			continue
		}
		var rec map[string]interface{}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if msg, _ := rec["msg"].(string); msg != "pipeline.edges" {
			continue
		}
		ty, _ := rec["type"].(string)
		cnt, _ := rec["count"].(float64)
		if ty != "" {
			counts = append(counts, edgeCount{Type: ty, Count: int64(cnt)})
		}
	}
	return counts
}

func parseDiscovered(logOutput string) int {
	for _, line := range strings.Split(logOutput, "\n") {
		if !strings.Contains(line, "pipeline.discovered") {
			continue
		}
		var rec map[string]interface{}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if msg, _ := rec["msg"].(string); msg == "pipeline.discovered" {
			if f, ok := rec["files"].(float64); ok {
				return int(f)
			}
		}
	}
	return 0
}

func parseDuration(v interface{}) time.Duration {
	switch val := v.(type) {
	case float64:
		// slog encodes Duration as nanoseconds (int64) which JSON decodes as float64
		return time.Duration(int64(val))
	case string:
		// Some slog handlers format as "1.234s"
		d, err := time.ParseDuration(val)
		if err != nil {
			return 0
		}
		return d
	default:
		return 0
	}
}

// TestLinuxKernelIntegrity runs PRAGMA integrity_check on an existing db.
// Set LINUX_DB to the path of a previously-created db file.
//
// Usage:
//
//	LINUX_DB=/path/to/linux.db go test ./internal/pipeline/ -run TestLinuxKernelIntegrity -v -count=1
func TestLinuxKernelIntegrity(t *testing.T) {
	dbPath := os.Getenv("LINUX_DB")
	if dbPath == "" {
		t.Skip("LINUX_DB not set")
	}

	s, err := store.OpenPath(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()

	// Run integrity check via raw SQL
	db := s.DB()
	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q", integrity)
	}

	// Report counts
	rows, err := db.Query("SELECT type, COUNT(*) FROM edges GROUP BY type ORDER BY COUNT(*) DESC")
	if err != nil {
		t.Fatalf("edge counts: %v", err)
	}
	defer rows.Close()
	t.Logf("integrity_check: ok")
	for rows.Next() {
		var ty string
		var cnt int
		if err := rows.Scan(&ty, &cnt); err != nil {
			t.Fatalf("scan row: %v", err)
		}
		t.Logf("  %-25s %d", ty, cnt)
	}

	var nc, ec int
	if err := db.QueryRow("SELECT COUNT(*) FROM nodes").Scan(&nc); err != nil {
		t.Fatalf("count nodes: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM edges").Scan(&ec); err != nil {
		t.Fatalf("count edges: %v", err)
	}
	t.Logf("nodes=%d edges=%d", nc, ec)

	dbInfo, _ := os.Stat(dbPath) //nolint:gosec // G703: dbPath from tmpdir, not user input
	if dbInfo != nil {
		t.Logf("db_size=%.1f MB", float64(dbInfo.Size())/(1<<20))
	}

	// Spot check: verify some indexes work
	var cnt int
	for _, idx := range []string{"idx_nodes_label", "idx_nodes_name", "idx_nodes_file",
		"idx_edges_source", "idx_edges_target", "idx_edges_type"} {
		err := db.QueryRow(fmt.Sprintf("SELECT COUNT(*) FROM %s INDEXED BY %s",
			tableForIndex(idx), idx)).Scan(&cnt)
		if err != nil {
			t.Errorf("index %s: %v", idx, err)
		} else {
			t.Logf("  %s: %d entries", idx, cnt)
		}
	}
}

func tableForIndex(idx string) string {
	if strings.HasPrefix(idx, "idx_nodes_") {
		return "nodes"
	}
	return "edges"
}
