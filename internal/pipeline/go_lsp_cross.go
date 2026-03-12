package pipeline

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// goLSPDefIndex indexes cross-file definitions by Go import path for LSP resolution.
type goLSPDefIndex struct {
	// byImportPath maps Go import path → []CrossFileDef
	byImportPath map[string][]cbm.CrossFileDef
	// goModulePath is the Go module path from go.mod (e.g., "github.com/DeusData/...")
	goModulePath string
}

// buildGoLSPDefIndex builds the cross-file definition index for Go LSP resolution.
// Called once before pass3 (passCalls). Scans all Go files in extractionCache.
func (p *Pipeline) buildGoLSPDefIndex() *goLSPDefIndex {
	goModPath := readGoModulePath(p.RepoPath)
	if goModPath == "" {
		return nil
	}

	idx := &goLSPDefIndex{
		byImportPath: make(map[string][]cbm.CrossFileDef),
		goModulePath: goModPath,
	}

	for relPath, ext := range p.extractionCache {
		if ext.Language != lang.Go {
			continue
		}
		if ext.Result == nil || len(ext.Result.Definitions) == 0 {
			continue
		}

		// Compute Go import path for this file's package
		dir := filepath.Dir(relPath)
		var importPath string
		if dir == "." || dir == "" {
			importPath = goModPath
		} else {
			importPath = goModPath + "/" + filepath.ToSlash(dir)
		}

		moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
		defs := cbm.DefsToLSPDefs(ext.Result.Definitions, moduleQN)

		// Enrich struct types with field definitions and interfaces with method names from Go source
		if len(defs) > 0 {
			enrichStructFieldDefs(p.RepoPath, relPath, defs)
			enrichInterfaceMethodNames(p.RepoPath, relPath, defs)
			idx.byImportPath[importPath] = append(idx.byImportPath[importPath], defs...)
		}
	}

	totalDefs := 0
	for _, defs := range idx.byImportPath {
		totalDefs += len(defs)
	}
	if totalDefs > 0 {
		slog.Info("go_lsp.cross_file.index",
			"packages", len(idx.byImportPath),
			"defs", totalDefs,
		)
	}

	return idx
}

// collectCrossFileDefs returns cross-file definitions for all imported packages.
func (idx *goLSPDefIndex) collectCrossFileDefs(importMap map[string]string) []cbm.CrossFileDef {
	if idx == nil || len(importMap) == 0 {
		return nil
	}

	var result []cbm.CrossFileDef
	seen := make(map[string]bool)

	for _, goImportPath := range importMap {
		if seen[goImportPath] {
			continue
		}
		seen[goImportPath] = true

		// Check if this import path matches a project package
		if defs, ok := idx.byImportPath[goImportPath]; ok {
			// Rewrite QNs: the C resolver will look up "importPath.TypeName",
			// so cross-file defs need their QN prefixed with the Go import path.
			for i := range defs {
				cd := defs[i]
				cd.QualifiedName = requalifyForImport(defs[i].QualifiedName, defs[i].DefModuleQN, goImportPath)
				cd.DefModuleQN = goImportPath
				if cd.ReceiverType != "" {
					cd.ReceiverType = requalifyForImport(defs[i].ReceiverType, defs[i].DefModuleQN, goImportPath)
				}
				// Requalify embedded types
				if cd.EmbeddedTypes != "" {
					parts := strings.Split(cd.EmbeddedTypes, "|")
					for j, part := range parts {
						parts[j] = requalifyForImport(part, defs[i].DefModuleQN, goImportPath)
					}
					cd.EmbeddedTypes = strings.Join(parts, "|")
				}
				result = append(result, cd)
			}
		}
	}

	return result
}

// requalifyForImport replaces the module QN prefix in a qualified name with
// the Go import path prefix so the C resolver can match it via import map lookup.
// E.g., "proj.internal-store-store.go.Store" → "github.com/.../internal/store.Store"
func requalifyForImport(qn, moduleQN, goImportPath string) string {
	if moduleQN == "" || !strings.HasPrefix(qn, moduleQN) {
		return qn
	}
	suffix := qn[len(moduleQN):]
	return goImportPath + suffix
}

// enrichStructFieldDefs parses Go source to extract struct field name:type pairs.
// Populates FieldDefs on Type/Class CrossFileDef entries.
func enrichStructFieldDefs(repoPath, relPath string, defs []cbm.CrossFileDef) {
	// Collect struct type names that need field info
	structNames := make(map[string]int) // shortName -> index in defs
	for i := range defs {
		d := &defs[i]
		if (d.Label == "Type" || d.Label == "Class") && !d.IsInterface {
			structNames[d.ShortName] = i
		}
	}
	if len(structNames) == 0 {
		return
	}

	src, err := os.ReadFile(filepath.Join(repoPath, relPath))
	if err != nil {
		return
	}

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, relPath, src, 0)
	if err != nil {
		return
	}

	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		enrichStructFieldsFromGenDecl(gd, structNames, defs)
	}
}

// enrichStructFieldsFromGenDecl processes a single GenDecl to extract struct field definitions.
func enrichStructFieldsFromGenDecl(gd *ast.GenDecl, structNames map[string]int, defs []cbm.CrossFileDef) {
	for _, spec := range gd.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok {
			continue
		}
		idx, found := structNames[ts.Name.Name]
		if !found {
			continue
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			continue
		}
		if fields := extractExportedStructFields(st); len(fields) > 0 {
			defs[idx].FieldDefs = strings.Join(fields, "|")
		}
	}
}

// extractExportedStructFields returns exported field name:type pairs from a struct.
func extractExportedStructFields(st *ast.StructType) []string {
	var fields []string
	for _, field := range st.Fields.List {
		if len(field.Names) == 0 {
			continue // embedded field, skip
		}
		typeText := goTypeToString(field.Type)
		if typeText == "" {
			continue
		}
		for _, name := range field.Names {
			if !name.IsExported() {
				continue
			}
			fields = append(fields, name.Name+":"+typeText)
		}
	}
	return fields
}

// goTypeToString converts a Go AST type expression to a string representation
// suitable for the LSP type resolver (e.g., "*Echo", "Binder", "[]string").
func goTypeToString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		inner := goTypeToString(t.X)
		if inner == "" {
			return ""
		}
		return "*" + inner
	case *ast.ArrayType:
		elem := goTypeToString(t.Elt)
		if elem == "" {
			return ""
		}
		return "[]" + elem
	case *ast.SelectorExpr:
		pkg := goTypeToString(t.X)
		if pkg == "" {
			return ""
		}
		return pkg + "." + t.Sel.Name
	case *ast.MapType:
		k := goTypeToString(t.Key)
		v := goTypeToString(t.Value)
		if k == "" || v == "" {
			return ""
		}
		return fmt.Sprintf("map[%s]%s", k, v)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.FuncType:
		return "func"
	default:
		return ""
	}
}

// enrichInterfaceMethodNames parses Go source to extract interface method names.
// Populates MethodNames on Interface CrossFileDef entries as "|"-separated strings.
func enrichInterfaceMethodNames(repoPath, relPath string, defs []cbm.CrossFileDef) {
	ifaceNames := make(map[string]int) // shortName -> index in defs
	for i := range defs {
		d := &defs[i]
		if d.IsInterface || d.Label == "Interface" {
			ifaceNames[d.ShortName] = i
		}
	}
	if len(ifaceNames) == 0 {
		return
	}

	src, err := os.ReadFile(filepath.Join(repoPath, relPath))
	if err != nil {
		return
	}

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, relPath, src, 0)
	if err != nil {
		return
	}

	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		enrichIfaceMethodsFromGenDecl(gd, ifaceNames, defs)
	}
}

// enrichIfaceMethodsFromGenDecl processes a single GenDecl to extract interface method names.
func enrichIfaceMethodsFromGenDecl(gd *ast.GenDecl, ifaceNames map[string]int, defs []cbm.CrossFileDef) {
	for _, spec := range gd.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok {
			continue
		}
		idx, found := ifaceNames[ts.Name.Name]
		if !found {
			continue
		}
		iface, ok := ts.Type.(*ast.InterfaceType)
		if !ok {
			continue
		}
		if methods := extractExportedIfaceMethods(iface); len(methods) > 0 {
			defs[idx].MethodNames = strings.Join(methods, "|")
		}
	}
}

// extractExportedIfaceMethods returns exported method names from an interface type.
func extractExportedIfaceMethods(iface *ast.InterfaceType) []string {
	if iface.Methods == nil {
		return nil
	}
	var methods []string
	for _, m := range iface.Methods.List {
		for _, name := range m.Names {
			if name.IsExported() {
				methods = append(methods, name.Name)
			}
		}
	}
	return methods
}

// readGoModulePath reads the module path from go.mod in the given directory.
func readGoModulePath(repoPath string) string {
	data, err := os.ReadFile(filepath.Join(repoPath, "go.mod"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "module ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "module "))
		}
	}
	return ""
}

// readFileSource reads a file's source content from the repo.
func readFileSource(repoPath, relPath string) []byte {
	data, err := os.ReadFile(filepath.Join(repoPath, relPath))
	if err != nil {
		return nil
	}
	return data
}
