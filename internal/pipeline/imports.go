package pipeline

import (
	"log/slog"
	"path/filepath"
	"strings"
	"unicode"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/parser"
)

// parseImports extracts the import map for a source file.
// Returns localName -> resolvedQN mapping.
func parseImports(
	root *tree_sitter.Node,
	source []byte,
	language lang.Language,
	projectName, relPath string,
) map[string]string {
	switch language {
	case lang.Go:
		return parseGoImports(root, source, projectName)
	case lang.Python:
		return parsePythonImports(root, source, projectName, relPath)
	case lang.JavaScript, lang.TypeScript, lang.TSX:
		return parseESModuleImports(root, source, projectName)
	case lang.Java:
		return parseJavaImports(root, source, projectName)
	case lang.Kotlin:
		return parseKotlinImports(root, source, projectName)
	case lang.Scala:
		return parseScalaImports(root, source, projectName)
	case lang.CSharp:
		return parseCSharpImports(root, source, projectName)
	case lang.C:
		return parseCImports(root, source, projectName)
	case lang.CPP:
		return parseCPPImports(root, source, projectName)
	case lang.PHP:
		return parsePHPImports(root, source, projectName)
	case lang.Ruby:
		return parseRubyImports(root, source, projectName)
	case lang.Rust:
		return parseRustImports(root, source, projectName)
	case lang.Lua:
		return parseLuaImports(root, source, projectName)
	case lang.Elixir:
		return parseElixirImports(root, source, projectName)
	case lang.Bash:
		return parseBashImports(root, source, projectName)
	case lang.Zig:
		return parseZigImports(root, source, projectName)
	case lang.Erlang:
		return parseErlangImports(root, source, projectName)
	case lang.Haskell:
		return parseHaskellImports(root, source, projectName)
	case lang.OCaml:
		return parseOCamlImports(root, source, projectName)
	default:
		return nil
	}
}

// parseGoImports extracts Go import declarations.
// For each import spec: localName -> module QN (project-relative) or raw path.
//
// Go import AST structure:
//
//	import_declaration
//	  import_spec_list
//	    import_spec
//	      name: package_identifier (optional alias)
//	      path: interpreted_string_literal
func parseGoImports(
	root *tree_sitter.Node,
	source []byte,
	projectName string,
) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "import_declaration" {
			return true
		}

		// Process each import_spec inside this declaration
		processGoImportDecl(node, source, projectName, imports)
		return false // don't recurse further
	})

	return imports
}

func processGoImportDecl(node *tree_sitter.Node, source []byte, projectName string, imports map[string]string) {
	parser.Walk(node, func(child *tree_sitter.Node) bool {
		if child.Kind() != "import_spec" {
			return true
		}

		pathNode := child.ChildByFieldName("path")
		if pathNode == nil {
			return false
		}

		importPath := stripQuotes(parser.NodeText(pathNode, source))
		if importPath == "" {
			return false
		}

		// Determine the local name: alias if present, else last segment
		localName := lastPathSegment(importPath)
		nameNode := child.ChildByFieldName("name")
		if nameNode != nil {
			alias := parser.NodeText(nameNode, source)
			if alias != "" && alias != "." && alias != "_" {
				localName = alias
			}
		}

		// Resolve the import path to a project-internal QN if possible.
		// We check if any part of the import path matches the project name,
		// which indicates an internal package.
		resolvedQN := resolveGoImportPath(importPath, projectName)
		imports[localName] = resolvedQN

		return false
	})
}

// resolveGoImportPath converts a Go import path to a project-internal QN.
// For internal packages: "github.com/org/project/pkg/foo" -> "project.pkg.foo"
// For external packages: "fmt" -> "fmt", "net/http" -> "http"
func resolveGoImportPath(importPath, projectName string) string {
	parts := strings.Split(importPath, "/")

	// Check if this is a project-internal import by looking for the project
	// name in the path segments (common pattern: github.com/org/project/...)
	for i, part := range parts {
		if part == projectName {
			// Everything after the project name becomes the QN
			remaining := parts[i:]
			return strings.Join(remaining, ".")
		}
	}

	// External package: use the full path with dots
	return strings.Join(parts, ".")
}

// parsePythonImports extracts Python import statements.
//
// Python import AST structures:
//
//	import_statement:
//	  dotted_name children (e.g., "import foo.bar")
//	  aliased_import with alias (e.g., "import foo as f")
//
//	import_from_statement:
//	  module_name: dotted_name or relative_import
//	  name: dotted_name (what's being imported)
//	  Multiple names possible (e.g., "from foo import bar, baz")
func parsePythonImports(
	root *tree_sitter.Node,
	source []byte,
	projectName, relPath string,
) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		switch node.Kind() {
		case "import_statement":
			processPythonImport(node, source, projectName, imports)
			return false
		case "import_from_statement":
			processPythonFromImport(node, source, projectName, relPath, imports)
			return false
		}
		return true
	})

	return imports
}

// processPythonImport handles "import X" and "import X as Y" statements.
func processPythonImport(node *tree_sitter.Node, source []byte, projectName string, imports map[string]string) {
	for i := uint(0); i < node.NamedChildCount(); i++ {
		child := node.NamedChild(i)
		if child == nil {
			continue
		}

		switch child.Kind() {
		case "dotted_name":
			name := parser.NodeText(child, source)
			localName := lastDotSegment(name)
			imports[localName] = resolvePythonModule(name, projectName)

		case "aliased_import":
			nameNode := child.ChildByFieldName("name")
			aliasNode := child.ChildByFieldName("alias")
			if nameNode == nil {
				continue
			}
			name := parser.NodeText(nameNode, source)
			localName := lastDotSegment(name)
			if aliasNode != nil {
				localName = parser.NodeText(aliasNode, source)
			}
			imports[localName] = resolvePythonModule(name, projectName)
		}
	}
}

// processPythonFromImport handles "from X import Y" statements.
func processPythonFromImport(
	node *tree_sitter.Node,
	source []byte,
	projectName, relPath string,
	imports map[string]string,
) {
	// Get the module being imported from
	moduleNode := node.ChildByFieldName("module_name")
	var modulePath string
	isRelative := false

	if moduleNode != nil {
		modulePath = parser.NodeText(moduleNode, source)
		isRelative = strings.HasPrefix(modulePath, ".")
	} else {
		// Check for bare relative import: "from . import X"
		text := parser.NodeText(node, source)
		if strings.HasPrefix(text, "from .") {
			isRelative = true
			modulePath = "."
		}
	}

	// Resolve the base module
	var baseModule string
	if isRelative {
		baseModule = resolveRelativePythonImport(modulePath, relPath, projectName)
	} else {
		baseModule = resolvePythonModule(modulePath, projectName)
	}

	// Extract each imported name
	for i := uint(0); i < node.NamedChildCount(); i++ {
		child := node.NamedChild(i)
		if child == nil {
			continue
		}

		switch child.Kind() {
		case "dotted_name":
			name := parser.NodeText(child, source)
			// Skip the module_name itself (first dotted_name is often the source)
			if name == modulePath {
				continue
			}
			localName := lastDotSegment(name)
			if baseModule != "" {
				imports[localName] = baseModule + "." + name
			} else {
				imports[localName] = name
			}

		case "aliased_import":
			nameNode := child.ChildByFieldName("name")
			aliasNode := child.ChildByFieldName("alias")
			if nameNode == nil {
				continue
			}
			name := parser.NodeText(nameNode, source)
			localName := lastDotSegment(name)
			if aliasNode != nil {
				localName = parser.NodeText(aliasNode, source)
			}
			if baseModule != "" {
				imports[localName] = baseModule + "." + name
			} else {
				imports[localName] = name
			}
		}
	}
}

// resolvePythonModule converts a Python module path to a project QN.
// "utils" -> "project.utils", "foo.bar" -> "project.foo.bar"
func resolvePythonModule(modulePath, projectName string) string {
	if modulePath == "" {
		return projectName
	}
	return projectName + "." + modulePath
}

// resolveRelativePythonImport resolves relative imports like "from . import X"
// or "from ..utils import X" based on the current file's location.
func resolveRelativePythonImport(modulePath, relPath, projectName string) string {
	// Count leading dots for relative depth
	dots := 0
	for _, ch := range modulePath {
		if ch == '.' {
			dots++
		} else {
			break
		}
	}
	remainder := strings.TrimLeft(modulePath, ".")

	// Navigate up from the current file's directory
	dir := filepath.Dir(relPath)
	for i := 1; i < dots; i++ {
		dir = filepath.Dir(dir)
	}

	baseQN := fqn.FolderQN(projectName, dir)
	if dir == "." || dir == "" {
		baseQN = projectName
	}

	if remainder != "" {
		return baseQN + "." + remainder
	}
	return baseQN
}

// stripQuotes removes surrounding quotes from a string literal.
func stripQuotes(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
		// Handle backtick quotes (Go raw strings)
		if s[0] == '`' && s[len(s)-1] == '`' {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// lastPathSegment returns the last segment of a /-separated path.
func lastPathSegment(path string) string {
	parts := strings.Split(path, "/")
	return parts[len(parts)-1]
}

// lastDotSegment returns the last segment of a .-separated name.
func lastDotSegment(name string) string {
	parts := strings.Split(name, ".")
	return parts[len(parts)-1]
}

// lastBackslashSegment returns the last segment of a \-separated name (PHP namespaces).
func lastBackslashSegment(name string) string {
	parts := strings.Split(name, "\\")
	return parts[len(parts)-1]
}

// lastColonSegment returns the last segment of a ::-separated name (Rust/C++ paths).
func lastColonSegment(name string) string {
	parts := strings.Split(name, "::")
	return parts[len(parts)-1]
}

// resolveImportPath converts a dot-separated module path to a project QN.
func resolveImportPath(modulePath, projectName string) string {
	if modulePath == "" {
		return projectName
	}
	return projectName + "." + modulePath
}

// --- ES Module imports (JavaScript, TypeScript, TSX) ---

// parseESModuleImports extracts ES module imports (import/require).
//
// AST structures:
//
//	import_statement:
//	  import_clause:
//	    named_imports: { import_specifier... }
//	    identifier (default import)
//	    namespace_import: * as name
//	  source: string_fragment
//
//	lexical_declaration (CommonJS):
//	  variable_declarator:
//	    name: identifier
//	    value: call_expression (require("..."))
func parseESModuleImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		switch node.Kind() {
		case "import_statement":
			parseESImportStatement(node, source, projectName, imports)
			return false
		case "lexical_declaration":
			parseCommonJSRequire(node, source, projectName, imports)
			return false
		}
		return true
	})

	return imports
}

func parseESImportStatement(node *tree_sitter.Node, source []byte, projectName string, imports map[string]string) {
	// Get the source path
	sourceNode := node.ChildByFieldName("source")
	if sourceNode == nil {
		return
	}
	importPath := stripQuotes(parser.NodeText(sourceNode, source))
	if importPath == "" {
		return
	}
	resolvedQN := resolveESImportPath(importPath, projectName)

	// Walk children for import clause elements
	for i := uint(0); i < node.NamedChildCount(); i++ {
		child := node.NamedChild(i)
		if child == nil {
			continue
		}
		switch child.Kind() {
		case "import_clause":
			parseESImportClause(child, source, resolvedQN, imports)
		case "named_imports":
			parseESNamedImports(child, source, resolvedQN, imports)
		case "namespace_import":
			if ident := child.ChildByFieldName("name"); ident == nil {
				if named := child.NamedChild(0); named != nil {
					imports[parser.NodeText(named, source)] = resolvedQN
				}
			} else {
				imports[parser.NodeText(ident, source)] = resolvedQN
			}
		}
	}
}

func parseESImportClause(clause *tree_sitter.Node, source []byte, resolvedQN string, imports map[string]string) {
	for i := uint(0); i < clause.NamedChildCount(); i++ {
		child := clause.NamedChild(i)
		if child == nil {
			continue
		}
		switch child.Kind() {
		case "identifier":
			// Default import: import Foo from "..."
			imports[parser.NodeText(child, source)] = resolvedQN
		case "named_imports":
			parseESNamedImports(child, source, resolvedQN, imports)
		case "namespace_import":
			// import * as Foo from "..."
			for j := uint(0); j < child.NamedChildCount(); j++ {
				ident := child.NamedChild(j)
				if ident != nil && ident.Kind() == "identifier" {
					imports[parser.NodeText(ident, source)] = resolvedQN
				}
			}
		}
	}
}

func parseESNamedImports(node *tree_sitter.Node, source []byte, resolvedQN string, imports map[string]string) {
	for i := uint(0); i < node.NamedChildCount(); i++ {
		child := node.NamedChild(i)
		if child == nil || child.Kind() != "import_specifier" {
			continue
		}
		nameNode := child.ChildByFieldName("name")
		aliasNode := child.ChildByFieldName("alias")
		if nameNode == nil {
			continue
		}
		name := parser.NodeText(nameNode, source)
		localName := name
		if aliasNode != nil {
			localName = parser.NodeText(aliasNode, source)
		}
		imports[localName] = resolvedQN + "." + name
	}
}

func parseCommonJSRequire(node *tree_sitter.Node, source []byte, projectName string, imports map[string]string) {
	// Matches CommonJS require variable declarations.
	for i := uint(0); i < node.NamedChildCount(); i++ {
		child := node.NamedChild(i)
		if child == nil || child.Kind() != "variable_declarator" {
			continue
		}
		nameNode := child.ChildByFieldName("name")
		valueNode := child.ChildByFieldName("value")
		if nameNode == nil || valueNode == nil {
			continue
		}
		if valueNode.Kind() != "call_expression" {
			continue
		}
		funcNode := valueNode.ChildByFieldName("function")
		if funcNode == nil || parser.NodeText(funcNode, source) != "require" {
			continue
		}
		args := valueNode.ChildByFieldName("arguments")
		if args == nil || args.NamedChildCount() == 0 {
			continue
		}
		arg := args.NamedChild(0)
		if arg == nil {
			continue
		}
		importPath := stripQuotes(parser.NodeText(arg, source))
		if importPath == "" {
			continue
		}
		imports[parser.NodeText(nameNode, source)] = resolveESImportPath(importPath, projectName)
	}
}

func resolveESImportPath(importPath, projectName string) string {
	// Relative imports: ./foo/bar → project.foo.bar
	// Package imports: react → react, @scope/pkg → scope.pkg
	path := strings.TrimPrefix(importPath, "./")
	path = strings.TrimPrefix(path, "../")
	// Strip file extension
	for _, ext := range []string{".js", ".ts", ".tsx", ".jsx", ".mjs", ".mts"} {
		path = strings.TrimSuffix(path, ext)
	}
	// Convert separators to dots
	path = strings.ReplaceAll(path, "/", ".")
	path = strings.ReplaceAll(path, "@", "")
	if strings.HasPrefix(importPath, ".") {
		return projectName + "." + path
	}
	return path
}

// --- Java imports ---

// parseJavaImports extracts Java import declarations.
//
//	import_declaration:
//	  (scoped_identifier / identifier) with optional "static" and "*"
func parseJavaImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "import_declaration" {
			return true
		}

		text := parser.NodeText(node, source)
		text = strings.TrimPrefix(text, "import ")
		text = strings.TrimPrefix(text, "static ")
		text = strings.TrimSuffix(text, ";")
		text = strings.TrimSpace(text)

		if text == "" || strings.HasSuffix(text, ".*") {
			return false // wildcard import — skip
		}

		localName := lastDotSegment(text)
		imports[localName] = resolveImportPath(text, projectName)

		return false
	})

	return imports
}

// --- Kotlin imports ---

// parseKotlinImports extracts Kotlin import statements.
//
//	import_header → import (node kind "import"):
//	  identifier: dotted path "org.example.Foo"
//	  import_alias: "as Bar"
func parseKotlinImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "import_header" && node.Kind() != "import" {
			return true
		}

		text := parser.NodeText(node, source)
		text = strings.TrimPrefix(text, "import ")
		text = strings.TrimSpace(text)

		// Handle "as" alias
		var localName string
		if idx := strings.Index(text, " as "); idx >= 0 {
			localName = strings.TrimSpace(text[idx+4:])
			text = strings.TrimSpace(text[:idx])
		}

		if text == "" || strings.HasSuffix(text, ".*") {
			return false
		}

		if localName == "" {
			localName = lastDotSegment(text)
		}
		imports[localName] = resolveImportPath(text, projectName)

		return false
	})

	return imports
}

// --- Scala imports ---

// parseScalaImports extracts Scala import declarations.
//
//	import_declaration:
//	  stable_identifier / import_expression with selectors
func parseScalaImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "import_declaration" {
			return true
		}

		text := parser.NodeText(node, source)
		text = strings.TrimPrefix(text, "import ")
		text = strings.TrimSpace(text)

		// Handle brace imports: import foo.{Bar, Baz} — complex; skip for now
		if strings.Contains(text, ".{") {
			return false
		}

		// Handle wildcard: import foo._
		if strings.HasSuffix(text, "._") {
			return false
		}

		// Handle rename: import foo.{Bar => B}
		if strings.Contains(text, "=>") {
			return false
		}

		localName := lastDotSegment(text)
		imports[localName] = resolveImportPath(text, projectName)

		return false
	})

	return imports
}

// --- C# imports ---

// parseCSharpImports extracts C# using directives.
//
//	using_directive:
//	  qualified_name / identifier / "using alias = Type"
func parseCSharpImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "using_directive" {
			return true
		}

		text := parser.NodeText(node, source)
		text = strings.TrimPrefix(text, "using ")
		text = strings.TrimPrefix(text, "static ")
		text = strings.TrimPrefix(text, "global::")
		text = strings.TrimSuffix(text, ";")
		text = strings.TrimSpace(text)

		if text == "" {
			return false
		}

		// Handle alias: using Alias = Namespace.Type
		if idx := strings.Index(text, " = "); idx >= 0 {
			localName := strings.TrimSpace(text[:idx])
			fullPath := strings.TrimSpace(text[idx+3:])
			imports[localName] = resolveImportPath(fullPath, projectName)
			return false
		}

		localName := lastDotSegment(text)
		imports[localName] = resolveImportPath(text, projectName)

		return false
	})

	return imports
}

// --- C imports ---

// parseCImports extracts C #include directives.
//
//	preproc_include:
//	  path: string_literal or system_lib_string
func parseCImports(root *tree_sitter.Node, source []byte, _ string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "preproc_include" {
			return true
		}

		pathNode := node.ChildByFieldName("path")
		if pathNode == nil {
			// Fallback: first named child
			if node.NamedChildCount() > 0 {
				pathNode = node.NamedChild(0)
			}
		}
		if pathNode == nil {
			return false
		}

		path := stripQuotes(parser.NodeText(pathNode, source))
		path = strings.Trim(path, "<>")
		if path == "" {
			return false
		}

		// Local name: filename without extension
		base := filepath.Base(path)
		localName := strings.TrimSuffix(base, filepath.Ext(base))
		resolvedQN := strings.ReplaceAll(path, "/", ".")
		resolvedQN = strings.TrimSuffix(resolvedQN, filepath.Ext(resolvedQN))

		imports[localName] = resolvedQN

		return false
	})

	return imports
}

// --- C++ imports ---

// parseCPPImports extracts C++ #include and using declarations.
func parseCPPImports(root *tree_sitter.Node, source []byte, _ string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		switch node.Kind() {
		case "preproc_include":
			pathNode := node.ChildByFieldName("path")
			if pathNode == nil && node.NamedChildCount() > 0 {
				pathNode = node.NamedChild(0)
			}
			if pathNode == nil {
				return false
			}
			path := stripQuotes(parser.NodeText(pathNode, source))
			path = strings.Trim(path, "<>")
			if path == "" {
				return false
			}
			base := filepath.Base(path)
			localName := strings.TrimSuffix(base, filepath.Ext(base))
			resolvedQN := strings.ReplaceAll(path, "/", ".")
			resolvedQN = strings.TrimSuffix(resolvedQN, filepath.Ext(resolvedQN))
			imports[localName] = resolvedQN
			return false

		case "using_declaration":
			text := parser.NodeText(node, source)
			text = strings.TrimPrefix(text, "using ")
			text = strings.TrimPrefix(text, "namespace ")
			text = strings.TrimSuffix(text, ";")
			text = strings.TrimSpace(text)
			if text != "" {
				localName := lastColonSegment(text)
				resolvedQN := strings.ReplaceAll(text, "::", ".")
				imports[localName] = resolvedQN
			}
			return false
		}
		return true
	})

	return imports
}

// --- PHP imports ---

// parsePHPImports extracts PHP use declarations.
//
//	namespace_use_declaration:
//	  namespace_use_clause → qualified_name
func parsePHPImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "namespace_use_declaration" {
			return true
		}

		// Walk children for namespace_use_clause nodes
		for i := uint(0); i < node.NamedChildCount(); i++ {
			child := node.NamedChild(i)
			if child == nil {
				continue
			}
			if child.Kind() == "namespace_use_clause" || child.Kind() == "namespace_use_group_clause" {
				nameNode := child.ChildByFieldName("name")
				if nameNode == nil {
					nameNode = child.NamedChild(0)
				}
				if nameNode == nil {
					continue
				}
				fullPath := parser.NodeText(nameNode, source)
				fullPath = strings.TrimLeft(fullPath, "\\")

				aliasNode := child.ChildByFieldName("alias")
				localName := lastBackslashSegment(fullPath)
				if aliasNode != nil {
					localName = parser.NodeText(aliasNode, source)
				}

				resolvedQN := strings.ReplaceAll(fullPath, "\\", ".")
				imports[localName] = resolveImportPath(resolvedQN, projectName)
			}
		}

		return false
	})

	return imports
}

// --- Ruby imports ---

// parseRubyImports extracts Ruby require/require_relative calls.
//
//	call: method = "require" / "require_relative", arguments contain string
//
//nolint:gocognit // WHY: inherent complexity from Ruby require/require_relative/autoload parsing
func parseRubyImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "call" && node.Kind() != "command" {
			return true
		}

		// Check if this is a require call
		methodNode := node.ChildByFieldName("method")
		if methodNode == nil {
			// command nodes use first child
			if node.NamedChildCount() > 0 {
				methodNode = node.NamedChild(0)
			}
		}
		if methodNode == nil {
			return true
		}

		methodName := parser.NodeText(methodNode, source)
		if methodName != "require" && methodName != "require_relative" {
			return true
		}

		// Get the arguments
		args := node.ChildByFieldName("arguments")
		if args == nil {
			// For command nodes, try second named child
			if node.NamedChildCount() > 1 {
				args = node.NamedChild(1)
			}
		}
		if args == nil {
			return false
		}

		// Extract string argument
		var pathStr string
		parser.Walk(args, func(n *tree_sitter.Node) bool {
			if n.Kind() == "string" || n.Kind() == "string_literal" {
				pathStr = stripQuotes(parser.NodeText(n, source))
				// Also handle string_content inside string node
				for j := uint(0); j < n.NamedChildCount(); j++ {
					if sc := n.NamedChild(j); sc != nil && sc.Kind() == "string_content" {
						pathStr = parser.NodeText(sc, source)
						break
					}
				}
				return false
			}
			return true
		})

		if pathStr == "" {
			return false
		}

		// Convert path to local name and QN
		pathStr = strings.TrimSuffix(pathStr, ".rb")
		localName := lastPathSegment(pathStr)
		resolvedQN := strings.ReplaceAll(pathStr, "/", ".")
		if methodName == "require_relative" {
			resolvedQN = projectName + "." + resolvedQN
		}
		imports[localName] = resolvedQN

		return false
	})

	return imports
}

// --- Rust imports ---

// parseRustImports extracts Rust use declarations.
//
//	use_declaration:
//	  argument: use_tree (scoped_identifier, use_list, use_as_clause, etc.)
func parseRustImports(root *tree_sitter.Node, source []byte, _ string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "use_declaration" {
			return true
		}

		// Extract text and parse
		text := parser.NodeText(node, source)
		text = strings.TrimPrefix(text, "use ")
		text = strings.TrimSuffix(text, ";")
		text = strings.TrimSpace(text)

		// Handle brace groups: use std::{io, fs}
		if idx := strings.Index(text, "::{"); idx >= 0 {
			basePath := text[:idx]
			braces := text[idx+3:]
			braces = strings.TrimSuffix(braces, "}")
			for _, item := range strings.Split(braces, ",") {
				item = strings.TrimSpace(item)
				if item == "" || item == "self" {
					continue
				}
				// Handle nested: io::{self, Write} — just take the top-level name
				if nestedIdx := strings.Index(item, "::"); nestedIdx >= 0 {
					item = item[:nestedIdx]
				}
				localName := item
				if asIdx := strings.Index(item, " as "); asIdx >= 0 {
					localName = strings.TrimSpace(item[asIdx+4:])
					item = strings.TrimSpace(item[:asIdx])
				}
				fullPath := basePath + "::" + item
				resolvedQN := strings.ReplaceAll(fullPath, "::", ".")
				imports[localName] = resolvedQN
			}
			return false
		}

		// Handle alias: use foo::bar as baz
		var localName string
		if asIdx := strings.Index(text, " as "); asIdx >= 0 {
			localName = strings.TrimSpace(text[asIdx+4:])
			text = strings.TrimSpace(text[:asIdx])
		}

		if text == "" {
			return false
		}

		if localName == "" {
			localName = lastColonSegment(text)
		}
		resolvedQN := strings.ReplaceAll(text, "::", ".")
		imports[localName] = resolvedQN

		return false
	})

	return imports
}

// --- Lua imports ---

// parseLuaImports extracts Lua require() calls.
//
//	function_call where function is "require" → string argument
func parseLuaImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "function_call" {
			return true
		}

		// Check if this is a require call
		nameNode := node.NamedChild(0)
		if nameNode == nil || parser.NodeText(nameNode, source) != "require" {
			return true
		}

		// Get the argument
		args := node.ChildByFieldName("arguments")
		if args == nil {
			// Lua: arguments might be the second named child
			if node.NamedChildCount() > 1 {
				args = node.NamedChild(1)
			}
		}
		if args == nil {
			return false
		}

		var pathStr string
		parser.Walk(args, func(n *tree_sitter.Node) bool {
			if n.Kind() == "string" || n.Kind() == "string_literal" {
				pathStr = stripQuotes(parser.NodeText(n, source))
				for j := uint(0); j < n.NamedChildCount(); j++ {
					if sc := n.NamedChild(j); sc != nil && sc.Kind() == "string_content" {
						pathStr = parser.NodeText(sc, source)
						break
					}
				}
				return false
			}
			return true
		})

		if pathStr == "" {
			return false
		}

		localName := lastDotSegment(pathStr)
		resolvedQN := projectName + "." + pathStr
		imports[localName] = resolvedQN

		return false
	})

	return imports
}

// --- Elixir imports ---

// parseElixirImports extracts Elixir import/alias/use/require calls.
//
//	call: function name is "import", "alias", "use", or "require"
func parseElixirImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "call" {
			return true
		}

		// Get the function name (first child)
		if node.NamedChildCount() == 0 {
			return true
		}
		funcChild := node.NamedChild(0)
		if funcChild == nil {
			return true
		}
		funcName := parser.NodeText(funcChild, source)

		switch funcName {
		case "alias", "import", "use", "require":
		default:
			return true
		}

		// Get the module argument (second named child or in arguments)
		var moduleName string
		if node.NamedChildCount() > 1 {
			arg := node.NamedChild(1)
			if arg != nil {
				argText := parser.NodeText(arg, source)
				// Strip keyword arguments
				if idx := strings.Index(argText, ","); idx > 0 {
					argText = strings.TrimSpace(argText[:idx])
				}
				moduleName = argText
			}
		}

		if moduleName == "" {
			return true
		}

		// Handle "alias Foo.Bar, as: Baz"
		localName := lastDotSegment(moduleName)

		// Check for "as:" option in arguments
		text := parser.NodeText(node, source)
		if idx := strings.Index(text, "as:"); idx > 0 {
			rest := strings.TrimSpace(text[idx+3:])
			if endIdx := strings.IndexAny(rest, ",)\n"); endIdx > 0 {
				rest = rest[:endIdx]
			}
			rest = strings.TrimSpace(rest)
			if rest != "" {
				localName = rest
			}
		}

		imports[localName] = resolveImportPath(moduleName, projectName)

		return true // continue walking for nested module definitions
	})

	return imports
}

// --- Bash imports ---

// parseBashImports extracts Bash source/. commands.
//
//	command: first word is "source" or "."
func parseBashImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "command" {
			return true
		}

		// First child should be command_name
		if node.NamedChildCount() == 0 {
			return true
		}
		cmdName := node.NamedChild(0)
		if cmdName == nil {
			return true
		}

		cmdText := parser.NodeText(cmdName, source)
		if cmdText != "source" && cmdText != "." {
			return true
		}

		// Second child is the file argument
		if node.NamedChildCount() < 2 {
			return false
		}
		arg := node.NamedChild(1)
		if arg == nil {
			return false
		}

		pathStr := stripQuotes(parser.NodeText(arg, source))
		if pathStr == "" {
			return false
		}

		// Strip leading ./ and extension
		pathStr = strings.TrimPrefix(pathStr, "./")
		base := filepath.Base(pathStr)
		localName := strings.TrimSuffix(base, filepath.Ext(base))
		resolvedQN := strings.ReplaceAll(pathStr, "/", ".")
		resolvedQN = strings.TrimSuffix(resolvedQN, filepath.Ext(resolvedQN))
		imports[localName] = projectName + "." + resolvedQN

		return false
	})

	return imports
}

// --- Zig imports ---

// parseZigImports extracts Zig @import() calls.
//
//	builtin_function: @import("path")
func parseZigImports(root *tree_sitter.Node, source []byte, projectName string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "builtin_function" {
			return true
		}

		text := parser.NodeText(node, source)
		if !strings.HasPrefix(text, "@import") {
			return true
		}

		// Extract the path from @import("...")
		start := strings.Index(text, "(")
		end := strings.LastIndex(text, ")")
		if start < 0 || end <= start {
			return false
		}
		pathStr := stripQuotes(strings.TrimSpace(text[start+1 : end]))
		if pathStr == "" {
			return false
		}

		// "std" → std, "foo.zig" → foo
		localName := strings.TrimSuffix(pathStr, ".zig")
		localName = lastPathSegment(localName)
		resolvedQN := strings.TrimSuffix(pathStr, ".zig")
		resolvedQN = strings.ReplaceAll(resolvedQN, "/", ".")

		if pathStr == "std" || pathStr == "builtin" {
			imports[localName] = localName
		} else {
			imports[localName] = projectName + "." + resolvedQN
		}

		return false
	})

	return imports
}

// --- Erlang imports ---

// parseErlangImports extracts Erlang -import() attributes.
//
//	module_attribute: -import(module, [func1/arity, ...]).
func parseErlangImports(root *tree_sitter.Node, source []byte, _ string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "module_attribute" {
			return true
		}

		text := parser.NodeText(node, source)
		if !strings.HasPrefix(text, "-import(") {
			return true
		}

		// Parse -import(module, [func1/arity, ...]).
		inner := strings.TrimPrefix(text, "-import(")
		inner = strings.TrimSuffix(inner, ").")
		inner = strings.TrimSuffix(inner, ")")

		// Split on first comma to get module name
		parts := strings.SplitN(inner, ",", 2)
		if len(parts) == 0 {
			return false
		}

		moduleName := strings.TrimSpace(parts[0])
		if moduleName == "" {
			return false
		}

		imports[moduleName] = moduleName

		return false
	})

	return imports
}

// --- Haskell imports ---

// parseHaskellImports extracts Haskell import declarations.
//
//	import: import [qualified] Module [as Alias] [(items)]
func parseHaskellImports(root *tree_sitter.Node, source []byte, _ string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "import" {
			return true
		}

		text := parser.NodeText(node, source)
		text = strings.TrimPrefix(text, "import ")
		text = strings.TrimPrefix(text, "qualified ")
		text = strings.TrimSpace(text)

		// Strip import list: import Foo (bar, baz)
		if idx := strings.Index(text, "("); idx > 0 {
			text = strings.TrimSpace(text[:idx])
		}
		// Strip "hiding" clause
		if idx := strings.Index(text, " hiding"); idx > 0 {
			text = strings.TrimSpace(text[:idx])
		}

		// Handle "as" alias: import Data.Map as Map
		var localName string
		if idx := strings.Index(text, " as "); idx > 0 {
			localName = strings.TrimSpace(text[idx+4:])
			text = strings.TrimSpace(text[:idx])
		}

		if text == "" {
			return false
		}

		if localName == "" {
			localName = lastDotSegment(text)
		}
		imports[localName] = text

		return false
	})

	return imports
}

// --- OCaml imports ---

// parseOCamlImports extracts OCaml open declarations.
//
//	open_module: open Module_path
func parseOCamlImports(root *tree_sitter.Node, source []byte, _ string) map[string]string {
	imports := make(map[string]string)

	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "open_module" {
			return true
		}

		// Get the module path — usually second named child (after "open" keyword)
		var moduleName string
		for i := uint(0); i < node.NamedChildCount(); i++ {
			child := node.NamedChild(i)
			if child == nil {
				continue
			}
			switch child.Kind() {
			case "module_path", "extended_module_path", "module_name":
				moduleName = parser.NodeText(child, source)
			}
		}
		if moduleName == "" {
			// Fallback: parse text
			text := parser.NodeText(node, source)
			text = strings.TrimPrefix(text, "open ")
			text = strings.TrimPrefix(text, "! ") // open!
			moduleName = strings.TrimSpace(text)
		}

		if moduleName == "" {
			return false
		}

		localName := lastDotSegment(moduleName)
		imports[localName] = moduleName

		return false
	})

	return imports
}

// isUpperFirst returns true if the first rune of s is uppercase.
func isUpperFirst(s string) bool {
	if s == "" {
		return false
	}
	return unicode.IsUpper(rune(s[0]))
}

// logImportDrop logs when an import edge cannot be created because the target node wasn't found.
func logImportDrop(moduleQN, localName, targetQN string) {
	slog.Debug("import.drop", "module", moduleQN, "local", localName, "target", targetQN)
}
