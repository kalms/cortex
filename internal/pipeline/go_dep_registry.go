package pipeline

import (
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
)

// goDepCache caches parsed third-party module definitions.
// Keyed by module@version (immutable in Go module cache).
var (
	goDepCacheMu sync.RWMutex
	goDepCache   = make(map[string]map[string][]cbm.CrossFileDef) // module@version -> importPath -> defs
)

// goDepVersions maps Go import path prefix → module@version directory path.
// Built from go.mod + go.sum.
type goDepVersions struct {
	// modDirByPath maps module import path → absolute directory in module cache
	modDirByPath map[string]string
}

// buildGoDepVersions reads go.mod and locates each dependency in the module cache.
func buildGoDepVersions(repoPath string) *goDepVersions {
	data, err := os.ReadFile(filepath.Join(repoPath, "go.mod"))
	if err != nil {
		return nil
	}

	goPath := os.Getenv("GOPATH")
	if goPath == "" {
		home, _ := os.UserHomeDir()
		goPath = filepath.Join(home, "go")
	}
	modCacheBase := filepath.Join(goPath, "pkg", "mod")

	dv := &goDepVersions{
		modDirByPath: make(map[string]string),
	}

	// Parse go.mod for require directives
	inRequire := false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "require (" {
			inRequire = true
			continue
		}
		if line == ")" {
			inRequire = false
			continue
		}
		if strings.HasPrefix(line, "require ") {
			// Single-line require
			line = strings.TrimPrefix(line, "require ")
		} else if !inRequire {
			continue
		}

		// Parse "module/path v1.2.3 // indirect"
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		modPath := parts[0]
		version := parts[1]

		// Module cache uses escaped paths (uppercase letters → !lowercase)
		escaped := escapeModPath(modPath)
		modDir := filepath.Join(modCacheBase, escaped+"@"+version)

		if info, err := os.Stat(modDir); err == nil && info.IsDir() { //nolint:gosec // path from trusted go.mod + GOPATH
			dv.modDirByPath[modPath] = modDir
		}
	}

	return dv
}

// escapeModPath applies Go module cache path escaping.
// Uppercase letters are replaced with !lowercase.
func escapeModPath(path string) string {
	var b strings.Builder
	for _, c := range path {
		if c >= 'A' && c <= 'Z' {
			b.WriteByte('!')
			b.WriteRune(c + 32)
		} else {
			b.WriteRune(c)
		}
	}
	return b.String()
}

// resolveModDir returns the module cache directory for a Go import path.
// Handles subpackage paths by finding the longest matching module prefix.
func (dv *goDepVersions) resolveModDir(importPath string) (modPath, modDir, subPkg string) {
	if dv == nil {
		return "", "", ""
	}
	// Try exact match first, then progressively shorter prefixes
	path := importPath
	for path != "" {
		if dir, ok := dv.modDirByPath[path]; ok {
			sub := strings.TrimPrefix(importPath, path)
			sub = strings.TrimPrefix(sub, "/")
			return path, dir, sub
		}
		idx := strings.LastIndex(path, "/")
		if idx < 0 {
			break
		}
		path = path[:idx]
	}
	return "", "", ""
}

// parseThirdPartyPackage parses a third-party Go package directory and extracts definitions.
func parseThirdPartyPackage(modPath, modDir, subPkg string) []cbm.CrossFileDef {
	pkgDir := modDir
	if subPkg != "" {
		pkgDir = filepath.Join(modDir, subPkg)
	}

	// The import path for this specific package
	importPath := modPath
	if subPkg != "" {
		importPath = modPath + "/" + subPkg
	}

	// Check cache
	cacheKey := modDir // module@version dir is unique and immutable
	goDepCacheMu.RLock()
	if cached, ok := goDepCache[cacheKey]; ok {
		if defs, ok := cached[importPath]; ok {
			goDepCacheMu.RUnlock()
			return defs
		}
	}
	goDepCacheMu.RUnlock()

	// Parse Go files in the package directory
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, pkgDir, func(fi os.FileInfo) bool { //nolint:staticcheck // SA1019: go/packages is heavyweight; ParseDir suffices for extracting exported names from module cache
		name := fi.Name()
		// Skip test files and non-Go files
		return strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go")
	}, 0) // no comments needed
	if err != nil {
		return nil
	}

	var defs []cbm.CrossFileDef
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			defs = append(defs, extractDefsFromAST(file, importPath)...)
		}
	}

	// Cache the result
	goDepCacheMu.Lock()
	if goDepCache[cacheKey] == nil {
		goDepCache[cacheKey] = make(map[string][]cbm.CrossFileDef)
	}
	goDepCache[cacheKey][importPath] = defs
	goDepCacheMu.Unlock()

	return defs
}

// extractDefsFromAST extracts exported function/method/type definitions from an AST file.
func extractDefsFromAST(file *ast.File, importPath string) []cbm.CrossFileDef {
	var defs []cbm.CrossFileDef

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if cd, ok := extractFuncDef(d, importPath); ok {
				defs = append(defs, cd)
			}
		case *ast.GenDecl:
			defs = append(defs, extractTypeDefs(d, importPath)...)
		}
	}

	return defs
}

// extractFuncDef extracts a single exported function/method definition from a FuncDecl.
func extractFuncDef(d *ast.FuncDecl, importPath string) (cbm.CrossFileDef, bool) {
	if !d.Name.IsExported() {
		return cbm.CrossFileDef{}, false
	}

	cd := cbm.CrossFileDef{
		ShortName:   d.Name.Name,
		DefModuleQN: importPath,
	}

	// Return types
	if d.Type.Results != nil && len(d.Type.Results.List) > 0 {
		retTypes := make([]string, 0, len(d.Type.Results.List))
		for _, field := range d.Type.Results.List {
			retTypes = append(retTypes, typeExprToString(field.Type))
		}
		cd.ReturnTypes = strings.Join(retTypes, "|")
	}

	if d.Recv != nil && len(d.Recv.List) > 0 {
		cd.Label = "Method"
		recvType := typeExprToString(d.Recv.List[0].Type)
		recvType = strings.TrimPrefix(recvType, "*")
		cd.ReceiverType = importPath + "." + recvType
		cd.QualifiedName = importPath + "." + recvType + "." + d.Name.Name
	} else {
		cd.Label = "Function"
		cd.QualifiedName = importPath + "." + d.Name.Name
	}

	return cd, true
}

// extractTypeDefs extracts exported type definitions from a GenDecl.
func extractTypeDefs(d *ast.GenDecl, importPath string) []cbm.CrossFileDef {
	if d.Tok != token.TYPE {
		return nil
	}
	var defs []cbm.CrossFileDef
	for _, spec := range d.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok || !ts.Name.IsExported() {
			continue
		}

		cd := cbm.CrossFileDef{
			QualifiedName: importPath + "." + ts.Name.Name,
			ShortName:     ts.Name.Name,
			DefModuleQN:   importPath,
		}

		switch t := ts.Type.(type) {
		case *ast.InterfaceType:
			cd.Label = "Interface"
			cd.IsInterface = true
		case *ast.StructType:
			cd.Label = "Type"
			cd.EmbeddedTypes = extractStructEmbeds(t, importPath)
		default:
			cd.Label = "Type"
		}

		defs = append(defs, cd)
	}
	return defs
}

// extractStructEmbeds extracts embedded type names from a struct type.
func extractStructEmbeds(st *ast.StructType, importPath string) string {
	if st.Fields == nil {
		return ""
	}
	var embeds []string
	for _, field := range st.Fields.List {
		if len(field.Names) == 0 {
			embed := typeExprToString(field.Type)
			embed = strings.TrimPrefix(embed, "*")
			embeds = append(embeds, importPath+"."+embed)
		}
	}
	if len(embeds) > 0 {
		return strings.Join(embeds, "|")
	}
	return ""
}

// typeExprToString converts an ast.Expr representing a type to its string form.
func typeExprToString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + typeExprToString(t.X)
	case *ast.ArrayType:
		if t.Len == nil {
			return "[]" + typeExprToString(t.Elt)
		}
		return "[...]" + typeExprToString(t.Elt)
	case *ast.SelectorExpr:
		return typeExprToString(t.X) + "." + t.Sel.Name
	case *ast.MapType:
		return "map[" + typeExprToString(t.Key) + "]" + typeExprToString(t.Value)
	case *ast.ChanType:
		return "chan " + typeExprToString(t.Value)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.FuncType:
		return "func()"
	case *ast.Ellipsis:
		return "..." + typeExprToString(t.Elt)
	default:
		return "any"
	}
}

// integrateThirdPartyDeps extends buildGoLSPDefIndex to also parse third-party deps.
// Called during pipeline setup, populates the index with dep definitions.
func (idx *goLSPDefIndex) integrateThirdPartyDeps(repoPath string, importMaps map[string]map[string]string) {
	if idx == nil {
		return
	}

	dv := buildGoDepVersions(repoPath)
	if dv == nil || len(dv.modDirByPath) == 0 {
		return
	}

	// Collect all unique third-party import paths from all files
	needed := make(map[string]bool)
	for _, importMap := range importMaps {
		for _, goImportPath := range importMap {
			if _, exists := idx.byImportPath[goImportPath]; !exists {
				needed[goImportPath] = true
			}
		}
	}

	parsedCount := 0
	defCount := 0
	for importPath := range needed {
		modPath, modDir, subPkg := dv.resolveModDir(importPath)
		if modDir == "" {
			continue
		}

		defs := parseThirdPartyPackage(modPath, modDir, subPkg)
		if len(defs) > 0 {
			idx.byImportPath[importPath] = defs
			defCount += len(defs)
			parsedCount++
		}
	}

	if parsedCount > 0 {
		slog.Info("go_lsp.third_party.index",
			"packages", parsedCount,
			"defs", defCount,
		)
	}
}
