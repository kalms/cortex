package cbm

/*
#include "sqlite_writer.h"
#include <stdlib.h>
#include <string.h>
*/
import "C"
import (
	"fmt"
	"runtime"
	"runtime/debug"
	"unsafe"
)

// DumpNode is the Go-side representation of CBMDumpNode.
type DumpNode struct {
	ID            int64
	Project       string
	Label         string
	Name          string
	QualifiedName string
	FilePath      string
	StartLine     int
	EndLine       int
	Properties    string // JSON
}

// DumpEdge is the Go-side representation of CBMDumpEdge.
type DumpEdge struct {
	ID         int64
	Project    string
	SourceID   int64
	TargetID   int64
	Type       string
	Properties string // JSON
	URLPath    string // pre-extracted from properties
}

// WriteDB constructs a SQLite .db file directly from sorted in-memory data.
// No SQL parser, no INSERTs, no B-tree rebalancing.
func WriteDB(path, project, rootPath, indexedAt string, nodes []DumpNode, edges []DumpEdge) error {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	cProject := C.CString(project)
	defer C.free(unsafe.Pointer(cProject))
	cRootPath := C.CString(rootPath)
	defer C.free(unsafe.Pointer(cRootPath))
	cIndexedAt := C.CString(indexedAt)
	defer C.free(unsafe.Pointer(cIndexedAt))

	// Track all CString allocations for cleanup.
	allStrings := make([]*C.char, 0, len(nodes)*5+len(edges)*3)

	// Allocate node array in C memory (CGo rules: can't pass Go ptrs containing ptrs).
	nodeSize := C.size_t(C.sizeof_CBMDumpNode)
	var cNodes *C.CBMDumpNode
	if len(nodes) > 0 {
		cNodes = (*C.CBMDumpNode)(C.malloc(nodeSize * C.size_t(len(nodes))))
		for i, n := range nodes {
			cN := (*C.CBMDumpNode)(unsafe.Add(unsafe.Pointer(cNodes), uintptr(i)*uintptr(nodeSize)))
			cN.id = C.int64_t(n.ID)
			cN.project = cProject
			cN.label = C.CString(n.Label)
			allStrings = append(allStrings, cN.label)
			cN.name = C.CString(n.Name)
			allStrings = append(allStrings, cN.name)
			cN.qualified_name = C.CString(n.QualifiedName)
			allStrings = append(allStrings, cN.qualified_name)
			cN.file_path = C.CString(n.FilePath)
			allStrings = append(allStrings, cN.file_path)
			cN.start_line = C.int(n.StartLine)
			cN.end_line = C.int(n.EndLine)
			cN.properties = C.CString(n.Properties)
			allStrings = append(allStrings, cN.properties)
		}
	}

	// Allocate edge array in C memory.
	edgeSize := C.size_t(C.sizeof_CBMDumpEdge)
	var cEdges *C.CBMDumpEdge
	if len(edges) > 0 {
		cEdges = (*C.CBMDumpEdge)(C.malloc(edgeSize * C.size_t(len(edges))))
		for i, e := range edges {
			cE := (*C.CBMDumpEdge)(unsafe.Add(unsafe.Pointer(cEdges), uintptr(i)*uintptr(edgeSize)))
			cE.id = C.int64_t(e.ID)
			cE.project = cProject
			cE.source_id = C.int64_t(e.SourceID)
			cE.target_id = C.int64_t(e.TargetID)
			cE._type = C.CString(e.Type)
			allStrings = append(allStrings, cE._type)
			cE.properties = C.CString(e.Properties)
			allStrings = append(allStrings, cE.properties)
			cE.url_path = C.CString(e.URLPath)
			allStrings = append(allStrings, cE.url_path)
		}
	}

	// Save counts before releasing Go slices.
	nodeCount := len(nodes)
	edgeCount := len(edges)

	// Release Go slices — all data is now in C memory.
	// This frees ~1.5GB for Linux kernel-scale indexes.
	nodes = nil //nolint:ineffassign // intentional: release Go heap before C call
	edges = nil //nolint:ineffassign // intentional: release Go heap before C call
	runtime.GC()
	debug.FreeOSMemory()

	rc := C.cbm_write_db(cPath, cProject, cRootPath, cIndexedAt,
		cNodes, C.int(nodeCount),
		cEdges, C.int(edgeCount))

	// Free all C allocations.
	for _, s := range allStrings {
		C.free(unsafe.Pointer(s))
	}
	if cNodes != nil {
		C.free(unsafe.Pointer(cNodes))
	}
	if cEdges != nil {
		C.free(unsafe.Pointer(cEdges))
	}

	if rc != 0 {
		return fmt.Errorf("cbm_write_db returned %d", rc)
	}
	return nil
}
