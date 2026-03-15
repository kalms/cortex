package cbm

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestWriteDB_MinimalData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")

	nodes := []DumpNode{
		{ID: 1, Project: "test", Label: "Module", Name: "main", QualifiedName: "test.main", FilePath: "main.go", StartLine: 1, EndLine: 10, Properties: "{}"},
		{ID: 2, Project: "test", Label: "Function", Name: "hello", QualifiedName: "test.main.hello", FilePath: "main.go", StartLine: 3, EndLine: 5, Properties: "{}"},
	}
	edges := []DumpEdge{
		{ID: 1, Project: "test", SourceID: 1, TargetID: 2, Type: "DEFINES", Properties: "{}", URLPath: ""},
	}

	err := WriteDB(path, "test", "/tmp/test", "2026-03-14T00:00:00Z", nodes, edges)
	if err != nil {
		t.Fatalf("WriteDB: %v", err)
	}

	// Verify file exists
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() == 0 {
		t.Fatal("db file is empty")
	}
	t.Logf("db size: %d bytes", info.Size())

	// Open with SQLite and run integrity check
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q, want 'ok'", integrity)
	}

	// Verify nodes
	var nodeCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM nodes").Scan(&nodeCount); err != nil {
		t.Fatalf("count nodes: %v", err)
	}
	if nodeCount != 2 {
		t.Errorf("node count = %d, want 2", nodeCount)
	}

	// Verify edges
	var edgeCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM edges").Scan(&edgeCount); err != nil {
		t.Fatalf("count edges: %v", err)
	}
	if edgeCount != 1 {
		t.Errorf("edge count = %d, want 1", edgeCount)
	}

	// Verify project
	var projName, rootPath string
	if err := db.QueryRow("SELECT name, root_path FROM projects").Scan(&projName, &rootPath); err != nil {
		t.Fatalf("query project: %v", err)
	}
	if projName != "test" || rootPath != "/tmp/test" {
		t.Errorf("project = (%q, %q), want ('test', '/tmp/test')", projName, rootPath)
	}

	// Verify node content
	var qn, label string
	if err := db.QueryRow("SELECT qualified_name, label FROM nodes WHERE id=2").Scan(&qn, &label); err != nil {
		t.Fatalf("query node: %v", err)
	}
	if qn != "test.main.hello" || label != "Function" {
		t.Errorf("node 2 = (%q, %q), want ('test.main.hello', 'Function')", qn, label)
	}

	// Verify edge content
	var srcID, tgtID int64
	var edgeType string
	if err := db.QueryRow("SELECT source_id, target_id, type FROM edges WHERE id=1").Scan(&srcID, &tgtID, &edgeType); err != nil {
		t.Fatalf("query edge: %v", err)
	}
	if srcID != 1 || tgtID != 2 || edgeType != "DEFINES" {
		t.Errorf("edge 1 = (%d, %d, %q), want (1, 2, 'DEFINES')", srcID, tgtID, edgeType)
	}
}

func TestWriteDB_ScaleAndIndexes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "scale.db")

	// 100 nodes across multiple files/labels, 200 edges with varied types
	nodes := make([]DumpNode, 100)
	labels := []string{"Function", "Method", "Class", "Module", "Variable"}
	files := []string{"alpha.go", "beta.go", "gamma.py", "delta.ts", "epsilon.rs"}
	for i := range nodes {
		nodes[i] = DumpNode{
			ID:            int64(i + 1),
			Project:       "proj",
			Label:         labels[i%len(labels)],
			Name:          fmt.Sprintf("sym_%03d", i),
			QualifiedName: fmt.Sprintf("proj.pkg.sym_%03d", i),
			FilePath:      files[i%len(files)],
			StartLine:     i*10 + 1,
			EndLine:       i*10 + 9,
			Properties:    "{}",
		}
	}

	// Build unique (source, target, type) edges
	edgeTypes := []string{"CALLS", "DEFINES", "IMPORTS", "IMPLEMENTS", "USES"}
	type edgeKey struct{ s, t int64; ty string }
	seen := map[edgeKey]bool{}
	var edges []DumpEdge
	edgeID := int64(1)
	for i := 0; len(edges) < 200 && i < 10000; i++ {
		src := int64(i%100) + 1
		tgt := int64((i*7+3)%100) + 1
		if tgt == src {
			tgt = (tgt%100) + 1
		}
		ty := edgeTypes[i%len(edgeTypes)]
		key := edgeKey{src, tgt, ty}
		if seen[key] {
			continue
		}
		seen[key] = true
		urlPath := ""
		props := fmt.Sprintf(`{"weight":%d}`, i)
		if len(edges)%20 == 0 {
			urlPath = fmt.Sprintf("/api/v1/resource/%d", len(edges))
			props = fmt.Sprintf(`{"weight":%d,"url_path":"%s"}`, i, urlPath)
		}
		edges = append(edges, DumpEdge{
			ID:         edgeID,
			Project:    "proj",
			SourceID:   src,
			TargetID:   tgt,
			Type:       ty,
			Properties: props,
			URLPath:    urlPath,
		})
		edgeID++
	}
	edgeCount := len(edges)

	if err := WriteDB(path, "proj", "/repo", "2026-03-14T12:00:00Z", nodes, edges); err != nil {
		t.Fatalf("WriteDB: %v", err)
	}

	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	// Integrity check
	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q, want 'ok'", integrity)
	}

	// Row counts
	var nc, ec int
	db.QueryRow("SELECT COUNT(*) FROM nodes").Scan(&nc)
	db.QueryRow("SELECT COUNT(*) FROM edges").Scan(&ec)
	if nc != 100 {
		t.Errorf("nodes = %d, want 100", nc)
	}
	if ec != edgeCount {
		t.Errorf("edges = %d, want %d", ec, edgeCount)
	}

	// Index queries (exercise each index)
	var cnt int
	db.QueryRow("SELECT COUNT(*) FROM nodes WHERE project='proj' AND label='Function'").Scan(&cnt)
	if cnt != 20 {
		t.Errorf("label=Function count = %d, want 20", cnt)
	}

	db.QueryRow("SELECT COUNT(*) FROM nodes WHERE project='proj' AND name='sym_042'").Scan(&cnt)
	if cnt != 1 {
		t.Errorf("name=sym_042 count = %d, want 1", cnt)
	}

	db.QueryRow("SELECT COUNT(*) FROM nodes WHERE project='proj' AND file_path='alpha.go'").Scan(&cnt)
	if cnt != 20 {
		t.Errorf("file=alpha.go count = %d, want 20", cnt)
	}

	db.QueryRow("SELECT COUNT(*) FROM edges WHERE source_id=1 AND type='CALLS'").Scan(&cnt)
	if cnt == 0 {
		// At least some edges should match
	}

	db.QueryRow("SELECT COUNT(*) FROM edges WHERE project='proj' AND type='DEFINES'").Scan(&cnt)
	if cnt == 0 {
		t.Errorf("type=DEFINES count = 0, expected some")
	}

	// url_path_gen generated column
	db.QueryRow("SELECT COUNT(*) FROM edges WHERE project='proj' AND url_path_gen IS NOT NULL").Scan(&cnt)
	if cnt == 0 {
		t.Errorf("url_path non-null count = 0, expected some")
	}

	// Unique constraint: verify qualified_name lookup
	var nid int64
	if err := db.QueryRow("SELECT id FROM nodes WHERE project='proj' AND qualified_name='proj.pkg.sym_050'").Scan(&nid); err != nil {
		t.Fatalf("qn lookup: %v", err)
	}
	if nid != 51 {
		t.Errorf("qn lookup id = %d, want 51", nid)
	}

	t.Logf("scale test passed: %d nodes, %d edges", nc, ec)
}

func TestWriteDB_Empty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.db")

	err := WriteDB(path, "test", "/tmp/test", "2026-03-14T00:00:00Z", nil, nil)
	if err != nil {
		t.Fatalf("WriteDB empty: %v", err)
	}

	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q, want 'ok'", integrity)
	}
}
