package cbm

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	_ "github.com/mattn/go-sqlite3"
)

func TestWriteDB_MultiPage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	N := 192
	nodes := make([]DumpNode, N)
	for i := range nodes {
		nodes[i] = DumpNode{
			ID: int64(i + 1), Project: "p", Label: "Function",
			Name: fmt.Sprintf("f%04d", i), QualifiedName: fmt.Sprintf("p.f%04d", i),
			FilePath: fmt.Sprintf("pkg%d/file.go", i%10), StartLine: i, EndLine: i + 1, Properties: "{}",
		}
	}
	// Also save to /tmp for sqlite3 inspection
	fixedPath := "/tmp/cbm_debug.db"
	_ = WriteDB(fixedPath, "p", "/r", "2026-01-01T00:00:00Z", nodes, nil)
	t.Logf("saved copy to %s", fixedPath)
	if err := WriteDB(path, "p", "/r", "2026-01-01T00:00:00Z", nodes, nil); err != nil {
		t.Fatalf("WriteDB: %v", err)
	}
	db, _ := sql.Open("sqlite3", path)
	defer db.Close()
	
	// Dump all rowids
	rows, _ := db.Query("SELECT rowid FROM nodes ORDER BY rowid")
	var rowids []int64
	for rows.Next() {
		var r int64; rows.Scan(&r); rowids = append(rowids, r)
	}
	rows.Close()
	t.Logf("rowids count: %d", len(rowids))
	
	// Find gaps or duplicates
	seen := map[int64]int{}
	for _, r := range rowids {
		seen[r]++
	}
	for r, c := range seen {
		if c > 1 {
			t.Logf("duplicate rowid %d (count %d)", r, c)
		}
	}
	// Find unexpected rowids
	for _, r := range rowids {
		if r < 1 || r > int64(N) {
			t.Logf("unexpected rowid: %d", r)
		}
	}
	
	// Compare with COUNT(*)
	var countStar int
	db.QueryRow("SELECT COUNT(*) FROM nodes").Scan(&countStar)
	t.Logf("COUNT(*) = %d, len(rowids) = %d", countStar, len(rowids))

	// Try reading the last few rows by rowid
	for _, rid := range []int64{190, 191, 192, 193, 194} {
		var id int64; var name string
		err := db.QueryRow("SELECT id, name FROM nodes WHERE rowid = ?", rid).Scan(&id, &name)
		if err != nil {
			t.Logf("rowid %d: %v", rid, err)
		} else {
			t.Logf("rowid %d: id=%d name=%q", rid, id, name)
		}
	}

	// Read raw page bytes and check nodes root page from sqlite_master
	var nodesRoot int
	db.QueryRow("SELECT rootpage FROM sqlite_master WHERE name='nodes'").Scan(&nodesRoot)
	t.Logf("nodes root page: %d", nodesRoot)

	// Integrity check
	var integrity string
	db.QueryRow("PRAGMA integrity_check").Scan(&integrity)
	t.Logf("integrity_check: %s", integrity)

	// Check which plan COUNT(*) uses
	planRows, _ := db.Query("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM nodes")
	for planRows.Next() {
		var id, parent, notused int
		var detail string
		planRows.Scan(&id, &parent, &notused, &detail)
		t.Logf("PLAN: %s", detail)
	}
	planRows.Close()

	// Count entries per index
	var cnt int
	for _, idx := range []string{"idx_nodes_label", "idx_nodes_name", "idx_nodes_file"} {
		db.QueryRow("SELECT COUNT(*) FROM nodes INDEXED BY " + idx).Scan(&cnt)
		t.Logf("%s count: %d", idx, cnt)
	}

	// Dump sqlite_master
	masterRows, _ := db.Query("SELECT rowid, type, name, rootpage, length(sql) FROM sqlite_master ORDER BY rowid")
	for masterRows.Next() {
		var rid, rootpage int
		var typ, name string
		var sqlLen sql.NullInt64
		masterRows.Scan(&rid, &typ, &name, &rootpage, &sqlLen)
		t.Logf("master[%d]: type=%s name=%s rootpage=%d sql_len=%v", rid, typ, name, rootpage, sqlLen)
	}
	masterRows.Close()

	// Also try NOT INDEXED count
	var cntNoIdx int
	db.QueryRow("SELECT COUNT(*) FROM nodes NOT INDEXED").Scan(&cntNoIdx)
	t.Logf("COUNT(*) NOT INDEXED = %d", cntNoIdx)

	// Raw page inspection — ALL pages
	raw, _ := os.ReadFile(path)
	pageSize := 4096
	totalPages := len(raw) / pageSize
	t.Logf("total pages in file: %d", totalPages)
	for pn := 1; pn <= totalPages; pn++ {
		off := (pn - 1) * pageSize
		if off+12 > len(raw) { continue }
		pg := raw[off:off+pageSize]
		hdr := 0
		if pn == 1 { hdr = 100 }
		flag := pg[hdr]
		cellCount := int(pg[hdr+3])<<8 | int(pg[hdr+4])
		contentOff := int(pg[hdr+5])<<8 | int(pg[hdr+6])
		flagName := "unknown"
		switch flag {
		case 0x0D: flagName = "leaf_table"
		case 0x05: flagName = "interior_table"
		case 0x0A: flagName = "leaf_index"
		case 0x02: flagName = "interior_index"
		}
		if cellCount > 0 || flag == 0x05 || flag == 0x02 {
			t.Logf("Page %d: %s(0x%02x) cells=%d content_off=%d", pn, flagName, flag, cellCount, contentOff)
		}
		if flag == 0x05 || flag == 0x02 {
			rc := int(pg[hdr+8])<<24 | int(pg[hdr+9])<<16 | int(pg[hdr+10])<<8 | int(pg[hdr+11])
			t.Logf("  right_child=%d", rc)
		}
	}
}
