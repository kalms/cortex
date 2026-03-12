// gen-go-stdlib.go generates C source data for Go stdlib type information.
// It parses GOROOT/src/ packages and emits static arrays that can be compiled
// into the codebase-memory-mcp binary, providing stdlib type information
// without requiring a Go toolchain at indexing time.
//
// Usage: go run scripts/gen-go-stdlib.go > internal/cbm/lsp/generated/go_stdlib_data.c
//
//go:build ignore

package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Packages to include (top-level stdlib packages used most commonly).
var targetPackages = []string{
	"bufio", "bytes", "context", "crypto", "database/sql",
	"encoding", "encoding/json", "encoding/xml", "errors",
	"fmt", "hash", "io", "io/fs", "log", "log/slog",
	"math", "mime", "net", "net/http", "net/url",
	"os", "os/exec", "path", "path/filepath", "regexp",
	"sort", "strconv", "strings", "sync", "sync/atomic",
	"testing", "text/template", "time", "unicode",
}

type funcInfo struct {
	Name       string
	PkgPath    string
	Receiver   string // empty for functions, "TypeName" for methods
	ParamTypes []string
	ReturnTypes []string
}

type typeInfo struct {
	Name      string
	PkgPath   string
	Fields    []fieldInfo
	Methods   []string // method names
	IsInterface bool
}

type fieldInfo struct {
	Name string
	Type string
}

func main() {
	goroot := runtime.GOROOT()
	if goroot == "" {
		fmt.Fprintf(os.Stderr, "GOROOT not set\n")
		os.Exit(1)
	}

	var allFuncs []funcInfo
	var allTypes []typeInfo

	for _, pkg := range targetPackages {
		pkgDir := filepath.Join(goroot, "src", pkg)
		fset := token.NewFileSet()
		pkgs, err := parser.ParseDir(fset, pkgDir, func(fi os.FileInfo) bool {
			return !strings.HasSuffix(fi.Name(), "_test.go")
		}, 0)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip %s: %v\n", pkg, err)
			continue
		}

		for _, p := range pkgs {
			funcs, types := extractPackage(pkg, p)
			allFuncs = append(allFuncs, funcs...)
			allTypes = append(allTypes, types...)
		}
	}

	// Sort for deterministic output
	sort.Slice(allFuncs, func(i, j int) bool {
		return allFuncs[i].PkgPath+"."+allFuncs[i].Name < allFuncs[j].PkgPath+"."+allFuncs[j].Name
	})
	sort.Slice(allTypes, func(i, j int) bool {
		return allTypes[i].PkgPath+"."+allTypes[i].Name < allTypes[j].PkgPath+"."+allTypes[j].Name
	})

	emitC(allFuncs, allTypes)
}

func extractPackage(pkgPath string, pkg *ast.Package) ([]funcInfo, []typeInfo) {
	var funcs []funcInfo
	var types []typeInfo
	methodsByType := make(map[string][]string)

	for _, f := range pkg.Files {
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if !d.Name.IsExported() {
					continue
				}
				fi := funcInfo{
					Name:    d.Name.Name,
					PkgPath: pkgPath,
				}
				if d.Recv != nil && len(d.Recv.List) > 0 {
					fi.Receiver = typeExprToString(d.Recv.List[0].Type)
					methodsByType[fi.Receiver] = append(methodsByType[fi.Receiver], fi.Name)
				}
				if d.Type.Params != nil {
					for _, p := range d.Type.Params.List {
						typeStr := typeExprToString(p.Type)
						n := len(p.Names)
						if n == 0 { n = 1 }
						for range n {
							fi.ParamTypes = append(fi.ParamTypes, typeStr)
						}
					}
				}
				if d.Type.Results != nil {
					for _, r := range d.Type.Results.List {
						typeStr := typeExprToString(r.Type)
						n := len(r.Names)
						if n == 0 { n = 1 }
						for range n {
							fi.ReturnTypes = append(fi.ReturnTypes, typeStr)
						}
					}
				}
				funcs = append(funcs, fi)

			case *ast.GenDecl:
				if d.Tok != token.TYPE {
					continue
				}
				for _, spec := range d.Specs {
					ts := spec.(*ast.TypeSpec)
					if !ts.Name.IsExported() {
						continue
					}
					ti := typeInfo{
						Name:    ts.Name.Name,
						PkgPath: pkgPath,
					}
					switch t := ts.Type.(type) {
					case *ast.StructType:
						if t.Fields != nil {
							for _, f := range t.Fields.List {
								typeStr := typeExprToString(f.Type)
								if len(f.Names) == 0 {
									// Embedded field
									ti.Fields = append(ti.Fields, fieldInfo{Name: typeStr, Type: typeStr})
								} else {
									for _, name := range f.Names {
										if name.IsExported() {
											ti.Fields = append(ti.Fields, fieldInfo{Name: name.Name, Type: typeStr})
										}
									}
								}
							}
						}
					case *ast.InterfaceType:
						ti.IsInterface = true
						if t.Methods != nil {
							for _, m := range t.Methods.List {
								for _, name := range m.Names {
									if name.IsExported() {
										ti.Methods = append(ti.Methods, name.Name)
									}
								}
							}
						}
					}
					types = append(types, ti)
				}
			}
		}
	}

	// Attach methods to types
	for i := range types {
		if methods, ok := methodsByType[types[i].Name]; ok {
			types[i].Methods = append(types[i].Methods, methods...)
		}
		if methods, ok := methodsByType["*"+types[i].Name]; ok {
			types[i].Methods = append(types[i].Methods, methods...)
		}
	}

	return funcs, types
}

func typeExprToString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + typeExprToString(t.X)
	case *ast.ArrayType:
		return "[]" + typeExprToString(t.Elt)
	case *ast.MapType:
		return "map[" + typeExprToString(t.Key) + "]" + typeExprToString(t.Value)
	case *ast.SelectorExpr:
		return typeExprToString(t.X) + "." + t.Sel.Name
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.ChanType:
		return "chan " + typeExprToString(t.Value)
	case *ast.FuncType:
		return "func()"
	case *ast.Ellipsis:
		return "..." + typeExprToString(t.Elt)
	default:
		return "any"
	}
}

func emitC(funcs []funcInfo, types []typeInfo) {
	fmt.Println("// AUTO-GENERATED by scripts/gen-go-stdlib.go — DO NOT EDIT")
	fmt.Println("// Go stdlib type information for LSP type resolver.")
	fmt.Println("")
	fmt.Println("#include \"../type_rep.h\"")
	fmt.Println("#include \"../type_registry.h\"")
	fmt.Println("#include <string.h>")
	fmt.Println("")

	// Emit string literals
	fmt.Printf("// %d functions, %d types from %d packages\n\n", len(funcs), len(types), len(targetPackages))

	// Emit function registration helper
	fmt.Println("void cbm_go_stdlib_register(CBMTypeRegistry* reg, CBMArena* arena) {")
	fmt.Println("    CBMRegisteredFunc rf;")
	fmt.Println("    CBMRegisteredType rt;")
	fmt.Println("")

	// Emit static method_names arrays for interfaces
	for _, t := range types {
		if !t.IsInterface || len(t.Methods) == 0 {
			continue
		}
		// Deduplicate and sort method names
		seen := make(map[string]bool)
		var methods []string
		for _, m := range t.Methods {
			if !seen[m] {
				seen[m] = true
				methods = append(methods, m)
			}
		}
		sort.Strings(methods)
		varName := strings.ReplaceAll(t.PkgPath, "/", "_") + "_" + t.Name + "_methods"
		fmt.Printf("    static const char* %s[] = {", varName)
		for _, m := range methods {
			fmt.Printf("%s, ", cStr(m))
		}
		fmt.Printf("NULL};\n")
	}
	fmt.Println()

	// Register types
	for _, t := range types {
		qn := cStr(t.PkgPath + "." + t.Name)
		fmt.Printf("    // Type: %s.%s\n", t.PkgPath, t.Name)
		fmt.Printf("    memset(&rt, 0, sizeof(rt));\n")
		fmt.Printf("    rt.qualified_name = %s;\n", qn)
		fmt.Printf("    rt.short_name = %s;\n", cStr(t.Name))
		if t.IsInterface {
			fmt.Printf("    rt.is_interface = true;\n")
			// Attach method_names if this interface has methods
			if len(t.Methods) > 0 {
				varName := strings.ReplaceAll(t.PkgPath, "/", "_") + "_" + t.Name + "_methods"
				fmt.Printf("    rt.method_names = %s;\n", varName)
			}
		}
		fmt.Printf("    cbm_registry_add_type(reg, rt);\n\n")
	}

	// Register functions
	for _, f := range funcs {
		qn := f.PkgPath + "." + f.Name
		if f.Receiver != "" {
			recv := strings.TrimPrefix(f.Receiver, "*")
			qn = f.PkgPath + "." + recv + "." + f.Name
		}
		fmt.Printf("    // %s\n", qn)
		fmt.Printf("    memset(&rf, 0, sizeof(rf));\n")
		fmt.Printf("    rf.qualified_name = %s;\n", cStr(qn))
		fmt.Printf("    rf.short_name = %s;\n", cStr(f.Name))
		if f.Receiver != "" {
			recv := strings.TrimPrefix(f.Receiver, "*")
			fmt.Printf("    rf.receiver_type = %s;\n", cStr(f.PkgPath+"."+recv))
		}

		// Build return type (simplified: single return type as named)
		if len(f.ReturnTypes) > 0 {
			// Use a simple FUNC type with return types
			fmt.Printf("    {\n")
			fmt.Printf("        const CBMType* ret[%d];\n", len(f.ReturnTypes)+1)
			for i, rt := range f.ReturnTypes {
				if isBuiltinType(rt) {
					fmt.Printf("        ret[%d] = cbm_type_builtin(arena, %s);\n", i, cStr(rt))
				} else if strings.HasPrefix(rt, "*") {
					inner := strings.TrimPrefix(rt, "*")
					if isBuiltinType(inner) {
						fmt.Printf("        ret[%d] = cbm_type_pointer(arena, cbm_type_builtin(arena, %s));\n", i, cStr(inner))
					} else {
						fmt.Printf("        ret[%d] = cbm_type_pointer(arena, cbm_type_named(arena, %s));\n", i, cStr(resolveStdlibType(f.PkgPath, inner)))
					}
				} else if strings.HasPrefix(rt, "[]") {
					inner := strings.TrimPrefix(rt, "[]")
					if isBuiltinType(inner) {
						fmt.Printf("        ret[%d] = cbm_type_slice(arena, cbm_type_builtin(arena, %s));\n", i, cStr(inner))
					} else {
						fmt.Printf("        ret[%d] = cbm_type_slice(arena, cbm_type_named(arena, %s));\n", i, cStr(resolveStdlibType(f.PkgPath, inner)))
					}
				} else {
					fmt.Printf("        ret[%d] = cbm_type_named(arena, %s);\n", i, cStr(resolveStdlibType(f.PkgPath, rt)))
				}
			}
			fmt.Printf("        ret[%d] = NULL;\n", len(f.ReturnTypes))
			fmt.Printf("        rf.signature = cbm_type_func(arena, NULL, NULL, ret);\n")
			fmt.Printf("    }\n")
		}
		fmt.Printf("    cbm_registry_add_func(reg, rf);\n\n")
	}

	fmt.Println("}")
}

func isBuiltinType(t string) bool {
	switch t {
	case "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64",
		"float32", "float64", "string", "bool", "byte", "rune",
		"error", "any", "uintptr", "complex64", "complex128":
		return true
	}
	return false
}

func resolveStdlibType(currentPkg, typeName string) string {
	if strings.Contains(typeName, ".") {
		return typeName // already qualified
	}
	return currentPkg + "." + typeName
}

func cStr(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\"", "\\\"")
	return "\"" + s + "\""
}
