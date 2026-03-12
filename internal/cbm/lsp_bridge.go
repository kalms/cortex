package cbm

//go:generate go run ../../scripts/gen-go-stdlib.go

/*
#include "lsp/type_rep.h"
#include "lsp/scope.h"
#include "lsp/type_registry.h"
#include "lsp/go_lsp.h"
#include "lsp/c_lsp.h"
*/
import "C"
import (
	"strings"
	"unsafe"
)

// CrossFileDef represents a definition from another file for cross-file LSP resolution.
type CrossFileDef struct {
	QualifiedName string
	ShortName     string
	Label         string // "Function", "Method", "Type", "Interface"
	ReceiverType  string // for methods: receiver type QN
	DefModuleQN   string // module QN where this def lives
	ReturnTypes   string // "|"-separated return type texts (e.g., "*File|error")
	EmbeddedTypes string // "|"-separated embedded type QNs
	FieldDefs     string // "|"-separated "name:type" pairs (for struct fields, e.g. "Binder:Binder|Name:string")
	MethodNames   string // "|"-separated method names for interfaces (e.g. "Get|Put|Delete")
	IsInterface   bool
}

// RunGoLSPCrossFile runs the Go LSP type resolver with cross-file definitions.
// source is the file content, moduleQN is the file's module QN,
// fileDefs are the file's own definitions (converted to CrossFileDef format),
// crossDefs are definitions from imported packages,
// imports are the file's import mappings.
// Returns resolved calls with high confidence.
func RunGoLSPCrossFile(
	source []byte,
	moduleQN string,
	fileDefs []CrossFileDef,
	crossDefs []CrossFileDef,
	imports []Import,
) []ResolvedCall {
	if len(source) == 0 {
		return nil
	}

	Init()

	// Merge file-local and cross-file defs
	allDefs := make([]CrossFileDef, 0, len(fileDefs)+len(crossDefs))
	allDefs = append(allDefs, fileDefs...)
	allDefs = append(allDefs, crossDefs...)

	if len(allDefs) == 0 {
		return nil
	}

	// Allocate arena for C data
	var arena C.CBMArena
	C.cbm_arena_init(&arena)
	defer C.cbm_arena_destroy(&arena)

	// Track C strings for cleanup
	var toFree []unsafe.Pointer
	defer func() {
		for _, p := range toFree {
			C.free(p)
		}
	}()

	cs := func(s string) *C.char {
		if s == "" {
			return nil
		}
		p := C.CString(s)
		toFree = append(toFree, unsafe.Pointer(p))
		return p
	}

	// Build C def array
	nDefs := len(allDefs)
	cDefsPtr := (*C.CBMLSPDef)(C.malloc(C.size_t(nDefs) * C.size_t(unsafe.Sizeof(C.CBMLSPDef{}))))
	if cDefsPtr == nil {
		return nil
	}
	toFree = append(toFree, unsafe.Pointer(cDefsPtr))
	cDefs := unsafe.Slice(cDefsPtr, nDefs)

	for i, d := range allDefs {
		cDefs[i] = C.CBMLSPDef{
			qualified_name:   cs(d.QualifiedName),
			short_name:       cs(d.ShortName),
			label:            cs(d.Label),
			receiver_type:    cs(d.ReceiverType),
			def_module_qn:    cs(d.DefModuleQN),
			return_types:     cs(d.ReturnTypes),
			embedded_types:   cs(d.EmbeddedTypes),
			field_defs:       cs(d.FieldDefs),
			method_names_str: cs(d.MethodNames),
			is_interface:     C.bool(d.IsInterface),
		}
	}

	// Build import arrays
	nImports := len(imports)
	ptrSize := C.size_t(unsafe.Sizeof((*C.char)(nil)))
	cImportNames := (**C.char)(C.malloc(C.size_t(nImports+1) * ptrSize))
	cImportQNs := (**C.char)(C.malloc(C.size_t(nImports+1) * ptrSize))
	toFree = append(toFree, unsafe.Pointer(cImportNames), unsafe.Pointer(cImportQNs))

	importNameSlice := unsafe.Slice(cImportNames, nImports+1)
	importQNSlice := unsafe.Slice(cImportQNs, nImports+1)
	for i, imp := range imports {
		importNameSlice[i] = cs(imp.LocalName)
		importQNSlice[i] = cs(imp.ModulePath)
	}
	importNameSlice[nImports] = nil
	importQNSlice[nImports] = nil

	// Call C function
	cModuleQN := cs(moduleQN)
	cSource := (*C.char)(unsafe.Pointer(&source[0]))

	var outCalls C.CBMResolvedCallArray
	C.cbm_run_go_lsp_cross(
		&arena,
		cSource, C.int(len(source)),
		cModuleQN,
		cDefsPtr, C.int(nDefs),
		cImportNames, cImportQNs, C.int(nImports),
		&outCalls,
	)

	// Convert results to Go
	if outCalls.count == 0 {
		return nil
	}
	result := make([]ResolvedCall, outCalls.count)
	rcs := unsafe.Slice(outCalls.items, outCalls.count)
	for i, rc := range rcs {
		result[i] = ResolvedCall{
			CallerQN:   C.GoString(rc.caller_qn),
			CalleeQN:   C.GoString(rc.callee_qn),
			Strategy:   C.GoString(rc.strategy),
			Confidence: float32(rc.confidence),
			Reason:     goStringOrEmpty(rc.reason),
		}
	}
	return result
}

// DefsToLSPDefs converts file-local Definition slice to CrossFileDef format.
func DefsToLSPDefs(defs []Definition, moduleQN string) []CrossFileDef {
	result := make([]CrossFileDef, 0, len(defs))

	// First pass: collect Field defs grouped by parent class QN → "name:type" pairs
	fieldsByClass := make(map[string][]string)
	for _, d := range defs {
		if d.Label == "Field" && d.ParentClass != "" && d.Name != "" && d.ReturnType != "" {
			fieldsByClass[d.ParentClass] = append(fieldsByClass[d.ParentClass],
				d.Name+":"+d.ReturnType)
		}
	}

	for _, d := range defs {
		if d.QualifiedName == "" || d.Name == "" {
			continue
		}
		switch d.Label {
		case "Function", "Method":
			cd := CrossFileDef{
				QualifiedName: d.QualifiedName,
				ShortName:     d.Name,
				Label:         d.Label,
				DefModuleQN:   moduleQN,
			}
			if len(d.ReturnTypes) > 0 {
				cd.ReturnTypes = strings.Join(d.ReturnTypes, "|")
			} else if d.ReturnType != "" {
				cd.ReturnTypes = d.ReturnType
			}
			if d.Label == "Method" && d.Receiver != "" {
				cd.ReceiverType = extractReceiverTypeQN(d.Receiver, moduleQN)
			}
			result = append(result, cd)

		case "Class", "Type", "Interface":
			cd := CrossFileDef{
				QualifiedName: d.QualifiedName,
				ShortName:     d.Name,
				Label:         d.Label,
				DefModuleQN:   moduleQN,
				IsInterface:   d.Label == "Interface",
			}
			if len(d.BaseClasses) > 0 {
				embeds := make([]string, len(d.BaseClasses))
				for i, bc := range d.BaseClasses {
					bc = strings.TrimLeft(bc, "*")
					embeds[i] = moduleQN + "." + bc
				}
				cd.EmbeddedTypes = strings.Join(embeds, "|")
			}
			// Attach field defs collected from Field-labeled definitions
			if fields, ok := fieldsByClass[d.QualifiedName]; ok {
				cd.FieldDefs = strings.Join(fields, "|")
			}
			result = append(result, cd)
		}
	}
	return result
}

// extractReceiverTypeQN extracts the receiver type QN from Go receiver text.
// E.g., "(r *Router)" -> "moduleQN.Router"
func extractReceiverTypeQN(receiver, moduleQN string) string {
	r := strings.TrimLeft(receiver, "( ")
	// Skip receiver name
	if idx := strings.IndexAny(r, " *"); idx >= 0 {
		r = r[idx:]
	}
	r = strings.TrimLeft(r, " *")
	// Get type name
	end := strings.IndexAny(r, ") ")
	if end > 0 {
		r = r[:end]
	}
	if r == "" {
		return ""
	}
	return moduleQN + "." + r
}

// RunCLSPCrossFile runs the C/C++ LSP type resolver with cross-file definitions.
// source is the file content, moduleQN is the file's module QN,
// cppMode enables C++ features (namespaces, classes, templates, etc.),
// fileDefs are the file's own definitions, crossDefs are from included headers,
// includes are the file's include mappings (header path → namespace QN).
func RunCLSPCrossFile(
	source []byte,
	moduleQN string,
	cppMode bool,
	fileDefs []CrossFileDef,
	crossDefs []CrossFileDef,
	includes []Import,
) []ResolvedCall {
	if len(source) == 0 {
		return nil
	}

	Init()

	allDefs := make([]CrossFileDef, 0, len(fileDefs)+len(crossDefs))
	allDefs = append(allDefs, fileDefs...)
	allDefs = append(allDefs, crossDefs...)

	if len(allDefs) == 0 {
		return nil
	}

	var arena C.CBMArena
	C.cbm_arena_init(&arena)
	defer C.cbm_arena_destroy(&arena)

	var toFree []unsafe.Pointer
	defer func() {
		for _, p := range toFree {
			C.free(p)
		}
	}()

	cs := func(s string) *C.char {
		if s == "" {
			return nil
		}
		p := C.CString(s)
		toFree = append(toFree, unsafe.Pointer(p))
		return p
	}

	// Build C def array
	nDefs := len(allDefs)
	cDefsPtr := (*C.CBMLSPDef)(C.malloc(C.size_t(nDefs) * C.size_t(unsafe.Sizeof(C.CBMLSPDef{}))))
	if cDefsPtr == nil {
		return nil
	}
	toFree = append(toFree, unsafe.Pointer(cDefsPtr))
	cDefs := unsafe.Slice(cDefsPtr, nDefs)

	for i, d := range allDefs {
		cDefs[i] = C.CBMLSPDef{
			qualified_name:   cs(d.QualifiedName),
			short_name:       cs(d.ShortName),
			label:            cs(d.Label),
			receiver_type:    cs(d.ReceiverType),
			def_module_qn:    cs(d.DefModuleQN),
			return_types:     cs(d.ReturnTypes),
			embedded_types:   cs(d.EmbeddedTypes),
			field_defs:       cs(d.FieldDefs),
			method_names_str: cs(d.MethodNames),
			is_interface:     C.bool(d.IsInterface),
		}
	}

	// Build include arrays (header path → namespace QN)
	nIncludes := len(includes)
	ptrSize := C.size_t(unsafe.Sizeof((*C.char)(nil)))
	cIncPaths := (**C.char)(C.malloc(C.size_t(nIncludes+1) * ptrSize))
	cIncQNs := (**C.char)(C.malloc(C.size_t(nIncludes+1) * ptrSize))
	toFree = append(toFree, unsafe.Pointer(cIncPaths), unsafe.Pointer(cIncQNs))

	incPathSlice := unsafe.Slice(cIncPaths, nIncludes+1)
	incQNSlice := unsafe.Slice(cIncQNs, nIncludes+1)
	for i, inc := range includes {
		incPathSlice[i] = cs(inc.LocalName)
		incQNSlice[i] = cs(inc.ModulePath)
	}
	incPathSlice[nIncludes] = nil
	incQNSlice[nIncludes] = nil

	cModuleQN := cs(moduleQN)
	cSource := (*C.char)(unsafe.Pointer(&source[0]))

	var outCalls C.CBMResolvedCallArray
	C.cbm_run_c_lsp_cross(
		&arena,
		cSource, C.int(len(source)),
		cModuleQN,
		C.bool(cppMode),
		cDefsPtr, C.int(nDefs),
		cIncPaths, cIncQNs, C.int(nIncludes),
		&outCalls,
	)

	if outCalls.count == 0 {
		return nil
	}
	result := make([]ResolvedCall, outCalls.count)
	rcs := unsafe.Slice(outCalls.items, outCalls.count)
	for i, rc := range rcs {
		result[i] = ResolvedCall{
			CallerQN:   C.GoString(rc.caller_qn),
			CalleeQN:   C.GoString(rc.callee_qn),
			Strategy:   C.GoString(rc.strategy),
			Confidence: float32(rc.confidence),
			Reason:     goStringOrEmpty(rc.reason),
		}
	}
	return result
}
